import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildSupplyTSWithPositionCommand } from '../commands/deposit';
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

  const handleSubmit = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    setSubmitting(true);
    setError('');

    try {
      const holdingCids = holdings.map((h) => h.contractId);

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

      const cmd = buildSupplyTSWithPositionCommand(
        {
          poolCid: position.poolCid,
          supplier: partyId,
          supplyAmount: amount,
          holdingCids,
          transferFactoryCid: ctx.transferFactoryCid,
          assetReserveCid: reserveCid,
          userPositionCid: position.userPositionCid,
          enableAsCollateral,
          existingDepositCid: null,
          choiceContext: ctx.choiceContext,
          reason: `${cfg.symbol} Supply`,
          featuredAppRightCid: null,
        },
        effectiveDisclosed
      );

      const result = await submitTx('SupplyTSWithPosition', cmd, `Supply ${amount} ${cfg.symbol}`, {
        estimateTraffic: false,
      });

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
        <div className="modal-balance">{parseFloat(maxAmount).toFixed(4)} {cfg.symbol}</div>
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
