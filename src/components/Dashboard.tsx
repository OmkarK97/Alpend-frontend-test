import { useState, useEffect } from 'react';
import type { LoopProvider, TransactionPayload } from '../loop/provider';
import type { PositionData, TransactionLog as TxLog, DepositPosition } from '../types';
import type { SubmitTxOptions } from '../hooks/useLoop';
import { buildInitializeUserPositionCommand } from '../commands/pool';
import { buildEnableCollateralCommand, buildDisableCollateralCommand } from '../commands/collateral';
import { fetchPoolDisclosedContracts, fetchLiveCids, poolCidFromDisclosed } from '../utils/transferContext';
import { fmtBalance, fmtUsd } from '../utils/format';
import { ADMIN_API_URL } from '../config';
import { DashboardSkeleton } from './DashboardSkeleton';
import { MigrationBanner } from './MigrationBanner';
import { SupplyModal } from './SupplyModal';
import { BorrowModal } from './BorrowModal';
import { WithdrawModal } from './WithdrawModal';
import { RepayModal } from './RepayModal';

type ModalType =
  | 'supply'
  | 'borrow'
  | 'withdraw'
  | 'repay'
  | 'cc-supply'
  | 'cc-withdraw'
  | 'cc-borrow'
  | 'cc-repay'
  | null;

interface Props {
  partyId: string;
  provider: LoopProvider | null;
  position: PositionData;
  submitTx: (
    operation: string,
    payload: TransactionPayload,
    message: string,
    options?: SubmitTxOptions
  ) => Promise<unknown>;
  addLog: (
    operation: string,
    status: 'pending' | 'success' | 'error',
    message: string,
    details?: unknown
  ) => void;
  logs: TxLog[];
}

// Dust-safe: a real-but-tiny value must never render as "$0.00" (e.g. 0.1 CC at $0.01 = $0.001).
function formatUSD(value: string): string {
  const num = parseFloat(value);
  if (isNaN(num)) return '$0.00';
  return fmtUsd(num);
}

export function Dashboard({
  partyId,
  provider,
  position,
  submitTx,
  addLog,
}: Props) {
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [initLoading, setInitLoading] = useState(false);
  const [grantLoading, setGrantLoading] = useState(false);
  // NEW-03 diagnostic: an UNUSED PoolAccess token while this wallet ALREADY holds a registry.
  // The DAR cannot detect this (no keys, no ACS query in a choice — see the PoolAccess template),
  // so surfacing it in the UI is the only place a user would ever see it.
  const [spareAccessCid, setSpareAccessCid] = useState<string | null>(null);
  const [dupBusy, setDupBusy] = useState(false);
  // Optimistic: GrantPoolAccess is nonconsuming and mints a token the user cannot see until
  // they hold it, so we track "granted this session" rather than re-querying the ledger.
  const [hasAccess, setHasAccess] = useState(false);
  const [togglingCid, setTogglingCid] = useState<string | null>(null);



  // Enable/disable a supply position as collateral. No token transfer; DisableCollateral
  // re-checks HF >= 1 on-chain (so it needs the OTHER reserves for the basket).
  const handleToggleCollateral = async (dep: DepositPosition) => {
    setTogglingCid(dep.cid);
    try {
      const [live, disclosed] = await Promise.all([
        fetchLiveCids(partyId),
        fetchPoolDisclosedContracts(partyId),
      ]);
      const instr = dep.instrumentId.id;
      const poolCid = poolCidFromDisclosed(disclosed, live.poolCid || position.poolCid);
      const assetReserveCid = live.reservesByInstrument[instr];
      const userPositionCid = live.userPositionCid || position.userPositionCid;
      if (!poolCid || !assetReserveCid || !userPositionCid) {
        throw new Error('Missing pool/reserve/user-position CID. Try refreshing.');
      }
      if (dep.isUsedAsCollateral) {
        const accountReserveCids = Object.entries(live.reservesByInstrument)
          .filter(([id]) => id !== instr)
          .map(([, cid]) => cid);
        const cmd = buildDisableCollateralCommand(
          { supplier: partyId, poolCid, depositPositionCid: dep.cid, assetReserveCid, userPositionCid, accountReserveCids, featuredAppRightCid: null },
          disclosed
        );
        await submitTx('DisableCollateral', cmd, `Disable ${instr} collateral`, { estimateTraffic: false });
      } else {
        const cmd = buildEnableCollateralCommand(
          { supplier: partyId, poolCid, depositPositionCid: dep.cid, assetReserveCid, userPositionCid, featuredAppRightCid: null },
          disclosed
        );
        await submitTx('EnableCollateral', cmd, `Enable ${instr} collateral`, { estimateTraffic: false });
      }
      await position.refresh();
    } catch (err) {
      addLog('ToggleCollateral', 'error', `Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setTogglingCid(null);
    }
  };

  useEffect(() => {
    if (!partyId || !position.hasUserPosition) { setSpareAccessCid(null); return; }
    fetch(`${ADMIN_API_URL}/user/pool-access/${encodeURIComponent(partyId)}`)
      .then((r) => r.json())
      .then((d) => setSpareAccessCid(d.registryInitialized === false ? d.poolAccessCid : null))
      .catch(() => setSpareAccessCid(null));
  }, [partyId, position.hasUserPosition]);

  /** TEST ONLY: spend the spare token on InitializeUserPosition to prove whether a second
   *  registry can be created. Destructive — a wallet with two registries cannot be repaired,
   *  because UserPosition has no archive choice (TN-03). */
  const handleDuplicateInit = async () => {
    if (!spareAccessCid) return;
    if (!window.confirm(
      'TEST: spend the spare PoolAccess token on InitializeUserPosition?\n\n' +
      'If this succeeds you will hold TWO registries. That state is PERMANENT — UserPosition has ' +
      'no archive choice — so this wallet becomes unusable for further testing.'
    )) return;
    setDupBusy(true);
    try {
      const disclosed = await fetchPoolDisclosedContracts(partyId);
      const cmd = buildInitializeUserPositionCommand(position.poolCid, partyId, spareAccessCid, disclosed);
      await submitTx('InitializeUserPosition', cmd, 'NEW-03 test: second registry', { estimateTraffic: false });
      addLog('InitializeUserPosition', 'success', 'Second registry CREATED — NEW-03 hazard is real; only the backend guard prevents it.');
      await position.refresh();
    } catch (err) {
      addLog('InitializeUserPosition', 'error', `Rejected: ${err instanceof Error ? err.message : err}`);
    } finally {
      setDupBusy(false);
    }
  };

  const netWorth =
    parseFloat(position.totalSupplied) - parseFloat(position.totalBorrowed);

  /** Ask the backend to onboard this wallet: maintenanceOperator exercises GrantPoolAccess,
   *  which mints the per-user PoolAccess token that InitializeUserPosition then consumes.
   *  Runs server-side because the choice is controlled by maintenanceOperator, not the user —
   *  it's a hot key, so no multisig ceremony is involved and no funds can move. */
  const handleGrantAccess = async () => {
    setGrantLoading(true);
    try {
      const resp = await fetch(`${ADMIN_API_URL}/user/grant-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: partyId }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'grant failed');
      addLog(
        'GrantPoolAccess',
        'success',
        `Access granted by ${String(data.grantedBy).slice(0, 28)}… — ${data.next}`
      );
      setHasAccess(true);
      await position.refresh();
    } catch (err) {
      addLog('GrantPoolAccess', 'error', `Failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setGrantLoading(false);
    }
  };

  const handleInitPosition = async () => {
    setInitLoading(true);
    try {
      // The one-shot PoolAccess token minted by Grant Access. Fetch it live rather than
      // relying on session state — the grant may have happened in an earlier session.
      const accResp = await fetch(
        `${ADMIN_API_URL}/user/pool-access/${encodeURIComponent(partyId)}`
      );
      const acc = await accResp.json();
      if (!acc.poolAccessCid) {
        throw new Error(acc.hint || 'No PoolAccess token — run Grant Access first.');
      }
      const disclosed = await fetchPoolDisclosedContracts(partyId);
      const cmd = buildInitializeUserPositionCommand(
        position.poolCid,
        partyId,
        acc.poolAccessCid,
        disclosed
      );
      await submitTx(
        'InitializeUserPosition',
        cmd,
        'Initialize user position',
        { estimateTraffic: false }
      );
      await position.refresh();
    } catch (err) {
      addLog(
        'InitializeUserPosition',
        'error',
        `Failed: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      setInitLoading(false);
    }
  };

  if (position.loading) {
    return (
      <DashboardSkeleton />
    );
  }

  if (position.error) {
    return (
      <div className="dashboard-error">
        <p>Failed to load positions: {position.error}</p>
        <button onClick={position.refresh} className="btn-retry">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      {/* Position Summary Cards */}
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">Total Supplied</span>
          <span className="stat-value stat-supplied">
            {formatUSD(position.totalSupplied)}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Total Borrowed</span>
          <span className="stat-value stat-borrowed">
            {formatUSD(position.totalBorrowed)}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Net Worth</span>
          <span className="stat-value">{formatUSD(netWorth.toString())}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Health Factor</span>
          <span
            className={`stat-value ${
              position.healthFactor
                ? parseFloat(position.healthFactor) >= 2
                  ? 'health-good'
                  : parseFloat(position.healthFactor) >= 1.5
                    ? 'health-warning'
                    : 'health-danger'
                : ''
            }`}
          >
            {position.healthFactor || '--'}
          </span>
        </div>
      </div>

      {/* Migration prompt — shows if the operator prepared a snapshot for this wallet */}
      <MigrationBanner
        partyId={partyId}
        submitTx={submitTx}
        onDone={position.refresh}
        addLog={addLog}
      />


      {spareAccessCid && (
        <div className="init-banner" style={{ borderColor: '#b45309' }}>
          <div className="init-banner-content">
            <h3>⚠ Unused pool-access token (NEW-03)</h3>
            <p>
              This wallet already has a position registry, yet an unused PoolAccess token is still
              outstanding. Spending it would create a SECOND registry — the DAR cannot prevent this
              (no contract keys, and a choice cannot query the ACS), so the operator must revoke it.
            </p>
          </div>
          <button onClick={handleDuplicateInit} disabled={dupBusy} className="btn-action btn-init">
            {dupBusy ? 'Testing…' : 'Test: spend spare token'}
          </button>
        </div>
      )}

      {/* Initialize Position Banner (hidden while a migration is pending is a future nicety) */}
      {!position.hasUserPosition && position.poolCid && (
        <div className="init-banner">
          <div className="init-banner-content">
            <h3>Get Started</h3>
            <p>
              Initialize your lending position to start supplying and borrowing.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={handleGrantAccess}
              disabled={grantLoading || hasAccess}
              className="btn-action btn-init"
              title="maintenanceOperator mints your PoolAccess token (step 1 of 2)"
            >
              {grantLoading ? 'Granting...' : hasAccess ? '✓ Access Granted' : '1 · Grant Access'}
            </button>
            <button
              onClick={handleInitPosition}
              disabled={initLoading}
              className="btn-action btn-init"
              title="Consumes the PoolAccess token and creates your UserPosition (step 2 of 2)"
            >
              {initLoading ? 'Initializing...' : '2 · Initialize Position'}
            </button>
          </div>
        </div>
      )}

      {/* Asset Table */}
      <div className="asset-section">
        <div className="section-header">
          <h2>Markets</h2>
          <button
            onClick={position.refresh}
            className="btn-refresh"
            title="Refresh"
          >
            Refresh
          </button>
        </div>

        <div className="asset-table">
          <div className="asset-table-header">
            <span>Asset</span>
            <span>Wallet Balance</span>
            <span>Supplied</span>
            <span>Borrowed</span>
            <span>Actions</span>
          </div>

          <div className="asset-row">
            <div className="asset-name">
              <div className="asset-icon">U</div>
              <div>
                <div className="asset-title">USDCx</div>
                <div className="asset-subtitle">USD Coin</div>
              </div>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {position.holdingsLoading
                  ? <span className="skeleton skeleton-text" style={{ width: '4rem' }} />
                  : fmtBalance(position.walletBalance)}
              </span>
              <span className="cell-label">USDCx</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {fmtBalance(position.usdcxSupplied)}
              </span>
              <span className="cell-label">USDCx</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {fmtBalance(position.usdcxBorrowed)}
              </span>
              <span className="cell-label">USDCx</span>
            </div>
            <div className="asset-actions">
              <button
                onClick={() => setActiveModal('supply')}
                disabled={
                  !position.hasUserPosition ||
                  position.usdcxHoldings.length === 0
                }
                className="btn-action-sm btn-supply"
              >
                Supply
              </button>
              <button
                onClick={() => setActiveModal('withdraw')}
                disabled={
                  !position.hasUserPosition ||
                  position.depositPositions.length === 0
                }
                className="btn-action-sm btn-withdraw"
              >
                Withdraw
              </button>
              <button
                onClick={() => setActiveModal('borrow')}
                disabled={
                  !position.hasUserPosition ||
                  position.depositPositions.length === 0
                }
                className="btn-action-sm btn-borrow"
              >
                Borrow
              </button>
              <button
                onClick={() => setActiveModal('repay')}
                disabled={
                  !position.hasUserPosition ||
                  position.borrowPositions.length === 0
                }
                className="btn-action-sm btn-repay"
              >
                Repay
              </button>
            </div>
          </div>

          <div className="asset-row">
            <div className="asset-name">
              <div className="asset-icon asset-icon-cc">C</div>
              <div>
                <div className="asset-title">CC</div>
                <div className="asset-subtitle">Canton Coin</div>
              </div>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {position.holdingsLoading
                  ? <span className="skeleton skeleton-text" style={{ width: '4rem' }} />
                  : fmtBalance(position.ccWalletBalance)}
              </span>
              <span className="cell-label">CC</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {fmtBalance(position.ccSupplied)}
              </span>
              <span className="cell-label">CC</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {fmtBalance(position.ccBorrowed)}
              </span>
              <span className="cell-label">CC</span>
            </div>
            <div className="asset-actions">
              <button
                onClick={() => setActiveModal('cc-supply')}
                disabled={
                  !position.hasUserPosition ||
                  position.ccHoldings.length === 0
                }
                className="btn-action-sm btn-supply"
              >
                Supply
              </button>
              <button
                onClick={() => setActiveModal('cc-withdraw')}
                disabled={
                  !position.hasUserPosition ||
                  parseFloat(position.ccSupplied) <= 0
                }
                className="btn-action-sm btn-withdraw"
              >
                Withdraw
              </button>
              <button
                onClick={() => setActiveModal('cc-borrow')}
                disabled={!position.hasUserPosition}
                className="btn-action-sm btn-borrow"
              >
                Borrow
              </button>
              <button
                onClick={() => setActiveModal('cc-repay')}
                disabled={
                  !position.hasUserPosition ||
                  parseFloat(position.ccBorrowed) <= 0 ||
                  position.ccHoldings.length === 0
                }
                className="btn-action-sm btn-repay"
              >
                Repay
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Positions Detail */}
      {position.depositPositions.length > 0 && (
        <div className="positions-section">
          <h3>Your Supply Positions</h3>
          <div className="positions-list">
            {position.depositPositions.map((dep) => (
              <div key={dep.cid} className="position-card">
                <div className="position-info">
                  <span className="position-asset">{dep.instrumentId.id}</span>
                  <span className="position-amount">
                    {fmtBalance(dep.principal)}
                  </span>
                </div>
                <div className="position-collateral">
                  <span
                    className={`collateral-badge ${dep.isUsedAsCollateral ? 'collateral-on' : 'collateral-off'}`}
                  >
                    {dep.isUsedAsCollateral ? 'Collateral' : 'Not Collateral'}
                  </span>
                  <button
                    className="btn-collateral-toggle"
                    onClick={() => handleToggleCollateral(dep)}
                    disabled={togglingCid !== null}
                  >
                    {togglingCid === dep.cid
                      ? '…'
                      : dep.isUsedAsCollateral
                      ? 'Disable'
                      : 'Enable'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {position.borrowPositions.length > 0 && (
        <div className="positions-section">
          <h3>Your Borrow Positions</h3>
          <div className="positions-list">
            {position.borrowPositions.map((bor) => (
              <div key={bor.cid} className="position-card">
                <div className="position-info">
                  <span className="position-asset">
                    {bor.instrumentId.id}
                  </span>
                  <span className="position-amount">
                    {fmtBalance(bor.principal)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Modals */}
      {activeModal === 'supply' && (
        <SupplyModal
          asset="usdcx"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === 'borrow' && (
        <BorrowModal
          asset="usdcx"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === 'withdraw' && (
        <WithdrawModal
          asset="usdcx"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === 'repay' && (
        <RepayModal
          asset="usdcx"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === 'cc-supply' && (
        <SupplyModal
          asset="cc"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === 'cc-withdraw' && (
        <WithdrawModal
          asset="cc"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === 'cc-borrow' && (
        <BorrowModal
          asset="cc"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === 'cc-repay' && (
        <RepayModal
          asset="cc"
          partyId={partyId}
          position={position}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
    </div>
  );
}
