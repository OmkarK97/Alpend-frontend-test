import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData } from '../types';
import { buildWithdrawTSWithPositionCommand } from '../commands/withdraw';
import { ASSETS, type AssetKey } from '../assets';
import { fetchPoolHoldings, poolCidFromDisclosed } from '../utils/transferContext';
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

  const handleSubmit = async () => {
    if (!fullWithdraw && (!amount || parseFloat(amount) <= 0)) return;
    setSubmitting(true);
    setError('');

    try {
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
          poolCid: poolCidFromDisclosed(effectiveDisclosed, position.poolCid),
          supplier: partyId,
          depositPositionCid: selectedDeposit?.cid || '',
          assetReserveCid: cfg.reserveCid(position),
          transferFactoryCid: ctx.transferFactoryCid,
          userPositionCid: position.userPositionCid,
          // Other reserves backing the user's collateral so the DAR's on-chain HF
          // counts the full basket.
          accountReserveCids: cfg.otherReserveCids(position),
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

      const result = await submitTx(
        'WithdrawTSWithPosition',
        cmd,
        fullWithdraw ? `Full ${cfg.symbol} withdrawal` : `Withdraw ${amount} ${cfg.symbol}`,
        { estimateTraffic: false }
      );

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
        <div className="modal-balance">{supplied.toFixed(4)} {cfg.symbol}</div>
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
