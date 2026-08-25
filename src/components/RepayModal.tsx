import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildRepayTSWithPositionCommand } from '../commands/repay';
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

export function RepayModal({ asset, partyId, position, submitTx, onClose }: Props) {
  const cfg = ASSETS[asset];
  const [amount, setAmount] = useState('');
  const [fullRepay, setFullRepay] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [updateId, setUpdateId] = useState('');

  const borrowed = parseFloat(cfg.borrowedAmount(position));
  const walletBal = parseFloat(cfg.walletBalance(position));
  const holdings = cfg.holdings(position);
  const borrowPos = cfg.borrowPosition(position);

  // Post-repay health-factor projection (repaying debt raises HF).
  const info = position.assetInfo[cfg.instrumentId] || { price: 0, ltv: 0, liqThreshold: 0 };
  const borrowedUSD = parseFloat(position.totalBorrowed);
  const liqThreshUSD = parseFloat(position.totalLiqThresholdCollateralUSD);
  const repayAmt = fullRepay ? borrowed : parseFloat(amount) || 0;
  const newBorrowedUSD = Math.max(0, borrowedUSD - repayAmt * info.price);
  const currentHF = borrowedUSD > 0 ? liqThreshUSD / borrowedUSD : null;
  const projectedHF = newBorrowedUSD > 0 ? liqThreshUSD / newBorrowedUSD : null;

  const handleSubmit = async () => {
    if (!fullRepay && (!amount || parseFloat(amount) <= 0)) return;
    setSubmitting(true);
    setError('');

    // Re-fetches wallet holdings each call so an ephemeral-CC retry uses current holding CIDs
    // (CC re-issues on round boundaries / during wallet-signing → stale CID → CONTRACT_NOT_FOUND).
    const doRepay = async () => {
      const fresh = await position.getFreshHoldings();
      const freshList = fresh ? (cfg.isEphemeral ? fresh.cc : fresh.usdcx) : holdings;
      const holdingCids = freshList.map((h) => h.contractId);

      const ctx = await cfg.fetchUserSendContext(
        partyId,
        fullRepay ? cfg.borrowedAmount(position) : amount,
        holdingCids
      );

      const effectiveDisclosed = ctx.disclosedContracts.map((dc) => ({
        ...(dc.templateId ? { templateId: dc.templateId } : {}),
        contractId: dc.contractId,
        createdEventBlob: dc.createdEventBlob,
        ...(dc.domainId || dc.synchronizerId ? { domainId: dc.domainId || dc.synchronizerId } : {}),
      }));

      // Re-resolve current CIDs (reserve/borrow/user-position churn between refreshes).
      const live = await fetchLiveCids(partyId);

      const cmd = buildRepayTSWithPositionCommand(
        {
          poolCid: poolCidFromDisclosed(effectiveDisclosed, live.poolCid || position.poolCid),
          borrower: partyId,
          borrowPositionCid: live.borrowsByInstrument[cfg.instrumentId] || borrowPos?.cid || '',
          repaymentHoldingCids: holdingCids,
          assetReserveCid: live.reservesByInstrument[cfg.instrumentId] || cfg.reserveCid(position),
          transferFactoryCid: ctx.transferFactoryCid,
          userPositionCid: live.userPositionCid || position.userPositionCid,
          repayAmount: fullRepay ? null : amount,
          choiceContext: ctx.choiceContext,
          reason: `${cfg.symbol} Repay`,
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      return submitTx(
        'RepayTSWithPosition',
        cmd,
        fullRepay ? `Full ${cfg.symbol} repayment` : `Repay ${amount} ${cfg.symbol}`,
        { estimateTraffic: false }
      );
    };

    try {
      const result = await withEphemeralRetry(cfg.isEphemeral, doRepay);

      const r = result as Record<string, unknown>;
      const txUpdateId = r?._extractedUpdateId as string | undefined;
      setUpdateId(txUpdateId || '');
      setSuccessMessage(fullRepay ? 'Full repayment completed' : `Repaid ${amount} ${cfg.symbol}`);
      await position.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionModal title={`Repay ${cfg.symbol}`} onClose={onClose} successMessage={successMessage} updateId={updateId}>
      <div className="modal-field">
        <label className="modal-label">Outstanding Debt</label>
        <div className="modal-balance">{fmtBalance(borrowed)} {cfg.symbol}</div>
      </div>

      <div className="modal-field">
        <label className="modal-label">Wallet Balance</label>
        <div className="modal-balance-sm">{fmtBalance(walletBal)} {cfg.symbol}</div>
      </div>

      <div className="modal-field">
        <label className="modal-checkbox-label">
          <input
            type="checkbox"
            checked={fullRepay}
            onChange={(e) => setFullRepay(e.target.checked)}
          />
          Full Repayment
        </label>
      </div>

      {!fullRepay && (
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
              onClick={() =>
                setAmount(Math.min(borrowed, walletBal).toFixed(10))
              }
            >
              MAX
            </button>
          </div>
        </div>
      )}

      {borrowedUSD > 0 && (
        <HealthFactorPreview current={currentHF} projected={projectedHF} showProjected={repayAmt > 0} />
      )}

      {error && <div className="modal-error">{error}</div>}

      <button
        onClick={handleSubmit}
        disabled={
          submitting ||
          !borrowPos ||
          holdings.length === 0 ||
          (!fullRepay && (!amount || parseFloat(amount) <= 0))
        }
        className="btn-action btn-repay"
      >
        {submitting
          ? <><span className="btn-spinner" />Repaying...</>
          : fullRepay
            ? 'Repay All'
            : `Repay ${amount || '0'} ${cfg.symbol}`}
      </button>
    </ActionModal>
  );
}
