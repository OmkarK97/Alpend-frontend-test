import { useState, useEffect } from 'react';
import type { TransactionPayload } from '../loop/provider';
import { ADMIN_API_URL, USDCX_INSTRUMENT_ADMIN, CC_INSTRUMENT_ADMIN } from '../config';
import { buildInitializeUserPositionCommand } from '../commands/pool';

interface Props {
  partyId: string;
  submitTx: (operation: string, payload: TransactionPayload, message: string) => Promise<unknown>;
  addLog: (operation: string, status: 'pending' | 'success' | 'error', message: string, details?: unknown) => void;
}

export function PoolSetup({ partyId, submitTx, addLog }: Props) {
  const [poolCid, setPoolCid] = useState('');
  const [oracleCid, setOracleCid] = useState('');
  const [newObserver, setNewObserver] = useState('');
  const [userParty, setUserParty] = useState('');
  const [adminLoading, setAdminLoading] = useState('');
  const [stepsCompleted, setStepsCompleted] = useState<Record<string, boolean>>({});

  // Auto-detect existing contracts on mount
  useEffect(() => {
    (async () => {
      try {
        // pass ?party so pool-status returns only THIS party's registry (never the full member list)
        const resp = await fetch(
          `${ADMIN_API_URL}/admin/pool-status${partyId ? `?party=${encodeURIComponent(partyId)}` : ''}`
        );
        const data = await resp.json();
        if (!data.success) return;

        const completed: Record<string, boolean> = {};

        if (data.oracle?.cid) {
          setOracleCid(data.oracle.cid);
          completed.oracle = true;
        }
        if (data.pool?.cid) {
          setPoolCid(data.pool.cid);
          completed.pool = true;
        }
        if (data.assetReserves?.length > 0) {
          completed.assetReserve = true;
          const hasCC = data.assetReserves.some((r: { instrumentId?: { id?: string } }) =>
            r.instrumentId?.id === 'Amulet'
          );
          if (hasCC) completed.ccAssetReserve = true;
        }
        if (data.oracle?.prices && Object.keys(data.oracle.prices).length > 0) {
          completed.price = true;
        }
        if (data.pool?.observers?.length > 0) {
          completed.observer = true;
        }
        if (data.userPositions?.some((u: { user: string }) => u.user === partyId)) {
          completed.userPosition = true;
        }

        setStepsCompleted(completed);
        if (Object.keys(completed).length > 0) {
          addLog('AutoDetect', 'success', `Found existing: ${Object.keys(completed).join(', ')}`, data);
        }
      } catch {
        // Silent fail — user can still do steps manually
      }
    })();
  }, [partyId]);

  // Asset Reserve fields
  const [priceFeedId, setPriceFeedId] = useState('usdcx-feed');
  const [ltv, setLtv] = useState('0.8000000000');
  const [liquidationThreshold, setLiquidationThreshold] = useState('0.8250000000');
  const [liquidationBonus, setLiquidationBonus] = useState('0.0500000000');
  const [optimalUtilization, setOptimalUtilization] = useState('0.8000000000');
  const [baseRate, setBaseRate] = useState('0.0000000000');
  const [slope1, setSlope1] = useState('0.0400000000');
  const [slope2, setSlope2] = useState('0.7500000000');
  const [reserveFactor, setReserveFactor] = useState('0.1000000000');

  // CC Asset Reserve fields
  const [ccPriceFeedId, setCcPriceFeedId] = useState('cc-feed');
  const [ccLtv, setCcLtv] = useState('0.7000000000');
  const [ccLiquidationThreshold, setCcLiquidationThreshold] = useState('0.7500000000');
  const [ccLiquidationBonus, setCcLiquidationBonus] = useState('0.0500000000');
  const [ccOptimalUtilization, setCcOptimalUtilization] = useState('0.8000000000');
  const [ccBaseRate, setCcBaseRate] = useState('0.0000000000');
  const [ccSlope1, setCcSlope1] = useState('0.0400000000');
  const [ccSlope2, setCcSlope2] = useState('0.7500000000');
  const [ccReserveFactor, setCcReserveFactor] = useState('0.1000000000');

  // Seed CC liquidity
  const [ccSeedAmount, setCcSeedAmount] = useState('10.0');

  // Set Price fields
  const [priceValue, setPriceValue] = useState('1.0000000000');
  const [ccPriceValue, setCcPriceValue] = useState('0.0100000000');

  const callAdmin = async (endpoint: string, body: Record<string, unknown>, operationName: string) => {
    setAdminLoading(operationName);
    addLog(operationName, 'pending', `Calling admin: ${operationName}`);
    try {
      const resp = await fetch(`${ADMIN_API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      addLog(operationName, 'success', `Admin ${operationName} completed`, data);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(operationName, 'error', `Admin ${operationName} failed: ${msg}`, err);
      throw err;
    } finally {
      setAdminLoading('');
    }
  };

  return (
    <div className="section">
      <h2>Pool & User Setup (Alpend v2)</h2>

      <h3 style={{ marginTop: 4, marginBottom: 8, color: '#f0f6fc' }}>
        Admin Operations <span style={{ fontSize: '0.7rem', color: '#8b949e' }}>(via backend as pool operator)</span>
      </h3>

      {/* Step 1: Create Oracle */}
      <div className="operation-card">
        <h3>1. Create Price Oracle {stepsCompleted.oracle && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>Creates PriceOracle contract. Required before creating the pool.</p>
        <button
          onClick={async () => {
            const result = await callAdmin('/admin/create-oracle', {
              maxStalenessSeconds: 3600,
            }, 'CreateOracle');
            if (result?.oracleCid) {
              setOracleCid(result.oracleCid);
            }
          }}
          disabled={adminLoading === 'CreateOracle'}
          className="btn btn-primary"
        >
          {adminLoading === 'CreateOracle' ? 'Creating...' : 'Create Oracle (Admin)'}
        </button>
        {oracleCid && (
          <div style={{ fontSize: '0.75rem', marginTop: 4, color: '#4caf50' }}>
            Oracle CID: {oracleCid.substring(0, 30)}...
          </div>
        )}
      </div>

      {/* Step 2: Create Pool */}
      <div className="operation-card">
        <h3>2. Create Lending Pool {stepsCompleted.pool && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>Creates LendingPool with the oracle. No asset-specific config needed here.</p>
        <div className="form-group">
          <label>Oracle CID (auto-filled from step 1)</label>
          <input value={oracleCid} onChange={(e) => setOracleCid(e.target.value)} placeholder="Oracle CID..." className="input-wide" />
        </div>
        <button
          onClick={async () => {
            const result = await callAdmin('/admin/create-pool', { oracleCid }, 'CreatePool');
            if (result?.poolContractId) {
              setPoolCid(result.poolContractId);
            }
          }}
          disabled={!oracleCid || adminLoading === 'CreatePool'}
          className="btn btn-primary"
        >
          {adminLoading === 'CreatePool' ? 'Creating...' : 'Create Lending Pool (Admin)'}
        </button>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '16px 0' }} />

      <div className="form-group">
        <label>Pool Contract ID (auto-filled after create, used for operations below)</label>
        <input
          type="text"
          value={poolCid}
          onChange={(e) => setPoolCid(e.target.value)}
          placeholder="Pool contract ID..."
          className="input-wide"
        />
      </div>

      {/* Step 3: Add Asset Reserve for USDCx */}
      <div className="operation-card">
        <h3>3. Add USDCx Asset Reserve {stepsCompleted.assetReserve && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>Creates per-asset reserve with risk params and interest rate model.</p>
        <div className="form-grid">
          <div className="form-group">
            <label>Price Feed ID</label>
            <input value={priceFeedId} onChange={(e) => setPriceFeedId(e.target.value)} placeholder="usdcx-feed" />
          </div>
          <div className="form-group">
            <label>LTV (e.g. 0.80)</label>
            <input value={ltv} onChange={(e) => setLtv(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Liquidation Threshold</label>
            <input value={liquidationThreshold} onChange={(e) => setLiquidationThreshold(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Liquidation Bonus</label>
            <input value={liquidationBonus} onChange={(e) => setLiquidationBonus(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Optimal Utilization</label>
            <input value={optimalUtilization} onChange={(e) => setOptimalUtilization(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Base Rate</label>
            <input value={baseRate} onChange={(e) => setBaseRate(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Slope 1</label>
            <input value={slope1} onChange={(e) => setSlope1(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Slope 2</label>
            <input value={slope2} onChange={(e) => setSlope2(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Reserve Factor</label>
            <input value={reserveFactor} onChange={(e) => setReserveFactor(e.target.value)} />
          </div>
        </div>
        <button
          onClick={async () => {
            const result = await callAdmin('/admin/add-asset-reserve', {
              poolContractId: poolCid,
              instrumentAdmin: USDCX_INSTRUMENT_ADMIN,
              instrumentId: { admin: USDCX_INSTRUMENT_ADMIN, id: 'USDCx' },
              riskParams: {
                ltv, liquidationThreshold, liquidationBonus,
                priceFeedId, isActive: true, depositCap: null, borrowCap: null,
              },
              interestRateParams: {
                optimalUtilization, baseRate, slope1, slope2, reserveFactor,
              },
            }, 'AddAssetReserve');
            if (result?.newPoolCid) {
              setPoolCid(result.newPoolCid);
            }
          }}
          disabled={!poolCid || adminLoading === 'AddAssetReserve'}
          className="btn btn-primary"
        >
          {adminLoading === 'AddAssetReserve' ? 'Adding...' : 'Add USDCx Reserve (Admin)'}
        </button>
      </div>

      {/* Step 3b: Add CC Asset Reserve */}
      <div className="operation-card">
        <h3>3b. Add CC (Canton Coin) Asset Reserve {stepsCompleted.ccAssetReserve && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>Adds Canton Coin as a borrowable asset on the same pool.</p>
        <div className="form-grid">
          <div className="form-group">
            <label>CC Price Feed ID</label>
            <input value={ccPriceFeedId} onChange={(e) => setCcPriceFeedId(e.target.value)} placeholder="cc-feed" />
          </div>
          <div className="form-group">
            <label>LTV</label>
            <input value={ccLtv} onChange={(e) => setCcLtv(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Liquidation Threshold</label>
            <input value={ccLiquidationThreshold} onChange={(e) => setCcLiquidationThreshold(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Liquidation Bonus</label>
            <input value={ccLiquidationBonus} onChange={(e) => setCcLiquidationBonus(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Optimal Utilization</label>
            <input value={ccOptimalUtilization} onChange={(e) => setCcOptimalUtilization(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Base Rate</label>
            <input value={ccBaseRate} onChange={(e) => setCcBaseRate(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Slope 1</label>
            <input value={ccSlope1} onChange={(e) => setCcSlope1(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Slope 2</label>
            <input value={ccSlope2} onChange={(e) => setCcSlope2(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Reserve Factor</label>
            <input value={ccReserveFactor} onChange={(e) => setCcReserveFactor(e.target.value)} />
          </div>
        </div>
        <button
          onClick={async () => {
            const result = await callAdmin('/admin/add-asset-reserve', {
              poolContractId: poolCid,
              instrumentAdmin: CC_INSTRUMENT_ADMIN,
              instrumentId: { admin: CC_INSTRUMENT_ADMIN, id: 'Amulet' },
              riskParams: {
                ltv: ccLtv, liquidationThreshold: ccLiquidationThreshold, liquidationBonus: ccLiquidationBonus,
                priceFeedId: ccPriceFeedId, isActive: true, depositCap: null, borrowCap: null,
              },
              interestRateParams: {
                optimalUtilization: ccOptimalUtilization, baseRate: ccBaseRate,
                slope1: ccSlope1, slope2: ccSlope2, reserveFactor: ccReserveFactor,
              },
            }, 'AddCCAssetReserve');
            if (result?.newPoolCid) {
              setPoolCid(result.newPoolCid);
            }
          }}
          disabled={!poolCid || adminLoading === 'AddCCAssetReserve'}
          className="btn btn-primary"
        >
          {adminLoading === 'AddCCAssetReserve' ? 'Adding...' : 'Add CC Reserve (Admin)'}
        </button>
      </div>

      {/* Step 3c: Seed CC Liquidity */}
      <div className="operation-card">
        <h3>3c. Seed CC Liquidity {stepsCompleted.ccLiquidity && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>
          Add CC (Canton Coin) liquidity to the pool so users can borrow.
          Uses the pool operator's CC holdings.
        </p>
        <div className="form-grid">
          <div className="form-group">
            <label>Amount (CC)</label>
            <input value={ccSeedAmount} onChange={(e) => setCcSeedAmount(e.target.value)} />
          </div>
        </div>
        <button
          onClick={async () => {
            // Find CC asset reserve CID
            const arResp = await fetch(`${ADMIN_API_URL}/admin/asset-reserves`);
            const arData = await arResp.json();
            const ccReserve = (arData.contracts || []).find(
              (c: { createArgument?: { instrumentId?: { id?: string } } }) =>
                c.createArgument?.instrumentId?.id === 'Amulet'
            );
            if (!ccReserve) {
              addLog('SeedCCLiquidity', 'error', 'CC asset reserve not found — add it first (Step 3b)');
              return;
            }
            await callAdmin('/admin/seed-cc-liquidity', {
              assetReserveCid: ccReserve.contractId,
              amount: ccSeedAmount,
            }, 'SeedCCLiquidity');
          }}
          disabled={!poolCid || adminLoading === 'SeedCCLiquidity' || !stepsCompleted.ccAssetReserve}
          className="btn btn-primary"
        >
          {adminLoading === 'SeedCCLiquidity' ? 'Seeding...' : `Seed ${ccSeedAmount} CC Liquidity`}
        </button>
      </div>

      {/* Step 4: Set Prices */}
      <div className="operation-card">
        <h3>4. Set Prices on Oracle {stepsCompleted.price && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>Sets prices so the oracle has values for USD calculations.</p>

        <h4 style={{ color: '#8b949e', marginBottom: 8 }}>USDCx Price</h4>
        <div className="form-grid">
          <div className="form-group">
            <label>Feed ID</label>
            <input value={priceFeedId} onChange={(e) => setPriceFeedId(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Price (USD)</label>
            <input value={priceValue} onChange={(e) => setPriceValue(e.target.value)} placeholder="1.0000000000" />
          </div>
        </div>
        <button
          onClick={() => callAdmin('/admin/set-price', {
            oracleCid,
            feedId: priceFeedId,
            priceValue,
          }, 'SetUSDCxPrice')}
          disabled={!priceFeedId || adminLoading === 'SetUSDCxPrice'}
          className="btn btn-primary"
          style={{ marginBottom: 12 }}
        >
          {adminLoading === 'SetUSDCxPrice' ? 'Setting...' : 'Set USDCx Price (Admin)'}
        </button>

        <h4 style={{ color: '#8b949e', marginBottom: 8 }}>CC Price</h4>
        <div className="form-grid">
          <div className="form-group">
            <label>Feed ID</label>
            <input value={ccPriceFeedId} onChange={(e) => setCcPriceFeedId(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Price (USD)</label>
            <input value={ccPriceValue} onChange={(e) => setCcPriceValue(e.target.value)} placeholder="0.0100000000" />
          </div>
        </div>
        <button
          onClick={() => callAdmin('/admin/set-price', {
            oracleCid,
            feedId: ccPriceFeedId,
            priceValue: ccPriceValue,
          }, 'SetCCPrice')}
          disabled={!ccPriceFeedId || adminLoading === 'SetCCPrice'}
          className="btn btn-primary"
        >
          {adminLoading === 'SetCCPrice' ? 'Setting...' : 'Set CC Price (Admin)'}
        </button>
      </div>

      {/* Step 4b: Fix stale oracle reference in pool */}
      <div className="operation-card">
        <h3>4b. Sync Pool Oracle Reference</h3>
        <p className="muted" style={{ marginBottom: 8 }}>
          If SetPrice was run but the pool still has a stale oracle CID, click this to update it.
          Auto-detects the latest oracle and pool contracts.
        </p>
        <button
          onClick={async () => {
            const result = await callAdmin('/admin/update-oracle-ref', {}, 'UpdateOracleRef');
            if (result?.updatedPoolCid) {
              setPoolCid(result.updatedPoolCid);
            }
          }}
          disabled={adminLoading === 'UpdateOracleRef'}
          className="btn btn-primary"
        >
          {adminLoading === 'UpdateOracleRef' ? 'Updating...' : 'Sync Oracle Reference (Admin)'}
        </button>
      </div>

      {/* Step 5: Add Observer */}
      <div className="operation-card">
        <h3>5. Add Observer {stepsCompleted.observer && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>Adds a party as observer so they can see and use the pool.</p>
        <div className="form-group">
          <label>New Observer Party</label>
          <input
            type="text"
            value={newObserver}
            onChange={(e) => setNewObserver(e.target.value)}
            placeholder="Party ID..."
            className="input-wide"
          />
        </div>
        <button
          onClick={async () => {
            const result = await callAdmin('/admin/add-observer', { poolContractId: poolCid, newObserver }, 'AddObserver');
            if (result?.newPoolContractId) {
              setPoolCid(result.newPoolContractId);
            }
          }}
          disabled={!poolCid || !newObserver || adminLoading === 'AddObserver'}
          className="btn btn-primary"
        >
          {adminLoading === 'AddObserver' ? 'Adding...' : 'Add Observer (Admin)'}
        </button>
      </div>

      <h3 style={{ marginTop: 24, marginBottom: 8, color: '#f0f6fc' }}>
        User Operations <span style={{ fontSize: '0.7rem', color: '#8b949e' }}>(via Loop wallet as connected user)</span>
      </h3>

      {/* Step 6: Initialize User Position */}
      <div className="operation-card">
        <h3>6. Initialize User Position {stepsCompleted.userPosition && <span style={{ color: '#4caf50', fontSize: '0.8rem' }}>Done</span>}</h3>
        <p className="muted" style={{ marginBottom: 8 }}>Creates your UserPosition contract. Signed by your Loop wallet.</p>
        <div className="form-group">
          <label>User Party (defaults to connected party)</label>
          <input
            type="text"
            value={userParty || partyId}
            onChange={(e) => setUserParty(e.target.value)}
            placeholder="Party ID..."
            className="input-wide"
          />
        </div>
        <button
          onClick={async () => {
            // Fetch pool disclosed contracts (LendingPool blob needed for visibility)
            let poolDisclosed: unknown[] = [];
            try {
              const dcResp = await fetch(`${ADMIN_API_URL}/admin/pool-disclosed-contracts`);
              const dcData = await dcResp.json();
              if (dcData.disclosedContracts) {
                poolDisclosed = dcData.disclosedContracts;
              }
            } catch (err) {
              addLog('InitializeUserPosition', 'error', `Failed to fetch pool disclosed contracts: ${err}`);
            }
            submitTx(
              'InitializeUserPosition',
              buildInitializeUserPositionCommand(poolCid, userParty || partyId, poolDisclosed as never[]),
              `Initialize user position for ${userParty || partyId}`
            );
          }}
          disabled={!poolCid}
          className="btn btn-primary"
        >
          Initialize User Position (Wallet)
        </button>
      </div>
    </div>
  );
}
