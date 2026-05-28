import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData, DisclosedContract } from '../types';
import { buildWithdrawTSWithPositionCommand } from '../commands/withdraw';
import { fetchTransferContext } from '../utils/transferContext';
import type { SubmitTxOptions } from '../hooks/useLoop';
import { ADMIN_API_URL, POOL_OPERATOR } from '../config';

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

export function WithdrawModal({
  partyId,
  position,
  submitTx,
  onClose,
}: Props) {
  const [amount, setAmount] = useState('');
  const [fullWithdraw, setFullWithdraw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [updateId, setUpdateId] = useState('');

  const supplied = parseFloat(position.totalSupplied);
  const selectedDeposit = position.depositPositions[0];
  const depositPrincipal = selectedDeposit ? parseFloat(selectedDeposit.principal) : 0;

  const handleSubmit = async () => {
    if (!fullWithdraw && (!amount || parseFloat(amount) <= 0)) return;
    setSubmitting(true);
    setError('');

    try {
      // For withdraw: pool is sender, user is receiver
      const holdingResp = await fetch(`${ADMIN_API_URL}/admin/usdcx-holdings/${encodeURIComponent(POOL_OPERATOR)}`).then(r => r.json());
      const poolHoldings = holdingResp.holdings || [];
      const poolHoldingCids = poolHoldings.map((h: { contractId: string }) => h.contractId);

      const ctx = await fetchTransferContext(
        POOL_OPERATOR,
        fullWithdraw ? position.totalSupplied : amount,
        poolHoldingCids.length > 0 ? poolHoldingCids : ['placeholder'],
        partyId
      );

      // Include pool operator's holdings as disclosed contracts
      const holdingDisclosed: DisclosedContract[] = poolHoldings
        .filter((h: { contractId: string; createdEventBlob?: string }) => h.contractId && h.createdEventBlob)
        .map((h: { contractId: string; createdEventBlob: string; templateId?: string; domainId?: string }) => ({
          templateId: h.templateId || '',
          contractId: h.contractId,
          createdEventBlob: h.createdEventBlob,
          domainId: h.domainId || '',
        }));

      const allDisclosed = [
        ...ctx.disclosedContracts.map((dc) => ({
          templateId: dc.templateId || '',
          contractId: dc.contractId,
          createdEventBlob: dc.createdEventBlob,
          domainId: dc.domainId || dc.synchronizerId || '',
        })),
        ...holdingDisclosed,
      ];
      // Deduplicate
      const seen = new Set<string>();
      const effectiveDisclosed = allDisclosed.filter(dc => {
        if (seen.has(dc.contractId)) return false;
        seen.add(dc.contractId);
        return true;
      });

      const cmd = buildWithdrawTSWithPositionCommand(
        {
          poolCid: position.poolCid,
          supplier: partyId,
          depositPositionCid: position.depositPositions[0]?.cid || '',
          assetReserveCid: position.assetReserveCid,
          transferFactoryCid: ctx.transferFactoryCid,
          userPositionCid: position.userPositionCid,
          withdrawAmount: fullWithdraw ? null : amount,
          choiceContext: ctx.choiceContext,
          reason: 'Withdraw',
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      const result = await submitTx(
        'WithdrawTSWithPosition',
        cmd,
        fullWithdraw ? 'Full withdrawal' : `Withdraw ${amount} USDCx`,
        { estimateTraffic: false }
      );

      const r = result as Record<string, unknown>;
      const txUpdateId = r?._extractedUpdateId as string | undefined;
      setUpdateId(txUpdateId || '');
      setSuccessMessage(fullWithdraw ? 'Full withdrawal completed' : `Withdrew ${amount} USDCx`);
      await position.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ActionModal title="Withdraw USDCx" onClose={onClose} successMessage={successMessage} updateId={updateId}>
      <div className="modal-field">
        <label className="modal-label">Currently Supplied</label>
        <div className="modal-balance">{supplied.toFixed(4)} USDCx</div>
      </div>

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
              onClick={() => setAmount(depositPrincipal.toFixed(10))}
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
          position.depositPositions.length === 0 ||
          (!fullWithdraw && (!amount || parseFloat(amount) <= 0))
        }
        className="btn-action btn-withdraw"
      >
        {submitting
          ? <><span className="btn-spinner" />Withdrawing...</>
          : fullWithdraw
            ? 'Withdraw All'
            : `Withdraw ${amount || '0'} USDCx`}
      </button>
    </ActionModal>
  );
}
