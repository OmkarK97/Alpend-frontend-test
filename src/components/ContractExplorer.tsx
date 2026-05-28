import { useState } from 'react';
import { useContracts } from '../hooks/useContracts';
import type { LoopProvider } from '../loop/provider';
import { TEMPLATES, INTERFACES, ADMIN_API_URL } from '../config';

interface Props {
  provider: LoopProvider | null;
  partyId: string;
}

const TEMPLATE_OPTIONS = [
  { label: 'LendingPool', value: TEMPLATES.lendingPool },
  { label: 'AssetReserve', value: TEMPLATES.assetReserve },
  { label: 'DepositPosition', value: TEMPLATES.depositPosition },
  { label: 'BorrowPosition', value: TEMPLATES.borrowPosition },
  { label: 'UserPosition', value: TEMPLATES.userPosition },
  { label: 'PriceOracle', value: TEMPLATES.priceOracle },
];

const INTERFACE_OPTIONS = [
  { label: 'Holding (Token Standard)', value: INTERFACES.holding },
  { label: 'TransferFactory', value: INTERFACES.transferFactory },
];

export function ContractExplorer({ provider, partyId }: Props) {
  const { contracts, holdings, loading, error, queryByTemplate, queryByInterface, fetchHoldings } =
    useContracts(provider);
  const [customId, setCustomId] = useState('');
  const [queryType, setQueryType] = useState<'template' | 'interface'>('template');
  const [adminResult, setAdminResult] = useState<unknown>(null);
  const [adminLoading, setAdminLoading] = useState(false);

  const handleQuery = () => {
    if (!customId) return;
    if (queryType === 'template') {
      queryByTemplate(customId);
    } else {
      queryByInterface(customId);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const fetchFromAdmin = async (endpoint: string) => {
    setAdminLoading(true);
    setAdminResult(null);
    try {
      const resp = await fetch(`${ADMIN_API_URL}${endpoint}`);
      const data = await resp.json();
      setAdminResult(data);
    } catch (err) {
      setAdminResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setAdminLoading(false);
    }
  };

  return (
    <div className="section">
      <h2>Contract Explorer</h2>

      <div className="button-row">
        {TEMPLATE_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            onClick={() => queryByTemplate(opt.value)}
            disabled={!provider || loading}
            className="btn btn-sm"
          >
            {opt.label}
          </button>
        ))}
        {INTERFACE_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            onClick={() => queryByInterface(opt.value)}
            disabled={!provider || loading}
            className="btn btn-sm btn-secondary"
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={fetchHoldings}
          disabled={!provider || loading}
          className="btn btn-sm btn-secondary"
        >
          My Holdings
        </button>
      </div>

      <div className="button-row" style={{ marginTop: 4 }}>
        <span style={{ fontSize: '0.75rem', color: '#8b949e', alignSelf: 'center' }}>Admin (via backend):</span>
        <button
          onClick={() => fetchFromAdmin('/admin/cc-transfer-factory')}
          disabled={adminLoading}
          className="btn btn-sm btn-danger"
        >
          CC Transfer Factory
        </button>
        <button
          onClick={() => fetchFromAdmin(`/admin/cc-holdings/${encodeURIComponent(partyId)}`)}
          disabled={adminLoading || !partyId}
          className="btn btn-sm btn-danger"
        >
          My CC Holdings (CIDs)
        </button>
        <button
          onClick={() => fetchFromAdmin('/admin/pool-state')}
          disabled={adminLoading}
          className="btn btn-sm btn-danger"
        >
          Pool State (Admin)
        </button>
      </div>

      <div className="input-row">
        <select
          value={queryType}
          onChange={(e) => setQueryType(e.target.value as 'template' | 'interface')}
        >
          <option value="template">Template ID</option>
          <option value="interface">Interface ID</option>
        </select>
        <input
          type="text"
          placeholder="Custom template/interface ID..."
          value={customId}
          onChange={(e) => setCustomId(e.target.value)}
          className="input-wide"
        />
        <button onClick={handleQuery} disabled={!provider || loading} className="btn btn-sm">
          Query
        </button>
      </div>

      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}

      {adminResult != null && (
        <div className="results">
          <h3>Admin Query Result</h3>
          <pre className="json-block">{JSON.stringify(adminResult, null, 2)}</pre>
        </div>
      )}

      {holdings.length > 0 && (
        <div className="results">
          <h3>Holdings ({holdings.length})</h3>
          <pre className="json-block">{JSON.stringify(holdings, null, 2)}</pre>
        </div>
      )}

      {contracts.length > 0 && (
        <div className="results">
          <h3>Contracts ({contracts.length})</h3>
          {contracts.map((c, i) => (
            <div key={i} className="contract-card">
              <div className="contract-header">
                <code className="contract-id">{c.contract_id}</code>
                <button
                  onClick={() => copyToClipboard(c.contract_id)}
                  className="btn btn-xs"
                  title="Copy Contract ID"
                >
                  Copy
                </button>
              </div>
              <pre className="json-block">
                {JSON.stringify(c, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {contracts.length === 0 && holdings.length === 0 && adminResult == null && !loading && !error && (
        <p className="muted">Click a button above to query contracts</p>
      )}
    </div>
  );
}
