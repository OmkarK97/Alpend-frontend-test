import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

export function buildRepayTSWithPositionCommand(
  params: {
    poolCid: string;
    borrower: string;
    borrowPositionCid: string;
    repaymentHoldingCids: string[];
    assetReserveCid: string;
    transferFactoryCid: string;
    userPositionCid: string;
    repayAmount: string | null; // null = full repayment
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
          choice: 'RepayTSWithPosition',
          choiceArgument: {
            borrower: params.borrower,
            borrowPositionCid: params.borrowPositionCid,
            repaymentHoldingCids: params.repaymentHoldingCids,
            assetReserveCid: params.assetReserveCid,
            transferFactoryCid: params.transferFactoryCid,
            userPositionCid: params.userPositionCid,
            repayAmount: params.repayAmount,
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
