import type { DisclosedContract } from '../types';

/**
 * Single normalizer for every DisclosedContract that leaves this app.
 *
 * Disclosures reach us from several sources (Scan's Amulet registry, the DA Utility
 * registry, our own admin endpoints) and each shapes them slightly differently. Two
 * fields have repeatedly broken submissions:
 *
 *  - `templateId` empty string  -> ledger rejects: "Invalid identifier format ()
 *    not matching the expected format (<package>:<moduleName>:<entityName>)".
 *  - `templateId` present but naming a package version THIS participant does not have
 *    (Scan stamps the current splice-amulet, e.g. fb10433a…, while our node may hold
 *    6e9fc50f…) -> JSON_API_PACKAGE_SELECTION_FAILED "Package-id … not known".
 *
 * `createdEventBlob` is self-describing, so `templateId` is optional metadata. The safe
 * rule is: keep it only when it is a well-formed identifier, drop it otherwise. Dropping
 * lets the participant resolve the contract with whatever compatible version it has.
 *
 * Applied centrally in useLoop.submitTx, so no call site can reintroduce the bug.
 */
const WELL_FORMED = /^[^:]+:[^:]+:[^:]+$/;

export function normalizeDisclosed(dc: DisclosedContract): DisclosedContract {
  const domain = dc.domainId || dc.synchronizerId;
  return {
    contractId: dc.contractId,
    createdEventBlob: dc.createdEventBlob,
    ...(dc.templateId && WELL_FORMED.test(dc.templateId) ? { templateId: dc.templateId } : {}),
    ...(domain ? { domainId: domain, synchronizerId: domain } : {}),
  };
}

/** Normalize a list, dropping entries that cannot be disclosed at all. */
export function normalizeDisclosedList(list?: DisclosedContract[]): DisclosedContract[] {
  return (list || [])
    .filter((dc) => dc && dc.contractId && dc.createdEventBlob)
    .map(normalizeDisclosed);
}
