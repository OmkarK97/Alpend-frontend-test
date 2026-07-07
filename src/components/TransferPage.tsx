import { useState } from 'react';
import { ADMIN_API_URL, EXPLORER_URL } from '../config';

type Asset = 'usdcx' | 'cc';

const ENDPOINTS: Record<Asset, string> = {
  usdcx: '/admin/send-usdcx',
  cc: '/admin/send-cc',
};

const SYMBOLS: Record<Asset, string> = {
  usdcx: 'USDCx',
  cc: 'CC',
};

interface Props {
  /** Connected Loop wallet party, used as the default recipient (may be empty). */
  partyId: string;
}

/**
 * Operator → wallet transfer. Sends tokens from the pool operator ("our validator")
 * to a recipient party (e.g. a Loop wallet). The transfer is signed server-side by
 * the operator — it does NOT go through the user's Loop wallet.
 */
export function TransferPage({ partyId }: Props) {
  const [asset, setAsset] = useState<Asset>('cc');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState(partyId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [updateId, setUpdateId] = useState('');

  const symbol = SYMBOLS[asset];

  const handleSend = async () => {
    setError('');
    setSuccess('');
    setUpdateId('');
    if (!recipient.trim()) {
      setError('Recipient party is required.');
      return;
    }
    if (!amount || parseFloat(amount) <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(`${ADMIN_API_URL}${ENDPOINTS[asset]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: recipient.trim(), amount }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      setSuccess(data.message || `Sent ${amount} ${symbol} to ${recipient.trim()}`);
      setUpdateId(data.updateId || '');
      setAmount('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="section">
      <h2>Transfer</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Send tokens from the pool operator (our validator) to a wallet. Signed by the
        operator server-side — this does not use the recipient's Loop wallet.
      </p>

      <div className="operation-card">
        <div className="form-group">
          <label>Asset</label>
          <select
            value={asset}
            onChange={(e) => setAsset(e.target.value as Asset)}
            className="input-wide"
          >
            <option value="cc">CC (Canton Coin)</option>
            <option value="usdcx">USDCx</option>
          </select>
        </div>

        <div className="form-group">
          <label>Recipient Party (defaults to connected wallet)</label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Loop wallet party ID..."
            className="input-wide"
          />
        </div>

        <div className="form-group">
          <label>Amount ({symbol})</label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="input-wide"
          />
        </div>

        {error && <div className="modal-error">{error}</div>}
        {success && (
          <div className="modal-success-inline" style={{ color: '#4caf50', marginBottom: 8 }}>
            {success}
            {updateId && (
              <>
                {' '}
                <a
                  href={`${EXPLORER_URL}/${updateId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Explorer
                </a>
              </>
            )}
          </div>
        )}

        <button
          onClick={handleSend}
          disabled={submitting || !recipient.trim() || !amount || parseFloat(amount) <= 0}
          className="btn btn-primary"
        >
          {submitting ? 'Sending...' : `Send ${amount || '0'} ${symbol}`}
        </button>
      </div>
    </div>
  );
}
