import {
  ONE_PACKAGE_ID,
  ONE_FACTORY_TEMPLATES,
  ONE_PROTOCOL_PARTY,
} from '../config';
import type { TransactionPayload } from '../loop/provider';

/**
 * Convert a human decimal string (e.g. "1.5") into integer atomic units for a
 * Daml `Int` field (e.g. "15000000000" at 10 decimals). Returns a string so we
 * never lose precision through a JS float — Daml `Int` is encoded as a JSON
 * string by the Ledger API.
 */
export function toAtomic(amount: string, decimals: number): string {
  const trimmed = amount.trim();
  if (trimmed === '' || trimmed === '.' || !/^\d*\.?\d*$/.test(trimmed)) {
    throw new Error(`Invalid amount: "${amount}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) {
    throw new Error(`Too many decimal places (max ${decimals} for this asset)`);
  }
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = ((whole || '0') + fracPadded).replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

export interface ExternalOpenVaultRequestParams {
  /** Borrower party — the Loop-connected wallet that signs this create. */
  owner: string;
  collateralTypeId: string;
  /** Collateral amount in atomic units (use `toAtomic`). */
  collateralDeposit: string;
  /** Borrowed $ONE principal in atomic units (use `toAtomic`). */
  principal: string;
  /** Borrower's minimum acceptable collateral ratio, in basis points. */
  minCollateralRatioBps: number;
  /** Reference to an off-ledger collateral transfer; demo-only when no transfer. */
  externalTransferId: string;
  /** Unique per-request nonce for replay safety. */
  nonce: string;
  /** ISO-8601 expiry; the protocol rejects settlement after this time. */
  expiresAt: string;
}

/**
 * Build the Loop `TransactionPayload` that CREATES a One Protocol
 * `ExternalOpenVaultRequest`. The template is `signatory owner` only, so a
 * single Loop signature from the borrower authorizes it — no protocol
 * co-signature, no collateral transfer, and no disclosed contracts required.
 * The protocol settles it afterward via `SettleExternalOpenVaultRequest`.
 */
export function buildExternalOpenVaultRequestCommand(
  params: ExternalOpenVaultRequestParams
): TransactionPayload {
  return {
    commands: [
      {
        CreateCommand: {
          templateId: ONE_FACTORY_TEMPLATES.externalOpenVaultRequest,
          createArguments: {
            protocol: ONE_PROTOCOL_PARTY,
            owner: params.owner,
            collateralTypeId: params.collateralTypeId,
            collateralDeposit: params.collateralDeposit,
            principal: params.principal,
            minCollateralRatioBps: String(params.minCollateralRatioBps),
            externalTransferId: params.externalTransferId,
            nonce: params.nonce,
            expiresAt: params.expiresAt,
            version: '1',
          },
        },
      },
    ],
    disclosedContracts: [],
    packageIdSelectionPreference: [ONE_PACKAGE_ID],
  };
}
