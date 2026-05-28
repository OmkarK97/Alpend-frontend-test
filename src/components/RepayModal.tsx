import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildRepayTSWithPositionCommand } from '../commands/repay';
import { fetchTransferContext } from '../utils/transferContext';
import type { SubmitTxOptions } from '../hooks/useLoop';

interface Props {
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

export function RepayModal({ partyId, position, submitTx, onClose }: Props) {
  const [amount, setAmount] = useState('');
  const [fullRepay, setFullRepay] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [updateId, setUpdateId] = useState('');

  const borrowed = parseFloat(position.totalBorrowed);
  const walletBal = parseFloat(position.walletBalance);

  const handleSubmit = async () => {
    console.log('[RepayModal] handleSubmit called, fullRepay:', fullRepay, 'amount:', amount);
    if (!fullRepay && (!amount || parseFloat(amount) <= 0)) {
      console.log('[RepayModal] early return: no amount');
      return;
    }
    setSubmitting(true);
    setError('');

    try {
      const holdingCids = position.usdcxHoldings.map((h) => h.contractId);
      console.log('[RepayModal] holdingCids:', holdingCids.length);

      const ctx = await fetchTransferContext(
        partyId,
        fullRepay ? position.totalBorrowed : amount,
        holdingCids
      );
      console.log('[RepayModal] transferContext fetched, transferFactoryCid:', ctx.transferFactoryCid?.substring(0, 30));

      const effectiveDisclosed = ctx.disclosedContracts.map((dc) => ({
        templateId: dc.templateId || '',
        contractId: dc.contractId,
        createdEventBlob: dc.createdEventBlob,
        domainId: dc.domainId || dc.synchronizerId || '',
      }));

      const borrowPos = position.borrowPositions[0];
      console.log('[RepayModal] borrowPos:', borrowPos?.cid?.substring(0, 30), 'principal:', borrowPos?.principal);

      const cmd = buildRepayTSWithPositionCommand(
        {
          poolCid: position.poolCid,
          borrower: partyId,
          borrowPositionCid: borrowPos?.cid || '',
          repaymentHoldingCids: holdingCids,
          assetReserveCid: position.assetReserveCid,
          transferFactoryCid: ctx.transferFactoryCid,
          userPositionCid: position.userPositionCid,
          repayAmount: fullRepay ? null : amount,
          choiceContext: ctx.choiceContext,
          reason: 'Repay',
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      console.log('[RepayModal] calling submitTx...');
      const result = await submitTx(
        'RepayTSWithPosition',
        cmd,
        fullRepay ? 'Full repayment' : `Repay ${amount} USDCx`,
        { estimateTraffic: false }
      );
      console.log('[RepayModal] submitTx returned:', JSON.stringify(result));

      const r = result as Record<string, unknown>;
      const txUpdateId = r?._extractedUpdateId as string | undefined;
      console.log('[RepayModal] extracted updateId:', txUpdateId);
      setUpdateId(txUpdateId || '');
      setSuccessMessage(fullRepay ? 'Full repayment completed' : `Repaid ${amount} USDCx`);
      console.log('[RepayModal] SUCCESS - set successMessage');
      await position.refresh();
      console.log('[RepayModal] position refreshed');
    } catch (err) {
      console.log('[RepayModal] CATCH error:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      console.log('[RepayModal] FINALLY - setting submitting=false');
      setSubmitting(false);
    }
  };

  return (
    <ActionModal title="Repay USDCx" onClose={onClose} successMessage={successMessage} updateId={updateId}>
      <div className="modal-field">
        <label className="modal-label">Outstanding Debt</label>
        <div className="modal-balance">{borrowed.toFixed(4)} USDCx</div>
      </div>

      <div className="modal-field">
        <label className="modal-label">Wallet Balance</label>
        <div className="modal-balance-sm">{walletBal.toFixed(4)} USDCx</div>
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
          position.borrowPositions.length === 0 ||
          position.usdcxHoldings.length === 0 ||
          (!fullRepay && (!amount || parseFloat(amount) <= 0))
        }
        className="btn-action btn-repay"
      >
        {submitting
          ? <><span className="btn-spinner" />Repaying...</>
          : fullRepay
            ? 'Repay All'
            : `Repay ${amount || '0'} USDCx`}
      </button>
    </ActionModal>
  );
}
