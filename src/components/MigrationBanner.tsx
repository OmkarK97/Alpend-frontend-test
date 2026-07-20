import { useState, useEffect, useCallback } from 'react';
import type { TransactionPayload } from '../loop/provider';
import type { SubmitTxOptions } from '../hooks/useLoop';
import { ADMIN_API_URL } from '../config';
import { fetchLiveCids, fetchPoolDisclosedContracts } from '../utils/transferContext';
import { buildMigrationAcceptCommand } from '../commands/migration';
import { fmtBalance } from '../utils/format';

interface SnapshotEntry {
  instrumentId: { admin: string; id: string };
  realizedPrincipal?: string;
  realizedDebt?: string;
  isUsedAsCollateral?: boolean;
}
interface Snapshot {
  contractId: string;
  createArgument: { collaterals: SnapshotEntry[]; borrows: SnapshotEntry[]; expiresAt: string };
}

interface Props {
  partyId: string;
  submitTx: (operation: string, payload: TransactionPayload, message: string, options?: SubmitTxOptions) => Promise<unknown>;
  onDone: () => Promise<void>;
  addLog?: (operation: string, status: 'pending' | 'success' | 'error', message: string, details?: unknown) => void;
}

/** Shows a one-click "accept migration" prompt if the operator has prepared a MigrationSnapshot
 *  for this wallet. Accepting materializes the user's position on-chain (one Loop signature). */
export function MigrationBanner({ partyId, submitTx, onDone, addLog }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!partyId) return;
    try {
      const r = await fetch(`${ADMIN_API_URL}/admin/migration-snapshot/${encodeURIComponent(partyId)}`).then((x) => x.json());
      setSnapshot(r.snapshots?.[0] || null);
    } catch { /* ignore */ }
  }, [partyId]);
  useEffect(() => { load(); }, [load]);

  if (!snapshot) return null;
  const a = snapshot.createArgument;

  const accept = async () => {
    setBusy(true); setStatus(null);
    try {
      const instrs = [...a.collaterals, ...a.borrows].map((e) => e.instrumentId.id);
      const live = await fetchLiveCids(partyId);
      const reserveCids = [...new Set(instrs.map((id) => live.reservesByInstrument[id]).filter(Boolean))];
      if (reserveCids.length === 0) throw new Error('Could not resolve reserve CIDs for the snapshot instruments.');
      const disclosed = await fetchPoolDisclosedContracts(partyId);
      const cmd = buildMigrationAcceptCommand({ snapshotCid: snapshot.contractId, reserveCids }, disclosed);
      await submitTx('MigrationAccept', cmd, 'Accept migration', { estimateTraffic: false });
      setStatus('Migration accepted ✓');
      setSnapshot(null);
      await onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus('Failed: ' + msg);
      addLog?.('MigrationAccept', 'error', msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="init-banner">
      <div className="init-banner-content">
        <h3>Migrate your position</h3>
        <p>We’ve prepared your existing balances. Sign once to move them onto the new protocol — no tokens move, it just recreates your position.</p>
        <ul className="migration-list">
          {a.collaterals.map((c, i) => (
            <li key={'c' + i}>
              Supply <strong>{fmtBalance(c.realizedPrincipal || '0')} {c.instrumentId.id}</strong>
              {c.isUsedAsCollateral ? ' (collateral)' : ''}
            </li>
          ))}
          {a.borrows.map((b, i) => (
            <li key={'b' + i}>
              Borrow <strong>{fmtBalance(b.realizedDebt || '0')} {b.instrumentId.id}</strong>
            </li>
          ))}
        </ul>
        {status && <div className={status.startsWith('Failed') ? 'admin-error' : 'admin-ok'}>{status}</div>}
      </div>
      <button className="btn-connect-large" onClick={accept} disabled={busy}>
        {busy ? 'Migrating…' : 'Accept & Migrate'}
      </button>
    </div>
  );
}
