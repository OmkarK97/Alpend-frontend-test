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
/**
 * REMOVED — a UserPosition can never be archived.
 *
 * TN-03 made the registry `signatory user, poolOperator` and gave it NO archive choice,
 * precisely because a user archiving their own registry made `LiquidateTS` abort at `fetch`
 * (permanent liquidation immunity). Co-signing is also what makes NEW-03's
 * one-canonical-registry-per-user rule enforceable.
 *
 * Any "reset registry" flow is therefore impossible by design, not merely unimplemented.
 * To test migration with a clean party, use a party that has never initialised.
 */
export function buildArchiveUserPositionCommand(_userPositionCid: string): never {
  throw new Error(
    'UserPosition cannot be archived (TN-03: signatory user + poolOperator, no archive choice). ' +
    'Use a party that has never initialised instead.'
  );
}

/** Accept a MigrationSnapshot with one Loop-wallet signature. Single-controller (`user`);
 *  the operator's authority is propagated because it's the snapshot's signatory. `reserveCids`
 *  are the CURRENT CIDs of every reserve the snapshot references (passed fresh at accept time
 *  so stale-CID drift can't break it). Materializes UserPosition + Deposit/Borrow positions
 *  and bumps the reserve totals atomically — no tokens move (treasury already holds them). */
export function buildMigrationAcceptCommand(
  // RA-07: MigrationAccept CONSUMES a one-shot PoolAccess token (asserts registryInitialized
  // == False, recreates it True). That is the on-ledger one-registry-per-user guarantee, so the
  // cid is required — omitting it fails preprocessing with "Missing non-optional fields".
  args: { snapshotCid: string; reserveCids: string[]; poolAccessCid: string },
  disclosedContracts: DisclosedContract[] = []
): TransactionPayload {
  return {
    commands: [
      {
        ExerciseCommand: {
          templateId: `${LENDING_PACKAGE_ID}:Lending.Migration:MigrationSnapshot`,
          contractId: args.snapshotCid,
          choice: 'MigrationAccept',
          choiceArgument: { reserveCids: args.reserveCids, poolAccessCid: args.poolAccessCid },
        },
      },
    ],
    disclosedContracts,
    packageIdSelectionPreference: [LENDING_PACKAGE_ID],
  };
}
