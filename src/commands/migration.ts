import { LENDING_PACKAGE_ID } from '../config';
import type { TransactionPayload } from '../loop/provider';
import type { DisclosedContract } from '../types';

/** TEST-ONLY. Archive the caller's own UserPosition registry so the party can be migrated fresh.
 *  `UserPosition` has `signatory user` (poolOperator is only an observer), so the plain `Archive`
 *  choice is controllable by the user alone — Loop can sign it with no operator involvement.
 *
 *  DANGER: only safe on an EMPTY registry. Archiving a populated one orphans its Deposit/Borrow
 *  positions — they survive on-ledger but become unreachable, because every user action requires the
 *  registry CID. Callers MUST check supplyPositionCids/borrowPositionCids are empty first.
 *  Not for production. */
export function buildArchiveUserPositionCommand(userPositionCid: string): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: `${LENDING_PACKAGE_ID}:Lending.UserPosition:UserPosition`,
          contractId: userPositionCid,
          choice: 'Archive',
          choiceArgument: {},
        },
      },
    ],
    disclosedContracts: [],
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}

/** Accept a MigrationSnapshot with one Loop-wallet signature. Single-controller (`user`);
 *  the operator's authority is propagated because it's the snapshot's signatory. `reserveCids`
 *  are the CURRENT CIDs of every reserve the snapshot references (passed fresh at accept time
 *  so stale-CID drift can't break it). Materializes UserPosition + Deposit/Borrow positions
 *  and bumps the reserve totals atomically — no tokens move (treasury already holds them). */
export function buildMigrationAcceptCommand(
  args: { snapshotCid: string; reserveCids: string[] },
  disclosedContracts: DisclosedContract[] = []
): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: `${LENDING_PACKAGE_ID}:Lending.Migration:MigrationSnapshot`,
          contractId: args.snapshotCid,
          choice: 'MigrationAccept',
          choiceArgument: { reserveCids: args.reserveCids },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}
