import { useState, useCallback } from 'react';
import type { LoopProvider } from '../loop/provider';

export function useContracts(provider: LoopProvider | null) {
  const [contracts, setContracts] = useState<{ template_id: string; contract_id: string; [k: string]: unknown }[]>([]);
  const [holdings, setHoldings] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const queryByTemplate = useCallback(
    async (templateId: string) => {
      if (!provider) return;
      setLoading(true);
      setError('');
      try {
        const result = await provider.getActiveContracts({ templateId });
        setContracts(result);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return [];
      } finally {
        setLoading(false);
      }
    },
    [provider]
  );

  const queryByInterface = useCallback(
    async (interfaceId: string) => {
      if (!provider) return;
      setLoading(true);
      setError('');
      try {
        const result = await provider.getActiveContracts({ interfaceId });
        setContracts(result);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return [];
      } finally {
        setLoading(false);
      }
    },
    [provider]
  );

  const fetchHoldings = useCallback(async () => {
    if (!provider) return;
    setLoading(true);
    setError('');
    try {
      const result = await provider.getHolding();
      setHoldings(result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return [];
    } finally {
      setLoading(false);
    }
  }, [provider]);

  return {
    contracts,
    holdings,
    loading,
    error,
    queryByTemplate,
    queryByInterface,
    fetchHoldings,
  };
}
