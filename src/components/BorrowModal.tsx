import { useState, useEffect } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildBorrowTSWithPositionCommand } from '../commands/borrow';
import { ASSETS, type AssetKey } from '../assets';
import { fetchPoolHoldings, poolCidFromDisclosed, fetchLiveCids } from '../utils/transferContext';
import type { SubmitTxOptions } from '../hooks/useLoop';
import { ADMIN_API_URL, POOL_OPERATOR } from '../config';

interface Props {
  asset: AssetKey;
  partyId: string;
  position: PositionData;
  submitTx: (
    operation: string,
    payload: TransactionPayload,
    message: string,
    options?: SubmitTxOptions
  ) => Promise<unknown>;
  onClose: () => void;
}

export function BorrowModal({ asset, partyId, position, submitTx, onClose }: Props) {
  const cfg = ASSETS[asset];
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [updateId, setUpdateId] = useState('');
  const [price, setPrice] = useState(0);
  const [poolLiquidity, setPoolLiquidity] = useState(0);
  const [reserveCid, setReserveCid] = useState('');
  const [preloading, setPreloading] = useState(true);

  // Preload price + reserve + pool liquidity for the borrow-capacity UI math.
  useEffect(() => {
    (async () => {
      try {
        const [poolResp, arResp] = await Promise.all([
          fetch(`${ADMIN_API_URL}/admin/pool-status`).then((r) => r.json()),
          fetch(`${ADMIN_API_URL}/admin/asset-reserves`).then((r) => r.json()),
        ]);
        const reserves = (arResp.contracts || []).filter(
          (c: { createArgument?: { instrumentId?: { id?: string } } }) =>
            c.createArgument?.instrumentId?.id === cfg.instrumentId
        );
        const latest = reserves[reserves.length - 1];
        if (latest) {
          setReserveCid(latest.contractId);
          setPoolLiquidity(parseFloat(latest.createArgument?.totalLiquidity || '0'));
          const feed = latest.createArgument?.riskParams?.priceFeedId;
          setPrice(parseFloat(poolResp.oracle?.prices?.[feed]?.price || '0'));
        }
      } catch (err) {
        console.error('BorrowModal: preload failed:', err);
      } finally {
        setPreloading(false);
      }
    })();
  }, [cfg.instrumentId]);

  const weightedCollateralUSD = parseFloat(position.totalWeightedCollateralUSD);
  const liqThresholdUSD = parseFloat(position.totalLiqThresholdCollateralUSD);
  const collateralUSD = parseFloat(position.totalCollateral);
  const borrowedUSD = parseFloat(position.totalBorrowed);

  const availableBorrowUSD = Math.max(0, weightedCollateralUSD - borrowedUSD);
  const maxBorrowByCollateral = price > 0 ? availableBorrowUSD / price : 0;
  const maxBorrow = poolLiquidity > 0
    ? Math.min(maxBorrowByCollateral, poolLiquidity)
    : maxBorrowByCollateral;
  const liquidityBottleneck = poolLiquidity < maxBorrowByCollateral && poolLiquidity >= 0;

  const inputAmount = parseFloat(amount) || 0;
  const inputValueUSD = inputAmount * price;
  const projectedBorrowedUSD = borrowedUSD + inputValueUSD;
  const projectedHF = projectedBorrowedUSD > 0
    ? liqThresholdUSD / projectedBorrowedUSD
    : null;
  const currentHF = borrowedUSD > 0.01
    ? liqThresholdUSD / borrowedUSD
    : null;
  const utilizationPct = weightedCollateralUSD > 0
    ? ((borrowedUSD + inputValueUSD) / weightedCollateralUSD) * 100
    : 0;

  const hfColor = (hf: number | null) => {
    if (hf === null) return '#8b949e';
    if (hf >= 2) return '#4caf50';
    if (hf >= 1.5) return '#ff9800';
    return '#f44336';
  };

  const handleSubmit = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    if (!reserveCid) {
      setError('Still loading — please wait a moment and try again.');
      return;
    }
    setSubmitting(true);
    setError('');

    try {
      // Borrow is a pool-as-sender payout (like withdraw): pull the pool operator's
      // current holdings of this asset — transfer inputs + disclosures, and, for
      // ephemeral assets (CC), freshReserveHoldingCids.
      const poolHoldings = await fetchPoolHoldings(cfg.poolHoldingsPath(POOL_OPERATOR));
      const ctx = await cfg.fetchPoolSendContext(
        amount,
        partyId,
        poolHoldings.cids.length > 0 ? poolHoldings.cids : ['placeholder']
      );

      const allDisclosed = [
        ...ctx.disclosedContracts.map((dc) => ({
          templateId: dc.templateId || '',
          contractId: dc.contractId,
          createdEventBlob: dc.createdEventBlob,
          domainId: dc.domainId || dc.synchronizerId || '',
        })),
        ...poolHoldings.disclosed,
      ];
      const seen = new Set<string>();
      const effectiveDisclosed = allDisclosed.filter((dc) => {
        if (seen.has(dc.contractId)) return false;
        seen.add(dc.contractId);
        return true;
      });

      // Re-resolve current CIDs (reserve/user-position churn between refreshes).
      const live = await fetchLiveCids(partyId);
      const accountReserveCids = Object.entries(live.reservesByInstrument)
        .filter(([id]) => id !== cfg.instrumentId)
        .map(([, cid]) => cid);

      const cmd = buildBorrowTSWithPositionCommand(
        {
          poolCid: poolCidFromDisclosed(effectiveDisclosed, live.poolCid || position.poolCid),
          borrower: partyId,
          borrowAmount: amount,
          borrowAssetReserveCid: live.reservesByInstrument[cfg.instrumentId] || reserveCid,
          transferFactoryCid: ctx.transferFactoryCid,
          userPositionCid: live.userPositionCid || position.userPositionCid,
          // Other reserves backing the user's collateral so the DAR's on-chain HF
          // counts the full basket.
          accountReserveCids,
          // Position unification: merge into the existing borrow for this asset if there is one.
          existingBorrowCid:
            live.borrowsByInstrument[cfg.instrumentId] || cfg.borrowPosition(position)?.cid || null,
          // Ephemeral assets (CC) must pass fresh pool holdings covering full reserve
          // liquidity (FIND-025); stable assets (USDCx) use stored holdings.
          freshReserveHoldingCids: cfg.isEphemeral ? poolHoldings.cids : null,
          choiceContext: ctx.choiceContext,
          reason: `Borrow ${cfg.symbol}`,
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      const result = await submitTx('BorrowTSWithPosition', cmd, `Borrow ${amount} ${cfg.symbol}`, {
        estimateTraffic: false,
      });

      const r = result as Record<string, unknown>;
      const txUpdateId = r?._extractedUpdateId as string | undefined;
      setUpdateId(txUpdateId || '');
      setSuccessMessage(`Borrowed ${amount} ${cfg.symbol}`);
      await position.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionModal title={`Borrow ${cfg.symbol}`} onClose={onClose} successMessage={successMessage} updateId={updateId}>
      <div className="modal-field">
        <label className="modal-label">Borrow Capacity</label>
        <div className="borrow-capacity">
          <div className="capacity-bar">
            <div
              className="capacity-fill"
              style={{
                width: `${Math.min(utilizationPct, 100)}%`,
                backgroundColor: utilizationPct > 90 ? '#f44336' : utilizationPct > 70 ? '#ff9800' : '#4caf50',
              }}
            />
          </div>
          <div className="capacity-labels">
            <span>{utilizationPct.toFixed(1)}% used</span>
            <span>${availableBorrowUSD.toFixed(2)} available</span>
          </div>
        </div>
      </div>

      <div className="modal-field">
        <label className="modal-label">Max Borrow (by collateral)</label>
        <div className="modal-balance">
          {maxBorrowByCollateral.toFixed(4)} {cfg.symbol}
          <span className="balance-sub"> (~${(maxBorrowByCollateral * price).toFixed(2)})</span>
        </div>
        {liquidityBottleneck && (
          <div className="hf-caution" style={{ marginTop: 6 }}>
            Pool liquidity: {poolLiquidity.toFixed(4)} {cfg.symbol} — borrowing limited to available liquidity
          </div>
        )}
      </div>

      <div className="modal-field">
        <label className="modal-label">Amount ({cfg.symbol})</label>
        <div className="modal-input-row">
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="modal-input"
          />
          <button
            className="btn-max"
            onClick={() => setAmount(maxBorrow.toFixed(10))}
          >
            MAX
          </button>
        </div>
        {inputAmount > 0 && (
          <div className="input-usd-value">~${inputValueUSD.toFixed(4)} USD</div>
        )}
      </div>

      <div className="modal-info">
        <div className="info-row">
          <span>Collateral</span>
          <span>${collateralUSD.toFixed(2)}</span>
        </div>
        <div className="info-row">
          <span>Weighted Collateral (LTV)</span>
          <span>${weightedCollateralUSD.toFixed(2)}</span>
        </div>
        <div className="info-row">
          <span>Current Borrows</span>
          <span>${borrowedUSD.toFixed(2)}</span>
        </div>
        {inputAmount > 0 && (
          <div className="info-row">
            <span>After Borrow</span>
            <span style={{ color: '#ff9800' }}>${projectedBorrowedUSD.toFixed(2)}</span>
          </div>
        )}
        <div className="info-row" style={{ borderTop: '1px solid #30363d', paddingTop: 8, marginTop: 4 }}>
          <span>{cfg.symbol} Price</span>
          <span>${price.toFixed(4)}</span>
        </div>
        <div className="info-row">
          <span>Pool Liquidity</span>
          <span>{poolLiquidity.toFixed(4)} {cfg.symbol}</span>
        </div>
      </div>

      <div className="modal-field">
        <label className="modal-label">Health Factor</label>
        <div className="health-factor-display">
          <div className="hf-current">
            <span className="hf-label">Current</span>
            <span className="hf-value" style={{ color: hfColor(currentHF) }}>
              {currentHF !== null ? currentHF.toFixed(2) : '∞'}
            </span>
          </div>
          {inputAmount > 0 && (
            <>
              <span className="hf-arrow">→</span>
              <div className="hf-projected">
                <span className="hf-label">After Borrow</span>
                <span className="hf-value" style={{ color: hfColor(projectedHF) }}>
                  {projectedHF !== null ? projectedHF.toFixed(2) : '∞'}
                </span>
              </div>
            </>
          )}
        </div>
        {projectedHF !== null && projectedHF < 1.0 && (
          <div className="hf-warning">Position would be liquidatable (HF &lt; 1.0)</div>
        )}
        {projectedHF !== null && projectedHF >= 1.0 && projectedHF < 1.5 && (
          <div className="hf-caution">Low health factor — risk of liquidation</div>
        )}
      </div>

      {inputAmount > 0 && inputAmount > poolLiquidity && (
        <div className="hf-warning">Insufficient pool liquidity ({poolLiquidity.toFixed(4)} {cfg.symbol} available)</div>
      )}
      {inputAmount > 0 && inputAmount > maxBorrowByCollateral && (
        <div className="hf-warning">Exceeds collateral capacity ({maxBorrowByCollateral.toFixed(4)} {cfg.symbol} max)</div>
      )}

      {error && <div className="modal-error">{error}</div>}

      <button
        onClick={handleSubmit}
        disabled={
          submitting ||
          preloading ||
          !amount ||
          inputAmount <= 0 ||
          inputAmount > maxBorrowByCollateral ||
          inputAmount > poolLiquidity ||
          (projectedHF !== null && projectedHF < 1.0) ||
          !position.poolCid ||
          !position.userPositionCid ||
          !reserveCid ||
          position.depositPositions.length === 0
        }
        className="btn-action btn-borrow"
      >
        {preloading ? 'Loading...' : submitting ? <><span className="btn-spinner" />Borrowing...</> : `Borrow ${amount || '0'} ${cfg.symbol}`}
      </button>
    </ActionModal>
  );
}
