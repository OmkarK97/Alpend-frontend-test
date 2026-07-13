import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3100;
const LEDGER_URL = process.env.LEDGER_URL;
const AUTH_URL = process.env.AUTH_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const AUDIENCE = process.env.AUDIENCE;
const POOL_OPERATOR = process.env.POOL_OPERATOR_PARTY;
const LENDING_PACKAGE_ID = process.env.LENDING_PACKAGE_ID;

// Auth0 token cache
let cachedToken = null;
let tokenExpiry = null;

async function getToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }
  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: AUDIENCE,
      grant_type: 'client_credentials',
    }),
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function submitCommand(commands, actAsParties, disclosedContracts = []) {
  const token = await getToken();
  // Prefer the CURRENT amulet package version for interpretation. The registry can
  // disclose amulet contracts spanning multiple versions (e.g. AmuletRules on an older
  // package, ExternalPartyConfigState on the current one). packageIdSelectionPreference
  // allows only ONE package-id per package-name, and it must be the NEWEST so older
  // contracts UPGRADE to it — downgrading a newer contract fails ("optional field ...
  // may not be dropped"). The ExternalPartyConfigState contract tracks the current amulet
  // version, so key the preference off its package.
  const configState = disclosedContracts.find((dc) =>
    (dc.templateId || '').includes('ExternalPartyConfigState')
  );
  const amuletPkg = configState ? (configState.templateId || '').split(':')[0] : null;
  const extraPrefs = amuletPkg && /^[0-9a-f]{64}$/.test(amuletPkg) ? [amuletPkg] : [];
  const packageIdSelectionPreference = [...new Set([LENDING_PACKAGE_ID, ...extraPrefs])];
  const payload = {
    commands: {
      commands,
      commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actAs: Array.isArray(actAsParties) ? actAsParties : [actAsParties],
      readAs: [],
      disclosedContracts,
      packageIdSelectionPreference,
    },
  };
  console.log('packageIdSelectionPreference:', packageIdSelectionPreference);
  console.log('submitCommand payload:', JSON.stringify(payload, null, 2));
  const resp = await fetch(`${LEDGER_URL}/v2/commands/submit-and-wait-for-transaction`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Ledger error ${resp.status}: ${errBody}`);
  }
  return resp.json();
}

// =============================================
// CC CHOICE CONTEXT & DISCLOSED CONTRACTS
// (Mirrors reference backend pattern)
// =============================================

// Canton proxy URL — proxy on canton-testnet has Scan API access
const CANTON_PROXY_URL = process.env.CANTON_PROXY_URL || 'http://34.72.196.18:4000';

/** Fetch CC transfer context from Scan registry transfer-factory endpoint.
 *  Returns factoryId, choiceContext (with amulet-rules, open-round, external-party-config-state),
 *  and all disclosed contracts (including ExternalPartyConfigState).
 *  @param {string} [sender] - sender party (defaults to pool operator) */
async function fetchCCTransferFactory(sender, overrides = {}) {
  const poolOperator = process.env.POOL_OPERATOR_PARTY;
  const effectiveSender = sender || poolOperator;
  const dso = `DSO::${(process.env.SYNCHRONIZER_ID || '').split('::')[1] || '1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337'}`;

  const resp = await fetch(`${CANTON_PROXY_URL}/api/transfer-factory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      choiceArguments: {
        expectedAdmin: dso,
        transfer: {
          sender: effectiveSender,
          receiver: overrides.receiver || poolOperator,
          amount: overrides.amount || '1.0',
          instrumentId: { admin: dso, id: 'Amulet' },
          requestedAt: new Date().toISOString(),
          executeBefore: new Date(Date.now() + 86400000).toISOString(),
          inputHoldingCids: overrides.inputHoldingCids || [],
          meta: { values: {} },
        },
        extraArgs: {
          context: { values: {} },
          meta: { values: {} },
        },
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`transfer-factory endpoint failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  console.log('CC transfer-factory: factoryId:', data.factoryId?.substring(0, 40),
    'context keys:', Object.keys(data.choiceContext?.choiceContextData?.values || {}),
    'disclosed:', data.choiceContext?.disclosedContracts?.length);
  return data;
}

/** Build CC choice context from env vars (for server-side CC operations).
 *  Returns choiceContext + CIDs/blobs for building disclosed contracts. */
async function buildCCChoiceContext() {
  const amuletRulesCid = process.env.AMULET_RULES_CID;
  const amuletRulesBlob = process.env.AMULET_RULES_BLOB;
  const openRoundCid = process.env.OPEN_ROUND_CID;
  const openRoundBlob = process.env.OPEN_ROUND_BLOB;

  if (!amuletRulesCid || !openRoundCid) {
    // Fallback: try fetching from Scan proxy
    try {
      const data = await fetchCCTransferFactory();
      const ctx = data.choiceContext?.choiceContextData || { values: {} };
      return {
        choiceContext: ctx,
        openRoundCid: ctx.values?.['open-round']?.value || '',
        openRoundBlob: '',
        amuletRulesCid: ctx.values?.['amulet-rules']?.value || '',
        amuletRulesBlob: '',
      };
    } catch (e) {
      throw new Error(`Missing AMULET_RULES_CID/OPEN_ROUND_CID env vars and Scan proxy fallback failed: ${e.message}`);
    }
  }

  const choiceContext = {
    values: {
      'amulet-rules': { tag: 'AV_ContractId', value: amuletRulesCid },
      'open-round': { tag: 'AV_ContractId', value: openRoundCid },
    },
  };

  return { choiceContext, openRoundCid, openRoundBlob, amuletRulesCid, amuletRulesBlob };
}

function buildCCDisclosedContracts(transferFactoryCid, openRoundCid, openRoundBlob, amuletRulesCid, amuletRulesBlob) {
  const disclosed = [];
  const synchronizerId = process.env.SYNCHRONIZER_ID || 'global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';
  const transferFactoryBlob = process.env.AMULET_TRANSFER_FACTORY_BLOB;
  if (transferFactoryBlob) {
    disclosed.push({ contractId: transferFactoryCid, createdEventBlob: transferFactoryBlob, synchronizerId });
  }
  const effectiveRulesCid = amuletRulesCid || process.env.AMULET_RULES_CID;
  const effectiveRulesBlob = amuletRulesBlob || process.env.AMULET_RULES_BLOB;
  if (effectiveRulesCid && effectiveRulesBlob) {
    disclosed.push({ contractId: effectiveRulesCid, createdEventBlob: effectiveRulesBlob, synchronizerId });
  }
  if (openRoundCid && openRoundBlob) {
    disclosed.push({ contractId: openRoundCid, createdEventBlob: openRoundBlob, synchronizerId });
  }
  return disclosed;
}

async function queryContracts(templateId, party) {
  const token = await getToken();
  // Get latest offset
  const offsetResp = await fetch(`${LEDGER_URL}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const offsetData = await offsetResp.json();
  const latestOffset = offsetData?.offset || 0;

  const payload = {
    eventFormat: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: { templateId, includeCreatedEventBlob: true },
                },
              },
            },
          ],
        },
      },
      verbose: true,
    },
    activeAtOffset: latestOffset,
  };

  const resp = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Query error ${resp.status}: ${errBody}`);
  }
  const data = await resp.json();
  console.log('queryContracts raw response keys:', Array.isArray(data) ? `array[${data.length}]` : Object.keys(data));
  // Extract active contracts from response
  // Response can be { activeContracts: [...] } or a flat array
  const contracts = [];
  const entries = Array.isArray(data) ? data : (data.activeContracts || []);
  for (const entry of entries) {
    const ce = entry?.contractEntry?.JsActiveContract?.createdEvent ||
               entry?.contractEntry?.activeContract?.createdEvent ||
               entry?.createdEvent;
    if (ce) contracts.push(ce);
  }
  return contracts;
}

// Query contracts using filtersForAnyParty — finds contracts visible to ANY party on the participant
// Useful for DSO-managed contracts (AmuletRules, OpenMiningRound, ExternalPartyConfigState)
async function queryContractsAnyParty(templateId) {
  const token = await getToken();
  const offsetResp = await fetch(`${LEDGER_URL}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const offsetData = await offsetResp.json();
  const latestOffset = offsetData?.offset || 0;

  const payload = {
    eventFormat: {
      filtersForAnyParty: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: { templateId, includeCreatedEventBlob: true },
              },
            },
          },
        ],
      },
      verbose: true,
    },
    activeAtOffset: latestOffset,
  };

  const resp = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`QueryAnyParty error ${resp.status}: ${errBody}`);
  }
  const data = await resp.json();
  console.log('queryContractsAnyParty raw response for', templateId, ':', Array.isArray(data) ? `array[${data.length}]` : Object.keys(data));
  const contracts = [];
  const entries = Array.isArray(data) ? data : (data.activeContracts || []);
  for (const entry of entries) {
    const ce = entry?.contractEntry?.JsActiveContract?.createdEvent ||
               entry?.contractEntry?.activeContract?.createdEvent ||
               entry?.createdEvent;
    if (ce) contracts.push(ce);
  }
  return contracts;
}

function extractContractId(result) {
  if (result.transaction?.events) {
    for (const event of result.transaction.events) {
      if (event.CreatedEvent?.contractId) return event.CreatedEvent.contractId;
    }
  }
  return null;
}

// =============================================
// ADMIN ENDPOINTS
// =============================================

/** GET /admin/pool-status
 * Auto-detect existing pool contracts so the frontend can skip already-completed steps.
 */
app.get('/admin/pool-status', async (req, res) => {
  try {
    const [oracleContracts, poolContracts, reserveContracts, userPosContracts] = await Promise.all([
      queryContracts(`#alpend-lending-final-loop:Lending.Oracle:PriceOracle`, POOL_OPERATOR),
      queryContracts(`#alpend-lending-final-loop:Lending.Pool:LendingPool`, POOL_OPERATOR),
      queryContracts(`#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`, POOL_OPERATOR),
      queryContracts(`#alpend-lending-final-loop:Lending.UserPosition:UserPosition`, POOL_OPERATOR),
    ]);

    const latestOracle = oracleContracts[oracleContracts.length - 1];
    const latestPool = poolContracts[poolContracts.length - 1];

    const status = {
      oracle: latestOracle ? { cid: latestOracle.contractId, prices: latestOracle.createArgument?.prices } : null,
      pool: latestPool ? {
        cid: latestPool.contractId,
        observers: latestPool.createArgument?.observers,
        assetReserveKeys: latestPool.createArgument?.assetReserveKeys,
        pauseFlags: {
          pauseDeposits: latestPool.createArgument?.pauseDeposits ?? false,
          pauseWithdrawals: latestPool.createArgument?.pauseWithdrawals ?? false,
          pauseBorrows: latestPool.createArgument?.pauseBorrows ?? false,
          pauseLiquidations: latestPool.createArgument?.pauseLiquidations ?? false,
        },
      } : null,
      assetReserves: reserveContracts.map(r => ({
        cid: r.contractId,
        instrumentId: r.createArgument?.instrumentId,
      })),
      userPositions: userPosContracts.map(u => ({
        cid: u.contractId,
        user: u.createArgument?.user,
      })),
    };

    console.log(`Pool status: oracle=${!!status.oracle}, pool=${!!status.pool}, reserves=${status.assetReserves.length}, positions=${status.userPositions.length}`);
    res.json({ success: true, ...status });
  } catch (e) {
    console.error('POOL STATUS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/create-oracle
 * Creates a PriceOracle contract.
 * Body: { maxStalenessSeconds? }
 */
app.post('/admin/create-oracle', async (req, res) => {
  try {
    const {
      maxStalenessSeconds = 3600,
      liquidationMaxStalenessSeconds = 7200,
      maxDeviationBps = 1000,
      allowManualPrice = true, // testnet: enables manual SetPrice; deploy false in prod
    } = req.body;
    const oraclePusher = process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR;

    const commands = [
      {
        CreateCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Oracle:PriceOracle`,
          createArguments: {
            poolOperator: POOL_OPERATOR,
            oraclePusher,
            prices: {},
            pendingPrices: {},
            feedAliases: {},
            // Daml Int must be string-encoded in the JSON Ledger API
            maxStalenessSeconds: String(parseInt(maxStalenessSeconds)),
            liquidationMaxStalenessSeconds: String(parseInt(liquidationMaxStalenessSeconds)),
            maxDeviationBps: String(parseInt(maxDeviationBps)),
            allowManualPrice,
            pinnedVerifierCid: null,
            pinnedVerifierConfigCid: null,
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);
    const oracleCid = extractContractId(result);

    res.json({
      success: true,
      oracleCid,
      message: 'PriceOracle created. Next: create pool.',
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('CREATE ORACLE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/create-pool
 * Creates a new LendingPool contract (Alpend v2).
 * Body: { oracleCid }
 */
app.post('/admin/create-pool', async (req, res) => {
  try {
    const { oracleCid } = req.body;

    if (!oracleCid) {
      return res.status(400).json({ success: false, error: 'oracleCid is required' });
    }

    const commands = [
      {
        CreateCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
          createArguments: {
            poolOperator: POOL_OPERATOR,
            oraclePusher: process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR,
            treasuryParty: process.env.TREASURY_PARTY || POOL_OPERATOR,
            oracleCid,
            assetReserveCids: [],
            pauseDeposits: false,
            pauseWithdrawals: false,
            pauseBorrows: false,
            pauseLiquidations: false,
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);
    const poolContractId = extractContractId(result);

    res.json({
      success: true,
      poolContractId,
      message: 'LendingPool created. Next: add asset reserve, set price, add observers.',
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('CREATE POOL error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/add-asset-reserve
 * Exercises AddAssetReserve on LendingPool.
 * Body: { poolContractId, instrumentAdmin, instrumentId, riskParams, interestRateParams }
 */
app.post('/admin/add-asset-reserve', async (req, res) => {
  try {
    const { poolContractId, instrumentAdmin, instrumentId, riskParams, interestRateParams } = req.body;

    if (!poolContractId || !instrumentAdmin || !instrumentId || !riskParams || !interestRateParams) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
          contractId: poolContractId,
          choice: 'AddAssetReserve',
          choiceArgument: {
            instrumentAdmin,
            instrumentId,
            riskParams: {
              ltv: riskParams.ltv,
              liquidationThreshold: riskParams.liquidationThreshold,
              liquidationBonus: riskParams.liquidationBonus,
              priceFeedId: riskParams.priceFeedId,
              isActive: riskParams.isActive ?? true,
              depositCap: riskParams.depositCap || null,
              borrowCap: riskParams.borrowCap || null,
            },
            interestRateParams: {
              optimalUtilization: interestRateParams.optimalUtilization,
              baseRate: interestRateParams.baseRate,
              slope1: interestRateParams.slope1,
              slope2: interestRateParams.slope2,
              reserveFactor: interestRateParams.reserveFactor,
              // Annualized decay on idle balance (CC holding fee); 0 for non-decaying assets like USDCx
              holdingFeeRate: interestRateParams.holdingFeeRate ?? '0.0000000000',
            },
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);

    // AddAssetReserve returns (ContractId LendingPool, ContractId AssetReserve)
    const events = result.transaction?.events || [];
    const createdEvents = events.filter(e => e.CreatedEvent);
    const newPoolCid = createdEvents.find(e =>
      e.CreatedEvent?.templateId?.includes('LendingPool')
    )?.CreatedEvent?.contractId;
    const assetReserveCid = createdEvents.find(e =>
      e.CreatedEvent?.templateId?.includes('AssetReserve')
    )?.CreatedEvent?.contractId;

    res.json({
      success: true,
      newPoolCid,
      assetReserveCid,
      message: 'Asset reserve added. Pool CID has changed.',
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('ADD ASSET RESERVE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/set-price
 * Exercises SetPrice on PriceOracle.
 * Body: { oracleCid, feedId, priceValue, featuredAppRightCid? }
 */
app.post('/admin/set-price', async (req, res) => {
  try {
    const { oracleCid: passedCid, feedId, priceValue, featuredAppRightCid = null } = req.body;

    if (!feedId || !priceValue) {
      return res.status(400).json({ success: false, error: 'feedId and priceValue are required' });
    }

    // SetPrice is a consuming choice — the oracle CID changes on every call. Resolve the
    // CURRENT active PriceOracle instead of trusting a possibly-stale CID from the caller
    // (setting a second price would otherwise hit the archived oracle from the first).
    const oracles = await queryContracts(`#alpend-lending-final-loop:Lending.Oracle:PriceOracle`, POOL_OPERATOR);
    const oracleCid = oracles.length ? oracles[oracles.length - 1].contractId : passedCid;
    if (!oracleCid) {
      return res.status(404).json({ success: false, error: 'No active PriceOracle found' });
    }

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Oracle:PriceOracle`,
          contractId: oracleCid,
          choice: 'SetPrice',
          choiceArgument: {
            feedId,
            priceValue,
            batchedMarkersProxyCid: null,
            featuredAppRightCid,
            numMarkers: null,
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);
    const newOracleCid = extractContractId(result);

    // Auto-update the LendingPool's oracleCid reference so it points to the new oracle
    let updatedPoolCid = null;
    if (newOracleCid) {
      try {
        const poolContracts = await queryContracts(`#alpend-lending-final-loop:Lending.Pool:LendingPool`, POOL_OPERATOR);
        const latestPool = poolContracts[poolContracts.length - 1];
        if (latestPool?.contractId) {
          const updateCmd = [{
            ExerciseCommand: {
              templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
              contractId: latestPool.contractId,
              choice: 'UpdateOracleCid',
              choiceArgument: { newOracleCid },
            },
          }];
          const updateResult = await submitCommand(updateCmd, [POOL_OPERATOR]);
          updatedPoolCid = extractContractId(updateResult);
          console.log(`Updated pool oracle reference: pool=${updatedPoolCid}, oracle=${newOracleCid}`);
        }
      } catch (err) {
        console.error('Failed to update pool oracle reference:', err.message);
      }
    }

    res.json({
      success: true,
      newOracleCid,
      updatedPoolCid,
      message: `Price set for ${feedId}: ${priceValue}`,
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('SET PRICE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/update-oracle-ref
 * Fixes stale oracleCid inside LendingPool by exercising UpdateOracleCid.
 * Auto-detects latest pool and oracle CIDs if not provided.
 */
app.post('/admin/update-oracle-ref', async (req, res) => {
  try {
    let { poolContractId, newOracleCid } = req.body;

    // Auto-detect if not provided
    if (!newOracleCid) {
      const oracleContracts = await queryContracts(`#alpend-lending-final-loop:Lending.Oracle:PriceOracle`, POOL_OPERATOR);
      const latestOracle = oracleContracts[oracleContracts.length - 1];
      if (!latestOracle?.contractId) {
        return res.status(400).json({ success: false, error: 'No oracle contract found' });
      }
      newOracleCid = latestOracle.contractId;
    }
    if (!poolContractId) {
      const poolContracts = await queryContracts(`#alpend-lending-final-loop:Lending.Pool:LendingPool`, POOL_OPERATOR);
      const latestPool = poolContracts[poolContracts.length - 1];
      if (!latestPool?.contractId) {
        return res.status(400).json({ success: false, error: 'No pool contract found' });
      }
      poolContractId = latestPool.contractId;
    }

    const commands = [{
      ExerciseCommand: {
        templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
        contractId: poolContractId,
        choice: 'UpdateOracleCid',
        choiceArgument: { newOracleCid },
      },
    }];

    const result = await submitCommand(commands, [POOL_OPERATOR]);
    const updatedPoolCid = extractContractId(result);
    console.log(`Updated pool oracle reference: pool=${updatedPoolCid}, oracle=${newOracleCid}`);

    res.json({
      success: true,
      updatedPoolCid,
      newOracleCid,
      message: `Pool oracle reference updated to ${newOracleCid.substring(0, 20)}...`,
    });
  } catch (e) {
    console.error('UPDATE ORACLE REF error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/add-observer — grant a user access to the pool.
 *  Post-audit the pool's shared observer list was replaced by per-user PoolAccess
 *  contracts (PV-01): this now exercises GrantPoolAccess, which is *nonconsuming*
 *  (the pool CID does NOT change) and issues one PoolAccess contract for the user. */
app.post('/admin/add-observer', async (req, res) => {
  try {
    const { poolContractId, newObserver } = req.body;
    if (!poolContractId) {
      return res.status(400).json({ success: false, error: 'poolContractId is required' });
    }
    if (!newObserver) {
      return res.status(400).json({ success: false, error: 'newObserver (user party) is required' });
    }

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
          contractId: poolContractId,
          choice: 'GrantPoolAccess',
          choiceArgument: { user: newObserver },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);
    // GrantPoolAccess returns the new PoolAccess cid. Do NOT surface it as a pool
    // CID — the pool is unchanged (nonconsuming), so the caller keeps its poolCid.
    const poolAccessCid = extractContractId(result);

    res.json({
      success: true,
      poolAccessCid,
      message: 'Pool access granted (PoolAccess contract created). Pool CID is unchanged.',
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('GRANT POOL ACCESS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/cc-transfer-context — full CC transfer context (factory CID, choice context, disclosed contracts)
 *  Fetches everything from Scan registry transfer-factory endpoint.
 *  Query param: party — the sender's party ID (needed for transfer-preapproval lookup) */
app.get('/admin/cc-transfer-context', async (req, res) => {
  try {
    const party = req.query.party;
    const data = await fetchCCTransferFactory(party);

    // Map response to frontend format
    const transferFactoryCid = data.factoryId;
    const choiceContext = data.choiceContext?.choiceContextData || { values: {} };
    const disclosedContracts = (data.choiceContext?.disclosedContracts || []).map((dc) => ({
      templateId: dc.templateId,
      contractId: dc.contractId,
      createdEventBlob: dc.createdEventBlob,
      domainId: dc.synchronizerId || '',
    }));

    console.log('CC transfer context built:', {
      transferFactoryCid: transferFactoryCid?.substring(0, 40),
      contextKeys: Object.keys(choiceContext.values || {}),
      disclosedCount: disclosedContracts.length,
      party: party?.substring(0, 30),
    });

    res.json({
      success: true,
      transferFactoryCid,
      choiceContext,
      disclosedContracts,
    });
  } catch (e) {
    console.error('CC TRANSFER CONTEXT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/cc-transfer-factory — fetch ExternalPartyAmuletRules (CC transfer factory)
 *  Priority: env vars first, then Scan API fallback */
app.get('/admin/cc-transfer-factory', async (req, res) => {
  try {
    // Use env vars if available (matches reference backend pattern)
    const envCid = process.env.AMULET_TRANSFER_FACTORY_CID;
    if (envCid) {
      console.log('Using ExternalPartyAmuletRules from env:', envCid);
      return res.json({
        success: true,
        contractId: envCid,
        templateId: process.env.AMULET_TRANSFER_FACTORY_TEMPLATE_ID || '',
        createdEventBlob: process.env.AMULET_TRANSFER_FACTORY_BLOB || '',
      });
    }

    // Fallback: fetch from Scan API
    const scanUrl = process.env.SCAN_URL || 'https://scan.sv-1.test.global.canton.network.sync.global';
    console.log('Fetching ExternalPartyAmuletRules from Scan API:', scanUrl);
    const response = await fetch(`${scanUrl}/api/scan/v0/external-party-amulet-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw new Error(`Scan API error: ${response.status}`);
    const data = await response.json();
    const contract = data?.external_party_amulet_rules_update?.contract;
    if (!contract?.contract_id) {
      return res.json({ success: false, error: 'No ExternalPartyAmuletRules found' });
    }
    res.json({
      success: true,
      contractId: contract.contract_id,
      templateId: contract.template_id,
      createdEventBlob: contract.created_event_blob,
    });
  } catch (e) {
    console.error('CC TRANSFER FACTORY error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/cc-holdings/:party — fetch CC (Amulet) holding contract IDs for a party */
app.get('/admin/cc-holdings/:party', async (req, res) => {
  try {
    const { party } = req.params;
    const contracts = await queryCCHoldings(party);
    res.json({
      success: true,
      holdings: contracts.map((c) => ({
        contractId: c.contractId,
        templateId: c.templateId,
        amount: c.createArgument?.amount?.initialAmount ||
                c.interfaceViews?.[0]?.viewValue?.amount,
        owner: c.createArgument?.owner ||
               c.interfaceViews?.[0]?.viewValue?.owner,
        createdEventBlob: c.createdEventBlob,
      })),
      rawContracts: contracts,
    });
  } catch (e) {
    console.error('CC HOLDINGS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/asset-reserves — query existing AssetReserve contracts */
app.get('/admin/asset-reserves', async (req, res) => {
  try {
    const templateId = `#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`;
    const contracts = await queryContracts(templateId, POOL_OPERATOR);
    res.json({ success: true, contracts });
  } catch (e) {
    console.error('QUERY ASSET RESERVES error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/refresh-holdings — reconcile a reserve's on-chain custody.
 *  The reserve's stored `reserveHoldingCids` drift over time (holdings get archived by
 *  merges/decay/manual transfers), and `totalLiquidity` drifts above the real balance via
 *  holding-fee decay. This exercises `AssetReserve.RefreshHoldings` with the pool operator's
 *  CURRENT live holdings of the asset — re-pointing `reserveHoldingCids` at live contracts and
 *  rebooking `totalLiquidity` from the real amounts — then updates the pool's reserve reference
 *  (RefreshHoldings is consuming, so the reserve CID changes). Body: { instrumentIdId } e.g. "USDCx" / "Amulet".
 */
app.post('/admin/refresh-holdings', async (req, res) => {
  try {
    const { instrumentIdId } = req.body;
    if (!instrumentIdId) {
      return res.status(400).json({ success: false, error: 'instrumentIdId is required (e.g. "USDCx" or "Amulet")' });
    }

    // Resolve the current reserve for this instrument (+ its feed id, for the pool re-point).
    const reserves = await queryContracts(`#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`, POOL_OPERATOR);
    const reserve = reserves.filter((r) => r.createArgument?.instrumentId?.id === instrumentIdId).slice(-1)[0];
    if (!reserve) {
      return res.status(404).json({ success: false, error: `No AssetReserve found for instrument ${instrumentIdId}` });
    }
    const feedId = reserve.createArgument?.riskParams?.priceFeedId;
    const oldTotalLiquidity = reserve.createArgument?.totalLiquidity;

    // Pool operator's live holdings of this instrument.
    const holdingContracts = await queryContractsByInterface(HOLDING_INTERFACE, POOL_OPERATOR);
    const holdings = holdingContracts.filter((c) => {
      const id = c.createArgument?.instrumentId?.id || c.interfaceViews?.[0]?.viewValue?.instrumentId?.id;
      return id === instrumentIdId;
    });
    const freshHoldingCids = holdings.map((c) => c.contractId).filter(Boolean);
    if (freshHoldingCids.length === 0) {
      return res.status(400).json({
        success: false,
        error: `Pool operator holds no live ${instrumentIdId} holdings — refusing to refresh totalLiquidity to 0`,
      });
    }
    const newTotalLiquidity = holdings.reduce((s, c) => {
      const amt = c.createArgument?.amount?.initialAmount || c.interfaceViews?.[0]?.viewValue?.amount || c.createArgument?.amount || '0';
      return s + parseFloat(amt);
    }, 0);

    // RefreshHoldings (consuming) → new reserve CID with reconciled holdings + totalLiquidity.
    const refreshResult = await submitCommand([
      {
        ExerciseCommand: {
          templateId: `#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`,
          contractId: reserve.contractId,
          choice: 'RefreshHoldings',
          choiceArgument: { freshHoldingCids },
        },
      },
    ], [POOL_OPERATOR]);
    const newReserveCid = extractContractId(refreshResult);

    // Re-point the pool at the new reserve CID (feed-keyed).
    let newPoolCid = null;
    if (newReserveCid && feedId) {
      const pools = await queryContracts(`#alpend-lending-final-loop:Lending.Pool:LendingPool`, POOL_OPERATOR);
      const pool = pools[pools.length - 1];
      if (pool?.contractId) {
        const upd = await submitCommand([
          {
            ExerciseCommand: {
              templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
              contractId: pool.contractId,
              choice: 'UpdateAssetReserveCid',
              choiceArgument: { feedId, newReserveCid },
            },
          },
        ], [POOL_OPERATOR]);
        newPoolCid = extractContractId(upd);
      }
    }

    console.log(`RefreshHoldings ${instrumentIdId}: liquidity ${oldTotalLiquidity} -> ${newTotalLiquidity}, cids=${freshHoldingCids.length}, reserve=${newReserveCid}, pool=${newPoolCid}`);
    res.json({
      success: true,
      instrumentIdId,
      feedId,
      freshHoldingCids,
      oldTotalLiquidity,
      newTotalLiquidity: String(newTotalLiquidity),
      newReserveCid,
      newPoolCid,
      updateId: refreshResult.transaction?.updateId || refreshResult.updateId,
    });
  } catch (e) {
    console.error('REFRESH HOLDINGS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Exercise a consuming admin choice on the current AssetReserve for `instrumentIdId`, then
 *  re-point the pool at the new reserve CID (feed-keyed). Shared by update-risk-params /
 *  update-interest-params (RefreshHoldings has its own copy with holdings-specific logic). */
async function exerciseReserveChoiceAndRepoint(instrumentIdId, choice, choiceArgument) {
  const RESERVE_TID = `#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`;
  const POOL_TID = `#alpend-lending-final-loop:Lending.Pool:LendingPool`;
  const reserves = await queryContracts(RESERVE_TID, POOL_OPERATOR);
  const reserve = reserves.filter((r) => r.createArgument?.instrumentId?.id === instrumentIdId).slice(-1)[0];
  if (!reserve) throw new Error(`No AssetReserve found for instrument ${instrumentIdId}`);
  const feedId = reserve.createArgument?.riskParams?.priceFeedId;

  const exResult = await submitCommand([
    { ExerciseCommand: { templateId: RESERVE_TID, contractId: reserve.contractId, choice, choiceArgument } },
  ], [POOL_OPERATOR]);
  const newReserveCid = extractContractId(exResult);

  let newPoolCid = null;
  if (newReserveCid && feedId) {
    const pools = await queryContracts(POOL_TID, POOL_OPERATOR);
    const pool = pools[pools.length - 1];
    if (pool?.contractId) {
      const upd = await submitCommand([
        { ExerciseCommand: { templateId: POOL_TID, contractId: pool.contractId, choice: 'UpdateAssetReserveCid', choiceArgument: { feedId, newReserveCid } } },
      ], [POOL_OPERATOR]);
      newPoolCid = extractContractId(upd);
    }
  }
  return { previous: reserve.createArgument, feedId, newReserveCid, newPoolCid, updateId: exResult.transaction?.updateId || exResult.updateId };
}

/** POST /admin/update-risk-params — exercise AssetReserve.UpdateRiskParams (pool operator).
 *  Body: { instrumentIdId, ltv, liquidationThreshold, liquidationBonus, isActive?, depositCap?, borrowCap? }.
 *  priceFeedId is preserved from the current reserve (the DAR forbids changing it here). */
app.post('/admin/update-risk-params', async (req, res) => {
  try {
    const { instrumentIdId, ltv, liquidationThreshold, liquidationBonus, isActive, depositCap, borrowCap } = req.body;
    if (!instrumentIdId || ltv == null || liquidationThreshold == null || liquidationBonus == null) {
      return res.status(400).json({ success: false, error: 'instrumentIdId, ltv, liquidationThreshold, liquidationBonus are required' });
    }
    // Resolve the current reserve to preserve its (immutable-here) priceFeedId + defaults.
    const reserves = await queryContracts(`#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`, POOL_OPERATOR);
    const reserve = reserves.filter((r) => r.createArgument?.instrumentId?.id === instrumentIdId).slice(-1)[0];
    if (!reserve) return res.status(404).json({ success: false, error: `No AssetReserve found for ${instrumentIdId}` });
    const cur = reserve.createArgument.riskParams;

    const newRiskParams = {
      ltv: String(ltv),
      liquidationThreshold: String(liquidationThreshold),
      liquidationBonus: String(liquidationBonus),
      priceFeedId: cur.priceFeedId,
      isActive: isActive ?? cur.isActive ?? true,
      depositCap: depositCap === undefined ? (cur.depositCap ?? null) : (depositCap === null ? null : String(depositCap)),
      borrowCap: borrowCap === undefined ? (cur.borrowCap ?? null) : (borrowCap === null ? null : String(borrowCap)),
    };

    const out = await exerciseReserveChoiceAndRepoint(instrumentIdId, 'UpdateRiskParams', { newRiskParams });
    console.log(`UpdateRiskParams ${instrumentIdId}: ltv ${cur.ltv}->${newRiskParams.ltv}, liqThr ${cur.liquidationThreshold}->${newRiskParams.liquidationThreshold}, reserve=${out.newReserveCid}`);
    res.json({ success: true, instrumentIdId, previousRiskParams: cur, newRiskParams, ...out });
  } catch (e) {
    console.error('UPDATE RISK PARAMS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/update-interest-params — exercise AssetReserve.UpdateInterestRateParams (pool operator).
 *  Body: { instrumentIdId, optimalUtilization, baseRate, slope1, slope2, reserveFactor, holdingFeeRate? } */
app.post('/admin/update-interest-params', async (req, res) => {
  try {
    const { instrumentIdId, optimalUtilization, baseRate, slope1, slope2, reserveFactor, holdingFeeRate } = req.body;
    if (!instrumentIdId || optimalUtilization == null || baseRate == null || slope1 == null || slope2 == null || reserveFactor == null) {
      return res.status(400).json({ success: false, error: 'instrumentIdId + all interest rate fields are required' });
    }
    const newInterestRateParams = {
      optimalUtilization: String(optimalUtilization),
      baseRate: String(baseRate),
      slope1: String(slope1),
      slope2: String(slope2),
      reserveFactor: String(reserveFactor),
      holdingFeeRate: String(holdingFeeRate ?? '0.0000000000'),
    };
    const out = await exerciseReserveChoiceAndRepoint(instrumentIdId, 'UpdateInterestRateParams', { newInterestRateParams });
    console.log(`UpdateInterestRateParams ${instrumentIdId}: reserve=${out.newReserveCid}`);
    res.json({ success: true, instrumentIdId, newInterestRateParams, ...out });
  } catch (e) {
    console.error('UPDATE INTEREST PARAMS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/set-pause-flags — exercise LendingPool.SetPauseFlags (pool operator, pool-wide).
 *  Body: { pauseDeposits, pauseWithdrawals, pauseBorrows, pauseLiquidations } (all Bool). */
app.post('/admin/set-pause-flags', async (req, res) => {
  try {
    const { pauseDeposits = false, pauseWithdrawals = false, pauseBorrows = false, pauseLiquidations = false } = req.body;
    const POOL_TID = `#alpend-lending-final-loop:Lending.Pool:LendingPool`;
    const pools = await queryContracts(POOL_TID, POOL_OPERATOR);
    const pool = pools[pools.length - 1];
    if (!pool?.contractId) return res.status(404).json({ success: false, error: 'No active LendingPool found' });

    const result = await submitCommand([
      {
        ExerciseCommand: {
          templateId: POOL_TID,
          contractId: pool.contractId,
          choice: 'SetPauseFlags',
          choiceArgument: {
            newPauseDeposits: !!pauseDeposits,
            newPauseWithdrawals: !!pauseWithdrawals,
            newPauseBorrows: !!pauseBorrows,
            newPauseLiquidations: !!pauseLiquidations,
          },
        },
      },
    ], [POOL_OPERATOR]);
    const newPoolCid = extractContractId(result);
    console.log(`SetPauseFlags: dep=${!!pauseDeposits} wd=${!!pauseWithdrawals} bor=${!!pauseBorrows} liq=${!!pauseLiquidations}, pool=${newPoolCid}`);
    res.json({
      success: true,
      pauseFlags: { pauseDeposits: !!pauseDeposits, pauseWithdrawals: !!pauseWithdrawals, pauseBorrows: !!pauseBorrows, pauseLiquidations: !!pauseLiquidations },
      newPoolCid,
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('SET PAUSE FLAGS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/accrue-interest — force AssetReserve.AccrueInterest, advancing the compound
 *  indices (liquidityIndex / variableBorrowIndex) to `now`. Accrual normally happens inline on
 *  every user action; this lets us advance indices on demand (testing / idle-pool freshness)
 *  without moving funds. Body: { instrumentIdId } e.g. "USDCx" / "Amulet". */
app.post('/admin/accrue-interest', async (req, res) => {
  try {
    const { instrumentIdId } = req.body;
    if (!instrumentIdId) {
      return res.status(400).json({ success: false, error: 'instrumentIdId is required (e.g. "USDCx" or "Amulet")' });
    }
    const out = await exerciseReserveChoiceAndRepoint(instrumentIdId, 'AccrueInterest', {});
    console.log(`AccrueInterest ${instrumentIdId}: reserve=${out.newReserveCid}, pool=${out.newPoolCid}`);
    res.json({
      success: true,
      instrumentIdId,
      previousLiquidityIndex: out.previous?.liquidityIndex,
      previousBorrowIndex: out.previous?.variableBorrowIndex,
      ...out,
    });
  } catch (e) {
    console.error('ACCRUE INTEREST error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/withdraw-revenue — treasury pulls accrued protocol revenue from a reserve.
 *  Exercises Pool.WithdrawProtocolRevenue (controller treasuryParty; == poolOperator on testnet, so
 *  the server can sign). It's a pool→treasury token transfer, so it needs the reserve's holdings
 *  (FIND-025: must cover full liquidity) + the registry transfer context; then re-points the pool
 *  (the AssetReserve CID churns via the internal AccrueInterest + RecordRevenueWithdrawal).
 *  CC (Amulet) only for now. Body: { instrumentIdId: "Amulet", amount }. */
app.post('/admin/withdraw-revenue', async (req, res) => {
  try {
    const { instrumentIdId, amount } = req.body;
    if (!instrumentIdId || !amount) {
      return res.status(400).json({ success: false, error: 'instrumentIdId and amount are required' });
    }
    if (instrumentIdId !== 'Amulet') {
      return res.status(400).json({ success: false, error: 'Only Amulet (CC) revenue withdrawal is wired currently' });
    }
    const RESERVE_TID = `#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`;
    const POOL_TID = `#alpend-lending-final-loop:Lending.Pool:LendingPool`;

    const reserves = await queryContracts(RESERVE_TID, POOL_OPERATOR);
    const reserve = reserves.filter((r) => r.createArgument?.instrumentId?.id === instrumentIdId).slice(-1)[0];
    if (!reserve) return res.status(404).json({ success: false, error: `No reserve for ${instrumentIdId}` });
    const feedId = reserve.createArgument?.riskParams?.priceFeedId;

    // Use the operator's LIVE CC holdings (avoids the ephemeral stale-CID issue); they must
    // cover the reserve's full liquidity (FIND-025), which they do since the pool is CC-solvent.
    const holdings = await queryCCHoldings(POOL_OPERATOR);
    const currentHoldingCids = holdings.map((h) => h.contractId).filter(Boolean);
    if (currentHoldingCids.length === 0) {
      return res.status(400).json({ success: false, error: 'Operator holds no CC to transfer' });
    }

    // Registry transfer context for a poolOperator -> treasury(=poolOperator) transfer.
    const factoryData = await fetchCCTransferFactory(POOL_OPERATOR, {
      receiver: POOL_OPERATOR,
      amount: String(amount),
      inputHoldingCids: currentHoldingCids,
    });
    const transferFactoryCid = factoryData.factoryId;
    if (!transferFactoryCid) return res.status(502).json({ success: false, error: 'No transfer factory from registry' });
    const choiceContext = factoryData.choiceContext?.choiceContextData || { values: {} };
    const disclosedContracts = (factoryData.choiceContext?.disclosedContracts || []).map((dc) => ({
      templateId: dc.templateId,
      contractId: dc.contractId,
      createdEventBlob: dc.createdEventBlob,
      synchronizerId: dc.synchronizerId || dc.domainId,
    }));

    const pools = await queryContracts(POOL_TID, POOL_OPERATOR);
    const pool = pools[pools.length - 1];
    if (!pool?.contractId) return res.status(404).json({ success: false, error: 'No active LendingPool' });

    const result = await submitCommand([
      {
        ExerciseCommand: {
          templateId: POOL_TID,
          contractId: pool.contractId,
          choice: 'WithdrawProtocolRevenue',
          choiceArgument: {
            assetReserveCid: reserve.contractId,
            transferFactoryCid,
            currentHoldingCids,
            amount: String(amount),
            choiceContext,
            featuredAppRightCid: null,
          },
        },
      },
    ], [POOL_OPERATOR], disclosedContracts);

    // Returns (new AssetReserve, revenue Holding) + internal AccrueInterest reserve — take the LAST AssetReserve created.
    const events = result.transaction?.events || [];
    const newReserveCid = events
      .filter((e) => e.CreatedEvent?.templateId?.includes('AssetReserve'))
      .map((e) => e.CreatedEvent.contractId)
      .slice(-1)[0];

    // Re-point the pool at the new reserve CID (WithdrawProtocolRevenue is nonconsuming on the pool,
    // so pool.contractId is still valid here).
    let newPoolCid = null;
    if (newReserveCid && feedId) {
      const upd = await submitCommand([
        { ExerciseCommand: { templateId: POOL_TID, contractId: pool.contractId, choice: 'UpdateAssetReserveCid', choiceArgument: { feedId, newReserveCid } } },
      ], [POOL_OPERATOR]);
      newPoolCid = extractContractId(upd);
    }

    console.log(`WithdrawProtocolRevenue ${instrumentIdId} amount=${amount}: reserve=${newReserveCid}, pool=${newPoolCid}`);
    res.json({ success: true, instrumentIdId, amount: String(amount), newReserveCid, newPoolCid, updateId: result.transaction?.updateId || result.updateId });
  } catch (e) {
    console.error('WITHDRAW REVENUE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/write-off-bad-debt — operator writes off an uncollectable borrow (H-3).
 *  Exercises Pool.WriteOffBadDebt (controller poolOperator). Only permitted when the borrower has
 *  ZERO collateral value left but still owes debt (recomputed on-chain). Reduces scaledTotalBorrowed
 *  and applies a proportional liquidityIndex HAIRCUT to suppliers (FIND-026 — note: the Pool source
 *  comment "suppliers are not haircut" is stale; the reserve code does haircut). Re-points the pool
 *  (reserve churns). Body: { borrower, instrumentIdId } — instrumentIdId is the DEBT asset. */
app.post('/admin/write-off-bad-debt', async (req, res) => {
  try {
    const { borrower, instrumentIdId } = req.body;
    if (!borrower || !instrumentIdId) {
      return res.status(400).json({ success: false, error: 'borrower and instrumentIdId (debt asset) are required' });
    }
    const P = `#alpend-lending-final-loop:Lending.`;
    const RESERVE_TID = `${P}AssetReserve:AssetReserve`;
    const POOL_TID = `${P}Pool:LendingPool`;

    const [reserves, borrows, userPositions] = await Promise.all([
      queryContracts(RESERVE_TID, POOL_OPERATOR),
      queryContracts(`${P}Borrow:BorrowPosition`, POOL_OPERATOR),
      queryContracts(`${P}UserPosition:UserPosition`, POOL_OPERATOR),
    ]);

    const debtReserve = reserves.filter((r) => r.createArgument?.instrumentId?.id === instrumentIdId).slice(-1)[0];
    if (!debtReserve) return res.status(404).json({ success: false, error: `No reserve for ${instrumentIdId}` });
    const feedId = debtReserve.createArgument?.riskParams?.priceFeedId;

    const borrowPos = borrows
      .filter((b) => b.createArgument?.borrower === borrower && b.createArgument?.instrumentId?.id === instrumentIdId)
      .slice(-1)[0];
    if (!borrowPos) return res.status(404).json({ success: false, error: `No ${instrumentIdId} borrow for that borrower` });

    const userPos = userPositions.filter((u) => u.createArgument?.user === borrower).slice(-1)[0];
    if (!userPos) return res.status(404).json({ success: false, error: 'No UserPosition for that borrower' });

    // Every OTHER reserve the borrower could have collateral in (for the on-chain collateral recompute).
    const accountReserveCids = reserves
      .filter((r) => r.createArgument?.instrumentId?.id !== instrumentIdId)
      .map((r) => r.contractId);

    const pools = await queryContracts(POOL_TID, POOL_OPERATOR);
    const pool = pools[pools.length - 1];

    const result = await submitCommand([
      {
        ExerciseCommand: {
          templateId: POOL_TID,
          contractId: pool.contractId,
          choice: 'WriteOffBadDebt',
          choiceArgument: {
            borrower,
            borrowPositionCid: borrowPos.contractId,
            debtAssetReserveCid: debtReserve.contractId,
            borrowerPositionCid: userPos.contractId,
            accountReserveCids,
          },
        },
      },
    ], [POOL_OPERATOR]);

    const events = result.transaction?.events || [];
    const newReserveCid = events
      .filter((e) => e.CreatedEvent?.templateId?.includes('AssetReserve'))
      .map((e) => e.CreatedEvent.contractId)
      .slice(-1)[0];

    let newPoolCid = null;
    if (newReserveCid && feedId) {
      const upd = await submitCommand([
        { ExerciseCommand: { templateId: POOL_TID, contractId: pool.contractId, choice: 'UpdateAssetReserveCid', choiceArgument: { feedId, newReserveCid } } },
      ], [POOL_OPERATOR]);
      newPoolCid = extractContractId(upd);
    }

    console.log(`WriteOffBadDebt ${instrumentIdId} borrower=${borrower.slice(0, 16)}: reserve=${newReserveCid}, pool=${newPoolCid}`);
    res.json({ success: true, borrower, instrumentIdId, newReserveCid, newPoolCid, updateId: result.transaction?.updateId || result.updateId });
  } catch (e) {
    console.error('WRITE OFF BAD DEBT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/liquidatable — scan every UserPosition, compute HF off-chain, and return the
 *  ones with HF < 1 along with the borrower's private-position blobs (the operator-mediated
 *  disclosure a liquidator needs to see them). HF here is approximate — the DAR re-verifies
 *  HF<1 on-chain at liquidation time; this only surfaces candidates. */
app.get('/admin/liquidatable', async (req, res) => {
  try {
    const P = `#alpend-lending-final-loop:Lending.`;
    const [poolC, reserveC, userPosC, depositC, borrowC, oracleC] = await Promise.all([
      queryContracts(`${P}Pool:LendingPool`, POOL_OPERATOR),
      queryContracts(`${P}AssetReserve:AssetReserve`, POOL_OPERATOR),
      queryContracts(`${P}UserPosition:UserPosition`, POOL_OPERATOR),
      queryContracts(`${P}Deposit:DepositPosition`, POOL_OPERATOR),
      queryContracts(`${P}Borrow:BorrowPosition`, POOL_OPERATOR),
      queryContracts(`${P}Oracle:PriceOracle`, POOL_OPERATOR),
    ]);

    const pool = poolC[poolC.length - 1];
    const oracle = oracleC[oracleC.length - 1];
    const prices = oracle?.createArgument?.prices || {}; // TextMap feedId -> PriceData

    // Per-instrument reserve info (current CID + blob + risk params + indices + price).
    const byInstrument = {};
    for (const r of reserveC) {
      const a = r.createArgument || {};
      const id = a.instrumentId?.id;
      if (!id) continue;
      const feed = a.riskParams?.priceFeedId;
      byInstrument[id] = {
        reserveCid: r.contractId,
        blob: r.createdEventBlob,
        templateId: r.templateId,
        instrumentId: a.instrumentId,
        price: parseFloat(prices[feed]?.price || '0'),
        ltv: parseFloat(a.riskParams?.ltv || '0'),
        liqThreshold: parseFloat(a.riskParams?.liquidationThreshold || '0'),
        liquidationBonus: parseFloat(a.riskParams?.liquidationBonus || '0'),
        liquidityIndex: parseFloat(a.liquidityIndex || '1'),
        variableBorrowIndex: parseFloat(a.variableBorrowIndex || '1'),
        totalLiquidity: parseFloat(a.totalLiquidity || '0'),
      };
    }

    const depByCid = {}, borByCid = {};
    for (const d of depositC) depByCid[d.contractId] = d;
    for (const b of borrowC) borByCid[b.contractId] = b;

    const candidates = [];
    for (const up of userPosC) {
      const a = up.createArgument || {};
      let liqThreshUSD = 0, borrowedUSD = 0, collateralUSD = 0;

      const collaterals = [];
      for (const cid of (a.supplyPositionCids || [])) {
        const d = depByCid[cid]; if (!d) continue;
        const da = d.createArgument || {};
        const info = byInstrument[da.instrumentId?.id]; if (!info) continue;
        const entryIdx = parseFloat(da.liquidityIndex || '1');
        const accrued = parseFloat(da.principal || '0') * (entryIdx > 0 ? info.liquidityIndex / entryIdx : 1);
        const valueUSD = accrued * info.price;
        collateralUSD += valueUSD;
        if (da.isUsedAsCollateral) liqThreshUSD += valueUSD * info.liqThreshold;
        collaterals.push({
          cid, blob: d.createdEventBlob, templateId: d.templateId,
          instrumentId: da.instrumentId, reserveCid: info.reserveCid,
          reserveBlob: info.blob, reserveTemplateId: info.templateId,
          amount: accrued, valueUSD, isUsedAsCollateral: !!da.isUsedAsCollateral,
          liquidationBonus: info.liquidationBonus, price: info.price,
          totalLiquidity: info.totalLiquidity,
        });
      }

      const borrows = [];
      for (const cid of (a.borrowPositionCids || [])) {
        const b = borByCid[cid]; if (!b) continue;
        const ba = b.createArgument || {};
        const info = byInstrument[ba.instrumentId?.id]; if (!info) continue;
        const entryIdx = parseFloat(ba.borrowIndex || '1');
        const accrued = parseFloat(ba.borrowedAmount || '0') * (entryIdx > 0 ? info.variableBorrowIndex / entryIdx : 1);
        const valueUSD = accrued * info.price;
        borrowedUSD += valueUSD;
        borrows.push({
          cid, blob: b.createdEventBlob, templateId: b.templateId,
          instrumentId: ba.instrumentId, reserveCid: info.reserveCid,
          reserveBlob: info.blob, reserveTemplateId: info.templateId,
          amount: accrued, valueUSD, price: info.price,
        });
      }

      const hf = borrowedUSD > 0 ? liqThreshUSD / borrowedUSD : Infinity;
      if (borrowedUSD > 0 && hf < 1.0) {
        candidates.push({
          borrower: a.user,
          userPositionCid: up.contractId,
          userPositionBlob: up.createdEventBlob,
          userPositionTemplateId: up.templateId,
          hf: Number.isFinite(hf) ? Number(hf.toFixed(4)) : null,
          collateralUSD: Number(collateralUSD.toFixed(2)),
          borrowedUSD: Number(borrowedUSD.toFixed(2)),
          borrows,
          collaterals,
        });
      }
    }

    res.json({
      success: true,
      poolCid: pool?.contractId,
      poolBlob: pool?.createdEventBlob,
      poolTemplateId: pool?.templateId,
      oracleCid: oracle?.contractId,
      oracleBlob: oracle?.createdEventBlob,
      oracleTemplateId: oracle?.templateId,
      candidates,
    });
  } catch (e) {
    console.error('LIQUIDATABLE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================
// QUERY ENDPOINTS
// =============================================

/** GET /query/lending-pool — query LendingPool contracts */
app.get('/query/lending-pool', async (req, res) => {
  try {
    const templateId = `#alpend-lending-final-loop:Lending.Pool:LendingPool`;
    const contracts = await queryContracts(templateId, POOL_OPERATOR);
    res.json({ success: true, contracts });
  } catch (e) {
    console.error('QUERY LENDING POOL error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /query/user-position/:party — query UserPosition (via pool operator who is observer) */
app.get('/query/user-position/:party', async (req, res) => {
  try {
    const templateId = `#alpend-lending-final-loop:Lending.UserPosition:UserPosition`;
    // Query as pool operator (observer on UserPosition), then filter by party
    const contracts = await queryContracts(templateId, POOL_OPERATOR);
    // Return ONLY this party's UserPosition(s). NEVER fall back to all contracts when the
    // party has none — a brand-new user would otherwise receive a stranger's UserPosition,
    // which makes the client think they're initialized and then fails on-chain with
    // "UserPosition does not belong to this user".
    const filtered = contracts.filter(c => c.createArgument?.user === req.params.party);
    res.json({ success: true, contracts: filtered });
  } catch (e) {
    console.error('QUERY USER POSITION error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /query/deposit-position — query all DepositPositions (via pool operator who is observer) */
app.get('/query/deposit-position/:party?', async (req, res) => {
  try {
    const templateId = `#alpend-lending-final-loop:Lending.Deposit:DepositPosition`;
    const contracts = await queryContracts(templateId, POOL_OPERATOR);
    const party = req.params.party;
    const filtered = party ? contracts.filter(c => c.createArgument?.depositor === party) : contracts;
    res.json({ success: true, contracts: filtered });
  } catch (e) {
    console.error('QUERY DEPOSIT POSITION error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /query/borrow-position — query BorrowPositions (via pool operator who is observer) */
app.get('/query/borrow-position/:party?', async (req, res) => {
  try {
    const templateId = `#alpend-lending-final-loop:Lending.Borrow:BorrowPosition`;
    const contracts = await queryContracts(templateId, POOL_OPERATOR);
    const party = req.params.party;
    const filtered = party ? contracts.filter(c => c.createArgument?.borrower === party) : contracts;
    res.json({ success: true, contracts: filtered });
  } catch (e) {
    console.error('QUERY BORROW POSITION error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/pool-disclosed-contracts — get createdEventBlobs for pool-level contracts (PoolState, LendingPool, UserPosition)
 *  These are needed as disclosed contracts when submitting via Loop wallet,
 *  since pool contracts are on our validator, not Loop's.
 *  Query param: ?party=<user-party> (for filtering UserPosition)
 */
app.get('/admin/pool-disclosed-contracts', async (req, res) => {
  try {
    const party = req.query.party;
    const synchronizerId = process.env.SYNCHRONIZER_ID || 'global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';

    // Fetch all pool-level contracts in parallel
    const [poolContracts, assetReserveContracts, userPosContracts, oracleContracts] = await Promise.all([
      queryContracts(`#alpend-lending-final-loop:Lending.Pool:LendingPool`, POOL_OPERATOR),
      queryContracts(`#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`, POOL_OPERATOR),
      queryContracts(`#alpend-lending-final-loop:Lending.UserPosition:UserPosition`, POOL_OPERATOR),
      queryContracts(`#alpend-lending-final-loop:Lending.Oracle:PriceOracle`, POOL_OPERATOR),
    ]);

    const disclosed = [];

    // Add all AssetReserves (they replace PoolState)
    for (const reserve of assetReserveContracts) {
      if (reserve?.contractId && reserve?.createdEventBlob) {
        disclosed.push({
          templateId: reserve.templateId || `#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`,
          contractId: reserve.contractId,
          createdEventBlob: reserve.createdEventBlob,
          domainId: synchronizerId,
        });
      }
    }

    // Add PriceOracle (needed by SupplyTSWithPosition for USD valuation)
    const latestOracle = oracleContracts[oracleContracts.length - 1];
    if (latestOracle?.contractId && latestOracle?.createdEventBlob) {
      disclosed.push({
        templateId: latestOracle.templateId || `#alpend-lending-final-loop:Lending.Oracle:PriceOracle`,
        contractId: latestOracle.contractId,
        createdEventBlob: latestOracle.createdEventBlob,
        domainId: synchronizerId,
      });
    }

    // Add UserPosition for the specified party (latest)
    if (party) {
      const userPos = userPosContracts.filter(c => c.createArgument?.user === party);
      const latestUserPos = userPos[userPos.length - 1] || userPosContracts[userPosContracts.length - 1];
      if (latestUserPos?.contractId && latestUserPos?.createdEventBlob) {
        disclosed.push({
          templateId: latestUserPos.templateId || `#alpend-lending-final-loop:Lending.UserPosition:UserPosition`,
          contractId: latestUserPos.contractId,
          createdEventBlob: latestUserPos.createdEventBlob,
          domainId: synchronizerId,
        });
      }
    }

    // Add LendingPool — needed for InitializeUserPosition so poolOperator signatory authority flows
    const latestPool = poolContracts[poolContracts.length - 1];
    if (latestPool?.contractId && latestPool?.createdEventBlob) {
      disclosed.push({
        templateId: latestPool.templateId || `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
        contractId: latestPool.contractId,
        createdEventBlob: latestPool.createdEventBlob,
        domainId: synchronizerId,
      });
    }

    console.log(`Pool disclosed contracts: ${disclosed.length} (pool=${!!latestPool?.createdEventBlob}, reserves=${assetReserveContracts.length}, oracle=${!!latestOracle?.createdEventBlob}, userPos=${party ? 'filtered' : 'skipped'})`);

    res.json({ success: true, disclosedContracts: disclosed });
  } catch (e) {
    console.error('POOL DISCLOSED CONTRACTS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================
// USER OPERATION ENDPOINTS
// (Submit via Ledger API — same pattern as reference backend)
// =============================================

/** POST /user/initialize-position
 * Initialize a UserPosition for a user on the lending pool.
 * Requires both user and poolOperator authorization — backend co-signs as poolOperator.
 * Body: { user, poolCid }
 */
app.post('/user/initialize-position', async (req, res) => {
  try {
    const { user, poolCid } = req.body;

    if (!user || !poolCid) {
      return res.status(400).json({ success: false, error: 'Missing required fields: user, poolCid' });
    }

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
          contractId: poolCid,
          choice: 'InitializeUserPosition',
          choiceArgument: { user },
        },
      },
    ];

    console.log(`InitializeUserPosition: user=${user}, poolCid=${poolCid.substring(0, 20)}...`);
    const result = await submitCommand(commands, [user, POOL_OPERATOR]);
    console.log('InitializeUserPosition SUCCESS');
    res.json({ success: true, result });
  } catch (e) {
    console.error('INITIALIZE POSITION error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});


/** GET /admin/cc-choice-context — build CC choice context + disclosed contracts for frontend */
app.get('/admin/cc-choice-context', async (req, res) => {
  try {
    const transferFactoryCid = process.env.AMULET_TRANSFER_FACTORY_CID;
    const { choiceContext, openRoundCid, openRoundBlob, amuletRulesCid, amuletRulesBlob } = await buildCCChoiceContext();
    const disclosedContracts = buildCCDisclosedContracts(transferFactoryCid, openRoundCid, openRoundBlob, amuletRulesCid, amuletRulesBlob);

    res.json({
      success: true,
      transferFactoryCid,
      choiceContext,
      disclosedContracts,
    });
  } catch (e) {
    console.error('CC CHOICE CONTEXT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/cc-payout-context — pool-as-sender CC transfer context (for withdraw/borrow
 *  payouts), sourced from the REGISTRY. Unlike the hand-rolled cc-choice-context, this returns
 *  disclosed contracts WITH templateIds and includes external-party-config-state — required for
 *  an external-party (pool operator) sender. Body: { receiver, amount, holdingCids }. */
app.post('/admin/cc-payout-context', async (req, res) => {
  try {
    const { receiver, amount = '1.0', holdingCids = [] } = req.body;
    if (!receiver) {
      return res.status(400).json({ success: false, error: 'receiver is required' });
    }
    const factoryData = await fetchCCTransferFactory(POOL_OPERATOR, {
      receiver,
      amount: amount.toString(),
      inputHoldingCids: holdingCids,
    });
    const transferFactoryCid = factoryData.factoryId;
    if (!transferFactoryCid) {
      return res.json({ success: false, error: 'Registry did not return a CC transfer factory' });
    }
    const syncId = process.env.SYNCHRONIZER_ID || 'global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';
    const choiceContext = factoryData.choiceContext?.choiceContextData || { values: {} };
    const disclosedContracts = (factoryData.choiceContext?.disclosedContracts || []).map((dc) => ({
      templateId: dc.templateId,
      contractId: dc.contractId,
      createdEventBlob: dc.createdEventBlob,
      domainId: dc.synchronizerId || syncId,
    }));
    res.json({ success: true, transferFactoryCid, choiceContext, disclosedContracts });
  } catch (e) {
    console.error('CC PAYOUT CONTEXT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================
// USER RIGHTS MANAGEMENT
// (Grant actAs rights on the Canton participant)
// =============================================

// Decode JWT sub claim to get user ID
function decodeJwtSub(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return decoded.sub;
  } catch (e) {
    return null;
  }
}

/** GET /admin/participant-user — show current user info and rights */
app.get('/admin/participant-user', async (req, res) => {
  try {
    const token = await getToken();
    const sub = decodeJwtSub(token);
    console.log('JWT sub claim:', sub);

    // Try multiple Canton API endpoint patterns to list users
    const endpoints = [
      `${LEDGER_URL}/v2/user-management/users`,
      `${LEDGER_URL}/v2/users`,
    ];

    const results = {};
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        results[url] = { status: resp.status, body: resp.ok ? await resp.json() : await resp.text() };
      } catch (e) {
        results[url] = { error: e.message };
      }
    }

    // Also try to get rights for the current user (from JWT sub)
    if (sub) {
      const rightsEndpoints = [
        { url: `${LEDGER_URL}/v2/user-management/rights/list`, method: 'POST', body: { userId: sub } },
        { url: `${LEDGER_URL}/v2/users/${encodeURIComponent(sub)}/rights`, method: 'GET', body: null },
      ];
      for (const ep of rightsEndpoints) {
        try {
          const resp = await fetch(ep.url, {
            method: ep.method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(ep.body ? { body: JSON.stringify(ep.body) } : {}),
          });
          results[`rights:${ep.url}`] = { status: resp.status, body: resp.ok ? await resp.json() : await resp.text() };
        } catch (e) {
          results[`rights:${ep.url}`] = { error: e.message };
        }
      }
    }

    res.json({ success: true, jwtSub: sub, results });
  } catch (e) {
    console.error('PARTICIPANT USER error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/grant-party-rights — grant actAs rights for a party to backend's user
 *  Body: { userId?, partyId }
 *  If userId not provided, uses JWT sub claim */
app.post('/admin/grant-party-rights', async (req, res) => {
  try {
    const { userId, partyId } = req.body;
    if (!partyId) {
      return res.status(400).json({ success: false, error: 'partyId is required' });
    }

    const token = await getToken();
    let targetUserId = userId || decodeJwtSub(token);

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: 'Could not determine user ID. Please provide userId in body. Try GET /admin/participant-user to discover it.',
      });
    }

    console.log(`Granting actAs for party ${partyId} to user ${targetUserId}`);

    // Grant rights via the working Canton JSON API v2 endpoint
    // Use the same format as the GET /v2/users/{userId}/rights response
    const grantUrl = `${LEDGER_URL}/v2/users/${encodeURIComponent(targetUserId)}/rights`;

    // Try multiple body formats
    const bodyFormats = [
      // Format 1: rights array with identityProviderId
      {
        label: 'rights-array',
        body: {
          userId: targetUserId,
          identityProviderId: '',
          rights: [
            { kind: { CanActAs: { value: { party: partyId } } } },
            { kind: { CanReadAs: { value: { party: partyId } } } },
          ],
        },
      },
      // Format 2: actAs/readAs shorthand with identityProviderId
      {
        label: 'actAs-readAs',
        body: {
          userId: targetUserId,
          identityProviderId: '',
          actAs: [{ party: partyId }],
          readAs: [{ party: partyId }],
        },
      },
    ];

    const errors = [];
    for (const fmt of bodyFormats) {
      try {
        console.log(`Trying grant format '${fmt.label}': POST ${grantUrl}`);
        console.log('Body:', JSON.stringify(fmt.body));
        const grantResp = await fetch(grantUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fmt.body),
        });

        const respText = await grantResp.text();
        console.log(`Grant response (${fmt.label}): ${grantResp.status} ${respText}`);

        if (grantResp.ok) {
          let grantData;
          try { grantData = JSON.parse(respText); } catch { grantData = respText; }
          return res.json({
            success: true,
            userId: targetUserId,
            grantedParty: partyId,
            format: fmt.label,
            result: grantData,
          });
        }
        errors.push({ format: fmt.label, status: grantResp.status, body: respText.substring(0, 300) });
      } catch (e) {
        errors.push({ format: fmt.label, error: e.message });
      }
    }

    // Also try PUT instead of POST (some APIs use PUT for grants)
    for (const fmt of bodyFormats.slice(0, 1)) {
      try {
        console.log(`Trying PUT ${grantUrl}`);
        const grantResp = await fetch(grantUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fmt.body),
        });
        const respText = await grantResp.text();
        console.log(`PUT response: ${grantResp.status} ${respText}`);
        if (grantResp.ok) {
          let grantData;
          try { grantData = JSON.parse(respText); } catch { grantData = respText; }
          return res.json({ success: true, userId: targetUserId, grantedParty: partyId, method: 'PUT', result: grantData });
        }
        errors.push({ format: 'PUT-' + fmt.label, status: grantResp.status, body: respText.substring(0, 300) });
      } catch (e) {
        errors.push({ format: 'PUT', error: e.message });
      }
    }

    res.json({
      success: false,
      error: `Could not grant rights. userId=${targetUserId}`,
      userId: targetUserId,
      attempts: errors,
    });
  } catch (e) {
    console.error('GRANT PARTY RIGHTS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/grant-via-admin-api — try granting rights via Canton Admin API on various ports
 *  Body: { partyId }
 */
app.post('/admin/grant-via-admin-api', async (req, res) => {
  try {
    const { partyId } = req.body;
    if (!partyId) return res.status(400).json({ success: false, error: 'partyId is required' });

    const token = await getToken();
    const userId = decodeJwtSub(token) || `${CLIENT_ID}@clients`;

    // Extract host from LEDGER_URL
    const ledgerHost = new URL(LEDGER_URL).hostname;

    // Try admin API on common Canton ports with JSON format
    const adminPorts = [5003, 10018, 10019, 5002, 7575, 5001];
    const results = {};

    for (const port of adminPorts) {
      const baseUrl = `http://${ledgerHost}:${port}`;
      // Try JSON admin API endpoint patterns
      const endpoints = [
        {
          url: `${baseUrl}/api/json-api/v2/user-management/rights/grant`,
          body: {
            userId,
            rights: [
              { canActAs: { party: partyId } },
              { canReadAs: { party: partyId } },
            ],
          },
        },
        {
          url: `${baseUrl}/v2/user-management/rights/grant`,
          body: {
            userId,
            rights: [
              { canActAs: { party: partyId } },
              { canReadAs: { party: partyId } },
            ],
          },
        },
        {
          url: `${baseUrl}/api/json-api/v2/user-management/rights/grant`,
          body: {
            userId,
            actAs: [{ party: partyId }],
            readAs: [{ party: partyId }],
          },
        },
      ];

      for (const ep of endpoints) {
        try {
          const resp = await fetch(ep.url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(ep.body),
            signal: AbortSignal.timeout(5000),
          });
          const respText = await resp.text();
          results[ep.url] = { status: resp.status, body: respText.substring(0, 500) };
          if (resp.ok) {
            return res.json({
              success: true,
              userId,
              grantedParty: partyId,
              endpoint: ep.url,
              result: respText.substring(0, 500),
            });
          }
        } catch (e) {
          results[ep.url] = { error: e.message };
        }
      }
    }

    res.json({
      success: false,
      error: 'Could not grant rights via any admin API endpoint.',
      userId,
      triedEndpoints: results,
    });
  } catch (e) {
    console.error('GRANT VIA ADMIN API error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/send-cc — Transfer CC from pool operator to a user (creates a second holding for the user)
 *  Body: { recipient, amount }
 *  This is needed because Loop wallet's fee consumes the user's single CC holding.
 *  By giving the user a second holding, the fee uses one and the deposit uses the other.
 */
app.post('/admin/send-cc', async (req, res) => {
  try {
    const { recipient, amount = '1.0' } = req.body;
    if (!recipient) {
      return res.status(400).json({ success: false, error: 'recipient party is required' });
    }

    // Fetch pool operator's CC holdings (via the Holding interface — the concrete
    // Amulet template can't be queried by hex package id)
    const holdings = await queryCCHoldings(POOL_OPERATOR);

    if (!holdings.length) {
      return res.json({ success: false, error: 'Pool operator has no CC holdings' });
    }

    const holdingCids = holdings.map(h => h.contractId);
    console.log(`Sending ${amount} CC from pool operator to ${recipient}`);
    console.log(`Using ${holdingCids.length} holding(s) as input`);

    // Get the transfer factory + FULL choice context (incl. external-party-config-state)
    // + disclosed contracts from the registry, computed for THIS transfer. The env-based
    // hand-rolled context (buildCCChoiceContext) omits external-party-config-state, which
    // the TransferFactory_Transfer choice requires for an external-party sender.
    const factoryData = await fetchCCTransferFactory(POOL_OPERATOR, {
      receiver: recipient,
      amount: amount.toString(),
      inputHoldingCids: holdingCids,
    });
    const transferFactoryCid = factoryData.factoryId;
    if (!transferFactoryCid) {
      return res.json({ success: false, error: 'Registry did not return a CC transfer factory' });
    }
    const choiceContext = factoryData.choiceContext?.choiceContextData || { values: {} };
    const syncId = process.env.SYNCHRONIZER_ID || 'global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';
    const disclosedContracts = (factoryData.choiceContext?.disclosedContracts || []).map((dc) => ({
      templateId: dc.templateId,
      contractId: dc.contractId,
      createdEventBlob: dc.createdEventBlob,
      synchronizerId: dc.synchronizerId || syncId,
    }));

    // Exercise the token-standard TransferFactory_Transfer (interface choice, referenced
    // by package NAME so it's version-agnostic). The ExternalPartyAmuletRules contract
    // implements this interface; the legacy ExternalPartyAmuletRules_Transfer choice was
    // removed in the current Amulet package.
    const transferFactoryInterfaceId =
      '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';
    const dso = `DSO::${(process.env.SYNCHRONIZER_ID || '').split('::')[1] || '1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337'}`;

    const currentTime = new Date().toISOString();
    const executeBefore = new Date(Date.now() + 3600000).toISOString();

    const commands = [
      {
        ExerciseCommand: {
          templateId: transferFactoryInterfaceId,
          contractId: transferFactoryCid,
          choice: 'TransferFactory_Transfer',
          choiceArgument: {
            expectedAdmin: dso,
            transfer: {
              sender: POOL_OPERATOR,
              receiver: recipient,
              amount: amount.toString(),
              instrumentId: { admin: dso, id: 'Amulet' },
              requestedAt: currentTime,
              executeBefore: executeBefore,
              inputHoldingCids: holdingCids,
              meta: { values: {} },
            },
            extraArgs: {
              context: choiceContext,
              meta: { values: {} },
            },
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR], disclosedContracts);

    res.json({
      success: true,
      message: `Sent ${amount} CC to ${recipient}. They should now have a second CC holding.`,
      updateId: result.transaction?.updateId,
      events: result.transaction?.events?.filter(e => e.CreatedEvent).map(e => ({
        contractId: e.CreatedEvent?.contractId,
        templateId: e.CreatedEvent?.templateId,
      })),
    });
  } catch (e) {
    console.error('SEND CC error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// =============================================
// USDCx ENDPOINTS
// =============================================

const USDCX_INSTRUMENT_ADMIN = process.env.USDCX_INSTRUMENT_ADMIN;
const USDCX_INSTRUMENT_ID = process.env.USDCX_INSTRUMENT_ID || 'USDCx';
const USDCX_REGISTRY_URL = process.env.USDCX_REGISTRY_URL || 'https://api.utilities.digitalasset-staging.com';
const USDCX_HOLDING_INTERFACE_ID = process.env.USDCX_HOLDING_INTERFACE_ID ||
  '718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding';

/** Query contracts by interface ID instead of template ID */
async function queryContractsByInterface(interfaceId, party) {
  const token = await getToken();
  const offsetResp = await fetch(`${LEDGER_URL}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const offsetData = await offsetResp.json();
  const latestOffset = offsetData?.offset || 0;

  const payload = {
    eventFormat: {
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: { interfaceId, includeCreatedEventBlob: true, includeInterfaceView: true },
                },
              },
            },
          ],
        },
      },
      verbose: true,
    },
    activeAtOffset: latestOffset,
  };

  const resp = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Interface query error ${resp.status}: ${errBody}`);
  }
  const data = await resp.json();
  const contracts = [];
  const entries = Array.isArray(data) ? data : (data.activeContracts || []);
  for (const entry of entries) {
    const ce = entry?.contractEntry?.JsActiveContract?.createdEvent ||
               entry?.contractEntry?.activeContract?.createdEvent ||
               entry?.createdEvent;
    if (ce) contracts.push(ce);
  }
  return contracts;
}

// The ledger rejects hex package IDs in template/interface filters ("expected a
// package name"), so reference the token-standard Holding interface by package NAME
// (the `#name` form the frontend uses). Both USDCx and Amulet holdings implement it.
const HOLDING_INTERFACE = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';

/** Fetch a party's CC (Amulet) holdings via the token-standard Holding interface.
 *  Querying the concrete Amulet template by hex package id is rejected by the ledger
 *  ("expected a package name"), so we go through the HoldingV1 interface (same path the
 *  frontend uses) and filter to Amulet. */
async function queryCCHoldings(party) {
  const contracts = await queryContractsByInterface(HOLDING_INTERFACE, party);
  return contracts.filter((c) => {
    const tmpl = c.templateId || '';
    const instId = c.createArgument?.instrumentId?.id ||
                   c.interfaceViews?.[0]?.viewValue?.instrumentId?.id;
    return tmpl.includes('Splice.Amulet') || instId === 'Amulet';
  });
}

/** GET /admin/user-holdings/:party — fetch USDCx holdings for any party using wildcard filter */
app.get('/admin/user-holdings/:party', async (req, res) => {
  try {
    const { party } = req.params;
    const token = await getToken();
    const offsetResp = await fetch(`${LEDGER_URL}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const offsetData = await offsetResp.json();
    const latestOffset = offsetData?.offset || 0;

    // Use filtersForAnyParty to query holdings visible to the authenticated token
    // Then filter by owner on the results
    const payload = {
      eventFormat: {
        filtersForAnyParty: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId: HOLDING_INTERFACE,
                    includeCreatedEventBlob: true,
                    includeInterfaceView: true,
                  },
                },
              },
            },
          ],
        },
        verbose: true,
      },
      activeAtOffset: latestOffset,
    };

    const resp = await fetch(`${LEDGER_URL}/v2/state/active-contracts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Wildcard query error ${resp.status}: ${errBody}`);
    }

    const data = await resp.json();
    const entries = Array.isArray(data) ? data : (data.activeContracts || []);
    const contracts = [];
    for (const entry of entries) {
      const ce = entry?.contractEntry?.JsActiveContract?.createdEvent ||
                 entry?.contractEntry?.activeContract?.createdEvent ||
                 entry?.createdEvent;
      if (ce) contracts.push(ce);
    }

    // Filter to USDCx holdings owned by the requested party
    const userHoldings = contracts.filter(c => {
      const owner = c.createArgument?.owner ||
                    c.interfaceViews?.[0]?.viewValue?.owner || '';
      const admin = c.createArgument?.instrumentId?.admin ||
                    c.interfaceViews?.[0]?.viewValue?.instrumentId?.admin || '';
      const isOwner = owner === party;
      const isUsdcx = !USDCX_INSTRUMENT_ADMIN || admin === USDCX_INSTRUMENT_ADMIN;
      return isOwner && isUsdcx;
    });

    console.log(`User holdings: ${contracts.length} total, ${userHoldings.length} USDCx for ${party.substring(0, 20)}...`);

    res.json({
      success: true,
      holdings: userHoldings.map(c => ({
        contractId: c.contractId,
        templateId: c.templateId,
        amount: c.createArgument?.amount?.initialAmount ||
                c.interfaceViews?.[0]?.viewValue?.amount ||
                (typeof c.createArgument?.amount === 'string' ? c.createArgument.amount : '0'),
        owner: c.createArgument?.owner ||
               c.interfaceViews?.[0]?.viewValue?.owner,
        createdEventBlob: c.createdEventBlob,
      })),
      count: userHoldings.length,
      totalScanned: contracts.length,
    });
  } catch (e) {
    console.error('USER HOLDINGS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/usdcx-holdings/:party — fetch USDCx holdings for a party via Holding interface */
app.get('/admin/usdcx-holdings/:party', async (req, res) => {
  try {
    const { party } = req.params;
    const contracts = await queryContractsByInterface(HOLDING_INTERFACE, party);

    // Filter to only USDCx holdings (by instrument admin)
    const usdcxHoldings = contracts.filter(c => {
      const admin = c.createArgument?.instrumentId?.admin ||
                    c.interfaceViews?.[0]?.viewValue?.instrumentId?.admin;
      return !USDCX_INSTRUMENT_ADMIN || admin === USDCX_INSTRUMENT_ADMIN;
    });

    // Debug: log why contracts were filtered
    const debugInfo = contracts.map(c => ({
      contractId: c.contractId?.substring(0, 40),
      templateId: c.templateId,
      admin: c.createArgument?.instrumentId?.admin ||
             c.interfaceViews?.[0]?.viewValue?.instrumentId?.admin || 'N/A',
      instrumentId: c.createArgument?.instrumentId?.id ||
                    c.interfaceViews?.[0]?.viewValue?.instrumentId?.id || 'N/A',
      amount: c.createArgument?.amount?.initialAmount ||
              c.interfaceViews?.[0]?.viewValue?.amount ||
              c.createArgument?.amount,
    }));
    console.log('Holdings debug:', JSON.stringify(debugInfo, null, 2));
    console.log('USDCX_INSTRUMENT_ADMIN:', USDCX_INSTRUMENT_ADMIN);

    res.json({
      success: true,
      holdings: usdcxHoldings.map((c) => ({
        contractId: c.contractId,
        templateId: c.templateId,
        amount: c.createArgument?.amount?.initialAmount ||
                c.interfaceViews?.[0]?.viewValue?.amount ||
                c.createArgument?.amount,
        owner: c.createArgument?.owner ||
               c.interfaceViews?.[0]?.viewValue?.owner,
        instrumentAdmin: c.createArgument?.instrumentId?.admin ||
                         c.interfaceViews?.[0]?.viewValue?.instrumentId?.admin,
        createdEventBlob: c.createdEventBlob,
      })),
      totalContracts: contracts.length,
      usdcxCount: usdcxHoldings.length,
      debug: debugInfo,
    });
  } catch (e) {
    console.error('USDCX HOLDINGS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/send-usdcx — Transfer USDCx from the pool operator ("our validator")
 *  to a recipient party (e.g. a Loop wallet). Server-signed as the operator, using
 *  the CIP-56 token-standard TransferFactory_Transfer via the USDCx registry. */
app.post('/admin/send-usdcx', async (req, res) => {
  try {
    const { recipient, amount = '1.0' } = req.body;
    if (!recipient) {
      return res.status(400).json({ success: false, error: 'recipient party is required' });
    }
    if (!USDCX_INSTRUMENT_ADMIN) {
      return res.status(500).json({ success: false, error: 'USDCX_INSTRUMENT_ADMIN not configured' });
    }

    // Pool operator's USDCx holdings as transfer inputs
    const holdingContracts = await queryContractsByInterface(HOLDING_INTERFACE, POOL_OPERATOR);
    const usdcxHoldings = holdingContracts.filter((c) => {
      const admin = c.createArgument?.instrumentId?.admin ||
                    c.interfaceViews?.[0]?.viewValue?.instrumentId?.admin;
      return !USDCX_INSTRUMENT_ADMIN || admin === USDCX_INSTRUMENT_ADMIN;
    });
    if (!usdcxHoldings.length) {
      return res.json({ success: false, error: 'Pool operator has no USDCx holdings' });
    }
    const holdingCids = usdcxHoldings.map((h) => h.contractId);

    const synchronizerId = process.env.SYNCHRONIZER_ID || 'global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';
    const now = new Date();
    const executeBefore = new Date(now.getTime() + 10 * 60 * 1000);

    // Get transfer factory + choice context from the USDCx registry
    const url = `${USDCX_REGISTRY_URL}/api/token-standard/v0/registrars/${USDCX_INSTRUMENT_ADMIN}/registry/transfer-instruction/v1/transfer-factory`;
    const registryResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        choiceArguments: {
          expectedAdmin: USDCX_INSTRUMENT_ADMIN,
          transfer: {
            sender: POOL_OPERATOR,
            receiver: recipient,
            amount: parseFloat(amount),
            instrumentId: { admin: USDCX_INSTRUMENT_ADMIN, id: USDCX_INSTRUMENT_ID },
            requestedAt: now.toISOString(),
            executeBefore: executeBefore.toISOString(),
            inputHoldingCids: holdingCids,
            meta: { values: {} },
          },
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!registryResp.ok) {
      throw new Error(`USDCx registry API error ${registryResp.status}`);
    }
    const data = await registryResp.json();
    const transferFactoryCid = data.factoryId || data.transferFactoryCid || data.contractId;
    const contextWrapper = data.choiceContext || data.choiceContextData || {};
    const choiceContext = contextWrapper.choiceContextData || { values: {} };
    const rawDisclosed = contextWrapper.disclosedContracts || data.disclosedContracts || [];
    const disclosedContracts = rawDisclosed.map((dc) => ({
      templateId: dc.templateId || dc.template_id || '',
      contractId: dc.contractId || dc.contract_id || '',
      createdEventBlob: dc.createdEventBlob || dc.created_event_blob || '',
      domainId: dc.domainId || dc.domain_id || dc.synchronizerId || dc.synchronizer_id || synchronizerId,
    }));

    const transferFactoryInterfaceId =
      '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';

    const commands = [
      {
        ExerciseCommand: {
          templateId: transferFactoryInterfaceId,
          contractId: transferFactoryCid,
          choice: 'TransferFactory_Transfer',
          choiceArgument: {
            expectedAdmin: USDCX_INSTRUMENT_ADMIN,
            transfer: {
              sender: POOL_OPERATOR,
              receiver: recipient,
              amount: amount.toString(),
              instrumentId: { admin: USDCX_INSTRUMENT_ADMIN, id: USDCX_INSTRUMENT_ID },
              requestedAt: now.toISOString(),
              executeBefore: executeBefore.toISOString(),
              inputHoldingCids: holdingCids,
              meta: { values: {} },
            },
            extraArgs: { context: choiceContext, meta: { values: {} } },
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR], disclosedContracts);
    res.json({
      success: true,
      message: `Sent ${amount} USDCx to ${recipient}.`,
      updateId: result.transaction?.updateId,
      events: result.transaction?.events?.filter((e) => e.CreatedEvent).map((e) => ({
        contractId: e.CreatedEvent?.contractId,
        templateId: e.CreatedEvent?.templateId,
      })),
    });
  } catch (e) {
    console.error('SEND USDCX error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/usdcx-transfer-factory — find TransferFactory for USDCx via interface query */
app.get('/admin/usdcx-transfer-factory', async (req, res) => {
  try {
    const transferFactoryInterfaceId =
      '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';

    // Query as pool operator
    const contracts = await queryContractsByInterface(transferFactoryInterfaceId, POOL_OPERATOR);

    // Log all found transfer factories
    console.log(`Found ${contracts.length} TransferFactory contracts`);
    for (const c of contracts) {
      console.log(`  TF: ${c.contractId?.substring(0, 40)}... template=${c.templateId}`);
    }

    // Return all transfer factories — frontend can pick the right one
    res.json({
      success: true,
      transferFactories: contracts.map(c => ({
        contractId: c.contractId,
        templateId: c.templateId,
        createdEventBlob: c.createdEventBlob,
      })),
      count: contracts.length,
    });
  } catch (e) {
    console.error('USDCX TRANSFER FACTORY error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/create-usdcx-pool — create a LendingPool configured for USDCx */
app.post('/admin/create-usdcx-pool', async (req, res) => {
  try {
    const {
      depositInterestRate = '0.0500000000',
      borrowInterestRate = '0.0800000000',
      collateralRatio = '2.0000000000',
      observers = [],
    } = req.body;

    if (!USDCX_INSTRUMENT_ADMIN) {
      return res.status(500).json({ success: false, error: 'USDCX_INSTRUMENT_ADMIN not configured in .env' });
    }

    const commands = [
      {
        CreateCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
          createArguments: {
            poolOperator: POOL_OPERATOR,
            instrumentAdmin: USDCX_INSTRUMENT_ADMIN,
            depositInterestRate,
            borrowInterestRate,
            collateralRatio,
            observers,
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);
    const poolContractId = extractContractId(result);

    res.json({
      success: true,
      poolContractId,
      instrumentAdmin: USDCX_INSTRUMENT_ADMIN,
      message: 'USDCx LendingPool created. Next: initialize pool state, add user as observer.',
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('CREATE USDCX POOL error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/record-external-deposit — Record a deposit after user transferred tokens via P2P
 *  Two-step flow: user sends tokens via Loop wallet P2P, then operator records it.
 *  Body: { depositor, depositAmount, receivedHoldingCid, poolCid, userPositionCid, poolStateCid }
 */
app.post('/admin/record-external-deposit', async (req, res) => {
  try {
    const {
      depositor,
      depositAmount,
      receivedHoldingCid,
      poolCid,
      userPositionCid,
      poolStateCid,
    } = req.body;

    if (!depositor || !depositAmount || !receivedHoldingCid || !poolCid || !userPositionCid || !poolStateCid) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: depositor, depositAmount, receivedHoldingCid, poolCid, userPositionCid, poolStateCid',
      });
    }

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending-final-loop:Lending.Pool:LendingPool`,
          contractId: poolCid,
          choice: 'RecordExternalDeposit',
          choiceArgument: {
            depositor,
            depositAmount: depositAmount.toString(),
            receivedHoldingCid,
            userPositionCid,
            poolStateCid,
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);

    const createdEvents = result.transaction?.events?.filter(e => e.CreatedEvent) || [];
    const depositPositionCid = createdEvents.find(e =>
      e.CreatedEvent?.templateId?.includes('DepositPosition')
    )?.CreatedEvent?.contractId;
    const newUserPositionCid = createdEvents.find(e =>
      e.CreatedEvent?.templateId?.includes('UserPosition')
    )?.CreatedEvent?.contractId;
    const newPoolStateCid = createdEvents.find(e =>
      e.CreatedEvent?.templateId?.includes('PoolState')
    )?.CreatedEvent?.contractId;

    res.json({
      success: true,
      depositPositionCid,
      newUserPositionCid,
      newPoolStateCid,
      events: createdEvents.map(e => ({
        contractId: e.CreatedEvent?.contractId,
        templateId: e.CreatedEvent?.templateId,
      })),
      updateId: result.transaction?.updateId,
    });
  } catch (e) {
    console.error('RECORD EXTERNAL DEPOSIT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/seed-cc-liquidity — Seed CC liquidity into the CC AssetReserve
 *  Uses the operator's CC (Amulet) holdings and calls RecordDeposit directly.
 *  Body: { assetReserveCid, amount (optional — defaults to all available CC) }
 */
app.post('/admin/seed-cc-liquidity', async (req, res) => {
  try {
    const { assetReserveCid, amount } = req.body;
    if (!assetReserveCid) {
      return res.status(400).json({ success: false, error: 'assetReserveCid is required' });
    }

    // Find operator's CC holdings (via the Holding interface — the concrete Amulet
    // template can't be queried by hex package id)
    const holdings = await queryCCHoldings(POOL_OPERATOR);

    if (!holdings.length) {
      return res.json({ success: false, error: 'Pool operator has no CC (Amulet) holdings. Tap CC first.' });
    }

    // Calculate total available CC
    const totalAvailable = holdings.reduce((sum, h) => {
      const amt = parseFloat(
        h.createArgument?.amount?.initialAmount ||
        h.interfaceViews?.[0]?.viewValue?.amount ||
        '0'
      );
      return sum + amt;
    }, 0);

    const seedAmount = amount ? parseFloat(amount) : totalAvailable;
    if (seedAmount <= 0) {
      return res.json({ success: false, error: 'No CC amount to seed' });
    }

    console.log(`Seeding CC liquidity: ${seedAmount} CC (${holdings.length} holdings, total available: ${totalAvailable})`);

    // Pick the first holding to use as the newHoldingCid
    // In a real flow this would be a transfer, but for seeding we record the holding directly
    const holdingCid = holdings[0].contractId;

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending-final-loop:Lending.AssetReserve:AssetReserve`,
          contractId: assetReserveCid,
          choice: 'RecordDeposit',
          choiceArgument: {
            newHoldingCid: holdingCid,
            depositAmount: seedAmount.toString(),
          },
        },
      },
    ];

    const result = await submitCommand(commands, [POOL_OPERATOR]);

    const createdEvents = result.transaction?.events?.filter(e => e.CreatedEvent) || [];
    const newReserveCid = createdEvents.find(e =>
      e.CreatedEvent?.templateId?.includes('AssetReserve')
    )?.CreatedEvent?.contractId;

    res.json({
      success: true,
      seedAmount,
      holdingCid,
      newReserveCid,
      updateId: result.transaction?.updateId,
    });
  } catch (e) {
    console.error('SEED CC LIQUIDITY error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/usdcx-transfer-context — get TransferFactory + disclosed contracts + choiceContext
 *  Tries Registry API first, falls back to querying TransferFactory directly from ledger.
 *  Body: { sender, receiver, amount, holdingCids }
 */
app.post('/admin/usdcx-transfer-context', async (req, res) => {
  try {
    const { sender, receiver, amount, holdingCids } = req.body;
    if (!sender || !receiver || !amount || !holdingCids?.length) {
      return res.status(400).json({ success: false, error: 'Missing required fields: sender, receiver, amount, holdingCids' });
    }

    const synchronizerId = process.env.SYNCHRONIZER_ID || 'global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337';

    // Strategy 1: Try Registry API
    try {
      const url = `${USDCX_REGISTRY_URL}/api/token-standard/v0/registrars/${USDCX_INSTRUMENT_ADMIN}/registry/transfer-instruction/v1/transfer-factory`;
      const now = new Date();
      const executeBefore = new Date(now.getTime() + 10 * 60 * 1000);

      const requestBody = {
        choiceArguments: {
          expectedAdmin: USDCX_INSTRUMENT_ADMIN,
          transfer: {
            sender,
            receiver,
            amount: parseFloat(amount),
            instrumentId: { admin: USDCX_INSTRUMENT_ADMIN, id: USDCX_INSTRUMENT_ID },
            requestedAt: now.toISOString(),
            executeBefore: executeBefore.toISOString(),
            inputHoldingCids: Array.isArray(holdingCids) ? holdingCids : [holdingCids],
            meta: { values: {} },
          },
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
      };

      console.log('Registry API request:', url);
      const registryResp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(15000),
      });

      if (!registryResp.ok) {
        throw new Error(`Registry API error ${registryResp.status}`);
      }

      const data = await registryResp.json();
      console.log('Registry API factoryId:', data.factoryId);

      const contextWrapper = data.choiceContext || data.choiceContextData || {};
      const choiceContext = contextWrapper.choiceContextData || { values: {} };
      const rawDisclosed = contextWrapper.disclosedContracts || data.disclosedContracts || [];

      const disclosedContracts = rawDisclosed.map(dc => ({
        templateId: dc.templateId || dc.template_id || '',
        contractId: dc.contractId || dc.contract_id || '',
        createdEventBlob: dc.createdEventBlob || dc.created_event_blob || '',
        domainId: dc.domainId || dc.domain_id || dc.synchronizerId || dc.synchronizer_id || synchronizerId,
      }));

      return res.json({
        success: true,
        transferFactoryCid: data.factoryId || data.transferFactoryCid || data.contractId,
        choiceContext,
        disclosedContracts,
      });
    } catch (registryErr) {
      console.warn('Registry API failed, falling back to direct ledger query:', registryErr.message);
    }

    // Strategy 2: Query TransferFactory directly from ledger
    const transferFactoryInterfaceId =
      '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory';

    const contracts = await queryContractsByInterface(transferFactoryInterfaceId, POOL_OPERATOR);
    console.log(`Ledger fallback: found ${contracts.length} TransferFactory contracts`);

    if (contracts.length === 0) {
      throw new Error('No TransferFactory contracts found on ledger');
    }

    // Use the first available TransferFactory
    const tf = contracts[0];
    console.log(`Using TransferFactory: ${tf.contractId?.substring(0, 40)}... template=${tf.templateId}`);

    const disclosedContracts = [];
    if (tf.createdEventBlob) {
      disclosedContracts.push({
        templateId: tf.templateId || '',
        contractId: tf.contractId,
        createdEventBlob: tf.createdEventBlob,
        domainId: synchronizerId,
      });
    }

    res.json({
      success: true,
      transferFactoryCid: tf.contractId,
      choiceContext: { values: {} },
      disclosedContracts,
    });
  } catch (e) {
    console.error('USDCX TRANSFER CONTEXT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/usdcx-config — return current USDCx configuration */
app.get('/admin/usdcx-config', (_, res) => {
  res.json({
    instrumentAdmin: USDCX_INSTRUMENT_ADMIN,
    instrumentId: USDCX_INSTRUMENT_ID,
    registryUrl: USDCX_REGISTRY_URL,
    holdingInterfaceId: USDCX_HOLDING_INTERFACE_ID,
  });
});

/** GET /health */
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    poolOperator: POOL_OPERATOR,
    lendingPackageId: LENDING_PACKAGE_ID,
  });
});

// Serve frontend static files
app.use(express.static(join(__dirname, '../dist')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Admin server running on port ${PORT}`);
  console.log(`Pool Operator: ${POOL_OPERATOR}`);
  console.log(`Lending Package: ${LENDING_PACKAGE_ID}`);
});
