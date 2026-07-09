import type { AdminData } from '../../hooks/useAdminData';
import { fmtAmount, fmtPercent, fmtDecimal, fmtUsd } from '../../utils/format';

/** Read-only snapshot of the pool — safe for anyone to look at. Each asset's price,
 *  supply/borrow, utilization and key risk params at a glance. */
export function AdminOverview({ data }: { data: AdminData }) {
  const { assets, pauseFlags, oracleFresh, loading, error, refresh } = data;
  const anyPaused =
    pauseFlags.pauseDeposits || pauseFlags.pauseWithdrawals || pauseFlags.pauseBorrows || pauseFlags.pauseLiquidations;

  return (
    <div className="admin-panel">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">Overview</h3>
          <p className="admin-panel-sub">Live pool state. Nothing here changes anything.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      <div className="admin-status-row">
        <span className={`admin-pill ${oracleFresh ? 'ok' : 'bad'}`}>
          Oracle {oracleFresh ? 'connected' : 'missing'}
        </span>
        <span className={`admin-pill ${anyPaused ? 'warn' : 'ok'}`}>
          {anyPaused ? 'Some actions paused' : 'All actions live'}
        </span>
      </div>

      {error && <div className="admin-error">{error}</div>}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Price</th>
              <th>Supplied</th>
              <th>Borrowed</th>
              <th>Utilization</th>
              <th>LTV</th>
              <th>Liq. threshold</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {assets.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="admin-table-empty">No reserves found.</td>
              </tr>
            )}
            {assets.map((a) => (
              <tr key={a.key}>
                <td className="admin-asset-cell">{a.symbol}</td>
                <td>{fmtUsd(a.price)}</td>
                <td>{fmtAmount(a.totalDeposited)}</td>
                <td>{fmtAmount(a.borrowed)}</td>
                <td>{fmtPercent(a.utilization)}</td>
                <td>
                  {fmtDecimal(a.risk.ltv)} <span className="admin-cell-pct">{fmtPercent(a.risk.ltv)}</span>
                </td>
                <td>
                  {fmtDecimal(a.risk.liquidationThreshold)}{' '}
                  <span className="admin-cell-pct">{fmtPercent(a.risk.liquidationThreshold)}</span>
                </td>
                <td>
                  <span className={`admin-pill ${a.isActive ? 'ok' : 'bad'}`}>
                    {a.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
