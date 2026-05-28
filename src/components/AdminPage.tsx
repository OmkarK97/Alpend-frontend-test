import type { LoopProvider, TransactionPayload } from '../loop/provider';
import { PoolSetup } from './PoolSetup';
import { ContractExplorer } from './ContractExplorer';

interface Props {
  partyId: string;
  provider: LoopProvider | null;
  submitTx: (
    operation: string,
    payload: TransactionPayload,
    message: string
  ) => Promise<unknown>;
  addLog: (
    operation: string,
    status: 'pending' | 'success' | 'error',
    message: string,
    details?: unknown
  ) => void;
}

export function AdminPage({
  partyId,
  provider,
  submitTx,
  addLog,
}: Props) {
  return (
    <div className="admin-page">
      <div className="admin-header">
        <h2>Admin Panel</h2>
        <p className="muted">
          Pool operator tools for managing the lending protocol.
        </p>
      </div>
      <PoolSetup partyId={partyId} submitTx={submitTx} addLog={addLog} />
      <ContractExplorer provider={provider} partyId={partyId} />
    </div>
  );
}
