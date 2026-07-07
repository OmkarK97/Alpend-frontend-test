export const LENDING_PACKAGE_ID =
  import.meta.env.VITE_LENDING_PACKAGE_ID ||
  'bb52e57aa7690fc7b711ecb0682d1efcee4590fa81888a6b42a1f77fdca68ca5';

export const SCAN_API_URL =
  import.meta.env.VITE_SCAN_API_URL || 'http://test.canton.palladiumlabs.org:4000';

export const TRANSFER_PREAPPROVAL_API_URL =
  import.meta.env.VITE_TRANSFER_PREAPPROVAL_API_URL ||
  'https://test.canton.palladiumlabs.org/api/validator/v0/scan-proxy/transfer-preapprovals/by-party';

export const NETWORK = import.meta.env.VITE_NETWORK || 'testnet';

export const SYNCHRONIZER_ID =
  import.meta.env.VITE_SYNCHRONIZER_ID ||
  'global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';

// Template IDs derived from lending package
export const TEMPLATES = {
  lendingPool: `${LENDING_PACKAGE_ID}:Lending.Pool:LendingPool`,
  assetReserve: `${LENDING_PACKAGE_ID}:Lending.AssetReserve:AssetReserve`,
  depositPosition: `${LENDING_PACKAGE_ID}:Lending.Deposit:DepositPosition`,
  borrowPosition: `${LENDING_PACKAGE_ID}:Lending.Borrow:BorrowPosition`,
  userPosition: `${LENDING_PACKAGE_ID}:Lending.UserPosition:UserPosition`,
  priceOracle: `${LENDING_PACKAGE_ID}:Lending.Oracle:PriceOracle`,
} as const;

// Admin backend URL (runs as pool operator for admin-only choices)
export const ADMIN_API_URL =
  import.meta.env.VITE_ADMIN_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3100');

// Canton Coin (CC / Amulet) config
export const CC_PACKAGE_ID =
  import.meta.env.VITE_CC_PACKAGE_ID ||
  '3ca1343ab26b453d38c8adb70dca5f1ead8440c42b59b68f070786955cbf9ec1';

export const CC_AMULET_TEMPLATE = `${CC_PACKAGE_ID}:Splice.Amulet:Amulet`;

export const CC_INSTRUMENT_ADMIN =
  import.meta.env.VITE_CC_INSTRUMENT_ADMIN ||
  'DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';

// Interface IDs for Token Standard queries
export const INTERFACES = {
  holding: '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
  transferFactory:
    '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory',
} as const;

// USDCx config
export const USDCX_INSTRUMENT_ADMIN =
  import.meta.env.VITE_USDCX_INSTRUMENT_ADMIN ||
  'decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61';

export const USDCX_INSTRUMENT_ID = import.meta.env.VITE_USDCX_INSTRUMENT_ID || 'USDCx';

export const USDCX_HOLDING_INTERFACE_ID =
  import.meta.env.VITE_USDCX_HOLDING_INTERFACE_ID ||
  '718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding';

// Pool operator party ID
export const POOL_OPERATOR =
  import.meta.env.VITE_POOL_OPERATOR ||
  'google-oauth2_007c102908799751727857785::12206d5dbed87522889b28486cea3dd6b6c1fc4b3ca156d2c4f31318710fcba57be3';

// Explorer base URL for transaction links
export const EXPLORER_URL =
  import.meta.env.VITE_EXPLORER_URL ||
  'https://lighthouse.testnet.cantonloop.com/transactions';
