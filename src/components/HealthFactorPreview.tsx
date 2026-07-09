const hfColor = (hf: number | null) => {
  if (hf === null) return '#8b949e';
  if (hf >= 2) return '#4caf50';
  if (hf >= 1.5) return '#ff9800';
  return '#f44336';
};

/**
 * Current → projected Health Factor display, shared by Supply/Withdraw/Repay
 * (mirrors the inline block in BorrowModal). `null` HF renders as ∞ (no debt).
 */
export function HealthFactorPreview({
  current,
  projected,
  showProjected,
}: {
  current: number | null;
  projected: number | null;
  showProjected: boolean;
}) {
  return (
    <div className="modal-field">
      <label className="modal-label">Health Factor</label>
      <div className="health-factor-display">
        <div className="hf-current">
          <span className="hf-label">Current</span>
          <span className="hf-value" style={{ color: hfColor(current) }}>
            {current !== null ? current.toFixed(2) : '∞'}
          </span>
        </div>
        {showProjected && (
          <>
            <span className="hf-arrow">→</span>
            <div className="hf-projected">
              <span className="hf-label">After</span>
              <span className="hf-value" style={{ color: hfColor(projected) }}>
                {projected !== null ? projected.toFixed(2) : '∞'}
              </span>
            </div>
          </>
        )}
      </div>
      {showProjected && projected !== null && projected < 1.0 && (
        <div className="hf-warning">Position would be liquidatable (HF &lt; 1.0)</div>
      )}
      {showProjected && projected !== null && projected >= 1.0 && projected < 1.5 && (
        <div className="hf-caution">Low health factor — risk of liquidation</div>
      )}
    </div>
  );
}
