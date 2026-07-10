/** Human-readable number formatting for the Admin UI.
 *  On-ledger Decimals are stored zero-padded (e.g. "0.8000000000"); these strip the noise
 *  for display. The zero-padded form is only reconstructed when calling the contract
 *  (see `pctInputToDecimal`). */

/** Trim trailing zeros but keep at least `minDp` decimals: 0.80…→"0.80", 0.825…→"0.825". */
export function fmtDecimal(v: number | string, minDp = 2): string {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (!isFinite(n)) return '0';
  let s = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  const dot = s.indexOf('.');
  const dp = dot === -1 ? 0 : s.length - dot - 1;
  if (dp < minDp) s = n.toFixed(minDp);
  return s;
}

/** Percentage with trailing zeros stripped and no forced decimals: 0.80→"80%", 0.825→"82.5%". */
export function fmtPercent(v: number | string): string {
  const n = (typeof v === 'string' ? parseFloat(v) : v) * 100;
  if (!isFinite(n)) return '0%';
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `${s}%`;
}

/** Both forms, for read-only reference displays: "0.80 · 80%". */
export function fmtRatio(v: number | string): string {
  return `${fmtDecimal(v)} · ${fmtPercent(v)}`;
}

/** Decimal (ratio) string → the percent number a user edits: "0.8250000000" → "82.5". */
export function decimalToPctInput(v: number | string): string {
  const n = (typeof v === 'string' ? parseFloat(v) : v) * 100;
  if (!isFinite(n)) return '0';
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** Percent number a user typed → zero-padded decimal string for the contract: "82.5" → "0.8250000000". */
export function pctInputToDecimal(pct: string | number): string {
  const n = (typeof pct === 'string' ? parseFloat(pct) : pct) / 100;
  if (!isFinite(n)) return '0.0000000000';
  return n.toFixed(10);
}

/** Plain amount (token quantity), trailing zeros trimmed, min 2 dp. */
export function fmtAmount(v: number | string, minDp = 2): string {
  return fmtDecimal(v, minDp);
}

/** Token balance for user-facing rows. Never renders a NON-ZERO amount as "0.0000":
 *  a tiny-but-positive value (dust, e.g. leftover accrued-interest debt) shows as "< 0.0001"
 *  so a user is never told they owe/hold nothing when they actually don't. */
export function fmtBalance(v: number | string, dp = 4): string {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (!isFinite(n) || n === 0) return (0).toFixed(dp);
  const eps = Math.pow(10, -dp);
  if (Math.abs(n) < eps) return `${n < 0 ? '> -' : '< '}${eps.toFixed(dp)}`;
  return n.toFixed(dp);
}

/** USD currency. Sub-$1 prices get more precision. */
export function fmtUsd(v: number | string): string {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (!isFinite(n)) return '$0.00';
  const dp = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
