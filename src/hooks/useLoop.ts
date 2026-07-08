import { useState, useCallback, useRef, useEffect } from 'react';
import { PaymentRequiredError } from '@fivenorth/loop-sdk';
import {
  initLoop,
  connectLoop,
  logoutLoop,
  type LoopProvider,
  type RunTransactionResponse,
  type TransactionPayload,
} from '../loop/provider';
import type { TransactionLog } from '../types';

export type SubmitTxOptions = {
  estimateTraffic?: boolean;
};

// Extract update_id from various possible result shapes
function extractUpdateId(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const r = obj as Record<string, unknown>;
  // Direct: result.update_id or result.updateId
  if (typeof r.update_id === 'string') return r.update_id;
  if (typeof r.updateId === 'string') return r.updateId;
  // Nested under payload: result.payload.update_id
  if (r.payload && typeof r.payload === 'object') {
    const p = r.payload as Record<string, unknown>;
    if (typeof p.update_id === 'string') return p.update_id;
    if (typeof p.updateId === 'string') return p.updateId;
    if (p.update_data && typeof p.update_data === 'object') {
      const ud = p.update_data as Record<string, unknown>;
      if (typeof ud.updateId === 'string') return ud.updateId;
      if (typeof ud.update_id === 'string') return ud.update_id;
    }
  }
  // Nested under update_data directly
  if (r.update_data && typeof r.update_data === 'object') {
    const ud = r.update_data as Record<string, unknown>;
    if (typeof ud.updateId === 'string') return ud.updateId;
    if (typeof ud.update_id === 'string') return ud.update_id;
  }
  return undefined;
}

export function useLoop() {
  const [provider, setProvider] = useState<LoopProvider | null>(null);
  const [partyId, setPartyId] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [logs, setLogs] = useState<TransactionLog[]>([]);
  const initialized = useRef(false);
  // Capture the latest update_id from onTransactionUpdate callback
  const lastTxUpdateRef = useRef<{ updateId: string; resolve?: (id: string) => void } | null>(null);

  const addLog = useCallback(
    (
      operation: string,
      status: TransactionLog['status'],
      message: string,
      details?: unknown,
      updateId?: string
    ) => {
      setLogs((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          timestamp: new Date().toISOString(),
          operation,
          status,
          message,
          details,
          updateId,
        },
        ...prev,
      ]);
    },
    []
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    initLoop({
      onAccept: (p: LoopProvider) => {
        setProvider(p);
        setPartyId(p.party_id);
        setIsConnecting(false);
        addLog('connect', 'success', `Connected as ${p.party_id}`);
      },
      onReject: () => {
        setIsConnecting(false);
        addLog('connect', 'error', 'Connection rejected by user');
      },
      onTransactionUpdate: (payload: RunTransactionResponse) => {
        console.log('[useLoop] onTransactionUpdate fired:', JSON.stringify({ status: payload.status, update_id: payload.update_id, command_id: payload.command_id }, null, 2));
        const updateId = payload.update_id || extractUpdateId(payload);
        console.log('[useLoop] extracted updateId from callback:', updateId);
        if (payload.status === 'failed') {
          console.log('[useLoop] callback status=failed, NOT resolving promise');
          addLog(
            'tx-update',
            'error',
            payload.error?.error_message || 'Transaction failed',
            payload
          );
          // Reject pending promise on failure so submitTx doesn't hang
          if (lastTxUpdateRef.current?.resolve) {
            lastTxUpdateRef.current.resolve('');
          }
        } else {
          addLog('tx-update', 'success', `Update: ${updateId || payload.command_id}`, payload, updateId);
          console.log('[useLoop] callback status=success, has pending resolve?', !!lastTxUpdateRef.current?.resolve);
          if (lastTxUpdateRef.current?.resolve) {
            lastTxUpdateRef.current.resolve(updateId || '');
            lastTxUpdateRef.current = { updateId: updateId || '' };
          } else {
            lastTxUpdateRef.current = { updateId: updateId || '' };
          }
        }
      },
    });
  }, [addLog]);

  const connect = useCallback(() => {
    setIsConnecting(true);
    connectLoop();
  }, []);

  const disconnect = useCallback(() => {
    logoutLoop();
    setProvider(null);
    setPartyId('');
    addLog('disconnect', 'success', 'Disconnected');
  }, [addLog]);

  const submitTx = useCallback(
    async (operation: string, payload: TransactionPayload, message: string, options?: SubmitTxOptions) => {
      if (!provider) throw new Error('Not connected');
      console.log('[submitTx] START operation:', operation, 'message:', message);
      addLog(operation, 'pending', `Submitting: ${message}`);

      // The Loop SDK's submitAndWaitForTransaction may never resolve —
      // the actual result comes via the onTransactionUpdate WebSocket callback.
      // Set up a promise that the callback will resolve, and race it against the SDK promise.
      const callbackPromise = new Promise<{ source: 'callback'; updateId: string }>((resolve) => {
        console.log('[submitTx] setting up callback promise');
        lastTxUpdateRef.current = {
          updateId: '',
          resolve: (id: string) => {
            console.log('[submitTx] callback promise RESOLVED with updateId:', id);
            resolve({ source: 'callback', updateId: id });
          },
        };
      });

      // Timeout: if neither resolves in 60s, give up
      const timeoutPromise = new Promise<{ source: 'timeout'; updateId: string }>((resolve) => {
        setTimeout(() => {
          console.log('[submitTx] TIMEOUT after 60s');
          resolve({ source: 'timeout', updateId: '' });
        }, 60000);
      });

      // Wrap the SDK call so we can race it
      const sdkPromise = provider.submitAndWaitForTransaction(payload, {
        message,
        estimateTraffic: options?.estimateTraffic ?? true,
      }).then((result) => {
        console.log('[submitTx] SDK promise RESOLVED, result type:', typeof result, 'keys:', result ? Object.keys(result as object) : 'null');
        return {
          source: 'sdk' as const,
          updateId: extractUpdateId(result) || '',
          result,
        };
      }).catch((err) => {
        console.log('[submitTx] SDK promise REJECTED:', err);
        throw err;
      });

      try {
        console.log('[submitTx] racing SDK vs callback vs timeout...');
        // Race: SDK resolution vs callback vs timeout
        const winner = await Promise.race([sdkPromise, callbackPromise, timeoutPromise]);
        console.log('[submitTx] race winner:', winner.source, 'updateId:', winner.updateId);

        let txUpdateId = winner.updateId;

        // If SDK won but had no updateId, check if callback already fired
        if (!txUpdateId && lastTxUpdateRef.current?.updateId) {
          txUpdateId = lastTxUpdateRef.current.updateId;
          console.log('[submitTx] got updateId from ref fallback:', txUpdateId);
        }

        if (winner.source === 'timeout') {
          throw new Error('Transaction timed out — check Activity log for status');
        }

        console.log('[submitTx] SUCCESS, returning updateId:', txUpdateId);
        addLog(operation, 'success', `Completed: ${message}`, undefined, txUpdateId || undefined);
        return { _extractedUpdateId: txUpdateId };
      } catch (err) {
        console.log('[submitTx] CATCH block, error:', err);
        // 0.12+ after-execution gas model: the SDK throws PaymentRequiredError (402)
        // when network gas is due. Surface a clear message rather than a raw 402.
        // (Paying it is a server-SDK concern — checkDueGas/payGas — not the client.)
        let errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof PaymentRequiredError) {
          errMsg = `Network gas payment required before this action can settle. ${err.message || ''}`.trim();
        }
        addLog(operation, 'error', `Failed: ${errMsg}`, err);
        throw err;
      }
    },
    [provider, addLog]
  );

  return {
    provider,
    partyId,
    isConnecting,
    isConnected: !!provider,
    connect,
    disconnect,
    submitTx,
    logs,
    addLog,
  };
}
