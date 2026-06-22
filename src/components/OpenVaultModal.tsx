import { useState } from 'react';
import { ActionModal } from './ActionModal';
import type { LoopProvider, TransactionPayload } from '../loop/provider';
import type { SubmitTxOptions } from '../hooks/useLoop';
import {
  buildExternalOpenVaultRequestCommand,
  toAtomic,
} from '../commands/openVault';
import { getGatewaySession, settleOpenVault } from '../utils/gateway';
import {
  ONE_COLLATERAL_TYPE_ID,
  ONE_COLLATERAL_DECIMALS,
  ONE_DEBT_DECIMALS,
  ONE_FACTORY_TEMPLATES,
  EXPLORER_URL,
} from '../config';

interface Props {
  partyId: string;
  provider: LoopProvider | null;
  submitTx: (
    operation: string,
    payload: TransactionPayload,
    message: string,
    options?: SubmitTxOptions
  ) => Promise<unknown>;
  onClose: () => void;
}

const DEFAULT_MIN_CR_BPS = 15000; // 150%
const REQUEST_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CID_RESOLVE_ATTEMPTS = 6;
const CID_RESOLVE_DELAY_MS = 1500;

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Look up the request we just created by its unique nonce. The Loop ACS shape
 * varies, so we match shape-agnostically: any active ExternalOpenVaultRequest
 * whose serialized payload contains our nonce is ours.
 */
async function findCreatedRequestCid(
  provider: LoopProvider | null,
  nonce: string
): Promise<string> {
  if (!provider) return '';
  try {
    let contracts = await provider.getActiveContracts({
      templateId: ONE_FACTORY_TEMPLATES.externalOpenVaultRequest,
    });
    if (!contracts || contracts.length === 0) {
      contracts = await provider.getActiveContracts();
    }
    const match = (contracts ?? []).find((c) => {
      const rec = c as Record<string, unknown>;
      const tid = String(rec.template_id ?? '');
      if (tid && !tid.includes('ExternalOpenVaultRequest')) return false;
      try {
        return JSON.stringify(rec).includes(nonce);
      } catch {
        return false;
      }
    });
    return (match?.contract_id as string) || '';
  } catch {
    return '';
  }
}

/** Retry the ACS lookup to absorb Loop indexing lag right after submit. */
async function resolveCidWithRetries(
  provider: LoopProvider | null,
  nonce: string
): Promise<string> {
  for (let i = 0; i < CID_RESOLVE_ATTEMPTS; i++) {
    const cid = await findCreatedRequestCid(provider, nonce);
    if (cid) return cid;
    if (i < CID_RESOLVE_ATTEMPTS - 1) await sleep(CID_RESOLVE_DELAY_MS);
  }
  return '';
}

/** The owner-signed request we created, plus the inputs needed to settle it. */
interface CreatedRequest {
  createUpdateId: string;
  collateralAtomic: string;
  principalAtomic: string;
  minCrBps: number;
}

export function OpenVaultModal({ partyId, provider, submitTx, onClose }: Props) {
  const [collateral, setCollateral] = useState('');
  const [borrow, setBorrow] = useState('');
  const [minCrBps, setMinCrBps] = useState(String(DEFAULT_MIN_CR_BPS));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [created, setCreated] = useState<CreatedRequest | null>(null);
  // Editable so the user can paste the CID if auto-resolution lags.
  const [requestCid, setRequestCid] = useState('');
  const [resolving, setResolving] = useState(false);

  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState('');
  const [settleResult, setSettleResult] = useState<{
    operationId: string;
    commandId: string;
  } | null>(null);

  // --- Step 1: owner-signed CreateCommand via Loop -------------------------
  const handleCreate = async () => {
    setError('');

    let collateralAtomic: string;
    let principalAtomic: string;
    try {
      collateralAtomic = toAtomic(collateral, ONE_COLLATERAL_DECIMALS);
      principalAtomic = toAtomic(borrow, ONE_DEBT_DECIMALS);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    if (BigInt(collateralAtomic) <= 0n || BigInt(principalAtomic) <= 0n) {
      setError('Collateral and borrow amounts must both be greater than 0.');
      return;
    }
    const minCr = parseInt(minCrBps, 10);
    if (!Number.isInteger(minCr) || minCr <= 0) {
      setError('Minimum collateral ratio (bps) must be a positive integer.');
      return;
    }

    setSubmitting(true);
    try {
      const nonce = uuid();
      const cmd = buildExternalOpenVaultRequestCommand({
        owner: partyId,
        collateralTypeId: ONE_COLLATERAL_TYPE_ID,
        collateralDeposit: collateralAtomic,
        principal: principalAtomic,
        minCollateralRatioBps: minCr,
        externalTransferId: `demo-${uuid()}`,
        nonce,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
      });

      const result = await submitTx(
        'CreateExternalOpenVaultRequest',
        cmd,
        `Open vault: deposit ${collateral} ${ONE_COLLATERAL_TYPE_ID}, borrow ${borrow} ONE`,
        { estimateTraffic: false }
      );

      const createUpdateId =
        ((result as Record<string, unknown>)?._extractedUpdateId as string) || '';

      setCreated({
        createUpdateId,
        collateralAtomic,
        principalAtomic,
        minCrBps: minCr,
      });

      // Resolve the new contract id in the background (with retries).
      setResolving(true);
      resolveCidWithRetries(provider, nonce)
        .then((cid) => {
          if (cid) setRequestCid(cid);
        })
        .finally(() => setResolving(false));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Step 2: protocol settlement via the One gateway ---------------------
  const handleSettle = async () => {
    if (!created) return;
    const cid = requestCid.trim();
    if (!cid) {
      setSettleError('Request contract id is required to settle.');
      return;
    }
    setSettleError('');
    setSettleResult(null);
    setSettling(true);
    try {
      const session = await getGatewaySession(partyId);
      const result = await settleOpenVault({
        token: session.token,
        operationNonce: uuid(),
        ownerParty: partyId,
        collateralTypeId: ONE_COLLATERAL_TYPE_ID,
        collateralDeposit: created.collateralAtomic,
        principal: created.principalAtomic,
        minCollateralRatioBps: String(created.minCrBps),
        externalRequestCid: cid,
        loopTransferUpdateId: created.createUpdateId,
      });
      setSettleResult(result);
    } catch (err) {
      setSettleError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettling(false);
    }
  };

  const createDisabled =
    submitting ||
    !collateral ||
    parseFloat(collateral) <= 0 ||
    !borrow ||
    parseFloat(borrow) <= 0;

  return (
    <ActionModal title={`Open Vault (${ONE_COLLATERAL_TYPE_ID})`} onClose={onClose}>
      <p className="modal-hint">
        Step 1 signs an <code>ExternalOpenVaultRequest</code> directly with your
        Loop wallet (owner-only). Step 2 asks the One gateway to settle it as the
        protocol party. No collateral transfer is performed.
      </p>

      {!created ? (
        <>
          <div className="modal-field">
            <label className="modal-label">
              Collateral deposit ({ONE_COLLATERAL_TYPE_ID})
            </label>
            <input
              type="text"
              value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
              placeholder="0.00"
              className="modal-input"
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">Borrow principal (ONE)</label>
            <input
              type="text"
              value={borrow}
              onChange={(e) => setBorrow(e.target.value)}
              placeholder="0.00"
              className="modal-input"
            />
          </div>

          <div className="modal-field">
            <label className="modal-label">Minimum collateral ratio (bps)</label>
            <input
              type="text"
              value={minCrBps}
              onChange={(e) => setMinCrBps(e.target.value)}
              placeholder={String(DEFAULT_MIN_CR_BPS)}
              className="modal-input"
            />
          </div>

          {error && <div className="modal-error">{error}</div>}

          <button
            onClick={handleCreate}
            disabled={createDisabled}
            className="btn-action btn-borrow"
          >
            {submitting ? (
              <>
                <span className="btn-spinner" />
                Signing...
              </>
            ) : (
              '1 · Sign & Create Request'
            )}
          </button>
        </>
      ) : (
        <>
          <div className="modal-field">
            <label className="modal-label">
              Request contract id {resolving && '· resolving from wallet…'}
            </label>
            <input
              type="text"
              value={requestCid}
              onChange={(e) => setRequestCid(e.target.value)}
              placeholder="paste contract id if not auto-resolved"
              className="modal-input"
              style={{ fontSize: '0.78rem' }}
            />
          </div>

          {created.createUpdateId && (
            <a
              href={`${EXPLORER_URL}/${created.createUpdateId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="success-explorer-link"
            >
              View create tx on Explorer
            </a>
          )}

          {settleResult ? (
            <div className="modal-field">
              <label className="modal-label">Settlement accepted</label>
              <div
                className="modal-balance"
                style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}
              >
                operationId: {settleResult.operationId}
                <br />
                commandId: {settleResult.commandId}
              </div>
            </div>
          ) : (
            <button
              onClick={handleSettle}
              disabled={settling || !requestCid.trim()}
              className="btn-action btn-supply"
            >
              {settling ? (
                <>
                  <span className="btn-spinner" />
                  Settling via gateway...
                </>
              ) : (
                '2 · Settle via Gateway (protocol)'
              )}
            </button>
          )}

          {settleError && <div className="modal-error">{settleError}</div>}

          <button className="btn-done" onClick={onClose} style={{ marginTop: 12 }}>
            Done
          </button>
        </>
      )}
    </ActionModal>
  );
}
