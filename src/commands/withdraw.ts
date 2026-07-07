import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

export function buildWithdrawTSWithPositionCommand(
  params: {
    poolCid: string;
    supplier: string;
    depositPositionCid: string;
    assetReserveCid: string;
    transferFactoryCid: string;
    userPositionCid: string;
    // Current CIDs of all OTHER reserves the user has positions in, for the DAR's
    // on-chain health-factor recompute (C-1). Excludes the primary reserve.
    accountReserveCids: string[];
    // Fresh pool holdings for ephemeral assets (e.g. CC); null = use stored reserve
    // holdings. USDCx is not ephemeral, so callers pass null.
    freshReserveHoldingCids: string[] | null;
    withdrawAmount: string | null; // null = full withdrawal
    choiceContext: { values: Record<string, unknown> };
    reason: string;
    featuredAppRightCid: string | null;
  },
  disclosedContracts: DisclosedContract[] = []
): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.lendingPool,
          contractId: params.poolCid,
          choice: 'WithdrawTSWithPosition',
          choiceArgument: {
            supplier: params.supplier,
            depositPositionCid: params.depositPositionCid,
            assetReserveCid: params.assetReserveCid,
            transferFactoryCid: params.transferFactoryCid,
            userPositionCid: params.userPositionCid,
            accountReserveCids: params.accountReserveCids,
            freshReserveHoldingCids: params.freshReserveHoldingCids,
            withdrawAmount: params.withdrawAmount,
            choiceContext: params.choiceContext,
            reason: params.reason,
            featuredAppRightCid: params.featuredAppRightCid,
          },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}
