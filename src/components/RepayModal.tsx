import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildRepayTSWithPositionCommand } from '../commands/repay';
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

  const handleSubmit = async () => {
    if (!fullRepay && (!amount || parseFloat(amount) <= 0)) return;
    setSubmitting(true);
    setError('');

    try {
      const holdingCids = holdings.map((h) => h.contractId);

      const ctx = await cfg.fetchUserSendContext(
        partyId,
        fullRepay ? cfg.borrowedAmount(position) : amount,
        holdingCids
      );

      const effectiveDisclosed = ctx.disclosedContracts.map((dc) => ({
        templateId: dc.templateId || '',
        contractId: dc.contractId,
        createdEventBlob: dc.createdEventBlob,
        domainId: dc.domainId || dc.synchronizerId || '',
      }));

      const cmd = buildRepayTSWithPositionCommand(
        {
          poolCid: position.poolCid,
          borrower: partyId,
          borrowPositionCid: borrowPos?.cid || '',
          repaymentHoldingCids: holdingCids,
          assetReserveCid: cfg.reserveCid(position),
          transferFactoryCid: ctx.transferFactoryCid,
          userPositionCid: position.userPositionCid,
          repayAmount: fullRepay ? null : amount,
          choiceContext: ctx.choiceContext,
          reason: `${cfg.symbol} Repay`,
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      const result = await submitTx(
        'RepayTSWithPosition',
        cmd,
        fullRepay ? `Full ${cfg.symbol} repayment` : `Repay ${amount} ${cfg.symbol}`,
        { estimateTraffic: false }
      );

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
        <div className="modal-balance">{borrowed.toFixed(4)} {cfg.symbol}</div>
      </div>

      <div className="modal-field">
        <label className="modal-label">Wallet Balance</label>
        <div className="modal-balance-sm">{walletBal.toFixed(4)} {cfg.symbol}</div>
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
