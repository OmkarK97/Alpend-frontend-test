import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

export function buildSupplyTSWithPositionCommand(
  params: {
    poolCid: string;
    supplier: string;
    supplyAmount: string;
    holdingCids: string[];
    transferFactoryCid: string;
    assetReserveCid: string;
    userPositionCid: string;
    enableAsCollateral: boolean;
    existingDepositCid: string | null;
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
          choice: 'SupplyTSWithPosition',
          choiceArgument: {
            supplier: params.supplier,
            supplyAmount: params.supplyAmount,
            holdingCids: params.holdingCids,
            transferFactoryCid: params.transferFactoryCid,
            assetReserveCid: params.assetReserveCid,
            userPositionCid: params.userPositionCid,
            enableAsCollateral: params.enableAsCollateral,
            existingDepositCid: params.existingDepositCid,
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
