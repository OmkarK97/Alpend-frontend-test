import { loop } from '@fivenorth/loop-sdk';
import type { Network, RunTransactionResponse, TransactionPayload } from '@fivenorth/loop-sdk';
import { NETWORK } from '../config';

// Re-export the Provider class type via the onAccept callback pattern
// since Provider is not directly exported from the main entry point
export type LoopProvider = {
  party_id: string;
  public_key: string;
  email?: string;
  getHolding: () => Promise<{ instrument_id: { admin: string; id: string }; total_unlocked_coin: string; [k: string]: unknown }[]>;
  getActiveContracts: (params?: { templateId?: string; interfaceId?: string }) => Promise<{ template_id: string; contract_id: string; [k: string]: unknown }[]>;
  submitTransaction: (payload: TransactionPayload, options?: SubmitOptions) => Promise<unknown>;
  submitAndWaitForTransaction: (payload: TransactionPayload, options?: SubmitOptions) => Promise<unknown>;
  signMessage: (message: string) => Promise<unknown>;
};

type SubmitOptions = {
  requestTimeout?: number;
  message?: string;
  estimateTraffic?: boolean;
  executionMode?: 'async' | 'wait';
};

export type { RunTransactionResponse, TransactionPayload };

export function initLoop(callbacks: {
  onAccept: (provider: LoopProvider) => void;
  onReject: () => void;
  onTransactionUpdate: (payload: RunTransactionResponse, message: unknown) => void;
}) {
  loop.init({
    appName: 'Lending Loop Test Harness',
    network: NETWORK as Network,
    onTransactionUpdate: callbacks.onTransactionUpdate as (payload: RunTransactionResponse, message: any) => void,
    options: {
      openMode: 'popup',
      requestSigningMode: 'popup',
    },
    onAccept: callbacks.onAccept as (provider: any) => void,
    onReject: callbacks.onReject,
  });
}

export function connectLoop() {
  loop.connect();
}

/** Restore a previously-approved session (the SDK persists it to localStorage) so a page
 *  refresh doesn't force the user to reconnect. On success it fires the SAME `onAccept`
 *  callback passed to initLoop, so the normal connect path handles it.
 *
 *  Throws when there's no stored/valid session — that's the ordinary "first visit" case, so
 *  callers should swallow it rather than surface an error. */
export function autoConnectLoop(): Promise<void> {
  return loop.autoConnect();
}

export function logoutLoop() {
  loop.logout();
}
