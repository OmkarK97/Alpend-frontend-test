import { useState, useCallback, useEffect, useRef } from 'react';
import type { LoopProvider } from '../loop/provider';
import { ADMIN_API_URL, USDCX_HOLDING_INTERFACE_ID } from '../config';
import type {
  PositionData,
  DepositPosition,
  BorrowPosition,
  UsdcxHolding,
  CcHolding,
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
  const [ccHoldings, setCcHoldings] = useState<CcHolding[]>([]);
  const [ccAssetReserveCid, setCcAssetReserveCid] = useState('');
  const [ccWalletBalance, setCcWalletBalance] = useState('0.00');
  const [totalSupplied, setTotalSupplied] = useState('0.00');
  const [totalBorrowed, setTotalBorrowed] = useState('0.00');
  const [totalCollateral, setTotalCollateral] = useState('0.00');
  const [totalWeightedCollateralUSD, setTotalWeightedCollateralUSD] = useState('0.00');
  const [totalLiqThresholdCollateralUSD, setTotalLiqThresholdCollateralUSD] = useState('0.00');
  const [usdcxSupplied, setUsdcxSupplied] = useState('0.00');
  const [usdcxBorrowed, setUsdcxBorrowed] = useState('0.00');
  const [ccSupplied, setCcSupplied] = useState('0.00');
  const [ccBorrowed, setCcBorrowed] = useState('0.00');
  const [healthFactor, setHealthFactor] = useState<string | null>(null);
  const [assetInfo, setAssetInfo] = useState<
    Record<string, { price: number; ltv: number; liqThreshold: number }>
  >({});
  const [walletBalance, setWalletBalance] = useState('0.00');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUserPosition, setHasUserPosition] = useState(false);
  const fetched = useRef(false);

  const fetchHoldings = useCallback(async (): Promise<{
    usdcx: { contractId: string; amount: string; owner: string }[];
    cc: { contractId: string; amount: string; owner: string }[];
  } | null> => {
    if (!provider) return null;

    // Parsed holding with metadata for splitting into USDCx vs CC
    type ParsedHolding = {
      contractId: string;
      amount: string;
      owner: string;
      instrumentId: string;
      templateId: string;
      packageName: string;
    };

    // Helper to parse active contract entries from Loop SDK responses
    const parseAllHoldings = (result: unknown[]): ParsedHolding[] => {
      return result
        .map((item: unknown) => {
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

          const contractId = flat.contract_id || ce?.contractId || '';

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

          const instrumentId =
            flat.instrument_id?.id ||
            flat.payload?.instrumentId?.id ||
            ce?.createArgument?.instrument?.id ||
            ce?.createArgument?.instrumentId?.id || '';

          const templateId = flat.template_id || ce?.templateId || '';
          const packageName = (ce as { packageName?: string })?.packageName || '';

          return { contractId, amount, instrumentId, templateId, packageName, owner: ce?.createArgument?.owner || flat.payload?.owner || partyId };
        })
        .filter((h) => !!h.contractId);
    };

    const setHoldingsFromParsed = (allHoldings: ParsedHolding[]) => {
      // USDCx: exclude Amulet, keep USDCx or unknown instrument
      const usdcx = allHoldings
        .filter((h) => {
          if (h.packageName === 'splice-amulet') return false;
          if (h.templateId?.includes('Splice.Amulet')) return false;
          if (h.instrumentId && h.instrumentId !== 'USDCx') return false;
          return true;
        })
        .map((h) => ({ contractId: h.contractId, amount: h.amount, owner: h.owner }));

      // CC: Amulet holdings
      const cc = allHoldings
        .filter((h) =>
          h.packageName === 'splice-amulet' ||
          h.templateId?.includes('Splice.Amulet') ||
          h.instrumentId === 'Amulet'
        )
        .map((h) => ({ contractId: h.contractId, amount: h.amount, owner: h.owner }));

      // Set UNCONDITIONALLY. Guarding on length > 0 kept a stale list when a fetch caught
      // an ephemeral CC holding mid-re-issue (old CID archived, new one not yet indexed) —
      // exactly the CONTRACT_NOT_FOUND source on CC supply. Reflect reality, including empty.
      setUsdcxHoldings(usdcx);
      setWalletBalance(usdcx.reduce((s, h) => s + parseFloat(h.amount), 0).toFixed(10));
      setCcHoldings(cc);
      setCcWalletBalance(cc.reduce((s, h) => s + parseFloat(h.amount), 0).toFixed(10));
      console.log('Holdings split: USDCx:', usdcx.length, 'CC:', cc.length);
      return { usdcx, cc };
    };

    // Strategy 1: Try getActiveContracts with interface ID (# prefix format from SDK docs)
    const interfaceIds = [
      '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
      USDCX_HOLDING_INTERFACE_ID,
    ];
    for (const iid of interfaceIds) {
      try {
        const loopResult = await provider.getActiveContracts({ interfaceId: iid });
        const allHoldings = parseAllHoldings(loopResult as unknown[]);
        if (allHoldings.length > 0) {
          console.log('Strategy 1: got', allHoldings.length, 'total holdings via interfaceId', iid);
          return setHoldingsFromParsed(allHoldings);
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
        const allHoldings = parseAllHoldings(loopResult as unknown[]);
        if (allHoldings.length > 0) {
          console.log('Strategy 2: got', allHoldings.length, 'total holdings via templateId', tid);
          return setHoldingsFromParsed(allHoldings);
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
          return { usdcx: cidsHoldings.map((h) => ({ contractId: h.contractId, amount: h.amount, owner: partyId })), cc: [] };
        }

        // Got balance but no CIDs — show balance but holdings can't be used for tx
        setWalletBalance(total.toFixed(10));
        console.warn('Strategy 3: got balance', total, 'but no contractIds — supply will not work');
        console.warn('Strategy 3: Available fields were:', usdcxEntries.map((e) => Object.keys(e as object)));
      }
    } catch {
      console.warn('Strategy 3 (getHolding) also failed');
    }
    return null;
  }, [provider, partyId]);

  const initialLoadDone = useRef(false);

  const refresh = useCallback(async () => {
    if (!partyId) return;
    // Only show loading skeleton on initial load, not on refresh.
    // Setting loading=true during refresh unmounts modals and destroys their state.
    if (!initialLoadDone.current) setLoading(true);
    setError(null);

    // Fetch all holdings from Loop SDK (returns both USDCx and CC)
    const holdingsPromise = fetchHoldings();

    // Fetch position data from backend
    try {
      const [poolResp, reserveResp, userPosResp, depositResp, borrowResp, poolStatusResp] =
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
          fetch(`${ADMIN_API_URL}/admin/pool-status`).then((r) => r.json()).catch(() => ({})),
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

      // Asset reserve (CC / Amulet)
      const ccReserves =
        reserveResp.contracts?.filter(
          (c: { createArgument?: { instrumentAdmin?: string; instrumentId?: { id?: string } } }) =>
            c.createArgument?.instrumentAdmin?.startsWith('DSO::') ||
            c.createArgument?.instrumentId?.id === 'Amulet'
        ) || [];
      const latestCcReserve =
        ccReserves.length > 0
          ? ccReserves[ccReserves.length - 1]
          : null;
      if (latestCcReserve) setCcAssetReserveCid(latestCcReserve.contractId);

      // User position — ONLY this party's. Never fall back to another user's UserPosition
      // when this party has none, or a new user looks initialized and supply fails on-chain
      // with "UserPosition does not belong to this user".
      const userPosFiltered =
        userPosResp.contracts?.filter(
          (c: { createArgument?: { user?: string } }) =>
            c.createArgument?.user === partyId
        ) || [];
      const latestUserPos =
        userPosFiltered.length > 0
          ? userPosFiltered[userPosFiltered.length - 1]
          : undefined;

      if (latestUserPos) {
        setUserPositionCid(latestUserPos.contractId);
        setHasUserPosition(true);
        // USD aggregates are computed below from positions × prices × risk params.
        // The post-audit DAR's UserPosition no longer caches totalCollateralUSD etc.
        // (HF is recomputed on-chain in-transaction), so reading those fields off the
        // contract would always be undefined → $0.
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
      const isCC = (d: { instrumentId: { admin: string; id: string } }) =>
        d.instrumentId.id === 'Amulet' || d.instrumentId.admin?.startsWith('DSO::');

      // Surface ACCRUED value, not raw principal (principal alone hides earned/owed interest).
      // Accrued deposit = principal * (reserve.liquidityIndex / entryLiquidityIndex);
      // accrued borrow  = principal * (reserve.variableBorrowIndex / entryBorrowIndex).
      // NB: the STORED reserve index only advances when the reserve is touched (AccrueInterest
      // or any action), so accrual becomes visible once the index moves.
      const reserveIndexById: Record<string, { liq: number; borrow: number }> = {};
      for (const c of (reserveResp.contracts || []) as Array<{
        createArgument?: { instrumentId?: { id?: string }; liquidityIndex?: string; variableBorrowIndex?: string };
      }>) {
        const a = c.createArgument;
        const id = a?.instrumentId?.id;
        if (id) reserveIndexById[id] = {
          liq: parseFloat(a?.liquidityIndex || '1') || 1,
          borrow: parseFloat(a?.variableBorrowIndex || '1') || 1,
        };
      }
      const depositAccrued = (d: DepositPosition) => {
        const idx = reserveIndexById[d.instrumentId.id];
        const entry = parseFloat(d.liquidityIndex || '1') || 1;
        return parseFloat(d.principal) * (idx ? idx.liq / entry : 1);
      };
      const borrowAccrued = (b: BorrowPosition) => {
        const idx = reserveIndexById[b.instrumentId.id];
        const entry = parseFloat(b.borrowIndex || '1') || 1;
        return parseFloat(b.principal) * (idx ? idx.borrow / entry : 1);
      };

      const usdcxDeps = deposits.filter((d) => !isCC(d));
      const ccDeps = deposits.filter((d) => isCC(d));
      const usdcxBors = borrows.filter((b) => !isCC(b));
      const ccBors = borrows.filter((b) => isCC(b));

      setUsdcxSupplied(usdcxDeps.reduce((s, d) => s + depositAccrued(d), 0).toFixed(10));
      setCcSupplied(ccDeps.reduce((s, d) => s + depositAccrued(d), 0).toFixed(10));
      setUsdcxBorrowed(usdcxBors.reduce((s, b) => s + borrowAccrued(b), 0).toFixed(10));
      setCcBorrowed(ccBors.reduce((s, b) => s + borrowAccrued(b), 0).toFixed(10));

      // USD aggregates — the post-audit DAR no longer caches these on UserPosition, so
      // compute them here from positions × live oracle prices × per-asset risk params.
      const prices =
        (poolStatusResp as { oracle?: { prices?: Record<string, { price?: string }> } })
          ?.oracle?.prices || {};
      const assetInfo: Record<string, { price: number; ltv: number; liqThreshold: number }> = {};
      for (const c of (reserveResp.contracts || []) as Array<{
        createArgument?: {
          instrumentId?: { id?: string };
          riskParams?: { priceFeedId?: string; ltv?: string; liquidationThreshold?: string };
        };
      }>) {
        const a = c.createArgument;
        const id = a?.instrumentId?.id;
        const feed = a?.riskParams?.priceFeedId || '';
        if (id) {
          assetInfo[id] = {
            price: parseFloat(prices[feed]?.price || '0'),
            ltv: parseFloat(a?.riskParams?.ltv || '0'),
            liqThreshold: parseFloat(a?.riskParams?.liquidationThreshold || '0'),
          };
        }
      }

      let suppliedUSD = 0;
      let collateralUSD = 0;
      let weightedUSD = 0;
      let liqThreshUSD = 0;
      for (const d of deposits) {
        const info = assetInfo[d.instrumentId.id] || { price: 0, ltv: 0, liqThreshold: 0 };
        const valueUSD = depositAccrued(d) * info.price;
        suppliedUSD += valueUSD;
        if (d.isUsedAsCollateral) {
          collateralUSD += valueUSD;
          weightedUSD += valueUSD * info.ltv;
          liqThreshUSD += valueUSD * info.liqThreshold;
        }
      }
      let borrowedUSD = 0;
      for (const b of borrows) {
        borrowedUSD += borrowAccrued(b) * (assetInfo[b.instrumentId.id]?.price || 0);
      }

      setTotalSupplied(suppliedUSD.toFixed(2));
      setTotalCollateral(collateralUSD.toFixed(2));
      setTotalWeightedCollateralUSD(weightedUSD.toFixed(2));
      setTotalLiqThresholdCollateralUSD(liqThreshUSD.toFixed(2));
      setTotalBorrowed(borrowedUSD.toFixed(2));
      setHealthFactor(
        borrowedUSD > 0.01 && liqThreshUSD > 0
          ? (liqThreshUSD / borrowedUSD).toFixed(2)
          : null
      );
      setAssetInfo(assetInfo);
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
    ccAssetReserveCid,
    userPositionCid,
    depositPositions,
    borrowPositions,
    usdcxHoldings,
    ccHoldings,
    totalSupplied,
    totalBorrowed,
    totalCollateral,
    totalWeightedCollateralUSD,
    totalLiqThresholdCollateralUSD,
    healthFactor,
    assetInfo,
    walletBalance,
    ccWalletBalance,
    usdcxSupplied,
    usdcxBorrowed,
    ccSupplied,
    ccBorrowed,
    loading,
    error,
    hasUserPosition,
    refresh,
    getFreshHoldings: fetchHoldings,
  };
}
