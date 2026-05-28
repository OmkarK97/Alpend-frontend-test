import { useState, useCallback, useEffect, useRef } from 'react';
import type { LoopProvider } from '../loop/provider';
import { ADMIN_API_URL, USDCX_HOLDING_INTERFACE_ID } from '../config';
import type {
  PositionData,
  DepositPosition,
  BorrowPosition,
  UsdcxHolding,
} from '../types';

export function usePosition(
  provider: LoopProvider | null,
  partyId: string
): PositionData {
  const [poolCid, setPoolCid] = useState('');
  const [assetReserveCid, setAssetReserveCid] = useState('');
  const [userPositionCid, setUserPositionCid] = useState('');
  const [depositPositions, setDepositPositions] = useState<DepositPosition[]>(
    []
  );
  const [borrowPositions, setBorrowPositions] = useState<BorrowPosition[]>([]);
  const [usdcxHoldings, setUsdcxHoldings] = useState<UsdcxHolding[]>([]);
  const [totalSupplied, setTotalSupplied] = useState('0.00');
  const [totalBorrowed, setTotalBorrowed] = useState('0.00');
  const [totalCollateral, setTotalCollateral] = useState('0.00');
  const [totalWeightedCollateralUSD, setTotalWeightedCollateralUSD] = useState('0.00');
  const [totalLiqThresholdCollateralUSD, setTotalLiqThresholdCollateralUSD] = useState('0.00');
  const [healthFactor, setHealthFactor] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState('0.00');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUserPosition, setHasUserPosition] = useState(false);
  const fetched = useRef(false);

  const fetchHoldings = useCallback(async () => {
    if (!provider) return;

    // Helper to parse active contract entries from Loop SDK responses
    const parseHoldings = (result: unknown[]): UsdcxHolding[] => {
      return result
        .map((item: unknown) => {
          // Loop SDK can return flat objects or nested contractEntry objects
          const flat = item as {
            contract_id?: string;
            template_id?: string;
            instrument_id?: { id?: string };
            payload?: {
              amount?: { initialAmount?: string } | string;
              owner?: string;
              instrumentId?: { id?: string; admin?: string };
            };
          };
          const nested = item as {
            contractEntry?: {
              JsActiveContract?: {
                createdEvent?: {
                  contractId?: string;
                  templateId?: string;
                  packageName?: string;
                  createArgument?: {
                    amount?: { initialAmount?: string } | string;
                    owner?: string;
                    instrument?: { id?: string };
                    instrumentId?: { id?: string };
                  };
                  interfaceViews?: Array<{
                    viewValue?: { amount?: string; owner?: string };
                  }>;
                };
              };
            };
          };
          const ce = nested?.contractEntry?.JsActiveContract?.createdEvent;

          // Get contractId from either format
          const contractId = flat.contract_id || ce?.contractId || '';

          // Get amount
          let amount = '0';
          if (ce) {
            const rawAmt = ce.createArgument?.amount;
            amount =
              typeof rawAmt === 'object'
                ? (rawAmt as { initialAmount?: string })?.initialAmount || '0'
                : ce?.interfaceViews?.[0]?.viewValue?.amount ||
                  rawAmt?.toString() || '0';
          } else if (flat.payload) {
            const rawAmt = flat.payload.amount;
            amount =
              typeof rawAmt === 'object'
                ? (rawAmt as { initialAmount?: string })?.initialAmount || '0'
                : rawAmt?.toString() || '0';
          }

          // Get instrument ID for filtering
          const instrumentId =
            flat.instrument_id?.id ||
            flat.payload?.instrumentId?.id ||
            ce?.createArgument?.instrument?.id ||
            ce?.createArgument?.instrumentId?.id || '';

          const templateId = flat.template_id || ce?.templateId || '';
          const packageName = (ce as { packageName?: string })?.packageName || '';

          return { contractId, amount, instrumentId, templateId, packageName, owner: ce?.createArgument?.owner || flat.payload?.owner || partyId };
        })
        .filter((h) => {
          if (!h.contractId) return false;
          if (h.packageName === 'splice-amulet') return false;
          if (h.templateId?.includes('Splice.Amulet')) return false;
          if (h.instrumentId && h.instrumentId !== 'USDCx') return false;
          return true;
        })
        .map((h) => ({
          contractId: h.contractId,
          amount: h.amount,
          owner: h.owner,
        }));
    };

    // Strategy 1: Try getActiveContracts with interface ID (# prefix format from SDK docs)
    const interfaceIds = [
      '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
      USDCX_HOLDING_INTERFACE_ID,
    ];
    for (const iid of interfaceIds) {
      try {
        const loopResult = await provider.getActiveContracts({ interfaceId: iid });
        const holdings = parseHoldings(loopResult as unknown[]);
        if (holdings.length > 0) {
          console.log('Strategy 1: got', holdings.length, 'holdings via interfaceId', iid);
          setUsdcxHoldings(holdings);
          setWalletBalance(holdings.reduce((s, h) => s + parseFloat(h.amount), 0).toFixed(10));
          return;
        }
      } catch {
        console.warn('Strategy 1 failed for interfaceId:', iid);
      }
    }

    // Strategy 2: Try getActiveContracts by templateId (USDCx Holding template)
    const templateIds = [
      '#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding',
      '112742269c282ab77490b7933f65582bc223e3bf6c120d81e0799cf0d99ecd9e:Utility.Registry.Holding.V0.Holding:Holding',
    ];
    for (const tid of templateIds) {
      try {
        const loopResult = await provider.getActiveContracts({ templateId: tid });
        const holdings = parseHoldings(loopResult as unknown[]);
        if (holdings.length > 0) {
          console.log('Strategy 2: got', holdings.length, 'holdings via templateId', tid);
          setUsdcxHoldings(holdings);
          setWalletBalance(holdings.reduce((s, h) => s + parseFloat(h.amount), 0).toFixed(10));
          return;
        }
      } catch {
        console.warn('Strategy 2 failed for templateId:', tid);
      }
    }

    // Strategy 3: Fallback to getHolding() — has balance but may lack contractIds
    try {
      const holdingResult = await provider.getHolding();
      const usdcxEntries = (holdingResult as unknown[]).filter((h: unknown) => {
        const entry = h as { instrument_id?: { id?: string } };
        return entry?.instrument_id?.id === 'USDCx';
      });

      if (usdcxEntries.length > 0) {
        // Log all keys so we can find where CIDs are stored
        for (const entry of usdcxEntries) {
          console.log('Strategy 3: USDCx entry keys:', Object.keys(entry as object));
          console.log('Strategy 3: USDCx entry full:', JSON.stringify(entry, null, 2));
        }

        const holdings: UsdcxHolding[] = usdcxEntries.map((h: unknown) => {
          const entry = h as Record<string, unknown>;
          // Try every plausible field name for contract IDs
          const contractId =
            (entry.contract_id as string) ||
            (entry.contractId as string) ||
            (entry.cid as string) ||
            '';
          const holdingCids =
            (entry.holding_cids as string[]) ||
            (entry.holdingCids as string[]) ||
            (entry.holding_contract_ids as string[]) ||
            (entry.unlocked_holdings as string[]) ||
            (entry.coins as Array<{ contract_id?: string }>)?.map(
              (c) => c.contract_id || ''
            ) ||
            null;
          return {
            contractId,
            amount:
              (entry.total_unlocked_coin as string) ||
              (entry.amount as string) ||
              '0',
            owner: partyId,
            holdingCids,
          };
        });

        // Gather all CIDs from any source
        const allCids: string[] = [];
        for (const h of holdings) {
          if (h.contractId) allCids.push(h.contractId);
          const extra = (h as { holdingCids?: string[] | null }).holdingCids;
          if (extra) allCids.push(...extra.filter(Boolean));
        }

        const total = holdings.reduce((s, h) => s + parseFloat(h.amount), 0);

        if (allCids.length > 0) {
          const perCid = total / allCids.length;
          const cidsHoldings: UsdcxHolding[] = allCids.map((cid) => ({
            contractId: cid,
            amount: perCid.toString(),
            owner: partyId,
          }));
          setUsdcxHoldings(cidsHoldings);
          setWalletBalance(total.toFixed(10));
          console.log('Strategy 3: got', allCids.length, 'holding CIDs');
          return;
        }

        // Got balance but no CIDs — show balance but holdings can't be used for tx
        setWalletBalance(total.toFixed(10));
        console.warn('Strategy 3: got balance', total, 'but no contractIds — supply will not work');
        console.warn('Strategy 3: Available fields were:', usdcxEntries.map((e) => Object.keys(e as object)));
      }
    } catch {
      console.warn('Strategy 3 (getHolding) also failed');
    }
  }, [provider, partyId]);

  const initialLoadDone = useRef(false);

  const refresh = useCallback(async () => {
    if (!partyId) return;
    // Only show loading skeleton on initial load, not on refresh.
    // Setting loading=true during refresh unmounts modals and destroys their state.
    if (!initialLoadDone.current) setLoading(true);
    setError(null);

    // Fetch holdings from Loop SDK independently (doesn't need backend)
    const holdingsPromise = fetchHoldings();

    // Fetch position data from backend
    try {
      const [poolResp, reserveResp, userPosResp, depositResp, borrowResp] =
        await Promise.all([
          fetch(`${ADMIN_API_URL}/query/lending-pool`).then((r) => r.json()).catch(() => ({ contracts: [] })),
          fetch(`${ADMIN_API_URL}/admin/asset-reserves`).then((r) => r.json()).catch(() => ({ contracts: [] })),
          fetch(
            `${ADMIN_API_URL}/query/user-position/${encodeURIComponent(partyId)}`
          ).then((r) => r.json()).catch(() => ({ contracts: [] })),
          fetch(
            `${ADMIN_API_URL}/query/deposit-position/${encodeURIComponent(partyId)}`
          )
            .then((r) => r.json())
            .catch(() => ({ contracts: [] })),
          fetch(
            `${ADMIN_API_URL}/query/borrow-position/${encodeURIComponent(partyId)}`
          )
            .then((r) => r.json())
            .catch(() => ({ contracts: [] })),
        ]);

      // Pool
      const latestPool =
        poolResp.contracts?.[poolResp.contracts.length - 1];
      if (latestPool) setPoolCid(latestPool.contractId);

      // Asset reserve (USDCx)
      const usdcxReserves =
        reserveResp.contracts?.filter(
          (c: { createArgument?: { instrumentAdmin?: string } }) =>
            c.createArgument?.instrumentAdmin?.startsWith(
              'decentralized-usdc'
            )
        ) || [];
      const latestReserve =
        usdcxReserves.length > 0
          ? usdcxReserves[usdcxReserves.length - 1]
          : null;
      if (latestReserve) setAssetReserveCid(latestReserve.contractId);

      // User position
      const userPosFiltered =
        userPosResp.contracts?.filter(
          (c: { createArgument?: { user?: string } }) =>
            c.createArgument?.user === partyId
        ) || [];
      const latestUserPos =
        userPosFiltered.length > 0
          ? userPosFiltered[userPosFiltered.length - 1]
          : userPosResp.contracts?.[userPosResp.contracts?.length - 1];

      if (latestUserPos) {
        setUserPositionCid(latestUserPos.contractId);
        setHasUserPosition(true);
        const args = latestUserPos.createArgument || {};
        setTotalSupplied(args.totalSuppliedUSD || '0.00');
        setTotalBorrowed(args.totalBorrowedUSD || '0.00');
        setTotalCollateral(args.totalCollateralUSD || '0.00');
        setTotalWeightedCollateralUSD(args.totalWeightedCollateralUSD || '0.00');
        setTotalLiqThresholdCollateralUSD(args.totalLiqThresholdCollateralUSD || '0.00');

        // Health factor — treat dust amounts (< $0.01) as zero
        const borrowed = parseFloat(args.totalBorrowedUSD || '0');
        const liqThreshold = parseFloat(
          args.totalLiqThresholdCollateralUSD || '0'
        );
        if (borrowed > 0.01 && liqThreshold > 0) {
          setHealthFactor((liqThreshold / borrowed).toFixed(2));
        } else {
          setHealthFactor(null);
        }
      } else {
        setHasUserPosition(false);
      }

      // Deposit positions — filter to only those tracked by the current UserPosition
      const trackedSupplyCids = latestUserPos?.createArgument?.supplyPositionCids || [];
      const allDeposits: DepositPosition[] = (
        depositResp.contracts || []
      ).map(
        (c: {
          contractId: string;
          createArgument: {
            principal?: string;
            instrumentId?: { admin: string; id: string };
            isUsedAsCollateral?: boolean;
            liquidityIndex?: string;
          };
        }) => ({
          cid: c.contractId,
          principal: c.createArgument?.principal || '0',
          instrumentId: c.createArgument?.instrumentId || {
            admin: '',
            id: '',
          },
          isUsedAsCollateral: c.createArgument?.isUsedAsCollateral ?? true,
          liquidityIndex: c.createArgument?.liquidityIndex || '1.0',
        })
      );
      const deposits = (trackedSupplyCids.length > 0
        ? allDeposits.filter((d: DepositPosition) => trackedSupplyCids.includes(d.cid))
        : allDeposits
      ).filter((d) => parseFloat(d.principal) > 0);
      deposits.sort((a, b) => parseFloat(b.principal) - parseFloat(a.principal));
      setDepositPositions(deposits);

      // Borrow positions — filter to only those tracked by the current UserPosition
      const trackedBorrowCids = latestUserPos?.createArgument?.borrowPositionCids || [];
      const allBorrows: BorrowPosition[] = (
        borrowResp.contracts || []
      ).map(
        (c: {
          contractId: string;
          createArgument: {
            borrowedAmount?: string;
            principal?: string;
            instrumentId?: { admin: string; id: string };
            borrowIndex?: string;
            lockedCollateralCid?: string;
          };
        }) => ({
          cid: c.contractId,
          principal: c.createArgument?.borrowedAmount || c.createArgument?.principal || '0',
          instrumentId: c.createArgument?.instrumentId || {
            admin: '',
            id: '',
          },
          borrowIndex: c.createArgument?.borrowIndex || '1.0',
          lockedCollateralCid:
            c.createArgument?.lockedCollateralCid || '',
        })
      );
      const borrows = (trackedBorrowCids.length > 0
        ? allBorrows.filter((b: BorrowPosition) => trackedBorrowCids.includes(b.cid))
        : allBorrows
      ).filter((b) => parseFloat(b.principal) > 0);
      borrows.sort((a, b) => parseFloat(b.principal) - parseFloat(a.principal));
      setBorrowPositions(borrows);

      // Compute totals from deposit/borrow positions directly
      // This is more reliable than the UserPosition aggregates which may lag
      const depositsTotal = deposits.reduce(
        (sum, d) => sum + parseFloat(d.principal),
        0
      );
      const borrowsTotal = borrows.reduce(
        (sum, b) => sum + parseFloat(b.principal),
        0
      );
      if (depositsTotal > 0) {
        setTotalSupplied(depositsTotal.toFixed(10));
        setTotalCollateral(
          deposits
            .filter((d) => d.isUsedAsCollateral)
            .reduce((sum, d) => sum + parseFloat(d.principal), 0)
            .toFixed(10)
        );
      }
      // Always set borrow total from filtered positions (overrides UserPosition dust values)
      setTotalBorrowed(borrowsTotal > 0 ? borrowsTotal.toFixed(10) : '0.00');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to fetch position data'
      );
    }

    // Wait for holdings to finish too
    await holdingsPromise;
    setLoading(false);
    initialLoadDone.current = true;
  }, [partyId, provider, fetchHoldings]);

  useEffect(() => {
    if (partyId && provider && !fetched.current) {
      fetched.current = true;
      refresh();
    }
  }, [partyId, provider, refresh]);

  // Reset when disconnected
  useEffect(() => {
    if (!partyId) {
      fetched.current = false;
    }
  }, [partyId]);

  return {
    poolCid,
    assetReserveCid,
    userPositionCid,
    depositPositions,
    borrowPositions,
    usdcxHoldings,
    totalSupplied,
    totalBorrowed,
    totalCollateral,
    totalWeightedCollateralUSD,
    totalLiqThresholdCollateralUSD,
    healthFactor,
    walletBalance,
    loading,
    error,
    hasUserPosition,
    refresh,
  };
}
