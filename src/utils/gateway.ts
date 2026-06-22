import { ONE_GATEWAY_URL } from '../config';

/**
 * One Protocol gateway client for the settlement half of the open-vault flow.
 * The borrower (Loop party) authenticates via the wallet-session handshake to
 * get a short-lived bearer token, then asks the gateway to settle the
 * owner-signed `ExternalOpenVaultRequest` as the protocol party.
 */

export interface GatewaySession {
  party: string;
  token: string;
}

/**
 * Obtain a gateway bearer token for `party`. On a localhost testnet the gateway
 * runs in `dev-loop` wallet mode, so the challenge can be returned without a
 * cryptographic wallet signature.
 */
export async function getGatewaySession(party: string): Promise<GatewaySession> {
  const chResp = await fetch(
    `${ONE_GATEWAY_URL}/v1/auth/challenge?party=${encodeURIComponent(party)}`
  );
  if (!chResp.ok) {
    throw new Error(`auth challenge failed: ${chResp.status} ${await chResp.text()}`);
  }
  const ch = (await chResp.json()) as { challenge: string };

  const sessResp = await fetch(`${ONE_GATEWAY_URL}/v1/auth/wallet-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ party, challenge: ch.challenge }),
  });
  if (!sessResp.ok) {
    throw new Error(`wallet-session failed: ${sessResp.status} ${await sessResp.text()}`);
  }
  const sess = (await sessResp.json()) as { token: string };
  return { party, token: sess.token };
}

export interface SettleOpenVaultParams {
  token: string;
  operationNonce: string;
  ownerParty: string;
  collateralTypeId: string;
  collateralDeposit: string;
  principal: string;
  minCollateralRatioBps: string;
  externalRequestCid: string;
  /**
   * Update id of the inbound collateral transfer to the protocol. Required by
   * the gateway's external-settlement path; in this no-transfer demo we pass the
   * create-request update id, so the gateway's transfer verification will reject
   * it — surfacing exactly what production settlement still needs.
   */
  loopTransferUpdateId: string;
}

export interface SettleOpenVaultResult {
  operationId: string;
  commandId: string;
}

export async function settleOpenVault(
  params: SettleOpenVaultParams
): Promise<SettleOpenVaultResult> {
  const { token, ...body } = params;
  const resp = await fetch(`${ONE_GATEWAY_URL}/v1/vaults/open`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`gateway ${resp.status}: ${text}`);
  }
  return JSON.parse(text) as SettleOpenVaultResult;
}
