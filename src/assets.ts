import type { BorrowPosition, DepositPosition, PositionData } from './types';
import { POOL_OPERATOR } from './config';
import {
  fetchTransferContext,
  fetchCCTransferContext,
  fetchCCPayoutContext,
  type TransferContext,
} from './utils/transferContext';

// Single source of truth for the per-asset differences the action modals used to
// hardcode (USDCx in SupplyModal/…, CC in CCSupplyModal). Adding a new supported
// asset should be a new entry here, not a new modal.

export type AssetKey = 'usdcx' | 'cc';

export interface AssetConfig {
  key: AssetKey;
  /** Display symbol shown in the UI. */
  symbol: string;
  /** On-ledger instrument id (differs from the display symbol for CC = 'Amulet'). */
  instrumentId: string;
  /**
   * Ephemeral assets (e.g. Canton Coin) whose pool-side holdings the network may
   * archive out-of-band. Pool-payout flows (withdraw/borrow) must then pass fresh
   * holdings via `freshReserveHoldingCids`. USDCx is stable, so this is false.
   */
  isEphemeral: boolean;
  /** User's wallet balance for this asset (display string). */
  walletBalance: (p: PositionData) => string;
  /** User's own holdings of this asset — transfer inputs for supply/repay. */
  holdings: (p: PositionData) => { contractId: string }[];
  /** Current CID of this asset's reserve. */
  reserveCid: (p: PositionData) => string;
  /**
   * Current CIDs of the OTHER reserves the user has positions in, for the DAR's
   * on-chain health-factor recompute (the `accountReserveCids` choice arg).
   * Excludes this asset's own reserve.
   */
  otherReserveCids: (p: PositionData) => string[];
  /** This asset's outstanding borrowed amount (display string). */
  borrowedAmount: (p: PositionData) => string;
  /** This asset's supplied amount (display string). */
  suppliedAmount: (p: PositionData) => string;
  /** This asset's active borrow position, if any (matched by instrument id). */
  borrowPosition: (p: PositionData) => BorrowPosition | undefined;
  /** This asset's active deposit position, if any (matched by instrument id). */
  depositPosition: (p: PositionData) => DepositPosition | undefined;
  /** Transfer context for the user-as-sender direction (supply / repay). */
  fetchUserSendContext: (
    partyId: string,
    amount: string,
    holdingCids: string[]
  ) => Promise<TransferContext>;
  /** Endpoint path for the pool operator's holdings of this asset (payout inputs). */
  poolHoldingsPath: (poolOperator: string) => string;
  /**
   * Transfer context for the pool-as-sender direction (withdraw / borrow payout).
   * `poolHoldingCids` are the pool's current holdings of this asset.
   */
  fetchPoolSendContext: (
    amount: string,
    receiver: string,
    poolHoldingCids: string[]
  ) => Promise<TransferContext>;
}

export const ASSETS: Record<AssetKey, AssetConfig> = {
  usdcx: {
    key: 'usdcx',
    symbol: 'USDCx',
    instrumentId: 'USDCx',
    isEphemeral: false,
    walletBalance: (p) => p.walletBalance,
    holdings: (p) => p.usdcxHoldings,
    reserveCid: (p) => p.assetReserveCid,
    otherReserveCids: (p) => [p.ccAssetReserveCid].filter(Boolean),
    borrowedAmount: (p) => p.usdcxBorrowed,
    suppliedAmount: (p) => p.usdcxSupplied,
    borrowPosition: (p) => p.borrowPositions.find((b) => b.instrumentId.id === 'USDCx'),
    depositPosition: (p) => p.depositPositions.find((d) => d.instrumentId.id === 'USDCx'),
    fetchUserSendContext: (partyId, amount, holdingCids) =>
      fetchTransferContext(partyId, amount, holdingCids),
    poolHoldingsPath: (poolOperator) =>
      `/admin/usdcx-holdings/${encodeURIComponent(poolOperator)}`,
    fetchPoolSendContext: (amount, receiver, poolHoldingCids) =>
      fetchTransferContext(POOL_OPERATOR, amount, poolHoldingCids, receiver),
  },
  cc: {
    key: 'cc',
    symbol: 'CC',
    instrumentId: 'Amulet',
    isEphemeral: true,
    walletBalance: (p) => p.ccWalletBalance,
    holdings: (p) => p.ccHoldings,
    reserveCid: (p) => p.ccAssetReserveCid,
    otherReserveCids: (p) => [p.assetReserveCid].filter(Boolean),
    borrowedAmount: (p) => p.ccBorrowed,
    suppliedAmount: (p) => p.ccSupplied,
    borrowPosition: (p) => p.borrowPositions.find((b) => b.instrumentId.id === 'Amulet'),
    depositPosition: (p) => p.depositPositions.find((d) => d.instrumentId.id === 'Amulet'),
    // CC's server-side context is built for user→pool and ignores amount/holdingCids.
    fetchUserSendContext: (partyId) => fetchCCTransferContext(partyId),
    poolHoldingsPath: (poolOperator) =>
      `/admin/cc-holdings/${encodeURIComponent(poolOperator)}`,
    // Pool-payout CC context comes from the registry (built for this exact transfer),
    // so it includes external-party-config-state + templateId'd disclosed contracts.
    fetchPoolSendContext: (amount, receiver, poolHoldingCids) =>
      fetchCCPayoutContext(receiver, amount, poolHoldingCids),
  },
};
