import { TEMPLATES, LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

export function buildAddObserverCommand(poolCid: string, newObserver: string): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.lendingPool,
          contractId: poolCid,
          choice: 'AddObserver',
          choiceArgument: { newObserver },
        },
      },
    ],
    disclosedContracts: [],
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}

export function buildInitializeUserPositionCommand(
  poolCid: string,
  user: string,
  disclosedContracts: DisclosedContract[] = []
): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: TEMPLATES.lendingPool,
          contractId: poolCid,
          choice: 'InitializeUserPosition',
          choiceArgument: { user },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}
