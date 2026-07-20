import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildWithdrawTSWithPositionCommand } from '../commands/withdraw';
import { ASSETS, type AssetKey } from '../assets';
import { fetchPoolHoldings, poolCidFromDisclosed, fetchLiveCids, withEphemeralRetry } from '../utils/transferContext';
import { fmtBalance } from '../utils/format';
import { HealthFactorPreview } from './HealthFactorPreview';
import type { SubmitTxOptions } from '../hooks/useLoop';
import { POOL_OPERATOR } from '../config';

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

export function WithdrawModal({
  asset,
  partyId,
  position,
  submitTx,
  onClose,
}: Props) {
  const cfg = ASSETS[asset];
  const [amount, setAmount] = useState('');
  const [fullWithdraw, setFullWithdraw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [updateId, setUpdateId] = useState('');

  const supplied = parseFloat(cfg.suppliedAmount(position));
  const selectedDeposit = cfg.depositPosition(position);
  const depositPrincipal = selectedDeposit ? parseFloat(selectedDeposit.principal) : 0;

  // Max SAFE withdrawal — keeps HF >= 1 (mirrors the DAR's auto-max: excess weighted
  // collateral / this asset's ltv / price), capped at the deposit principal. With no debt
  // the whole deposit is withdrawable. Post-withdraw HF drops as collateral leaves.
  const info = position.assetInfo[cfg.instrumentId] || { price: 0, ltv: 0, liqThreshold: 0 };
  const borrowedUSD = parseFloat(position.totalBorrowed);
  const liqThreshUSD = parseFloat(position.totalLiqThresholdCollateralUSD);
  const weightedUSD = parseFloat(position.totalWeightedCollateralUSD);
  const maxSafeWithdraw = borrowedUSD > 0 && info.ltv > 0 && info.price > 0
    ? Math.max(0, Math.min(depositPrincipal, (weightedUSD - borrowedUSD) / info.ltv / info.price))
    : depositPrincipal;
  const effectiveWithdraw = fullWithdraw
    ? (borrowedUSD > 0 ? Math.min(supplied, maxSafeWithdraw) : supplied)
    : parseFloat(amount) || 0;
  const currentHF = borrowedUSD > 0 ? liqThreshUSD / borrowedUSD : null;
  const projectedHF = borrowedUSD > 0
    ? Math.max(0, liqThreshUSD - effectiveWithdraw * info.price * info.liqThreshold) / borrowedUSD
    : null;

  const handleSubmit = async () => {
    if (!fullWithdraw && (!amount || parseFloat(amount) <= 0)) return;
    setSubmitting(true);
    setError('');

    try {
      // Ephemeral-retry: a Canton Coin holding can re-issue between fetching the pool's holdings
      // and the ledger's verdict, surfacing as INACTIVE_CONTRACTS (or CONTRACT_NOT_FOUND). On an
      // ephemeral asset, re-fetch fresh holdings + resubmit once. `doWithdraw` re-fetches each call.
      const doWithdraw = async () => {
      // Re-resolve the current reserve / user-position / deposit CIDs — the cached
      // `position` copy can be stale (reserve CIDs churn on every accrue/action).
      const live = await fetchLiveCids(partyId);
      const reserveCid = live.reservesByInstrument[cfg.instrumentId] || cfg.reserveCid(position);
      const userPositionCid = live.userPositionCid || position.userPositionCid;
      const depositPositionCid = live.depositsByInstrument[cfg.instrumentId] || selectedDeposit?.cid || '';
      const accountReserveCids = Object.entries(live.reservesByInstrument)
        .filter(([id]) => id !== cfg.instrumentId)
        .map(([, cid]) => cid);

      // Withdraw is a pool-as-sender payout: pull the pool operator's current
      // holdings of this asset (they double as transfer inputs + disclosures, and
      // as freshReserveHoldingCids for ephemeral assets).
      const poolHoldings = await fetchPoolHoldings(cfg.poolHoldingsPath(POOL_OPERATOR));

      const ctx = await cfg.fetchPoolSendContext(
        fullWithdraw ? cfg.suppliedAmount(position) : amount,
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
      // Deduplicate
      const seen = new Set<string>();
      const effectiveDisclosed = allDisclosed.filter((dc) => {
        if (seen.has(dc.contractId)) return false;
        seen.add(dc.contractId);
        return true;
      });

      const cmd = buildWithdrawTSWithPositionCommand(
        {
          poolCid: poolCidFromDisclosed(effectiveDisclosed, live.poolCid || position.poolCid),
          supplier: partyId,
          depositPositionCid,
          assetReserveCid: reserveCid,
          transferFactoryCid: ctx.transferFactoryCid,
          userPositionCid,
          // Other reserves backing the user's collateral so the DAR's on-chain HF
          // counts the full basket.
          accountReserveCids,
          // Ephemeral assets (CC) must pass fresh pool holdings covering full
          // reserve liquidity (FIND-025); stable assets (USDCx) use stored holdings.
          freshReserveHoldingCids: cfg.isEphemeral ? poolHoldings.cids : null,
          withdrawAmount: fullWithdraw ? null : amount,
          choiceContext: ctx.choiceContext,
          reason: `${cfg.symbol} Withdraw`,
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      return await submitTx(
        'WithdrawTSWithPosition',
        cmd,
        fullWithdraw ? `Full ${cfg.symbol} withdrawal` : `Withdraw ${amount} ${cfg.symbol}`,
        { estimateTraffic: false }
      );
      };
      const result = await withEphemeralRetry(cfg.isEphemeral, doWithdraw);

      const r = result as Record<string, unknown>;
      const txUpdateId = r?._extractedUpdateId as string | undefined;
      setUpdateId(txUpdateId || '');
      setSuccessMessage(fullWithdraw ? 'Full withdrawal completed' : `Withdrew ${amount} ${cfg.symbol}`);
      await position.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionModal title={`Withdraw ${cfg.symbol}`} onClose={onClose} successMessage={successMessage} updateId={updateId}>
      <div className="modal-field">
        <label className="modal-label">Currently Supplied</label>
        <div className="modal-balance">{fmtBalance(supplied)} {cfg.symbol}</div>
      </div>

      {borrowedUSD > 0 && (
        <div className="modal-field">
          <label className="modal-label">Max Safe Withdrawal (keeps HF ≥ 1)</label>
          <div className="modal-balance-sm">{fmtBalance(maxSafeWithdraw)} {cfg.symbol}</div>
        </div>
      )}

      <div className="modal-field">
        <label className="modal-checkbox-label">
          <input
            type="checkbox"
            checked={fullWithdraw}
            onChange={(e) => setFullWithdraw(e.target.checked)}
          />
          Full Withdrawal
        </label>
      </div>

      {!fullWithdraw && (
        <div className="modal-field">
          <label className="modal-label">Amount</label>
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
              onClick={() => setAmount(maxSafeWithdraw.toFixed(10))}
            >
              MAX
            </button>
          </div>
        </div>
      )}

      {borrowedUSD > 0 && (
        <HealthFactorPreview current={currentHF} projected={projectedHF} showProjected={effectiveWithdraw > 0} />
      )}

      {error && <div className="modal-error">{error}</div>}

      <button
        onClick={handleSubmit}
        disabled={
          submitting ||
          !selectedDeposit ||
          (!fullWithdraw && (!amount || parseFloat(amount) <= 0))
        }
        className="btn-action btn-withdraw"
      >
        {submitting
          ? <><span className="btn-spinner" />Withdrawing...</>
          : fullWithdraw
            ? 'Withdraw All'
            : `Withdraw ${amount || '0'} ${cfg.symbol}`}
      </button>
    </ActionModal>
  );
}
