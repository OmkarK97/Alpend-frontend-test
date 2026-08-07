import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildSupplyTSWithPositionCommand } from '../commands/deposit';
import { poolCidFromDisclosed, fetchLiveCids, withEphemeralRetry } from '../utils/transferContext';
import { fmtBalance } from '../utils/format';
import { HealthFactorPreview } from './HealthFactorPreview';
import { ASSETS, type AssetKey } from '../assets';
import type { SubmitTxOptions } from '../hooks/useLoop';

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

export function SupplyModal({ asset, partyId, position, submitTx, onClose }: Props) {
  const cfg = ASSETS[asset];
  const [amount, setAmount] = useState('');
  const [enableAsCollateral, setEnableAsCollateral] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [updateId, setUpdateId] = useState('');

  const maxAmount = cfg.walletBalance(position);
  const holdings = cfg.holdings(position);
  const reserveCid = cfg.reserveCid(position);

  // Post-supply health-factor projection (supplying collateral raises HF).
  const info = position.assetInfo[cfg.instrumentId] || { price: 0, ltv: 0, liqThreshold: 0 };
  const borrowedUSD = parseFloat(position.totalBorrowed);
  const liqThreshUSD = parseFloat(position.totalLiqThresholdCollateralUSD);
  const inputAmount = parseFloat(amount) || 0;
  const currentHF = borrowedUSD > 0 ? liqThreshUSD / borrowedUSD : null;
  const projectedHF = borrowedUSD > 0
    ? (liqThreshUSD + (enableAsCollateral ? inputAmount * info.price * info.liqThreshold : 0)) / borrowedUSD
    : null;

  const handleSubmit = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    setSubmitting(true);
    setError('');

    // Assemble + submit. Re-fetches the wallet's holdings via Loop each call so an
    // ephemeral-CC retry uses the CURRENT holding CIDs (CC re-issues on round boundaries,
    // including during wallet-signing latency → stale CID → CONTRACT_NOT_FOUND).
    const doSupply = async () => {
      const fresh = await position.getFreshHoldings();
      const freshList = fresh ? (cfg.isEphemeral ? fresh.cc : fresh.usdcx) : holdings;
      const holdingCids = freshList.map((h) => h.contractId);

      const missingCids: string[] = [];
      if (!position.poolCid) missingCids.push('poolCid');
      if (!reserveCid) missingCids.push(`${cfg.symbol} reserve`);
      if (!position.userPositionCid) missingCids.push('userPositionCid');
      if (holdingCids.length === 0 || holdingCids.some((c) => !c))
        missingCids.push(`${cfg.symbol} holdings`);
      if (missingCids.length > 0) {
        throw new Error(`Missing contract IDs: ${missingCids.join(', ')}. Try refreshing.`);
      }

      const ctx = await cfg.fetchUserSendContext(partyId, amount, holdingCids);

      if (!ctx.transferFactoryCid) {
        throw new Error(`${cfg.symbol} TransferFactory contract ID not found. Check server logs.`);
      }

      const effectiveDisclosed = ctx.disclosedContracts
        .filter((dc) => dc.contractId && dc.createdEventBlob)
        .map((dc) => ({
          templateId: dc.templateId || '',
          contractId: dc.contractId,
          createdEventBlob: dc.createdEventBlob,
          domainId: dc.domainId || dc.synchronizerId || '',
        }));

      // Re-resolve current CIDs (reserve/user-position churn between refreshes).
      const live = await fetchLiveCids(partyId);

      const cmd = buildSupplyTSWithPositionCommand(
        {
          poolCid: poolCidFromDisclosed(effectiveDisclosed, live.poolCid || position.poolCid),
          supplier: partyId,
          supplyAmount: amount,
          holdingCids,
          transferFactoryCid: ctx.transferFactoryCid,
          assetReserveCid: live.reservesByInstrument[cfg.instrumentId] || reserveCid,
          userPositionCid: live.userPositionCid || position.userPositionCid,
          // TN-13: the DAR gates new supply on the caller's PoolAccess grant.
          poolAccessCid: live.poolAccessCid,
          enableAsCollateral,
          // Position unification: if a deposit for this asset already exists, merge into it
          // (DAR realizes its accrued value + adds this supply → one position, not a duplicate).
          existingDepositCid:
            live.depositsByInstrument[cfg.instrumentId] || cfg.depositPosition(position)?.cid || null,
          choiceContext: ctx.choiceContext,
          reason: `${cfg.symbol} Supply`,
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      return submitTx('SupplyTSWithPosition', cmd, `Supply ${amount} ${cfg.symbol}`, {
        estimateTraffic: false,
      });
    };

    try {
      const result = await withEphemeralRetry(cfg.isEphemeral, doSupply);

      const r = result as Record<string, unknown>;
      const txUpdateId = r?._extractedUpdateId as string | undefined;
      setUpdateId(txUpdateId || '');
      setSuccessMessage(`Supplied ${amount} ${cfg.symbol}`);
      await position.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionModal title={`Supply ${cfg.symbol}`} onClose={onClose} successMessage={successMessage} updateId={updateId}>
      <div className="modal-field">
        <label className="modal-label">Available Balance</label>
        <div className="modal-balance">{fmtBalance(maxAmount)} {cfg.symbol}</div>
      </div>

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
            onClick={() => setAmount(maxAmount)}
          >
            MAX
          </button>
        </div>
      </div>

      <div className="modal-field">
        <label className="modal-checkbox-label">
          <input
            type="checkbox"
            checked={enableAsCollateral}
            onChange={(e) => setEnableAsCollateral(e.target.checked)}
          />
          Use as collateral
        </label>
      </div>

      {borrowedUSD > 0 && (
        <HealthFactorPreview current={currentHF} projected={projectedHF} showProjected={inputAmount > 0} />
      )}

      {error && <div className="modal-error">{error}</div>}

      <button
        onClick={handleSubmit}
        disabled={
          submitting ||
          !amount ||
          parseFloat(amount) <= 0 ||
          !position.poolCid ||
          !reserveCid ||
          !position.userPositionCid ||
          holdings.length === 0
        }
        className="btn-action btn-supply"
      >
        {submitting ? <><span className="btn-spinner" />Supplying...</> : `Supply ${amount || '0'} ${cfg.symbol}`}
      </button>
    </ActionModal>
  );
}
