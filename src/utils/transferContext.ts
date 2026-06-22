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
