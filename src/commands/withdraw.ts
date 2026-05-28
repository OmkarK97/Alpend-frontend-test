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
