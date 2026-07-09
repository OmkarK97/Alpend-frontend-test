import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

/**
 * Build a `LiquidateTS` command. The connected Loop wallet is the `liquidator`
 * (single-controller). It's a two-sided cross-asset transfer in one atomic tx:
 * the liquidator repays part of the borrower's debt (liquidator → pool, debt asset)
 * and receives seized collateral + bonus (pool → liquidator, collateral asset) — so
 * it needs BOTH a debt-asset transfer context (liquidator's repayment funds) and a
 * collateral-asset payout context. The DAR recomputes HF<1 on-chain; the caller only
 * needs to cap `repayAmount` at the close factor (50%, or 100% below the FIND-004
 * boundary) — the choice re-asserts it.
 */
export function buildLiquidateTSCommand(
  params: {
    poolCid: string;
    liquidator: string;
    borrower: string;
    borrowPositionCid: string;
    debtAssetReserveCid: string;
    collateralDepositCid: string;
    collateralAssetReserveCid: string;
    // Liquidator's own holdings of the debt asset, funding the repayment.
    repaymentHoldingCids: string[];
    repayAmount: string;
    // Transfer factory + context for the debt-asset repayment (liquidator → pool).
    transferFactoryCid: string;
    choiceContext: { values: Record<string, unknown> };
    // Transfer factory + context for the collateral seize (pool → liquidator).
    collateralTransferFactoryCid: string;
    collateralChoiceContext: { values: Record<string, unknown> };
    // Fresh pool collateral holdings for ephemeral assets (CC); null = use stored.
    freshCollateralHoldingCids: string[] | null;
    // The borrower's UserPosition (for the on-chain HF recompute over their basket).
    borrowerPositionCid: string;
    // Current CIDs of all OTHER reserves backing the borrower's positions (for HF).
    accountReserveCids: string[];
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
          choice: 'LiquidateTS',
          choiceArgument: {
            liquidator: params.liquidator,
            borrower: params.borrower,
            borrowPositionCid: params.borrowPositionCid,
            debtAssetReserveCid: params.debtAssetReserveCid,
            collateralDepositCid: params.collateralDepositCid,
            collateralAssetReserveCid: params.collateralAssetReserveCid,
            repaymentHoldingCids: params.repaymentHoldingCids,
            repayAmount: params.repayAmount,
            transferFactoryCid: params.transferFactoryCid,
            collateralTransferFactoryCid: params.collateralTransferFactoryCid,
            freshCollateralHoldingCids: params.freshCollateralHoldingCids,
            borrowerPositionCid: params.borrowerPositionCid,
            accountReserveCids: params.accountReserveCids,
            choiceContext: params.choiceContext,
            collateralChoiceContext: params.collateralChoiceContext,
            featuredAppRightCid: params.featuredAppRightCid,
          },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}
