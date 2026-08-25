import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

export function buildInitializeUserPositionCommand(
  poolCid: string,
  user: string,
  // TN-13/RA-07: InitializeUserPosition CONSUMES a one-shot PoolAccess token minted by
  // GrantPoolAccess (maintenanceOperator). It is the on-ledger guarantee of
  // one-registry-per-user, so the cid is required — omitting it fails preprocessing with
  // "Missing non-optional fields: Set(poolAccessCid)".
  poolAccessCid: string,
  disclosedContracts: DisclosedContract[] = []
): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.lendingPool,
          contractId: poolCid,
          choice: 'InitializeUserPosition',
          choiceArgument: { user, poolAccessCid },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}
