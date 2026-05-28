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

export interface PositionData {
  poolCid: string;
  assetReserveCid: string;
  userPositionCid: string;
  depositPositions: DepositPosition[];
  borrowPositions: BorrowPosition[];
  usdcxHoldings: UsdcxHolding[];

  totalSupplied: string;
  totalBorrowed: string;
  totalCollateral: string;
  totalWeightedCollateralUSD: string;
  totalLiqThresholdCollateralUSD: string;
  healthFactor: string | null;
  walletBalance: string;

  loading: boolean;
  error: string | null;
  hasUserPosition: boolean;
  refresh: () => Promise<void>;
}
