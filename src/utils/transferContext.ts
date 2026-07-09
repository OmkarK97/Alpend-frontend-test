import { ADMIN_API_URL } from '../config';
import type { DisclosedContract } from '../types';

const POOL_OPERATOR =
  'google-oauth2_007c102908799751727857785::12206d5dbed87522889b28486cea3dd6b6c1fc4b3ca156d2c4f31318710fcba57be3';

export interface TransferContext {
  transferFactoryCid: string;
  choiceContext: { values: Record<string, unknown> };
  disclosedContracts: DisclosedContract[];
}

/** True if the error is a ledger CONTRACT_NOT_FOUND (archived/stale contract). */
export function isContractNotFound(e: unknown): boolean {
  const s = typeof e === 'string' ? e : (e as { message?: string })?.message || JSON.stringify(e ?? '');
  return /CONTRACT_NOT_FOUND/i.test(s);
}

/** Run `fn`; if it fails with CONTRACT_NOT_FOUND on an ephemeral asset (Canton Coin holdings
 *  re-issue on round boundaries, including during wallet-signing latency), rebuild + retry ONCE.
 *  `fn` must itself re-fetch fresh holdings each call so the retry uses the current CIDs. */
export async function withEphemeralRetry<T>(ephemeral: boolean, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (ephemeral && isContractNotFound(e)) {
      return await fn();
    }
    throw e;
  }
}

/**
 * Live contract CIDs for a party, fetched fresh at submit time. `position` (from usePosition)
 * is only as fresh as its last refresh, but reserve CIDs churn on every accrue/action by ANY
 * user and the UserPosition CID churns on every action — so a command that references cached
 * CIDs can hit CONTRACT_NOT_FOUND. Re-resolve them here right before building the command.
 */
export interface LiveCids {
  poolCid: string;
  userPositionCid: string;
  reservesByInstrument: Record<string, string>; // instrumentId.id -> current reserve cid
  depositsByInstrument: Record<string, string>;  // instrumentId.id -> current deposit cid
  borrowsByInstrument: Record<string, string>;   // instrumentId.id -> current borrow cid
}

export async function fetchLiveCids(partyId: string): Promise<LiveCids> {
  const [poolResp, arResp, upResp, depResp, borResp] = await Promise.all([
    fetch(`${ADMIN_API_URL}/query/lending-pool`).then((r) => r.json()).catch(() => ({ contracts: [] })),
    fetch(`${ADMIN_API_URL}/admin/asset-reserves`).then((r) => r.json()).catch(() => ({ contracts: [] })),
    fetch(`${ADMIN_API_URL}/query/user-position/${encodeURIComponent(partyId)}`).then((r) => r.json()).catch(() => ({ contracts: [] })),
    fetch(`${ADMIN_API_URL}/query/deposit-position/${encodeURIComponent(partyId)}`).then((r) => r.json()).catch(() => ({ contracts: [] })),
    fetch(`${ADMIN_API_URL}/query/borrow-position/${encodeURIComponent(partyId)}`).then((r) => r.json()).catch(() => ({ contracts: [] })),
  ]);

  type C = { contractId: string; createArgument?: { user?: string; instrumentId?: { id?: string } } };
  const poolC: C[] = poolResp.contracts || [];
  const poolCid = poolC[poolC.length - 1]?.contractId || '';

  // ONLY this party's UserPosition — never fall back to another user's (see usePosition).
  const upC: C[] = (upResp.contracts || []).filter((c: C) => c.createArgument?.user === partyId);
  const userPositionCid = upC[upC.length - 1]?.contractId || '';

  const reservesByInstrument: Record<string, string> = {};
  for (const c of (arResp.contracts || []) as C[]) {
    const id = c.createArgument?.instrumentId?.id;
    if (id) reservesByInstrument[id] = c.contractId; // last active wins (queryContracts returns active)
  }
  const depositsByInstrument: Record<string, string> = {};
  for (const c of (depResp.contracts || []) as C[]) {
    const id = c.createArgument?.instrumentId?.id;
    if (id && !depositsByInstrument[id]) depositsByInstrument[id] = c.contractId;
  }
  const borrowsByInstrument: Record<string, string> = {};
  for (const c of (borResp.contracts || []) as C[]) {
    const id = c.createArgument?.instrumentId?.id;
    if (id && !borrowsByInstrument[id]) borrowsByInstrument[id] = c.contractId;
  }

  return { poolCid, userPositionCid, reservesByInstrument, depositsByInstrument, borrowsByInstrument };
}

/**
 * The LendingPool CID a command exercises on MUST match the pool disclosed in that same
 * command, and must be the CURRENT one — the pool CID churns whenever a consuming admin
 * choice runs (e.g. UpdateOracleCid on every SetPrice / oracle sync). Trusting a cached
 * `position.poolCid` causes `CONTRACT_NOT_FOUND` until a hard refresh. Since the freshly
 * fetched disclosed set already carries the current pool, take the CID from there so the
 * exercise target can never disagree with what's disclosed. Falls back to the cached cid.
 */
export function poolCidFromDisclosed(
  disclosed: DisclosedContract[],
  fallback: string
): string {
  const pool = disclosed.find((dc) =>
    (dc.templateId || '').includes('Lending.Pool:LendingPool')
  );
  return pool?.contractId || fallback;
}

export async function fetchTransferContext(
  sender: string,
  amount: string,
  holdingCids: string[],
  receiver?: string
): Promise<TransferContext> {
  const actualReceiver = receiver || POOL_OPERATOR;
  const [registryResp, poolDisclosedResp] = await Promise.all([
    fetch(`${ADMIN_API_URL}/admin/usdcx-transfer-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender,
        receiver: actualReceiver,
        amount,
        holdingCids,
      }),
    }),
    fetch(
      `${ADMIN_API_URL}/admin/pool-disclosed-contracts?party=${encodeURIComponent(sender)}`
    ),
  ]);

  const [registryData, poolDisclosedData] = await Promise.all([
    registryResp.json(),
    poolDisclosedResp.json(),
  ]);

  if (!registryData.success) {
    throw new Error(registryData.error || 'Failed to fetch transfer context');
  }

  const registryDisclosed: DisclosedContract[] =
    registryData.disclosedContracts || [];
  const poolDisclosed: DisclosedContract[] =
    poolDisclosedData.disclosedContracts || [];

  return {
    transferFactoryCid: registryData.transferFactoryCid,
    choiceContext: registryData.choiceContext || { values: {} },
    disclosedContracts: [...registryDisclosed, ...poolDisclosed],
  };
}

export async function fetchCCTransferContext(
  partyId: string
): Promise<TransferContext> {
  const [ccResp, poolDisclosedResp] = await Promise.all([
    fetch(`${ADMIN_API_URL}/admin/cc-transfer-context?party=${encodeURIComponent(partyId)}`),
    fetch(
      `${ADMIN_API_URL}/admin/pool-disclosed-contracts?party=${encodeURIComponent(partyId)}`
    ),
  ]);

  const [ccData, poolDisclosedData] = await Promise.all([
    ccResp.json(),
    poolDisclosedResp.json(),
  ]);

  if (!ccData.success) {
    throw new Error(ccData.error || 'Failed to fetch CC transfer context');
  }

  const ccDisclosed: DisclosedContract[] = ccData.disclosedContracts || [];
  const poolDisclosed: DisclosedContract[] =
    poolDisclosedData.disclosedContracts || [];

  return {
    transferFactoryCid: ccData.transferFactoryCid,
    choiceContext: ccData.choiceContext || { values: {} },
    disclosedContracts: [...ccDisclosed, ...poolDisclosed],
  };
}

export async function fetchPoolDisclosedContracts(
  partyId: string
): Promise<DisclosedContract[]> {
  const resp = await fetch(
    `${ADMIN_API_URL}/admin/pool-disclosed-contracts?party=${encodeURIComponent(partyId)}`
  );
  const data = await resp.json();
  return data.disclosedContracts || [];
}

/**
 * CC transfer context for the pool-as-sender (payout) direction — used by CC
 * withdraw/borrow. Sourced from the REGISTRY (via `/admin/cc-payout-context`), so the
 * disclosed contracts carry templateIds and include `external-party-config-state`
 * (required because the pool operator is an external-party sender). We merge the
 * lending pool/reserve/oracle disclosures the receiving party needs.
 */
export async function fetchCCPayoutContext(
  receiver: string,
  amount: string,
  holdingCids: string[]
): Promise<TransferContext> {
  const [ccResp, poolDisclosedResp] = await Promise.all([
    fetch(`${ADMIN_API_URL}/admin/cc-payout-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiver, amount, holdingCids }),
    }),
    fetch(
      `${ADMIN_API_URL}/admin/pool-disclosed-contracts?party=${encodeURIComponent(receiver)}`
    ),
  ]);

  const [ccData, poolDisclosedData] = await Promise.all([
    ccResp.json(),
    poolDisclosedResp.json(),
  ]);

  if (!ccData.success) {
    throw new Error(ccData.error || 'Failed to fetch CC payout context');
  }

  const ccDisclosed: DisclosedContract[] = ccData.disclosedContracts || [];
  const poolDisclosed: DisclosedContract[] =
    poolDisclosedData.disclosedContracts || [];

  return {
    transferFactoryCid: ccData.transferFactoryCid,
    choiceContext: ccData.choiceContext || { values: {} },
    disclosedContracts: [...ccDisclosed, ...poolDisclosed],
  };
}

export interface PoolHoldings {
  /** Holding contract IDs — used both as transfer inputs and, for ephemeral
   *  assets, as `freshReserveHoldingCids` (must cover full liquidity, FIND-025). */
  cids: string[];
  /** Same holdings as disclosed contracts (the pool's holdings aren't otherwise
   *  visible to the receiving party's participant). */
  disclosed: DisclosedContract[];
}

/** Fetch the pool operator's holdings of an asset from its holdings endpoint.
 *  Both `/admin/usdcx-holdings/:party` and `/admin/cc-holdings/:party` return
 *  `{ holdings: [{ contractId, createdEventBlob, templateId, domainId? }] }`. */
export async function fetchPoolHoldings(path: string): Promise<PoolHoldings> {
  const resp = await fetch(`${ADMIN_API_URL}${path}`);
  const data = await resp.json();
  const holdings: Array<{
    contractId?: string;
    createdEventBlob?: string;
    templateId?: string;
    domainId?: string;
    synchronizerId?: string;
  }> = data.holdings || [];

  return {
    cids: holdings.map((h) => h.contractId).filter((c): c is string => !!c),
    disclosed: holdings
      .filter((h) => h.contractId && h.createdEventBlob)
      .map((h) => ({
        templateId: h.templateId || '',
        contractId: h.contractId as string,
        createdEventBlob: h.createdEventBlob as string,
        domainId: h.domainId || h.synchronizerId || '',
      })),
  };
}
