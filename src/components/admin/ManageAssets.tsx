import { useState } from 'react';
import { ADMIN_API_URL } from '../../config';
import type { AdminAsset, AdminData } from '../../hooks/useAdminData';
import { fmtUsd, fmtPercent, decimalToPctInput, pctInputToDecimal } from '../../utils/format';

async function postAdmin(path: string, body: Record<string, unknown>) {
  const resp = await fetch(`${ADMIN_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

type Status = { kind: 'idle' | 'ok' | 'err'; msg?: string };

/** Labelled input with the current value shown beside it and an optional unit suffix (e.g. %). */
function Field({
  label, hint, value, onChange, current, suffix,
}: {
  label: string; hint?: string; value: string; onChange: (v: string) => void;
  current?: string; suffix?: string;
}) {
  return (
    <label className="admin-field">
      <span className="admin-field-label">
        {label}
        {current !== undefined && <span className="admin-field-current">now: {current}</span>}
      </span>
      <div className={`admin-input-wrap ${suffix ? 'has-suffix' : ''}`}>
        <input className="admin-input" value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" />
        {suffix && <span className="admin-input-suffix">{suffix}</span>}
      </div>
      {hint && <span className="admin-field-hint">{hint}</span>}
    </label>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  return <div className={status.kind === 'ok' ? 'admin-ok' : 'admin-error'}>{status.msg}</div>;
}

/* ---- Set Price ---------------------------------------------------------- */
function SetPriceCard({ asset, onDone }: { asset: AdminAsset; onDone: () => void }) {
  const [price, setPrice] = useState(String(asset.price || ''));
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setStatus({ kind: 'idle' });
    const r = await postAdmin('/admin/set-price', { feedId: asset.feedId, priceValue: price });
    setBusy(false);
    if (r.success) { setStatus({ kind: 'ok', msg: `Price set to ${fmtUsd(price)}` }); onDone(); }
    else setStatus({ kind: 'err', msg: r.error || 'Failed' });
  };

  return (
    <div className="admin-card">
      <h4 className="admin-card-title">Set price</h4>
      <p className="admin-card-desc">
        The oracle price used to value {asset.symbol}. Lowering a collateral asset's price lowers
        every borrower's health factor.
      </p>
      <Field label={`${asset.symbol} price (USD)`} value={price} onChange={setPrice} current={fmtUsd(asset.price)} suffix="$" />
      <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || !price}>
        {busy ? 'Setting…' : 'Set Price'}
      </button>
      <StatusLine status={status} />
    </div>
  );
}

/* ---- Risk Params (method 2) --------------------------------------------- */
function RiskParamsCard({ asset, onDone }: { asset: AdminAsset; onDone: () => void }) {
  const [ltv, setLtv] = useState(decimalToPctInput(asset.risk.ltv));
  const [thr, setThr] = useState(decimalToPctInput(asset.risk.liquidationThreshold));
  const [bonus, setBonus] = useState(decimalToPctInput(asset.risk.liquidationBonus));
  const [active, setActive] = useState(asset.risk.isActive);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  // Validate in decimal space (percent ÷ 100), phrase errors in percent.
  const dLtv = parseFloat(ltv) / 100, dThr = parseFloat(thr) / 100, dBonus = parseFloat(bonus) / 100;
  const errors: string[] = [];
  if (!(dLtv > 0 && dLtv < 1)) errors.push('LTV must be between 0% and 100%.');
  if (!(dThr > dLtv && dThr <= 1)) errors.push('Liquidation threshold must be above LTV and at most 100%.');
  if (!(dBonus > 0 && dBonus < 1)) errors.push('Liquidation bonus must be between 0% and 100%.');
  if (dThr * (1 + dBonus) > 1 + 1e-9) errors.push('Threshold × (1 + bonus) must be ≤ 100% (keeps liquidations solvent).');
  const valid = errors.length === 0;

  const submit = async () => {
    setBusy(true); setStatus({ kind: 'idle' });
    const r = await postAdmin('/admin/update-risk-params', {
      instrumentIdId: asset.instrumentId,
      ltv: pctInputToDecimal(ltv),
      liquidationThreshold: pctInputToDecimal(thr),
      liquidationBonus: pctInputToDecimal(bonus),
      isActive: active,
    });
    setBusy(false);
    if (r.success) { setStatus({ kind: 'ok', msg: `Updated. New reserve ${String(r.newReserveCid).slice(0, 20)}…` }); onDone(); }
    else setStatus({ kind: 'err', msg: r.error || 'Failed' });
  };

  return (
    <div className="admin-card">
      <h4 className="admin-card-title">Risk parameters</h4>
      <p className="admin-card-desc">
        Controls how much can be borrowed against {asset.symbol} and when a position gets liquidated.
        Applies pool-wide to every position in this asset.
      </p>
      <div className="admin-field-grid">
        <Field label="Loan-to-value (LTV)" hint="max borrow per $1 of collateral" value={ltv} onChange={setLtv} current={fmtPercent(asset.risk.ltv)} suffix="%" />
        <Field label="Liquidation threshold" hint="health factor hits 1 here" value={thr} onChange={setThr} current={fmtPercent(asset.risk.liquidationThreshold)} suffix="%" />
        <Field label="Liquidation bonus" hint="discount a liquidator earns" value={bonus} onChange={setBonus} current={fmtPercent(asset.risk.liquidationBonus)} suffix="%" />
      </div>
      <label className="admin-checkbox">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Asset active (usable for supply/borrow)
      </label>
      {!valid && (
        <ul className="admin-validation">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || !valid}>
        {busy ? 'Updating…' : 'Update Risk Params'}
      </button>
      <StatusLine status={status} />
    </div>
  );
}

/* ---- Interest Rates ----------------------------------------------------- */
function InterestRatesCard({ asset, onDone }: { asset: AdminAsset; onDone: () => void }) {
  const i = asset.interest;
  const [opt, setOpt] = useState(decimalToPctInput(i?.optimalUtilization ?? '0.8'));
  const [base, setBase] = useState(decimalToPctInput(i?.baseRate ?? '0.0'));
  const [s1, setS1] = useState(decimalToPctInput(i?.slope1 ?? '0.04'));
  const [s2, setS2] = useState(decimalToPctInput(i?.slope2 ?? '0.75'));
  const [rf, setRf] = useState(decimalToPctInput(i?.reserveFactor ?? '0.1'));
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setStatus({ kind: 'idle' });
    const r = await postAdmin('/admin/update-interest-params', {
      instrumentIdId: asset.instrumentId,
      optimalUtilization: pctInputToDecimal(opt),
      baseRate: pctInputToDecimal(base),
      slope1: pctInputToDecimal(s1),
      slope2: pctInputToDecimal(s2),
      reserveFactor: pctInputToDecimal(rf),
      holdingFeeRate: i?.holdingFeeRate ?? '0.0000000000',
    });
    setBusy(false);
    if (r.success) { setStatus({ kind: 'ok', msg: 'Interest rates updated' }); onDone(); }
    else setStatus({ kind: 'err', msg: r.error || 'Failed' });
  };

  return (
    <div className="admin-card">
      <h4 className="admin-card-title">Interest rate model</h4>
      <p className="admin-card-desc">
        The two-slope borrow-rate curve for {asset.symbol}. Higher slopes make debt grow faster,
        which is another way a position drifts toward liquidation over time.
      </p>
      <div className="admin-field-grid">
        <Field label="Optimal utilization" value={opt} onChange={setOpt} current={fmtPercent(i?.optimalUtilization ?? 0)} suffix="%" />
        <Field label="Base rate" value={base} onChange={setBase} current={fmtPercent(i?.baseRate ?? 0)} suffix="%" />
        <Field label="Slope 1 (below optimal)" value={s1} onChange={setS1} current={fmtPercent(i?.slope1 ?? 0)} suffix="%" />
        <Field label="Slope 2 (above optimal)" value={s2} onChange={setS2} current={fmtPercent(i?.slope2 ?? 0)} suffix="%" />
        <Field label="Reserve factor" value={rf} onChange={setRf} current={fmtPercent(i?.reserveFactor ?? 0)} suffix="%" />
      </div>
      <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
        {busy ? 'Updating…' : 'Update Interest Rates'}
      </button>
      <StatusLine status={status} />
    </div>
  );
}

/* ---- Refresh Holdings --------------------------------------------------- */
function RefreshHoldingsCard({ asset, onDone }: { asset: AdminAsset; onDone: () => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setStatus({ kind: 'idle' });
    const r = await postAdmin('/admin/refresh-holdings', { instrumentIdId: asset.instrumentId });
    setBusy(false);
    if (r.success) { setStatus({ kind: 'ok', msg: `Liquidity re-booked ${r.oldTotalLiquidity} → ${r.newTotalLiquidity}` }); onDone(); }
    else setStatus({ kind: 'err', msg: r.error || 'Failed' });
  };

  return (
    <div className="admin-card">
      <h4 className="admin-card-title">Refresh holdings</h4>
      <p className="admin-card-desc">
        Re-syncs the reserve to the pool's real {asset.symbol} balance. Run this if a withdraw/borrow
        fails with a "contract not found" error that isn't in the transaction.
      </p>
      <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
        {busy ? 'Refreshing…' : `Refresh ${asset.symbol} Holdings`}
      </button>
      <StatusLine status={status} />
    </div>
  );
}

/* ---- Section ------------------------------------------------------------ */
export function ManageAssets({ data }: { data: AdminData }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const key = selectedKey ?? data.assets[0]?.key ?? null;
  const asset = data.assets.find((a) => a.key === key) || null;

  return (
    <div className="admin-panel">
      <div className="admin-panel-head">
        <div>
          <h3 className="admin-panel-title">Manage Assets</h3>
          <p className="admin-panel-sub">Day-to-day levers. Changes apply pool-wide, right away.</p>
        </div>
        <div className="admin-asset-tabs">
          {data.assets.map((a) => (
            <button
              key={a.key}
              className={`admin-asset-tab ${a.key === key ? 'active' : ''}`}
              onClick={() => setSelectedKey(a.key)}
            >
              {a.symbol}
            </button>
          ))}
        </div>
      </div>

      {!asset ? (
        <p className="admin-panel-sub">No assets to manage yet.</p>
      ) : (
        // key forces the cards' local form state to re-seed when the asset changes
        <div className="admin-card-grid" key={asset.key}>
          <SetPriceCard asset={asset} onDone={data.refresh} />
          <RiskParamsCard asset={asset} onDone={data.refresh} />
          <InterestRatesCard asset={asset} onDone={data.refresh} />
          <RefreshHoldingsCard asset={asset} onDone={data.refresh} />
        </div>
      )}
    </div>
  );
}
