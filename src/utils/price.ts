// Mirror of the DAR's `resolvePrice` (Lending.Oracle): look up the feed key directly first,
// then fall back through the registered alias (label -> raw feed id). Live Chainlink prices are
// stored under the raw 32-byte feed id, while a reserve is configured with a human label
// (e.g. "cc-feed"), so the alias hop is REQUIRED — without it every price reads as 0. (Legacy
// manual SetPrice stored under the label directly, which is why the label-only lookup used to
// work; the fresh oracle stores under the raw id, so we must resolve the alias.)
type PriceEntry = { price?: string };

export function resolveOraclePrice(
  prices: Record<string, PriceEntry> | undefined,
  feedAliases: Record<string, string> | undefined,
  feedLabel: string
): number {
  if (!prices || !feedLabel) return 0;
  const direct = prices[feedLabel]?.price;
  if (direct != null) return parseFloat(direct);
  const raw = feedAliases?.[feedLabel];
  const aliased = raw ? prices[raw]?.price : undefined;
  if (aliased != null) return parseFloat(aliased);
  return 0;
}
