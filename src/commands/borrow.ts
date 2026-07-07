import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

export function buildBorrowTSWithPositionCommand(
  params: {
    poolCid: string;
    borrower: string;
    borrowAmount: string | null;
    borrowAssetReserveCid: string;
    transferFactoryCid: string;
    userPositionCid: string;
    // Current CIDs of all OTHER reserves backing the user's collateral, for the
    // DAR's on-chain health-factor recompute (C-1). Excludes the primary reserve.
    accountReserveCids: string[];
    existingBorrowCid: string | null;
    // Fresh pool holdings for ephemeral assets (e.g. CC); null = use stored reserve
    // holdings. USDCx is not ephemeral, so callers pass null.
    freshReserveHoldingCids: string[] | null;
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
          choice: 'BorrowTSWithPosition',
          choiceArgument: {
            borrower: params.borrower,
            borrowAmount: params.borrowAmount,
            borrowAssetReserveCid: params.borrowAssetReserveCid,
            transferFactoryCid: params.transferFactoryCid,
            userPositionCid: params.userPositionCid,
            accountReserveCids: params.accountReserveCids,
            existingBorrowCid: params.existingBorrowCid,
            freshReserveHoldingCids: params.freshReserveHoldingCids,
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
