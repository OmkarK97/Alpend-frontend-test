import { useState, useEffect, useCallback } from 'react';
import type { PositionData } from '../types';
import { useLoop } from '../hooks/useLoop';
import { ASSETS, type AssetKey } from '../assets';
import { ADMIN_API_URL } from '../config';
import { fetchPoolDisclosedContracts } from '../utils/transferContext';
import { buildInitializeUserPositionCommand } from '../commands/pool';
import { buildArchiveUserPositionCommand } from '../commands/migration';
import { SupplyModal } from '../components/SupplyModal';
import { BorrowModal } from '../components/BorrowModal';
import { RepayModal } from '../components/RepayModal';
import { WithdrawModal } from '../components/WithdrawModal';
import './v2.css';

type LoopApi = ReturnType<typeof useLoop>;

interface Props {
  position: PositionData;
  partyId: string;
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => void;
  disconnect: () => void;
  submitTx: LoopApi['submitTx'];
  addLog: LoopApi['addLog'];
  onExit: () => void;
}

type ModalState = { type: 'supply' | 'borrow' | 'repay' | 'withdraw'; asset: AssetKey } | null;

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const usd = (v: number) =>
  '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 4 });

function short(p: string) {
  if (!p) return '';
  const id = p.split('::')[0];
  return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
}

export function AlpendV2({
  position,
  partyId,
  isConnected,
  isConnecting,
  connect,
  disconnect,
  submitTx,
  addLog,
  onExit,
}: Props) {
  const [modal, setModal] = useState<ModalState>(null);
  const [initLoading, setInitLoading] = useState(false);
  const [accessState, setAccessState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [archiving, setArchiving] = useState(false);

  // loose accessor for the display fields (usePosition returns more than PositionData narrows)
  const p = position as unknown as Record<string, unknown>;
  const userPositionCid = (p.userPositionCid as string) || '';

  // Check on-ledger whether this party holds a PoolAccess grant (PV-01 membership).
  const checkAccess = useCallback(async () => {
    if (!partyId) return;
    try {
      const r = await fetch(`${ADMIN_API_URL}/admin/pool-access/${encodeURIComponent(partyId)}`);
      const j = await r.json();
      setHasAccess(!!j.hasAccess);
    } catch {
      setHasAccess(false);
    }
  }, [partyId]);

  useEffect(() => {
    if (isConnected && position.hasUserPosition && hasAccess === null) checkAccess();
  }, [isConnected, position.hasUserPosition, hasAccess, checkAccess]);

  const handleArchive = async () => {
    if (!userPositionCid) return;
    if (
      !window.confirm(
        'Reset from scratch: archive your position registry AND revoke pool access, returning to onboarding?\n\nArchiving only works if you have no open supplies or borrows.'
      )
    )
      return;
    setArchiving(true);
    try {
      // 1. archive the registry (user signs — controller is the user)
      const cmd = buildArchiveUserPositionCommand(userPositionCid);
      await submitTx('ArchiveUserPosition', cmd, 'Reset position registry (test)', { estimateTraffic: false });
      // 2. revoke pool access (operator-only submit, non-fatal if it fails)
      try {
        await fetch(`${ADMIN_API_URL}/admin/revoke-pool-access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ party: partyId }),
        });
      } catch (e) {
        addLog('RevokePoolAccess', 'error', `Revoke failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      setHasAccess(false);
      setAccessState('idle');
      await position.refresh();
    } catch (err) {
      addLog('ArchiveUserPosition', 'error', `Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setArchiving(false);
    }
  };

  const toggleTheme = () => {
    const root = document.documentElement;
    const cur =
      root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  };

  const handleInit = async () => {
    setInitLoading(true);
    try {
      const disclosed = await fetchPoolDisclosedContracts(partyId);
      const cmd = buildInitializeUserPositionCommand(position.poolCid, partyId, disclosed);
      await submitTx('InitializeUserPosition', cmd, 'Initialize user position', {
        estimateTraffic: false,
      });
      await position.refresh();
    } catch (err) {
      addLog(
        'InitializeUserPosition',
        'error',
        `Failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setInitLoading(false);
    }
  };

  const handleGrantAccess = async () => {
    setAccessState('busy');
    try {
      const r = await fetch(`${ADMIN_API_URL}/admin/add-observer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poolContractId: position.poolCid, newObserver: partyId }),
      });
      setAccessState(r.ok ? 'done' : 'error');
      if (r.ok) {
        setHasAccess(true);
        checkAccess();
      }
    } catch {
      setAccessState('error');
    }
  };

  // ---- header (shared) ----
  const header = (
    <header className="av-top">
      <div className="av-top-in">
        <div className="av-brand">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M2 20 L8.5 8 L12 13.5 L15 7 L22 20 Z" fill="var(--accent)" opacity=".9" />
            <path d="M6.8 20 L9 16 L11.2 20 Z" fill="var(--surface)" opacity=".6" />
          </svg>
          <span>Alpend</span>
        </div>
        <span className="av-chip">
          <i /> Canton · testnet
        </span>
        <span className="av-spacer" />
        <button className="av-icon" onClick={onExit} title="Back to classic app" aria-label="Back to classic app">
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" fill="none">
            <path d="M9 6l-6 6 6 6M3 12h13a5 5 0 0 1 5 5v1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button className="av-icon" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="4.5" />
            <path
              d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {isConnected ? (
          <button className="av-wallet on" onClick={disconnect} title="Disconnect">
            <span className="dot" /> {short(partyId)}
          </button>
        ) : (
          <button className="av-wallet" onClick={connect} disabled={isConnecting}>
            {isConnecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
      </div>
    </header>
  );

  // ---- not connected ----
  if (!isConnected) {
    return (
      <div className="alpend-v2">
        {header}
        <main className="av-shell">
          <section className="av-connect">
            <div className="card">
              <svg width="76" height="60" viewBox="0 0 76 60" fill="none" aria-hidden="true">
                <path d="M2 56 L26 14 L38 32 L49 10 L74 56 Z" fill="var(--accent)" opacity=".18" />
                <path d="M2 56 L26 14 L38 32 L49 10 L74 56 Z" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M20 24 L26 14 L31 21.5 L26.5 24 L30 28 L22 28 Z" fill="var(--accent)" opacity=".55" />
                <line x1="0" y1="44" x2="76" y2="44" stroke="var(--bad)" strokeWidth="1" strokeDasharray="3 4" opacity=".5" />
              </svg>
              <h1>Lend above the line.</h1>
              <p>
                Supply Canton Coin and USDCx, borrow against them, and keep your health factor high above
                liquidation. Your positions, read straight from the ledger.
              </p>
              <button className="btn" onClick={connect} disabled={isConnecting}>
                {isConnecting ? 'Connecting…' : 'Connect Loop wallet'}
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  // ---- loading ----
  if (position.loading) {
    return (
      <div className="alpend-v2">
        {header}
        <main className="av-shell">
          <div className="av-loading">Reading your position from the ledger…</div>
        </main>
      </div>
    );
  }

  // ---- checking membership on the ledger ----
  if (position.hasUserPosition && hasAccess === null) {
    return (
      <div className="alpend-v2">
        {header}
        <main className="av-shell">
          <div className="av-loading">Checking your pool access…</div>
        </main>
      </div>
    );
  }

  // ---- onboarding (needs a registry and/or pool access) ----
  if (!position.hasUserPosition || hasAccess === false) {
    const step1Done = position.hasUserPosition;
    const step2Done = hasAccess === true;
    return (
      <div className="alpend-v2">
        {header}
        <main className="av-shell">
          <section className="av-onb">
            <h2>Two quick steps to start</h2>
            <p className="sub">
              You're connected as <span className="num">{short(partyId)}</span>. Before you can supply or
              borrow, your account needs a position registry and pool access.
            </p>
            <div className="av-steps">
              <div className={'av-step' + (step1Done ? ' done' : '')}>
                <div className="mk">{step1Done ? '✓' : '1'}</div>
                <div className="body">
                  <h3>Initialize your position</h3>
                  {step1Done ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <p className="av-done" style={{ margin: 0 }}>
                        Done · registry created on-ledger
                      </p>
                      <button className="av-mini" onClick={handleArchive} disabled={archiving}>
                        {archiving ? 'Resetting…' : 'Archive & start over'}
                      </button>
                    </div>
                  ) : (
                    <>
                      <p>
                        Creates your on-ledger position registry — signed by you alone. This is where your
                        supplies and borrows are tracked.
                      </p>
                      <button className="btn" onClick={handleInit} disabled={initLoading || !position.poolCid}>
                        {initLoading ? 'Initializing…' : 'Initialize'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className={'av-step' + (step2Done ? ' done' : '')}>
                <div className="mk">{step2Done ? '✓' : '2'}</div>
                <div className="body">
                  <h3>Get pool access</h3>
                  {step2Done ? (
                    <p className="av-done">Granted · PoolAccess on-ledger</p>
                  ) : (
                    <>
                      <p>
                        The operator issues you a private access grant so the pool recognizes you as a
                        member. One click — nothing to sign.
                      </p>
                      <button
                        className="btn"
                        onClick={handleGrantAccess}
                        disabled={accessState === 'busy' || !step1Done}
                        title={!step1Done ? 'Initialize your position first' : undefined}
                      >
                        {accessState === 'busy'
                          ? 'Requesting…'
                          : accessState === 'error'
                          ? 'Retry request'
                          : 'Request access'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    );
  }

  // ---- dashboard ----
  const supplied = n(p.totalSupplied);
  const borrowed = n(p.totalBorrowed);
  const net = supplied - borrowed;
  const capacity = n(p.totalWeightedCollateralUSD);
  const powerUsed = capacity > 0 ? Math.min(100, (borrowed / capacity) * 100) : 0;
  const available = Math.max(0, capacity - borrowed);

  const hf = p.healthFactor != null ? n(p.healthFactor) : null;
  const MIN = 0.6,
    MAX = 2.4;
  const pct = (v: number) => Math.max(0, Math.min(100, ((Math.min(MAX, Math.max(MIN, v)) - MIN) / (MAX - MIN)) * 100));
  const liqPct = pct(1.0);
  const hfPct = hf != null ? pct(hf) : 0;
  const hfCls = hf == null ? 'g' : hf >= 1.5 ? 'g' : hf >= 1.15 ? 'a' : 'r';
  const hfStatus =
    hf == null
      ? 'No debt — nothing to liquidate'
      : hf >= 1.5
      ? 'Safe — well above the liquidation line'
      : hf >= 1.15
      ? 'Watch it — getting closer to the line'
      : 'At risk — one price drop from liquidation';

  const rows = (['cc', 'usdcx'] as AssetKey[]).map((key) => {
    const cfg = ASSETS[key];
    const info =
      (p.assetInfo as Record<string, { price: number }> | undefined)?.[cfg.instrumentId] ||
      (p.assetInfo as Record<string, { price: number }> | undefined)?.[cfg.symbol];
    const price = info?.price ?? 0;
    const supAmt = n(key === 'cc' ? p.ccSupplied : p.usdcxSupplied);
    const borAmt = n(key === 'cc' ? p.ccBorrowed : p.usdcxBorrowed);
    return { key, cfg, price, supAmt, borAmt, supUsd: supAmt * price, borUsd: borAmt * price };
  });
  const suppliedRows = rows.filter((r) => r.supAmt > 0);
  const borrowedRows = rows.filter((r) => r.borAmt > 0);

  const coinChip = (key: AssetKey) => (
    <span className={'av-coin ' + key}>{key === 'cc' ? 'CC' : 'USD'}</span>
  );

  return (
    <div className="alpend-v2">
      {header}
      <main className="av-shell">
        {/* summary */}
        <div className="av-statgrid">
          <div className="av-stat">
            <div className="lbl">Net position</div>
            <div className="v">{usd(net)}</div>
            <div className="sub">
              Supplied <b>{usd(supplied)}</b> · Borrowed <b>{usd(borrowed)}</b>
            </div>
          </div>
          <div className="av-stat">
            <div className="lbl">Borrow power used</div>
            <div className="v">
              {Math.round(powerUsed)}
              <small>%</small>
            </div>
            <div className="sub">
              <b>{usd(available)}</b> still available to borrow
            </div>
          </div>
        </div>

        <div className="av-grid av-board">
          {/* HF altitude gauge */}
          <div className="av-gauge">
            <div className="lbl">Health factor · altitude</div>
            <div className={'hf ' + hfCls}>{hf != null ? hf.toFixed(2) : '∞'}</div>
            <div className="status">{hfStatus}</div>
            <div className="viz">
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 6,
                  bottom: 6,
                  width: 6,
                  borderRadius: 3,
                  background: 'linear-gradient(to top, var(--gauge-bot), var(--gauge-mid), var(--gauge-top))',
                  opacity: 0.85,
                }}
              />
              {hf != null && (
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 16,
                    bottom: 0,
                    height: `${hfPct}%`,
                    background:
                      'linear-gradient(to top, color-mix(in srgb, var(--accent) 16%, transparent), transparent)',
                  }}
                />
              )}
              <div style={{ position: 'absolute', left: 0, right: 16, bottom: `${liqPct}%`, borderTop: '1.4px dashed var(--bad)', opacity: 0.8 }}>
                <span style={{ position: 'absolute', left: 0, top: -15, fontFamily: 'var(--mono)', fontSize: '.6rem', fontWeight: 600, letterSpacing: '.05em', color: 'var(--bad)' }}>
                  LIQUIDATION · 1.00
                </span>
              </div>
              {hf != null && (
                <div style={{ position: 'absolute', left: 0, right: 16, bottom: `${hfPct}%`, borderTop: '2px solid var(--accent)' }}>
                  <span style={{ position: 'absolute', left: 0, top: -15, fontFamily: 'var(--mono)', fontSize: '.64rem', fontWeight: 600, color: 'var(--accent-ink)' }}>
                    YOU · {hf.toFixed(2)}
                  </span>
                  <i style={{ position: 'absolute', right: -3.5, top: -6, width: 11, height: 11, borderRadius: 99, background: 'var(--surface)', border: '2.5px solid var(--accent)' }} />
                </div>
              )}
            </div>
          </div>

          {/* supplied */}
          <div className="av-col">
            <div className="av-colh">
              <h2>
                <span className="dm" style={{ background: 'var(--accent)' }} /> Supplied
              </h2>
              <span className="tot">{usd(supplied)}</span>
            </div>
            {suppliedRows.length === 0 && <div className="av-empty">Nothing supplied yet.</div>}
            {suppliedRows.map((r) => (
              <div className="av-row" key={r.key}>
                <div className="av-asset">
                  {coinChip(r.key)}
                  <div className="meta">
                    <div className="nm">
                      {r.cfg.symbol} <span className="tag">collateral</span>
                    </div>
                    <div className="amt">
                      {amt(r.supAmt)} {r.cfg.symbol}
                    </div>
                  </div>
                </div>
                <div className="av-rr">
                  <div className="av-usd">{usd(r.supUsd)}</div>
                  <div className="av-btns">
                    <button className="av-mini primary" onClick={() => setModal({ type: 'supply', asset: r.key })}>
                      Supply
                    </button>
                    <button className="av-mini" onClick={() => setModal({ type: 'withdraw', asset: r.key })}>
                      Withdraw
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {/* let users supply an asset they don't hold yet */}
            {rows
              .filter((r) => r.supAmt === 0)
              .map((r) => (
                <div className="av-row" key={'add-' + r.key}>
                  <div className="av-asset">
                    {coinChip(r.key)}
                    <div className="meta">
                      <div className="nm">{r.cfg.symbol}</div>
                      <div className="amt">Not supplied</div>
                    </div>
                  </div>
                  <div className="av-rr">
                    <div className="av-btns">
                      <button className="av-mini primary" onClick={() => setModal({ type: 'supply', asset: r.key })}>
                        Supply
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>

          {/* borrowed */}
          <div className="av-col">
            <div className="av-colh">
              <h2>
                <span className="dm" style={{ background: 'var(--warn)' }} /> Borrowed
              </h2>
              <span className="tot">{usd(borrowed)}</span>
            </div>
            {borrowedRows.length === 0 && <div className="av-empty">No open borrows.</div>}
            {borrowedRows.map((r) => (
              <div className="av-row" key={r.key}>
                <div className="av-asset">
                  {coinChip(r.key)}
                  <div className="meta">
                    <div className="nm">{r.cfg.symbol}</div>
                    <div className="amt">
                      {amt(r.borAmt)} {r.cfg.symbol}
                    </div>
                  </div>
                </div>
                <div className="av-rr">
                  <div className="av-usd">{usd(r.borUsd)}</div>
                  <div className="av-btns">
                    <button className="av-mini primary" onClick={() => setModal({ type: 'repay', asset: r.key })}>
                      Repay
                    </button>
                    <button className="av-mini" onClick={() => setModal({ type: 'borrow', asset: r.key })}>
                      Borrow
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {rows
              .filter((r) => r.borAmt === 0)
              .map((r) => (
                <div className="av-row" key={'brw-' + r.key}>
                  <div className="av-asset">
                    {coinChip(r.key)}
                    <div className="meta">
                      <div className="nm">{r.cfg.symbol}</div>
                      <div className="amt">Not borrowed</div>
                    </div>
                  </div>
                  <div className="av-rr">
                    <div className="av-btns">
                      <button className="av-mini" onClick={() => setModal({ type: 'borrow', asset: r.key })}>
                        Borrow
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            <div className="av-bar">
              <div className="lbl">
                <span>Borrow power</span>
                <b>{Math.round(powerUsed)}% used</b>
              </div>
              <div className="av-track">
                <i style={{ width: `${powerUsed}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div className="av-foot">
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: hasAccess ? 'var(--good)' : 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: '.72rem' }}>
              {hasAccess ? '✓ pool access granted' : '— no pool access'}
            </span>
            <button className="av-mini" onClick={handleArchive} disabled={archiving || !userPositionCid}>
              {archiving ? 'Resetting…' : 'Reset from scratch (test)'}
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            v2 · figures are your live testnet position · reusing the audited action modals for now
          </div>
        </div>
      </main>

      {/* action modals — reuse the existing, fully-wired components */}
      {modal?.type === 'supply' && (
        <SupplyModal asset={modal.asset} partyId={partyId} position={position} submitTx={submitTx} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'borrow' && (
        <BorrowModal asset={modal.asset} partyId={partyId} position={position} submitTx={submitTx} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'repay' && (
        <RepayModal asset={modal.asset} partyId={partyId} position={position} submitTx={submitTx} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'withdraw' && (
        <WithdrawModal asset={modal.asset} partyId={partyId} position={position} submitTx={submitTx} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
