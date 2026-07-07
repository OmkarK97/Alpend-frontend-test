import { ADMIN_API_URL } from '../config';
import type { DisclosedContract } from '../types';

const POOL_OPERATOR =
  'google-oauth2_007c102908799751727857785::12206d5dbed87522889b28486cea3dd6b6c1fc4b3ca156d2c4f31318710fcba57be3';

export interface TransferContext {
  transferFactoryCid: string;
  choiceContext: { values: Record<string, unknown> };
  disclosedContracts: DisclosedContract[];
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
