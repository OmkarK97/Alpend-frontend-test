import { useState, useEffect, useCallback } from 'react';
import { ADMIN_API_URL } from '../config';
import { ASSETS } from '../assets';
import { resolveOraclePrice } from '../utils/price';

export interface AdminRiskParams {
  ltv: string;
  liquidationThreshold: string;
  liquidationBonus: string;
  priceFeedId: string;
  isActive: boolean;
  depositCap: string | null;
  borrowCap: string | null;
}

export interface AdminInterestParams {
  optimalUtilization: string;
  baseRate: string;
  slope1: string;
  slope2: string;
  reserveFactor: string;
  holdingFeeRate: string;
}

export interface AdminAsset {
  key: string;            // registry key (usdcx / cc)
  symbol: string;         // display symbol
  instrumentId: string;   // on-ledger instrument id (USDCx / Amulet)
  feedId: string;
  reserveCid: string;
  price: number;
  totalLiquidity: number;
  totalDeposited: number;
  scaledBorrowed: number;
  borrowed: number;       // scaledBorrowed × variableBorrowIndex
  utilization: number;    // borrowed / (liquidity + borrowed)
  revenue: number;        // extractable protocol revenue = poolEntitled − suppliersOwed
  isActive: boolean;
  risk: AdminRiskParams;
  interest: AdminInterestParams | null;
}

export interface PauseFlags {
  pauseDeposits: boolean;
  pauseWithdrawals: boolean;
  pauseBorrows: boolean;
  pauseLiquidations: boolean;
}

export interface AdminData {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  assets: AdminAsset[];
  pauseFlags: PauseFlags;
  poolCid: string;
  oracleFresh: boolean;
}

const EMPTY_PAUSE: PauseFlags = {
  pauseDeposits: false,
  pauseWithdrawals: false,
  pauseBorrows: false,
  pauseLiquidations: false,
};

export function useAdminData(): AdminData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<AdminAsset[]>([]);
  const [pauseFlags, setPauseFlags] = useState<PauseFlags>(EMPTY_PAUSE);
  const [poolCid, setPoolCid] = useState('');
  const [oracleFresh, setOracleFresh] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reservesResp, statusResp] = await Promise.all([
        fetch(`${ADMIN_API_URL}/admin/asset-reserves`).then((r) => r.json()),
        fetch(`${ADMIN_API_URL}/admin/pool-status`).then((r) => r.json()),
      ]);

      const prices: Record<string, { price?: string }> = statusResp?.oracle?.prices || {};
      const feedAliases: Record<string, string> = statusResp?.oracle?.feedAliases || {};
      setPoolCid(statusResp?.pool?.cid || '');
      setPauseFlags(statusResp?.pool?.pauseFlags || EMPTY_PAUSE);
      setOracleFresh(!!statusResp?.oracle);

      const reserves: Array<{ contractId: string; createArgument?: Record<string, unknown> }> =
        reservesResp?.contracts || [];

      const out: AdminAsset[] = [];
      for (const [key, cfg] of Object.entries(ASSETS)) {
        const r = reserves.filter(
          (x) => (x.createArgument as { instrumentId?: { id?: string } })?.instrumentId?.id === cfg.instrumentId
        ).slice(-1)[0];
        if (!r) continue;
        const a = r.createArgument as Record<string, any>;
        const risk = a.riskParams || {};
        const feedId = risk.priceFeedId || '';
        const price = resolveOraclePrice(prices, feedAliases, feedId);
        const totalLiquidity = parseFloat(a.totalLiquidity || '0');
        const scaledBorrowed = parseFloat(a.scaledTotalBorrowed || '0');
        const borrowIdx = parseFloat(a.variableBorrowIndex || '1');
        const borrowed = scaledBorrowed * borrowIdx;
        const totalDeposited = parseFloat(a.totalDeposited || '0');
        const denom = totalLiquidity + borrowed;
        // reserveProtocolRevenue = max(0, poolEntitled − suppliersOwed)
        const suppliersOwed = parseFloat(a.scaledTotalSupplied || '0') * parseFloat(a.liquidityIndex || '1');
        const revenue = Math.max(0, (totalLiquidity + borrowed) - suppliersOwed);
        out.push({
          key,
          symbol: cfg.symbol,
          instrumentId: cfg.instrumentId,
          feedId,
          reserveCid: r.contractId,
          price,
          totalLiquidity,
          totalDeposited,
          scaledBorrowed,
          borrowed,
          utilization: denom > 0 ? borrowed / denom : 0,
          revenue,
          isActive: risk.isActive ?? true,
          risk: {
            ltv: risk.ltv ?? '0',
            liquidationThreshold: risk.liquidationThreshold ?? '0',
            liquidationBonus: risk.liquidationBonus ?? '0',
            priceFeedId: feedId,
            isActive: risk.isActive ?? true,
            depositCap: risk.depositCap ?? null,
            borrowCap: risk.borrowCap ?? null,
          },
          interest: a.interestRateParams
            ? {
                optimalUtilization: a.interestRateParams.optimalUtilization ?? '0',
                baseRate: a.interestRateParams.baseRate ?? '0',
                slope1: a.interestRateParams.slope1 ?? '0',
                slope2: a.interestRateParams.slope2 ?? '0',
                reserveFactor: a.interestRateParams.reserveFactor ?? '0',
                holdingFeeRate: a.interestRateParams.holdingFeeRate ?? '0',
              }
            : null,
        });
      }
      setAssets(out);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { loading, error, refresh, assets, pauseFlags, poolCid, oracleFresh };
}
