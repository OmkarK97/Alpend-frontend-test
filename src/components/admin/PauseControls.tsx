import { useState } from 'react';
import { ADMIN_API_URL } from '../../config';
import type { AdminData, PauseFlags } from '../../hooks/useAdminData';

const FLAGS: { key: keyof PauseFlags; label: string; desc: string }[] = [
  { key: 'pauseDeposits', label: 'Deposits', desc: 'Block new supplies' },
  { key: 'pauseWithdrawals', label: 'Withdrawals', desc: 'Block withdrawals' },
  { key: 'pauseBorrows', label: 'Borrows', desc: 'Block new borrows' },
  { key: 'pauseLiquidations', label: 'Liquidations', desc: 'Block liquidations' },
];

/** Pool-wide circuit breakers. Toggling shows a diff and only submits on Apply, so you can't
 *  flip something by accident. */
export function PauseControls({ data }: { data: AdminData }) {
  const [draft, setDraft] = useState<PauseFlags>(data.pauseFlags);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Re-seed the draft whenever the live flags change (after a refresh).
  const [seeded, setSeeded] = useState(JSON.stringify(data.pauseFlags));
  const liveKey = JSON.stringify(data.pauseFlags);
  if (liveKey !== seeded) { setSeeded(liveKey); setDraft(data.pauseFlags); }

  const dirty = FLAGS.some((f) => draft[f.key] !== data.pauseFlags[f.key]);

  const apply = async () => {
    setBusy(true); setStatus(null);
    const resp = await fetch(`${ADMIN_API_URL}/admin/set-pause-flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const r = await resp.json();
    setBusy(false);
    if (r.success) { setStatus('Pause flags applied.'); data.refresh(); }
    else setStatus(r.error || 'Failed');
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">Circuit Breakers</h3>
          <p className="admin-panel-sub">Pause categories of activity pool-wide in an emergency.</p>
        </div>
      </div>
      <div className="admin-toggle-row">
        {FLAGS.map((f) => (
          <label key={f.key} className={`admin-toggle ${draft[f.key] ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={draft[f.key]}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked }))}
            />
            <span className="admin-toggle-label">{f.label}</span>
            <span className="admin-toggle-desc">{f.desc}</span>
            <span className="admin-toggle-state">{draft[f.key] ? 'PAUSED' : 'live'}</span>
          </label>
        ))}
      </div>
      <div className="admin-panel-actions">
        <button className="btn btn-primary btn-sm" onClick={apply} disabled={busy || !dirty}>
          {busy ? 'Applying…' : dirty ? 'Apply Changes' : 'No Changes'}
        </button>
        {status && <span className="admin-inline-status">{status}</span>}
      </div>
    </div>
  );
}
