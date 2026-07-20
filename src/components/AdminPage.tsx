import type { LoopProvider, TransactionPayload } from '../loop/provider';
import { useAdminData } from '../hooks/useAdminData';
import { AdminOverview } from './admin/AdminOverview';
import { SolvencyPanel } from './admin/SolvencyPanel';
import { ManageAssets } from './admin/ManageAssets';
import { PauseControls } from './admin/PauseControls';
import { CollapsibleSection } from './admin/CollapsibleSection';
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

export function AdminPage({ partyId, provider, submitTx, addLog }: Props) {
  const data = useAdminData();

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h2>Admin</h2>
        <p className="muted">
          Pool operator tools. The top sections are for everyday use; setup and debug are tucked
          away below.
        </p>
      </div>

      <AdminOverview data={data} />
      <SolvencyPanel />
      <ManageAssets data={data} />
      <PauseControls data={data} />

      <CollapsibleSection
        title="Initial Setup"
        subtitle="one-time bootstrap — you normally never touch these"
        icon="⚠"
        tone="warn"
      >
        <PoolSetup partyId={partyId} submitTx={submitTx} addLog={addLog} />
      </CollapsibleSection>

      <CollapsibleSection title="Contract Explorer" subtitle="raw on-ledger contracts (debug)" icon="🔍">
        <ContractExplorer provider={provider} partyId={partyId} />
      </CollapsibleSection>
    </div>
  );
}
