/** The dashboard's loading shape. Used both while a connected wallet's position is loading
 *  AND while the Loop session is being restored on refresh — so a refresh shows the real
 *  layout filling in, rather than flashing a "not connected" prompt at someone who is. */
export function DashboardSkeleton() {
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
          <div className="skeleton skeleton-row" style={{ marginTop: 8 }} />
        </div>
      </div>
    </div>
  );
}
