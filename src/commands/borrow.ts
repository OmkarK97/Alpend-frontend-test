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
    existingBorrowCid: string | null;
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
            existingBorrowCid: params.existingBorrowCid,
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
