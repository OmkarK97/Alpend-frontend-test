import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

/** Enable a supply position as collateral. No token transfer, no HF check
 *  (enabling only raises HF). Needs the pool + reserve + user-position disclosed. */
export function buildEnableCollateralCommand(
  args: {
    supplier: string;
    poolCid: string;
    depositPositionCid: string;
    assetReserveCid: string;
    userPositionCid: string;
    featuredAppRightCid?: string | null;
  },
  disclosedContracts: DisclosedContract[] = []
): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.lendingPool,
          contractId: args.poolCid,
          choice: 'EnableCollateral',
          choiceArgument: {
            supplier: args.supplier,
            depositPositionCid: args.depositPositionCid,
            assetReserveCid: args.assetReserveCid,
            userPositionCid: args.userPositionCid,
            featuredAppRightCid: args.featuredAppRightCid ?? null,
          },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}

/** Disable a supply position as collateral. No token transfer, but the DAR recomputes
 *  HF over the remaining collateral and requires HF >= 1 after disabling — so it needs
 *  the OTHER reserves backing the user's basket (accountReserveCids) + oracle disclosed. */
export function buildDisableCollateralCommand(
  args: {
    supplier: string;
    poolCid: string;
    depositPositionCid: string;
    assetReserveCid: string;
    userPositionCid: string;
    accountReserveCids: string[];
    featuredAppRightCid?: string | null;
  },
  disclosedContracts: DisclosedContract[] = []
): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.lendingPool,
          contractId: args.poolCid,
          choice: 'DisableCollateral',
          choiceArgument: {
            supplier: args.supplier,
            depositPositionCid: args.depositPositionCid,
            assetReserveCid: args.assetReserveCid,
            userPositionCid: args.userPositionCid,
            accountReserveCids: args.accountReserveCids,
            featuredAppRightCid: args.featuredAppRightCid ?? null,
          },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}
