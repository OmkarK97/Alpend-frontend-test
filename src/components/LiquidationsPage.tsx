import { useState, useEffect, useCallback } from 'react';
import type { TransactionPayload } from '../loop/provider';
import type { PositionData, DisclosedContract } from '../types';
import type { SubmitTxOptions } from '../hooks/useLoop';
import { buildLiquidateTSCommand } from '../commands/liquidate';
import { ASSETS, type AssetKey } from '../assets';
import { fetchPoolHoldings, poolCidFromDisclosed } from '../utils/transferContext';
import { ADMIN_API_URL, POOL_OPERATOR, SYNCHRONIZER_ID, EXPLORER_URL } from '../config';

// One borrow or collateral leg as returned by /admin/liquidatable.
interface Leg {
  cid: string;
  blob: string;
  templateId: string;
  instrumentId: { admin: string; id: string };
  reserveCid: string;
  reserveBlob: string;
  reserveTemplateId: string;
  amount: number;
  valueUSD: number;
  price: number;
  isUsedAsCollateral?: boolean;
  liquidationBonus?: number;
  totalLiquidity?: number;
}

interface Candidate {
  borrower: string;
  userPositionCid: string;
  userPositionBlob: string;
  userPositionTemplateId: string;
  hf: number | null;
  collateralUSD: number;
  borrowedUSD: number;
  borrows: Leg[];
  collaterals: Leg[];
}

interface ScanResult {
  poolCid: string;
  poolBlob: string;
  poolTemplateId: string;
  oracleCid: string;
  oracleBlob: string;
  oracleTemplateId: string;
  candidates: Candidate[];
}

interface Props {
  partyId: string;
  position: PositionData;
  submitTx: (
    operation: string,
    payload: TransactionPayload,
    message: string,
    options?: SubmitTxOptions
  ) => Promise<unknown>;
}

// Ledger instrument id → asset-registry key.
function assetKeyOf(id: string): AssetKey | null {
  if (id === 'USDCx') return 'usdcx';
  if (id === 'Amulet') return 'cc';
  return null;
}

const disc = (contractId: string, blob: string, templateId: string): DisclosedContract => ({
  templateId: templateId || '',
  contractId,
  createdEventBlob: blob,
  domainId: SYNCHRONIZER_ID,
});

export function LiquidationsPage({ partyId, position, submitTx }: Props) {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [updateId, setUpdateId] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetch(`${ADMIN_API_URL}/admin/liquidatable`).then((r) => r.json());
      if (!data.success) throw new Error(data.error || 'scan failed');
      setScan(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleLiquidate = async (c: Candidate) => {
    setError('');
    setSuccess('');
    setUpdateId('');
    if (!scan) return;

    // Auto-pick: largest debt, largest enabled collateral.
    const debt = [...c.borrows].sort((a, b) => b.valueUSD - a.valueUSD)[0];
    const collateral = [...c.collaterals]
      .filter((x) => x.isUsedAsCollateral)
      .sort((a, b) => b.valueUSD - a.valueUSD)[0];
    if (!debt || !collateral) {
      setError('No debt/collateral leg available to liquidate.');
      return;
    }

    const debtKey = assetKeyOf(debt.instrumentId.id);
    const collKey = assetKeyOf(collateral.instrumentId.id);
    if (!debtKey || !collKey) {
      setError(`Unsupported asset (debt ${debt.instrumentId.id} / collateral ${collateral.instrumentId.id}).`);
      return;
    }

    // Liquidator repays 50% of debt (safe under the close factor; DAR re-asserts),
    // capped by the liquidator's own balance of the debt asset AND by what the borrower's
    // collateral can actually cover — the DAR reverts if the seize exceeds available collateral
    // ("Insufficient collateral to seize"). For an under-collateralised position this cap makes
    // the liquidator seize ALL the collateral and leave residual (bad) debt behind.
    const liqDebtHoldings = debtKey === 'usdcx' ? position.usdcxHoldings : position.ccHoldings;
    const liqDebtBalance = liqDebtHoldings.reduce((s, h) => s + parseFloat(h.amount), 0);
    const bonus = collateral.liquidationBonus || 0;
    // max repay whose seize == all available collateral: seize = repay*debtPrice*(1+bonus)/collPrice
    const maxRepayByCollateral = (collateral.amount * collateral.price) / (debt.price * (1 + bonus));
    const repay = Math.min(debt.amount * 0.5, liqDebtBalance, maxRepayByCollateral);
    if (repay <= 0) {
      setError(`You hold no ${ASSETS[debtKey].symbol} to repay this debt with.`);
      return;
    }
    const repayAmount = repay.toFixed(10);
    const seizeAmount = ((repay * debt.price * (1 + (collateral.liquidationBonus || 0))) / collateral.price).toFixed(10);

    setBusy(c.userPositionCid);
    try {
      // Debt-repay leg: liquidator → pool (liquidator's own holdings).
      const repaymentHoldingCids = liqDebtHoldings.map((h) => h.contractId);
      const debtCtx = await ASSETS[debtKey].fetchUserSendContext(partyId, repayAmount, repaymentHoldingCids);

      // Collateral-seize leg: pool → liquidator (pool's collateral holdings).
      const poolColl = await fetchPoolHoldings(ASSETS[collKey].poolHoldingsPath(POOL_OPERATOR));
      const collCtx = await ASSETS[collKey].fetchPoolSendContext(
        seizeAmount,
        partyId,
        poolColl.cids.length > 0 ? poolColl.cids : ['placeholder']
      );

      // Other reserves backing the borrower's basket (for the on-chain HF recompute).
      const accountReserveCids = [
        ...new Set([...c.borrows, ...c.collaterals].map((l) => l.reserveCid)),
      ].filter((cid) => cid !== debt.reserveCid && cid !== collateral.reserveCid);

      // Assemble disclosed contracts: the borrower's private positions + reserves + oracle +
      // pool (operator-disclosed via the scan) + both transfer contexts + pool collateral holdings.
      const raw: DisclosedContract[] = [
        disc(scan.poolCid, scan.poolBlob, scan.poolTemplateId),
        disc(scan.oracleCid, scan.oracleBlob, scan.oracleTemplateId),
        disc(c.userPositionCid, c.userPositionBlob, c.userPositionTemplateId),
        disc(debt.cid, debt.blob, debt.templateId),
        disc(collateral.cid, collateral.blob, collateral.templateId),
        ...[...c.borrows, ...c.collaterals].map((l) => disc(l.reserveCid, l.reserveBlob, l.reserveTemplateId)),
        ...debtCtx.disclosedContracts.map((d) => ({
          templateId: d.templateId || '',
          contractId: d.contractId,
          createdEventBlob: d.createdEventBlob,
          domainId: d.domainId || d.synchronizerId || SYNCHRONIZER_ID,
        })),
        ...collCtx.disclosedContracts.map((d) => ({
          templateId: d.templateId || '',
          contractId: d.contractId,
          createdEventBlob: d.createdEventBlob,
          domainId: d.domainId || d.synchronizerId || SYNCHRONIZER_ID,
        })),
        ...poolColl.disclosed,
      ].filter((d) => d.contractId && d.createdEventBlob);
      const seen = new Set<string>();
      const disclosed = raw.filter((d) => (seen.has(d.contractId) ? false : (seen.add(d.contractId), true)));

      const cmd = buildLiquidateTSCommand(
        {
          poolCid: poolCidFromDisclosed(disclosed, scan.poolCid),
          liquidator: partyId,
          borrower: c.borrower,
          borrowPositionCid: debt.cid,
          debtAssetReserveCid: debt.reserveCid,
          collateralDepositCid: collateral.cid,
          collateralAssetReserveCid: collateral.reserveCid,
          repaymentHoldingCids,
          repayAmount,
          transferFactoryCid: debtCtx.transferFactoryCid,
          choiceContext: debtCtx.choiceContext,
          collateralTransferFactoryCid: collCtx.transferFactoryCid,
          collateralChoiceContext: collCtx.choiceContext,
          freshCollateralHoldingCids: ASSETS[collKey].isEphemeral ? poolColl.cids : null,
          borrowerPositionCid: c.userPositionCid,
          accountReserveCids,
          featuredAppRightCid: null,
        },
        disclosed
      );

      const result = await submitTx(
        'LiquidateTS',
        cmd,
        `Liquidate ${c.borrower.slice(0, 12)}… (repay ${repay.toFixed(4)} ${ASSETS[debtKey].symbol})`,
        { estimateTraffic: false }
      );
      const r = result as Record<string, unknown>;
      setUpdateId((r?._extractedUpdateId as string) || '');
      setSuccess(
        `Liquidated: repaid ${repay.toFixed(4)} ${ASSETS[debtKey].symbol}, seized ~${parseFloat(seizeAmount).toFixed(4)} ${ASSETS[collKey].symbol}`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="section">
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Liquidations</h2>
        <button onClick={refresh} className="btn-refresh" title="Refresh">Refresh</button>
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>
        Positions with health factor &lt; 1. You (the connected wallet) act as liquidator:
        repay part of the debt from your balance and seize collateral + bonus. HF is re-verified
        on-chain when you sign.
      </p>

      {error && <div className="modal-error">{error}</div>}
      {success && (
        <div style={{ color: '#4caf50', marginBottom: 12 }}>
          {success}
          {updateId && (
            <>
              {' '}
              <a href={`${EXPLORER_URL}/${updateId}`} target="_blank" rel="noopener noreferrer">
                View on Explorer
              </a>
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="muted">Scanning positions…</div>
      ) : !scan || scan.candidates.length === 0 ? (
        <div className="muted">No liquidatable positions (all healthy). 🎉</div>
      ) : (
        <div className="asset-table">
          <div className="asset-table-header">
            <span>Borrower</span>
            <span>Health Factor</span>
            <span>Collateral</span>
            <span>Debt</span>
            <span>Action</span>
          </div>
          {scan.candidates.map((c) => (
            <div className="asset-row" key={c.userPositionCid}>
              <div className="asset-cell"><span className="cell-value">{c.borrower.slice(0, 16)}…</span></div>
              <div className="asset-cell"><span className="cell-value" style={{ color: '#f44336' }}>{c.hf ?? '—'}</span></div>
              <div className="asset-cell"><span className="cell-value">${c.collateralUSD.toFixed(2)}</span></div>
              <div className="asset-cell"><span className="cell-value">${c.borrowedUSD.toFixed(2)}</span></div>
              <div className="asset-actions">
                <button
                  onClick={() => handleLiquidate(c)}
                  disabled={!!busy}
                  className="btn-action-sm btn-repay"
                >
                  {busy === c.userPositionCid ? 'Liquidating…' : 'Liquidate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
