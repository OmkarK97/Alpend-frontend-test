import { useState, useEffect, useCallback } from 'react';
import { ADMIN_API_URL } from '../../config';
import { fmtDecimal } from '../../utils/format';

type Check = { pass: boolean } & Record<string, number | boolean>;
interface ReserveSolvency { instrument: string; pass: boolean; checks: Record<string, Check>; }
interface SolvencyData { allPass: boolean; reserves: ReserveSolvency[]; }

// Plain-language label + which numeric field to surface for each invariant.
const CHECK_META: Record<string, { label: string; metric: string }> = {
  realSolvency: { label: 'Real tokens + outstanding debt cover what suppliers are owed', metric: 'margin' },
  supplyConsistency: { label: 'Deposit positions match the reserve’s supply total', metric: 'drift' },
  borrowConsistency: { label: 'Borrow positions match the reserve’s debt total', metric: 'drift' },
  booksVsReality: { label: 'Reserve’s booked liquidity matches real on-chain holdings', metric: 'gap' },
};

/** Live protocol-health panel: runs the DAR accounting invariants (/admin/solvency) and shows any
 *  violation per reserve. Green = the pool is solvent + internally consistent. */
export function SolvencyPanel() {
  const [data, setData] = useState<SolvencyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${ADMIN_API_URL}/admin/solvency`).then((x) => x.json());
      if (r.success) setData(r); else setError(r.error || 'Failed');
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">Protocol Health</h3>
          <p className="admin-panel-sub">Solvency + accounting invariants, checked live against the ledger.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {data && (
            <span className={`admin-pill ${data.allPass ? 'ok' : 'bad'}`}>
              {data.allPass ? 'All invariants hold' : 'Invariant violation'}
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
            {loading ? 'Checking…' : '↻ Recheck'}
          </button>
        </div>
      </div>

      {error && <div className="admin-error">{error}</div>}

      {data?.reserves.map((r) => (
        <div key={r.instrument} className="admin-card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 className="admin-card-title">{r.instrument}</h4>
            <span className={`admin-pill ${r.pass ? 'ok' : 'bad'}`}>{r.pass ? 'OK' : 'FAIL'}</span>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <tbody>
                {Object.entries(r.checks).map(([key, c]) => {
                  const meta = CHECK_META[key] || { label: key, metric: '' };
                  const val = meta.metric ? (c[meta.metric] as number) : undefined;
                  return (
                    <tr key={key}>
                      <td style={{ width: 36 }}>
                        <span className={`admin-pill ${c.pass ? 'ok' : 'bad'}`}>{c.pass ? '✓' : '✗'}</span>
                      </td>
                      <td>{meta.label}</td>
                      <td className="admin-cell-pct" style={{ whiteSpace: 'nowrap' }}>
                        {meta.metric}: {val !== undefined ? fmtDecimal(val, 4) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
