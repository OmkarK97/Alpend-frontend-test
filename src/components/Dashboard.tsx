import { useState } from 'react';
import type { LoopProvider, TransactionPayload } from '../loop/provider';
import type { PositionData, TransactionLog as TxLog } from '../types';
import type { SubmitTxOptions } from '../hooks/useLoop';
import { buildInitializeUserPositionCommand } from '../commands/pool';
import { fetchPoolDisclosedContracts } from '../utils/transferContext';
import { SupplyModal } from './SupplyModal';
import { BorrowModal } from './BorrowModal';
import { WithdrawModal } from './WithdrawModal';
import { RepayModal } from './RepayModal';
import { OpenVaultModal } from './OpenVaultModal';

type ModalType =
  | 'supply'
  | 'borrow'
  | 'withdraw'
  | 'repay'
  | 'cc-supply'
  | 'open-vault'
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

function formatUSD(value: string): string {
  const num = parseFloat(value);
  if (isNaN(num)) return '$0.00';
  return `$${num.toFixed(2)}`;
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

  const netWorth =
    parseFloat(position.totalSupplied) - parseFloat(position.totalBorrowed);

  const handleInitPosition = async () => {
    setInitLoading(true);
    try {
      const disclosed = await fetchPoolDisclosedContracts(partyId);
      const cmd = buildInitializeUserPositionCommand(
        position.poolCid,
        partyId,
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
      <div className="dashboard">
        <div className="stat-cards">
          {[0, 1, 2, 3].map((i) => (
            <div className="stat-card" key={i}>
              <span className="stat-label"><span className="skeleton skeleton-text" style={{ width: '50%' }} /></span>
              <span className="stat-value"><span className="skeleton skeleton-value" /></span>
            </div>
          ))}
        </div>
        <div className="asset-section">
          <div className="section-header">
            <h2>Markets</h2>
          </div>
          <div className="asset-table">
            <div className="asset-table-header">
              <span>Asset</span>
              <span>Wallet Balance</span>
              <span>Supplied</span>
              <span>Borrowed</span>
              <span>Actions</span>
            </div>
            <div className="skeleton skeleton-row" style={{ marginTop: 8 }} />
          </div>
        </div>
      </div>
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

      {/* One Protocol — Loop-signed Open Vault (CDP) */}
      <div className="init-banner">
        <div className="init-banner-content">
          <h3>One Protocol — Open Vault</h3>
          <p>
            Create an <code>ExternalOpenVaultRequest</code> signed directly by
            your Loop wallet. No transfer flow.
          </p>
        </div>
        <button
          onClick={() => setActiveModal('open-vault')}
          className="btn-action btn-borrow"
        >
          Open Vault
        </button>
      </div>

      {/* Initialize Position Banner */}
      {!position.hasUserPosition && position.poolCid && (
        <div className="init-banner">
          <div className="init-banner-content">
            <h3>Get Started</h3>
            <p>
              Initialize your lending position to start supplying and borrowing.
            </p>
          </div>
          <button
            onClick={handleInitPosition}
            disabled={initLoading}
            className="btn-action btn-init"
          >
            {initLoading ? 'Initializing...' : 'Initialize Position'}
          </button>
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
                {parseFloat(position.walletBalance).toFixed(4)}
              </span>
              <span className="cell-label">USDCx</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {parseFloat(position.usdcxSupplied).toFixed(4)}
              </span>
              <span className="cell-label">USDCx</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {parseFloat(position.usdcxBorrowed).toFixed(4)}
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
                {parseFloat(position.ccWalletBalance).toFixed(4)}
              </span>
              <span className="cell-label">CC</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {parseFloat(position.ccSupplied).toFixed(4)}
              </span>
              <span className="cell-label">CC</span>
            </div>
            <div className="asset-cell">
              <span className="cell-value">
                {parseFloat(position.ccBorrowed).toFixed(4)}
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
                    {parseFloat(dep.principal).toFixed(4)}
                  </span>
                </div>
                <span
                  className={`collateral-badge ${dep.isUsedAsCollateral ? 'collateral-on' : 'collateral-off'}`}
                >
                  {dep.isUsedAsCollateral ? 'Collateral' : 'Not Collateral'}
                </span>
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
                    {parseFloat(bor.principal).toFixed(4)}
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
      {activeModal === 'open-vault' && (
        <OpenVaultModal
          partyId={partyId}
          provider={provider}
          submitTx={submitTx}
          onClose={() => setActiveModal(null)}
        />
      )}
    </div>
  );
}
