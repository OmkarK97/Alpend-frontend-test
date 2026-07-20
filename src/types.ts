export interface TransactionLog {
  id: string;
  timestamp: string;
  operation: string;
  status: 'pending' | 'success' | 'error';
  message: string;
  details?: unknown;
  updateId?: string;
}

export interface ActiveContract {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
  createdEventBlob?: string;
}

export interface DisclosedContract {
  templateId?: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId?: string;
  domainId?: string;
}

export interface DepositPosition {
  cid: string;
  principal: string;
  instrumentId: { admin: string; id: string };
  isUsedAsCollateral: boolean;
  liquidityIndex: string;
}

export interface BorrowPosition {
  cid: string;
  principal: string;
  instrumentId: { admin: string; id: string };
  borrowIndex: string;
  lockedCollateralCid: string;
}

export interface UsdcxHolding {
  contractId: string;
  amount: string;
  owner: string;
}

export interface CcHolding {
  contractId: string;
  amount: string;
  owner: string;
}

export interface PositionData {
  poolCid: string;
  assetReserveCid: string;
  ccAssetReserveCid: string;
  userPositionCid: string;
  depositPositions: DepositPosition[];
  borrowPositions: BorrowPosition[];
  usdcxHoldings: UsdcxHolding[];
  ccHoldings: CcHolding[];

  totalSupplied: string;
  totalBorrowed: string;
  totalCollateral: string;
  totalWeightedCollateralUSD: string;
  totalLiqThresholdCollateralUSD: string;
  healthFactor: string | null;
  /** Per-instrument-id price + risk params, for post-action HF projections. */
  assetInfo: Record<string, { price: number; ltv: number; liqThreshold: number }>;
  walletBalance: string;
  ccWalletBalance: string;
  /** True while the Loop wallet is still returning holdings. Tracked separately from
   *  `loading` because the wallet call is several seconds slower than our own server —
   *  only the balance cells wait on it, not the whole dashboard. */
  holdingsLoading: boolean;

  // Per-asset breakdowns
  usdcxSupplied: string;
  usdcxBorrowed: string;
  ccSupplied: string;
  ccBorrowed: string;

  loading: boolean;
  error: string | null;
  hasUserPosition: boolean;
  refresh: () => Promise<void>;
  /** Re-fetch the wallet's holdings via Loop (fresh CIDs) — used at submit time on the
   *  ephemeral CC path to avoid stale-holding CONTRACT_NOT_FOUND. */
  getFreshHoldings: () => Promise<{
    usdcx: { contractId: string; amount: string; owner: string }[];
    cc: { contractId: string; amount: string; owner: string }[];
  } | null>;
}
