import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchSignedReport } from './chainlinkDataStreams.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
// Ledger state changes under us constantly, so NOTHING from this server may be cached.
// Express sets an ETag on res.json by default, which made every dashboard poll come back
// 304 Not Modified — the browser then reused a body captured against a previous pool
// deployment, so the UI showed a stale UserPosition that no longer existed.
app.set('etag', false);
app.use(cors());
app.use(express.json());
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

const PORT = process.env.PORT || 3100;
const LEDGER_URL = process.env.LEDGER_URL;
const AUTH_URL = process.env.AUTH_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const AUDIENCE = process.env.AUDIENCE;
const POOL_OPERATOR = process.env.POOL_OPERATOR_PARTY;
const LENDING_PACKAGE_ID = process.env.LENDING_PACKAGE_ID;

// TARGET_POOL_OPERATOR pins every pool/oracle/reserve selection to ONE deployment. Needed once the
// query party (POOL_OPERATOR) can see more than one deployment's contracts — e.g. a decparty deployment
// where POOL_OPERATOR is only the oraclePusher/observer and also still sees the old single-key pool.
// Unset = original single-deployment behaviour (return everything). Contracts of PriceOracle / LendingPool /
// AssetReserve all carry a `poolOperator` field, so this filter works uniformly across them.
const TARGET_POOL_OPERATOR = process.env.TARGET_POOL_OPERATOR;
const targetFilter = (contracts) =>
  !TARGET_POOL_OPERATOR
    ? contracts
    : (contracts || []).filter((c) => c?.createArgument?.poolOperator === TARGET_POOL_OPERATOR);

// Party to READ ledger state as. In a decparty deployment the query party (POOL_OPERATOR = oraclePusher)
// is NOT a stakeholder of the new pool's AssetReserves (signatory poolOperator, no observer) or its
// UserPositions (observer = the new poolOperator), so reading as it returns "no reserves" and the OLD
// pool's positions. Read as the new poolOperator instead — it sees every contract in ITS deployment and
// none of the other — which fixes reserve discovery AND scopes positions to this deployment. The server's
// ledger user must have readAs/actAs this party (we granted CanActAs). Unset TARGET → read as POOL_OPERATOR
// (original single-deployment behaviour). NOTE: oracle-push submissions still use POOL_OPERATOR (the
// oraclePusher) as actAs — only READS switch to READ_PARTY.
const READ_PARTY = TARGET_POOL_OPERATOR || POOL_OPERATOR;

// TN-14: routine-maintenance key on LendingPool. Controls GrantPoolAccess (onboarding),
// ConsolidateReserveHoldings, and RefreshReserveHoldings — none of which can move value to an
// outside party, so it stays a HOT single key even when poolOperator becomes an M-of-N threshold
// party (otherwise onboarding one user or a routine consolidation would each need a signing
// ceremony). Defaults to POOL_OPERATOR for single-key testing.
const MAINTENANCE_OPERATOR = process.env.MAINTENANCE_OPERATOR_PARTY || POOL_OPERATOR;
// GOV-01: the committee party that controls every risk-bearing admin choice. This is a
// DecMan-managed decentralized party — we CANNOT sign for it, and that is the point. Its choices
// are reached only through GovernableAction proposals confirmed in the DecMan UI. Defaults to the
// operator so a non-governed deployment behaves exactly as before.
const GOVERNANCE_PARTY = process.env.GOVERNANCE_PARTY || '';

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
/** Drop templateId for LOCAL submission (this server submits via its own participant, which may
 *  not hold the splice-amulet version Scan stamps). The blob is self-describing, so the
 *  participant resolves the contract with whatever compatible version it has. */
function stripTemplateIds(list) {
  return (list || []).map(({ templateId, ...rest }) => rest);
}

async function fetchCCTransferFactory(sender, overrides = {}) {
  // Receiver/sender default to the DEPLOYMENT's poolOperator (READ_PARTY = TARGET_POOL_OPERATOR when set).
  // A supply transfers TO the pool operator, so on the decparty deployment this must be the new party —
  // else the transfer factory is scoped ForOwner the old operator and SupplyTSWithPosition rejects it with
  // a "Contract group identifier mismatch". Payout callers pass overrides.receiver (the user) explicitly.
  const poolOperator = READ_PARTY;
  const effectiveSender = sender || poolOperator;
  const dso = `DSO::${(process.env.SYNCHRONIZER_ID || '').split('::')[1] || '1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337'}`;

  // Amulet's token-standard registry is served by SCAN at its root. CANTON_PROXY_URL was an
  // older proxy that is no longer configured — an empty value made this fetch a malformed URL
  // ("fetch failed"). Verified live: /registry/transfer-instruction/v1/transfer-factory.
  const registryBase = (process.env.SCAN_URL || 'https://scan.sv-1.test.global.canton.network.digitalasset.com').replace(/\/$/, '');
  const resp = await fetch(`${registryBase}/registry/transfer-instruction/v1/transfer-factory`, {
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
      queryContracts(`#alpend-lending:Lending.Oracle:PriceOracle`, READ_PARTY),
      queryContracts(`#alpend-lending:Lending.Pool:LendingPool`, READ_PARTY),
      queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, READ_PARTY),
      queryContracts(`#alpend-lending:Lending.UserPosition:UserPosition`, READ_PARTY),
    ]);

    // TARGET_POOL_OPERATOR pins to a specific deployment when this party sees more than one
    // (see exerciseOracleChoiceAndRepoint). Unset = original single-deployment behaviour.
    const TARGET = process.env.TARGET_POOL_OPERATOR;
    const ownedByTarget = (c) => !TARGET || c?.createArgument?.poolOperator === TARGET;
    const targetPools = poolContracts.filter(ownedByTarget);
    const targetOracles = oracleContracts.filter(ownedByTarget);

    const latestPool = targetPools[targetPools.length - 1];
    // Show the oracle the POOL actually points at — not "last active oracle". After a
    // rebuild-oracle the orphaned old oracle still lingers, and picking it would surface its
    // stale prices/aliases here. feedAliases is included so the frontend can resolve a reserve's
    // feed LABEL (e.g. "cc-feed") to the raw feed id the live price is stored under.
    const poolOracleCid = latestPool?.createArgument?.oracleCid;
    const latestOracle = targetOracles.find((o) => o.contractId === poolOracleCid)
      || targetOracles[targetOracles.length - 1];

    const status = {
      oracle: latestOracle ? {
        cid: latestOracle.contractId,
        prices: latestOracle.createArgument?.prices,
        feedAliases: latestOracle.createArgument?.feedAliases,
      } : null,
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
      assetReserves: reserveContracts.filter(ownedByTarget).map(r => ({
        cid: r.contractId,
        instrumentId: r.createArgument?.instrumentId,
      })),
      // PRIVACY: only ever expose the REQUESTING party's own registry (PV-01). Never the full
      // member list — that leaks every user of the pool. Callers that need "does my party have a
      // registry?" pass ?party=<self>; without it we return nothing.
      userPositions: req.query.party
        ? userPosContracts
            .filter((u) => u.createArgument?.user === req.query.party)
            .map((u) => ({ cid: u.contractId, user: u.createArgument?.user }))
        : [],
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
      // PRODUCTION DEFAULT: false. With this off, SetPrice is gated and the only way a price
      // reaches the oracle is PushVerifiedPrice -> Verify against the pinned Chainlink verifier.
      // That makes the feeder wiring a hard prerequisite for borrow/withdraw — which is the
      // dependency we want to rehearse, not paper over. Pass true explicitly to override.
      allowManualPrice = false,
    } = req.body;
    const oraclePusher = process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR;

    const commands = [
      {
        CreateCommand: {
          templateId: `#alpend-lending:Lending.Oracle:PriceOracle`,
          createArguments: {
            // The pool/oracle SIGNATORY is the (possibly multisig) operator, NOT the key this
            // server submits with. Those are different parties in a decparty deployment.
            poolOperator: DECPARTY_OPERATOR || POOL_OPERATOR,
            ...(GOVERNANCE_PARTY ? { governanceParty: GOVERNANCE_PARTY } : {}),
            oraclePusher,
            prices: {},
            pendingPrices: {},
            feedAliases: {},
            // Daml Int must be string-encoded in the JSON Ledger API
            maxStalenessSeconds: String(parseInt(maxStalenessSeconds)),
            liquidationMaxStalenessSeconds: String(parseInt(liquidationMaxStalenessSeconds)),
            maxDeviationBps: String(parseInt(maxDeviationBps)),
            allowManualPrice,
            // The Chainlink Verifier/VerifierConfig pin moved OUT of PriceOracle into
            // alpend-oracle-chainlink's ChainlinkPriceFeeder, so alpend-lending carries no
            // Chainlink dependency (36-dalf closure, none of them Chainlink). Pin it by
            // creating a feeder: POST /admin/create-feeder.
          },
        },
      },
    ];

    return await operatorAction(res, commands, `#alpend-lending:Lending.Oracle:PriceOracle`,
      { step: 'PriceOracle', allowManualPrice, oraclePusher,
        message: 'PriceOracle. Next: create pool.' });
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
          templateId: `#alpend-lending:Lending.Pool:LendingPool`,
          createArguments: {
            poolOperator: DECPARTY_OPERATOR || POOL_OPERATOR,
            ...(GOVERNANCE_PARTY ? { governanceParty: GOVERNANCE_PARTY } : {}),
            oraclePusher: process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR,
            // treasuryParty pulls accrued protocol revenue, so it must NOT default to the hot
            // submitting key — that would let a leaked pusher key drain revenue. Default to the
            // operator (multisig) instead; override only with a deliberate treasury party.
            treasuryParty: process.env.TREASURY_PARTY || DECPARTY_OPERATOR || POOL_OPERATOR,
            maintenanceOperator: MAINTENANCE_OPERATOR,
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

    return await operatorAction(res, commands, `#alpend-lending:Lending.Pool:LendingPool`,
      { step: 'LendingPool', oracleCid,
        message: 'LendingPool. Next: add asset reserve, wire the feeder, register feeds.' });
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

    // RA-06 transfer-factory pin. For Amulet/CC the factory + its disclosure come from the env
    // (Scan-sourced); pass transferFactoryCid/blob explicitly for any other registry.
    const transferFactoryCid = req.body.transferFactoryCid || process.env.AMULET_TRANSFER_FACTORY_CID;
    const transferFactoryBlob = req.body.transferFactoryBlob || process.env.AMULET_TRANSFER_FACTORY_BLOB;
    if (!transferFactoryCid) {
      return res.status(400).json({ success: false, error: 'transferFactoryCid required (RA-06 pins it at listing time)' });
    }
    // NOTE: no templateId here on purpose. Scan stamps its contracts with the CURRENT
    // splice-amulet version, which this participant may not have — forwarding it fails
    // JSON_API_PACKAGE_SELECTION_FAILED. The blob alone identifies the contract.
    const factoryDisclosure = transferFactoryBlob
      ? [{ contractId: transferFactoryCid, createdEventBlob: transferFactoryBlob,
           synchronizerId: process.env.SYNCHRONIZER_ID }]
      : [];

    // TN-20: AddAssetReserve now requires the CURRENT cids of every already-registered reserve.
    // The DAR's L-6 duplicate-instrument guard reads each existing reserve's instrumentId, and the
    // pool's STORED cids go stale after any AccrueInterest (each archives + re-creates the reserve).
    // The caller must supply them fresh, covering EXACTLY the registered set. For the first reserve
    // this is []. We resolve the live set from the ledger, scoped to THIS deployment.
    const allReserves = await queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, READ_PARTY);
    const currentReserveCids = allReserves
      .filter((c) => !TARGET_POOL_OPERATOR || c?.createArgument?.poolOperator === TARGET_POOL_OPERATOR)
      .map((c) => c.contractId);

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending:Lending.Pool:LendingPool`,
          contractId: poolContractId,
          choice: 'AddAssetReserve',
          choiceArgument: {
            instrumentAdmin,
            instrumentId,
            // RA-06: the reserve is PINNED to one transfer factory at listing time, so a rogue
            // factory can never be substituted per-transfer. AddAssetReserve validates it with
            // TransferFactory_PublicFetch, which means the factory must also be DISCLOSED —
            // poolOperator is not a stakeholder on the registry's contract.
            transferFactoryCid,
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
            // TN-20: fresh cids of all already-registered reserves (must cover exactly the set).
            currentReserveCids,
          },
        },
      },
    ];

    return await operatorAction(res, commands, `#alpend-lending:Lending.AssetReserve:AssetReserve`,
      { step: `AddAssetReserve ${instrumentId?.id || ''}`, currentReserveCids, transferFactoryCid,
        warning: 'AddAssetReserve calls getTime — the prepared tx expires in tens of seconds. '
               + 'Stage both sign commands before executing.' },
      factoryDisclosure);

    /* eslint-disable no-unreachable */
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
    const oracles = await queryContracts(`#alpend-lending:Lending.Oracle:PriceOracle`, POOL_OPERATOR);
    const oracleCid = oracles.length ? oracles[oracles.length - 1].contractId : passedCid;
    if (!oracleCid) {
      return res.status(404).json({ success: false, error: 'No active PriceOracle found' });
    }

    const commands = [
      {
        ExerciseCommand: {
          templateId: `#alpend-lending:Lending.Oracle:PriceOracle`,
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
        const poolContracts = await queryContracts(`#alpend-lending:Lending.Pool:LendingPool`, POOL_OPERATOR);
        const latestPool = poolContracts[poolContracts.length - 1];
        if (latestPool?.contractId) {
          const updateCmd = [{
            ExerciseCommand: {
              templateId: `#alpend-lending:Lending.Pool:LendingPool`,
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
      const oracleContracts = await queryContracts(`#alpend-lending:Lending.Oracle:PriceOracle`, POOL_OPERATOR);
      const latestOracle = oracleContracts[oracleContracts.length - 1];
      if (!latestOracle?.contractId) {
        return res.status(400).json({ success: false, error: 'No oracle contract found' });
      }
      newOracleCid = latestOracle.contractId;
    }
    if (!poolContractId) {
      const poolContracts = await queryContracts(`#alpend-lending:Lending.Pool:LendingPool`, POOL_OPERATOR);
      const latestPool = poolContracts[poolContracts.length - 1];
      if (!latestPool?.contractId) {
        return res.status(400).json({ success: false, error: 'No pool contract found' });
      }
      poolContractId = latestPool.contractId;
    }

    const commands = [{
      ExerciseCommand: {
        templateId: `#alpend-lending:Lending.Pool:LendingPool`,
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

/** POST /user/grant-access — onboard a wallet to THIS pool.
 *  Body: { user }  (the connected party id; pool is resolved server-side)
 *
 *  GrantPoolAccess is controlled by maintenanceOperator — a HOT key, deliberately NOT the
 *  multisig poolOperator, so self-serve signup doesn't cost an M-of-N ceremony. It cannot move
 *  funds: the worst a leaked key does is let an unvetted party use the protocol.
 *
 *  RA-07: `registryInitialized` states whether the user ALREADY has a UserPosition registry.
 *  The contract cannot look this up (no keys, no ACS query), so the grantor must assert it.
 *  We check the ledger here rather than trusting the caller — passing `true` for a genuinely
 *  new user leaves them unable to initialise, and `false` for an existing one is the ONE
 *  remaining way to hand somebody a second registry. */
app.post('/user/grant-access', async (req, res) => {
  try {
    const { user } = req.body;
    if (!user) return res.status(400).json({ success: false, error: 'user (party id) is required' });

    const pool = await currentPoolContract();
    if (!pool?.contractId) return res.status(400).json({ success: false, error: 'no LendingPool found for this deployment' });

    // IDEMPOTENT. GrantPoolAccess is nonconsuming, so calling it twice mints a SECOND one-shot
    // token — and that is a real hazard, not just clutter: once MigrationAccept (or
    // InitializeUserPosition) spends one, the leftover can be spent on the other, giving the user
    // a SECOND UserPosition registry. That is exactly the NEW-03 failure RA-07's one-shot token
    // exists to prevent, and the DAR cannot catch it (no keys, no ACS query — the grantor asserts
    // registryInitialized). So refuse to mint when an unused token is already outstanding.
    const existing = targetFilter(await queryContracts(`#alpend-lending:Lending.Pool:PoolAccess`, READ_PARTY))
      .filter((c) => c?.createArgument?.user === user);
    const unused = existing.find((c) => c?.createArgument?.registryInitialized === false);
    if (unused && !req.body.force) {
      return res.json({
        success: true, user, reused: true,
        poolAccessCid: unused.contractId,
        registryInitialized: false,
        outstanding: existing.length,
        next: 'Already granted — go straight to InitializeUserPosition / MigrationAccept.',
        note: 'Not minting a second token: two unused tokens let one user create two registries (NEW-03). Pass {"force":true} only if you know why you need another.',
      });
    }

    // Does this user already hold a UserPosition in THIS deployment?
    const positions = targetFilter(await queryContracts(`#alpend-lending:Lending.UserPosition:UserPosition`, READ_PARTY))
      .filter((c) => c?.createArgument?.user === user);
    const registryInitialized = positions.length > 0;

    const result = await submitCommand([{ ExerciseCommand: {
      templateId: `#alpend-lending:Lending.Pool:LendingPool`,
      contractId: pool.contractId,
      choice: 'GrantPoolAccess',
      choiceArgument: { user, registryInitialized },
    } }], [MAINTENANCE_OPERATOR]);

    res.json({
      success: true,
      user,
      poolAccessCid: extractContractId(result),
      registryInitialized,
      grantedBy: MAINTENANCE_OPERATOR,
      next: registryInitialized
        ? 'User already has a registry — go straight to supply.'
        : 'Now exercise InitializeUserPosition from the wallet, then supply.',
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('GRANT ACCESS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /user/pool-access/:party — the user's PoolAccess token, if any.
 *  InitializeUserPosition consumes an UNINITIALISED one (registryInitialized = false), so we
 *  return that in preference to an already-initialised token. PV-01: scoped to the requesting
 *  party only — never surface another user's access contract. */
app.get('/user/pool-access/:party', async (req, res) => {
  try {
    const user = decodeURIComponent(req.params.party);
    const all = targetFilter(await queryContracts(`#alpend-lending:Lending.Pool:PoolAccess`, READ_PARTY))
      .filter((c) => c?.createArgument?.user === user);
    const uninitialised = all.find((c) => c?.createArgument?.registryInitialized === false);
    const chosen = uninitialised || all[all.length - 1];
    res.json({
      success: true,
      user,
      poolAccessCid: chosen?.contractId || null,
      registryInitialized: chosen?.createArgument?.registryInitialized ?? null,
      count: all.length,
      hint: chosen
        ? (uninitialised ? 'Ready for InitializeUserPosition.' : 'Token already used — this wallet has a registry.')
        : 'No PoolAccess — run POST /user/grant-access first.',
    });
  } catch (e) {
    console.error('POOL ACCESS lookup error:', e.message);
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
          templateId: `#alpend-lending:Lending.Pool:LendingPool`,
          contractId: poolContractId,
          choice: 'GrantPoolAccess',
          // RA-07 added registryInitialized; omitting it fails against the current DAR.
          choiceArgument: { user: newObserver, registryInitialized: req.body.registryInitialized ?? false },
        },
      },
    ];

    // TN-14: GrantPoolAccess is controlled by maintenanceOperator, not poolOperator.
    const result = await submitCommand(commands, [MAINTENANCE_OPERATOR]);
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
    // Optional overrides (used by the fund-safety drain test): explicit receiver + input holding cids,
    // so we can build a raw poolOperator->attacker transfer of real pool CC and prove 1-of-2 is rejected.
    const receiver = req.query.receiver;
    const holdingCids = req.query.holdingCids ? String(req.query.holdingCids).split(',').filter(Boolean) : undefined;
    const overrides = {};
    if (receiver) overrides.receiver = receiver;
    if (holdingCids) overrides.inputHoldingCids = holdingCids;
    const data = await fetchCCTransferFactory(party, overrides);

    // Map response to frontend format
    const transferFactoryCid = data.factoryId;
    const choiceContext = data.choiceContext?.choiceContextData || { values: {} };
    // KEEP templateId. Two submission paths, opposite requirements:
    //  - Loop wallet (the UI): the SDK REQUIRES templateId on every disclosed contract. Omitting
    //    it decodes as "" and the ledger rejects "Invalid identifier format ()". Loop's own
    //    participant runs the current splice-amulet, so Scan's version resolves there fine.
    //  - This server submitting via palladium: palladium may NOT have that splice-amulet version,
    //    and forwarding it fails JSON_API_PACKAGE_SELECTION_FAILED "Package-id … not known".
    // So we pass the registry's value through untouched and let each submitter decide; the
    // server-side callers strip it (see stripTemplateIds) before submitting locally.
    const disclosedContracts = (data.choiceContext?.disclosedContracts || []).map((dc) => ({
      ...(dc.templateId ? { templateId: dc.templateId } : {}),
      contractId: dc.contractId,
      createdEventBlob: dc.createdEventBlob,
      synchronizerId: dc.synchronizerId || process.env.SYNCHRONIZER_ID || '',
      domainId: dc.synchronizerId || process.env.SYNCHRONIZER_ID || '',
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
    const templateId = `#alpend-lending:Lending.AssetReserve:AssetReserve`;
    const contracts = targetFilter(await queryContracts(templateId, READ_PARTY));
    res.json({ success: true, contracts });
  } catch (e) {
    console.error('QUERY ASSET RESERVES error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/pool-access/:party — does this party hold a PoolAccess grant? (PV-01 membership check) */
app.get('/admin/pool-access/:party', async (req, res) => {
  try {
    const contracts = await queryContracts(`#alpend-lending:Lending.Pool:PoolAccess`, READ_PARTY);
    // PRIVACY: only ever the requesting party's own grant — never expose others'. The cid is needed
    // as the poolAccessCid argument to SupplyTSWithPosition / BorrowTSWithPosition (TN-13).
    const own = contracts.find((c) => c.createArgument?.user === req.params.party);
    res.json({ success: true, hasAccess: !!own, cid: own?.contractId || null });
  } catch (e) {
    console.error('QUERY POOL ACCESS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/revoke-pool-access { party } — archive this party's PoolAccess grant (operator-only). */
app.post('/admin/revoke-pool-access', async (req, res) => {
  try {
    const { party } = req.body;
    if (!party) return res.status(400).json({ success: false, error: 'party is required' });
    const grants = targetFilter(await queryContracts(`#alpend-lending:Lending.Pool:PoolAccess`, READ_PARTY))
      .filter((c) => c.createArgument?.user === party);
    if (!grants.length) return res.json({ success: true, revoked: false, message: 'No PoolAccess grant for this party' });

    // Target a SPECIFIC token. A party can legitimately hold two (an unused one plus the
    // initialised one recreated by InitializeUserPosition/MigrationAccept), and revoking the
    // wrong one is the difference between cleaning up a NEW-03 hazard and cutting off a live
    // user. Default to the UNUSED token, since that is the one that can mint a second registry.
    const chosen = req.body.poolAccessCid
      ? grants.find((c) => c.contractId === req.body.poolAccessCid)
      : (grants.find((c) => c.createArgument?.registryInitialized === false) || grants[0]);
    if (!chosen) return res.status(400).json({ success: false, error: 'poolAccessCid not found for this party' });

    // RevokePoolAccess is `controller poolOperator` — the multisig — so this is a ceremony.
    return await operatorAction(res, [{ ExerciseCommand: {
      templateId: `#alpend-lending:Lending.Pool:PoolAccess`,
      contractId: chosen.contractId, choice: 'RevokePoolAccess', choiceArgument: {},
    } }], `#alpend-lending:Lending.Pool:PoolAccess`,
      { step: 'RevokePoolAccess', party, poolAccessCid: chosen.contractId,
        registryInitialized: chosen.createArgument?.registryInitialized,
        outstanding: grants.length });
  } catch (e) {
    console.error('REVOKE POOL ACCESS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/admin/refresh-holdings', async (req, res) => {
  try {
    const { instrumentIdId } = req.body;
    if (!instrumentIdId) {
      return res.status(400).json({ success: false, error: 'instrumentIdId is required (e.g. "USDCx" or "Amulet")' });
    }

    // Resolve the current reserve for this instrument (+ its feed id, for the pool re-point).
    const reserves = await queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, POOL_OPERATOR);
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
          templateId: `#alpend-lending:Lending.AssetReserve:AssetReserve`,
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
      const pools = await queryContracts(`#alpend-lending:Lending.Pool:LendingPool`, POOL_OPERATOR);
      const pool = pools[pools.length - 1];
      if (pool?.contractId) {
        const upd = await submitCommand([
          {
            ExerciseCommand: {
              templateId: `#alpend-lending:Lending.Pool:LendingPool`,
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
  const RESERVE_TID = `#alpend-lending:Lending.AssetReserve:AssetReserve`;
  const POOL_TID = `#alpend-lending:Lending.Pool:LendingPool`;
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
    const reserves = await queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, POOL_OPERATOR);
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
    const POOL_TID = `#alpend-lending:Lending.Pool:LendingPool`;
    const pools = await queryContracts(POOL_TID, POOL_OPERATOR);
    const pool = pools[pools.length - 1];
    if (!pool?.contractId) return res.status(404).json({ success: false, error: 'No active LendingPool found' });

    // SetPauseFlags is `controller poolOperator`, so it MUST go through operatorAction: when the
    // operator is an external multisig the hot submitting key has no authority and a direct
    // submitCommand fails DAML_AUTHORIZATION_ERROR. This is the emergency brake — it has to work
    // under a threshold party, which is exactly when it is most likely to be needed.
    const commands = [
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
    ];
    return await operatorAction(res, commands, POOL_TID, {
      step: 'SetPauseFlags',
      pauseFlags: { pauseDeposits: !!pauseDeposits, pauseWithdrawals: !!pauseWithdrawals, pauseBorrows: !!pauseBorrows, pauseLiquidations: !!pauseLiquidations },
      previousPoolCid: pool.contractId,
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
    const RESERVE_TID = `#alpend-lending:Lending.AssetReserve:AssetReserve`;
    const POOL_TID = `#alpend-lending:Lending.Pool:LendingPool`;

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
    const P = `#alpend-lending:Lending.`;
    const RESERVE_TID = `${P}AssetReserve:AssetReserve`;
    const POOL_TID = `${P}Pool:LendingPool`;

    const [reserves, borrows, userPositions] = await Promise.all([
      queryContracts(RESERVE_TID, POOL_OPERATOR),
      queryContracts(`${P}Borrow:BorrowPosition`, READ_PARTY),
      queryContracts(`${P}UserPosition:UserPosition`, READ_PARTY),
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

/** Exercise a consuming choice on the current PriceOracle, then re-point the pool at the new
 *  oracle CID (Oracle choices churn the CID). Shared by set-verifier / register-feed / push-price. */
async function exerciseOracleChoiceAndRepoint(choice, choiceArgument, actAs = [POOL_OPERATOR]) {
  const ORACLE_TID = `#alpend-lending:Lending.Oracle:PriceOracle`;
  const POOL_TID = `#alpend-lending:Lending.Pool:LendingPool`;
  // TARGET_POOL_OPERATOR pins pool/oracle selection to a SPECIFIC deployment. Needed once this
  // pusher party (POOL_OPERATOR) can see more than one deployment's contracts — e.g. a decparty
  // deployment where POOL_OPERATOR is only the oraclePusher/observer. There "last active" is
  // ambiguous (it may pick the OTHER deployment's pool/oracle). Set it to the poolOperator party
  // of the deployment this process should drive; unset keeps the original single-deployment
  // behaviour (live prod untouched). NB: choices exercised here must be controlled by POOL_OPERATOR
  // — for a decparty deployment that means oraclePusher-only choices (UpdatePrice / UpdateOracleCid);
  // SetVerifier / RegisterFeed are poolOperator (the decparty) and must go through a signing ceremony.
  const TARGET = process.env.TARGET_POOL_OPERATOR;
  const ownedByTarget = (c) => !TARGET || c?.createArgument?.poolOperator === TARGET;

  // Target the oracle the POOL currently points at — NOT "last active oracle". After a
  // rebuild-oracle / SetVerifier there can be >1 active PriceOracle (the orphaned old one lingers),
  // and picking the wrong one here would push prices to a stale oracle and repoint the pool back
  // to it (re-introducing the manual-price shadow). The pool's oracleCid is authoritative; the
  // fallback (last matching oracle) self-heals a stale pointer left by a poolOperator-side ceremony.
  const pools = (await queryContracts(POOL_TID, POOL_OPERATOR)).filter(ownedByTarget);
  const pool = pools[pools.length - 1];
  const targetOracleCid = pool?.createArgument?.oracleCid;
  const oracles = (await queryContracts(ORACLE_TID, POOL_OPERATOR)).filter(ownedByTarget);
  const oracle = oracles.find((o) => o.contractId === targetOracleCid) || oracles[oracles.length - 1];
  if (!oracle?.contractId) throw new Error(`No active PriceOracle found${TARGET ? ` for poolOperator ${TARGET}` : ''}`);

  const result = await submitCommand([
    { ExerciseCommand: { templateId: ORACLE_TID, contractId: oracle.contractId, choice, choiceArgument } },
  ], actAs);
  const newOracleCid = extractContractId(result);

  let newPoolCid = null;
  if (newOracleCid) {
    const pools = (await queryContracts(POOL_TID, POOL_OPERATOR)).filter(ownedByTarget);
    const pool = pools[pools.length - 1];
    if (pool?.contractId) {
      const upd = await submitCommand([
        { ExerciseCommand: { templateId: POOL_TID, contractId: pool.contractId, choice: 'UpdateOracleCid', choiceArgument: { newOracleCid } } },
      ], [POOL_OPERATOR]);
      newPoolCid = extractContractId(upd);
    }
  }
  return { newOracleCid, newPoolCid, updateId: result.transaction?.updateId || result.updateId };
}

// ── oracle/pool resolution shared by the feeder push path ────────────────────
// Same selection rule as exerciseOracleChoiceAndRepoint: prefer the oracle the POOL points at,
// because after a rebuild there can be more than one active PriceOracle and picking the stale
// one would push prices nowhere useful.
const _ownedByTarget = (c) =>
  !process.env.TARGET_POOL_OPERATOR || c?.createArgument?.poolOperator === process.env.TARGET_POOL_OPERATOR;

async function currentPoolContract() {
  const pools = (await queryContracts(`#alpend-lending:Lending.Pool:LendingPool`, READ_PARTY)).filter(_ownedByTarget);
  return pools[pools.length - 1];
}
const currentPoolCid = async () => (await currentPoolContract())?.contractId;

async function currentOracleContract() {
  const pool = await currentPoolContract();
  const oracles = (await queryContracts(`#alpend-lending:Lending.Oracle:PriceOracle`, READ_PARTY)).filter(_ownedByTarget);
  return oracles.find((o) => o.contractId === pool?.createArgument?.oracleCid) || oracles[oracles.length - 1];
}
const currentOracleCid = async () => (await currentOracleContract())?.contractId;

/** Does the current oracle carry a price for EVERY feed the pool has a reserve for?
 *  This is exactly FIND-014's assert inside UpdateOracleCid — checking it first is what lets us
 *  pass poolCid for an atomic retarget only when it will actually succeed. Mirrors resolvePrice:
 *  direct key first, then the registered alias. */
async function everyFeedPriced() {
  const oracle = await currentOracleContract();
  if (!oracle) return false;
  const prices = oracle.createArgument?.prices || {};
  const aliases = oracle.createArgument?.feedAliases || {};
  const reserves = (await queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, READ_PARTY)).filter(_ownedByTarget);
  if (!reserves.length) return false;
  return reserves.every((r) => {
    const f = r.createArgument?.riskParams?.priceFeedId;
    return f && (prices[f] !== undefined || (aliases[f] && prices[aliases[f]] !== undefined));
  });
}

async function repointPoolOracle(newOracleCid) {
  const pool = await currentPoolContract();
  if (!pool?.contractId) throw new Error('no LendingPool to repoint');
  const upd = await submitCommand([{ ExerciseCommand: {
    templateId: `#alpend-lending:Lending.Pool:LendingPool`, contractId: pool.contractId,
    choice: 'UpdateOracleCid', choiceArgument: { newOracleCid },
  } }], [process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR]);
  return extractContractId(upd);
}

// ── Chainlink feeder (alpend-oracle-chainlink) ───────────────────────────────
// SetVerifier is GONE from PriceOracle. The verifier pin now lives on ChainlinkPriceFeeder
// in a separate DAR, which is why alpend-lending has no Chainlink dependency. The feeder is
// `signatory poolOperator` and its PushVerifiedPrice choice is `controller oraclePusher`, so
// exercising it runs with poolOperator authority — that is what lets it reach the
// poolOperator-controlled RecordVerifiedPrice on the oracle. A leaked oraclePusher key still
// cannot write a price without passing Verify.
const FEEDER_TEMPLATE = `#alpend-oracle-chainlink:Oracle.Chainlink:ChainlinkPriceFeeder`;

// ── 2-of-2 ceremony engine (interactive submission) ──────────────────────────
// This server submits with a SINGLE ledger token, so it cannot actAs an external M-of-N
// poolOperator. Those choices go: prepare -> sign on EACH key holder's box -> execute.
// Keys never touch this server; it only assembles the two signatures.
// DECPARTY_OPERATOR is the external party (defaults to TARGET_POOL_OPERATOR when that differs
// from our submitting key). SIGNER{1,2}_FP are the PROTOCOL key fingerprints (psk1/psk2).
const DECPARTY_OPERATOR = process.env.DECPARTY_OPERATOR
  || (TARGET_POOL_OPERATOR && TARGET_POOL_OPERATOR !== POOL_OPERATOR ? TARGET_POOL_OPERATOR : null);
// The operator party's signing threshold decides how many signatures an execute needs, and that is
// a property of the PARTY, not of this server: our self-managed party is `partySigningKeys
// threshold 2` (psk1 + psk2), while a DecMan-created party can be threshold 1 with a single usable
// key. So the signer set is a list, ordered, and the count is whatever is configured — not a
// hardcoded pair. Signatures supplied at execute must be in THIS order.
const SIGNER_FPS = [
  process.env.SIGNER1_FP, process.env.SIGNER2_FP,
  process.env.SIGNER3_FP, process.env.SIGNER4_FP,
].filter(Boolean);
const SIG_FORMAT = process.env.SIG_FORMAT || 'SIGNATURE_FORMAT_CONCAT';
const SIG_SPEC = process.env.SIG_SPEC || 'SIGNING_ALGORITHM_SPEC_ED25519';
const S1_BOX = process.env.SIGNER1_BOX || 'palladium';
const S1_KEY = process.env.SIGNER1_KEY || 'psk1.priv.pem';
const S2_BOX = process.env.SIGNER2_BOX || 'ibex';
const S2_KEY = process.env.SIGNER2_KEY || 'psk2.priv.pem';
const LEDGER_USER_ID = process.env.LEDGER_USER_ID
  || (CLIENT_ID ? `${CLIENT_ID}@clients` : null);

// Prepared txs persist: each represents real two-box human work, and nodemon/--watch restarts
// would otherwise discard a ceremony mid-flight.
const CER_DIR = join(__dirname, '.ceremonies');
const ceremonies = new Map();
(function loadCeremonies() {
  try {
    fsMkdirSync(CER_DIR, { recursive: true });
    for (const f of fsReaddirSync(CER_DIR).filter((n) => n.endsWith('.json'))) {
      try { ceremonies.set(f.replace(/\.json$/, ''), JSON.parse(fsReadFileSync(join(CER_DIR, f), 'utf8'))); } catch {}
    }
  } catch {}
})();
const cerSave = (id, v) => { try { fsMkdirSync(CER_DIR, { recursive: true }); fsWriteFileSync(join(CER_DIR, `${id}.json`), JSON.stringify(v)); } catch {} };
const cerDrop = (id) => { try { const p = join(CER_DIR, `${id}.json`); if (fsExistsSync(p)) fsUnlinkSync(p); } catch {} };

const needsCeremony = (actAs) =>
  !!DECPARTY_OPERATOR && (Array.isArray(actAs) ? actAs : [actAs]).includes(DECPARTY_OPERATOR);

async function startCeremony({ commands, disclosedContracts = [], label, watchTemplate }) {
  if (!LEDGER_USER_ID) throw new Error('ceremony needs LEDGER_USER_ID (or CLIENT_ID to derive it)');
  if (!process.env.SYNCHRONIZER_ID) throw new Error('ceremony needs SYNCHRONIZER_ID');
  const token = await getToken();
  const resp = await fetch(`${LEDGER_URL}/v2/interactive-submission/prepare`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: LEDGER_USER_ID,
      commandId: `cer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      actAs: [DECPARTY_OPERATOR], readAs: [],
      synchronizerId: process.env.SYNCHRONIZER_ID,
      commands, disclosedContracts, verboseHashing: false,
      ...(LENDING_PACKAGE_ID ? { packageIdSelectionPreference: [LENDING_PACKAGE_ID] } : {}),
    }),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`prepare ${resp.status}: ${txt.slice(0, 400)}`);
  const prepared = JSON.parse(txt);
  const hashB64 = prepared.preparedTransactionHash;
  if (!hashB64) throw new Error('prepare returned no preparedTransactionHash');
  const id = label || `cer-${Date.now().toString(36)}`;
  const rec = { prepared, hashB64, watchTemplate, createdAt: new Date().toISOString(),
    // Keep the raw commands: executeCeremony needs each ExerciseCommand's target contractId to
    // verify the transaction actually committed (see the note there).
    rawCommands: commands,
    commands: commands.map((c) => Object.keys(c)[0] + ':' + (c.ExerciseCommand?.choice || c.CreateCommand?.templateId || '')) };
  ceremonies.set(id, rec); cerSave(id, rec);
  return {
    ceremony: id, hashB64,
    // Signing hints are generated from the CONFIGURED signer set, not a hardcoded pair — a
    // threshold-1 operator gets one box and one signature; a 2-of-2 gets the palladium->ibex chain.
    signaturesRequired: SIGNER_FPS.length,
    ...(SIGNER_FPS.length === 1
      ? {
          run_on: `${S1_BOX}: atd '${hashB64}' '${id}'`,
          setup: {
            once: `atd () { local H="$1" L="$2"; [ -f ${S1_KEY} ] || { echo "NO KEY at ${S1_KEY} (wrong user?)"; return 1; }; echo -n "$H" | base64 -d > "$HOME/h.bin"; local S=$(openssl pkeyutl -sign -inkey ${S1_KEY} -rawin -in "$HOME/h.bin" | base64 -w0); [ -z "$S" ] && { echo SIGN_FAILED; return 1; }; printf '\\n===== PASTE ON YOUR MAC =====\\n'; echo "curl -sS -X POST http://localhost:${PORT}/ceremony/execute -H 'Content-Type: application/json' -d '{\\"label\\":\\"$L\\",\\"sigs\\":[\\"$S\\"]}'"; }`,
          },
          boxes: { sig1: S1_BOX },
        }
      : {
          run_on_palladium: `alp1 '${hashB64}' '${id}'`,
          setup: {
            palladium_once: `alp1 () { local H="$1" L="$2"; local S1=$(echo -n "$H" | base64 -d > "$HOME/h.bin"; openssl pkeyutl -sign -inkey ${S1_KEY} -rawin -in "$HOME/h.bin" | base64 -w0); [ -z "$S1" ] && { echo SIGN_FAILED; return 1; }; printf '\\n===== PASTE ON ${S2_BOX.toUpperCase()} =====\\n'; echo "alp2 '$H' '$L' '$S1'"; }`,
            ibex_once: `alp2 () { local H="$1" L="$2" S1="$3"; local S2=$(echo -n "$H" | base64 -d > "$HOME/h.bin"; openssl pkeyutl -sign -inkey ${S2_KEY} -rawin -in "$HOME/h.bin" | base64 -w0); [ -z "$S2" ] && { echo SIGN_FAILED; return 1; }; printf '\\n===== PASTE ON YOUR MAC =====\\n'; echo "curl -sS -X POST http://localhost:${PORT}/ceremony/execute -H 'Content-Type: application/json' -d '{\\"label\\":\\"$L\\",\\"sig1\\":\\"$S1\\",\\"sig2\\":\\"$S2\\"}'"; }`,
          },
          boxes: { sig1: S1_BOX, sig2: S2_BOX },
        }),
  };
}

async function executeCeremony(id, sigs) {
  const c = ceremonies.get(id);
  if (!c) throw new Error(`unknown ceremony '${id}' — re-run prepare`);
  if (!SIGNER_FPS.length) throw new Error('no signer fingerprints configured (set SIGNER1_FP[, SIGNER2_FP, ...])');
  if (sigs.length !== SIGNER_FPS.length) {
    throw new Error(`this operator needs ${SIGNER_FPS.length} signature(s), got ${sigs.length}`);
  }
  const mk = (s, fp) => ({ format: SIG_FORMAT, signature: s, signedBy: fp, signingAlgorithmSpec: SIG_SPEC });
  const token = await getToken();
  // Offset BEFORE submitting, so we can find our own completion afterwards.
  const beginOffset = await (async () => {
    try {
      const r = await fetch(`${LEDGER_URL}/v2/state/ledger-end`, { headers: { Authorization: `Bearer ${token}` } });
      return (await r.json()).offset;
    } catch { return null; }
  })();
  const submissionId = `cer-${id}`;
  const resp = await fetch(`${LEDGER_URL}/v2/interactive-submission/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preparedTransaction: c.prepared.preparedTransaction,
      hashingSchemeVersion: c.prepared.hashingSchemeVersion,
      userId: LEDGER_USER_ID,
      submissionId,
      deduplicationPeriod: { Empty: {} },
      partySignatures: { signatures: [{ party: DECPARTY_OPERATOR, signatures: sigs.map((s, i) => mk(s, SIGNER_FPS[i])) }] },
    }),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`execute ${resp.status}: ${txt.slice(0, 400)}`);
  ceremonies.delete(id); cerDrop(id);

  // ── VERIFY THE TRANSACTION ACTUALLY COMMITTED ───────────────────────────────────────────────
  // `/v2/interactive-submission/execute` is ASYNCHRONOUS: HTTP 200 means the submission was
  // ACCEPTED, not that the transaction committed. Rejections (LOCAL_VERDICT_INACTIVE_CONTRACTS when
  // something else consumed the target first, authorization failures, ...) are delivered on the
  // COMPLETION stream and never appear in that response.
  //
  // Do NOT infer success from "the exercised contract is now archived" — that is satisfied when a
  // COMPETING transaction archived it, which is precisely the failure mode here (the oracle push
  // loop rotates the pool on every price push). That heuristic produced a false `verified: true` on
  // an unpause that never landed. The only sound signal is our own completion, matched on
  // submissionId. There is no execute-and-wait on this JSON API build.
  let verified = null, commitError = null, updateId = null;
  if (beginOffset != null) {
    const parties = [DECPARTY_OPERATOR, POOL_OPERATOR].filter(Boolean);
    for (let i = 0; i < 20 && verified === null; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const cr = await fetch(`${LEDGER_URL}/v2/commands/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: LEDGER_USER_ID, parties, beginExclusive: beginOffset }),
        });
        if (!cr.ok) break;                       // endpoint shape differs — fall through to null
        const rows = await cr.json();
        for (const row of (Array.isArray(rows) ? rows : [])) {
          const comp = row?.completionResponse?.Completion?.value || row?.Completion?.value || row?.completion;
          if (!comp || comp.submissionId !== submissionId) continue;
          const st = comp.status || {};
          if (!st.code) { verified = true; updateId = comp.updateId || null; }
          else { verified = false; commitError = `${st.code}: ${String(st.message || '').slice(0, 300)}`; }
          break;
        }
      } catch { break; }
    }
  }

  let created = [];
  if (c.watchTemplate) {
    for (let i = 0; i < 20 && !created.length; i++) {
      const now = targetFilter(await queryContracts(c.watchTemplate, READ_PARTY));
      created = now.map((x) => x.contractId).filter((cid) => !(c.before || []).includes(cid));
      if (!created.length) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (verified === false) console.error(`CEREMONY ${id}: REJECTED — ${commitError}`);
  if (verified === null) console.warn(`CEREMONY ${id}: could not confirm commit (no matching completion) — verify on-ledger`);
  return {
    created,
    verified,
    ...(updateId ? { updateId } : {}),
    ...(verified === false ? {
      error: `Transaction did NOT commit — ${commitError}`,
      hint: 'If this is INACTIVE_CONTRACTS, something consumed the target first — usually the oracle '
        + 'push loop (it rotates the pool on every price push). Stop it, then re-prepare.',
    } : {}),
    ...(verified === null ? { warning: 'Commit unconfirmed — check on-ledger state before trusting this.' } : {}),
    raw: txt ? JSON.parse(txt) : {},
  };
}

/** Run a poolOperator command: ceremony when the operator is an external multisig,
 *  direct single-token submit otherwise. */
async function operatorAction(res, commands, watchTemplate, extra = {}, disclosedContracts = []) {
  if (needsCeremony([DECPARTY_OPERATOR])) {
    const before = watchTemplate
      ? targetFilter(await queryContracts(watchTemplate, READ_PARTY)).map((x) => x.contractId) : [];
    const cer = await startCeremony({ commands, disclosedContracts, watchTemplate });
    const rec = ceremonies.get(cer.ceremony); rec.before = before; cerSave(cer.ceremony, rec);
    return res.json({ success: true, ceremonyRequired: true, ...extra, ...cer });
  }
  const result = await submitCommand(commands, [POOL_OPERATOR], disclosedContracts);
  return res.json({ success: true, ...extra, updateId: result.transaction?.updateId, created: extractContractId(result) });
}

app.post('/ceremony/prepare', async (req, res) => {
  try {
    const { commands, disclosedContracts = [], label, watchTemplate } = req.body;
    if (!Array.isArray(commands) || !commands.length) return res.status(400).json({ success: false, error: 'need commands[]' });
    res.json({ success: true, ...(await startCeremony({ commands, disclosedContracts, label, watchTemplate })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/ceremony/execute', async (req, res) => {
  try {
    const { label, sigs, sig1, sig2 } = req.body;
    // Accept either an explicit `sigs` array or the legacy sig1/sig2 pair.
    const list = Array.isArray(sigs) ? sigs.filter(Boolean) : [sig1, sig2].filter(Boolean);
    if (!label || !list.length) {
      return res.status(400).json({ success: false,
        error: `need label and ${SIGNER_FPS.length} signature(s) — pass sigs: [...] or sig1/sig2` });
    }
    res.json({ success: true, label, ...(await executeCeremony(label, list)) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/ceremony/list', (_req, res) => res.json({ success: true,
  operator: DECPARTY_OPERATOR, submittingAs: POOL_OPERATOR, signaturesRequired: SIGNER_FPS.length,
  pending: [...ceremonies.entries()].map(([k, v]) => ({ label: k, createdAt: v.createdAt, hashB64: v.hashB64, commands: v.commands })) }));

async function currentFeederCid() {
  const cs = await queryContracts(FEEDER_TEMPLATE, READ_PARTY);
  const mine = cs.filter((c) => !TARGET_POOL_OPERATOR || c?.createArgument?.poolOperator === TARGET_POOL_OPERATOR);
  return mine.slice(-1)[0]?.contractId;
}

/** POST /admin/rotate-oracle-pusher — repoint BOTH the oracle and the pool at a new
 *  oraclePusher party. Body: { newOraclePusher? } (defaults to ORACLE_PUSHER_PARTY).
 *
 *  Both must move together: PriceOracle has `observer oraclePusher` (so the bot can SEE the
 *  oracle it writes to) and Pool.UpdateOracleCid asserts
 *  `newOracle.oraclePusher == oraclePusher`, so a mismatch bricks every retarget.
 *
 *  Two ceremonies, deliberately not batched: each choice is consuming and returns a new cid,
 *  and Canton's interactive submission prepares ONE command at a time. Run oracle first, then
 *  pool — the pool's assert reads the oracle. */
app.post('/admin/rotate-oracle-pusher', async (req, res) => {
  try {
    const newOraclePusher = req.body.newOraclePusher || process.env.ORACLE_PUSHER_PARTY;
    const target = req.body.target; // 'oracle' | 'pool'
    if (!newOraclePusher) return res.status(400).json({ success: false, error: 'newOraclePusher required' });
    if (target !== 'oracle' && target !== 'pool') {
      return res.status(400).json({ success: false, error: "target must be 'oracle' or 'pool' (run oracle first)" });
    }

    if (target === 'oracle') {
      const oracle = await currentOracleContract();
      if (!oracle?.contractId) return res.status(400).json({ success: false, error: 'no PriceOracle found' });
      return await operatorAction(res, [{ ExerciseCommand: {
        templateId: `#alpend-lending:Lending.Oracle:PriceOracle`, contractId: oracle.contractId,
        choice: 'RotateOraclePusher', choiceArgument: { newOraclePusher },
      } }], `#alpend-lending:Lending.Oracle:PriceOracle`,
        { step: 'RotateOraclePusher (oracle)', newOraclePusher, from: oracle.contractId,
          next: 'then target=pool' });
    }

    const pool = await currentPoolContract();
    if (!pool?.contractId) return res.status(400).json({ success: false, error: 'no LendingPool found' });
    return await operatorAction(res, [{ ExerciseCommand: {
      templateId: `#alpend-lending:Lending.Pool:LendingPool`, contractId: pool.contractId,
      choice: 'UpdateOraclePusher', choiceArgument: { newOraclePusher },
    } }], `#alpend-lending:Lending.Pool:LendingPool`,
      { step: 'UpdateOraclePusher (pool)', newOraclePusher, from: pool.contractId });
  } catch (e) {
    console.error('ROTATE ORACLE PUSHER error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/create-feeder — genesis the ChainlinkPriceFeeder (replaces SetVerifier).
 *  Body: { verifierCid, verifierConfigCid, expectedConfigOwner? } */
app.post('/admin/create-feeder', async (req, res) => {
  try {
    const { verifierCid, verifierConfigCid, expectedConfigOwner } = req.body;
    if (!verifierCid || !verifierConfigCid) {
      return res.status(400).json({ success: false, error: 'verifierCid and verifierConfigCid are required' });
    }
    const createArguments = {
      poolOperator: DECPARTY_OPERATOR || POOL_OPERATOR,
      oraclePusher: process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR,
      verifierCid, verifierConfigCid,
      // Whose VerifierConfig we require. Pinned as a field, not passed per call — a
      // caller-supplied expectation is no expectation at all (same reasoning as RA-06).
      expectedConfigOwner: expectedConfigOwner || process.env.CHAINLINK_CONFIG_OWNER || POOL_OPERATOR,
    };
    return await operatorAction(res, [{ CreateCommand: { templateId: FEEDER_TEMPLATE, createArguments } }],
      FEEDER_TEMPLATE, { step: 'ChainlinkPriceFeeder', args: createArguments,
        next: 'POST /admin/push-price { feedId }' });
  } catch (e) {
    console.error('CREATE FEEDER error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/rotate-verifier — re-pin the verifier/config pair (poolOperator).
 *  Must exist from genesis: a Splice hard-domain migration makes the pinned cid stale, and
 *  migration is one-way, so without rotation the pool would have to be redeployed. */
app.post('/admin/rotate-verifier', async (req, res) => {
  try {
    const { verifierCid, verifierConfigCid } = req.body;
    const feederCid = req.body.feederCid || await currentFeederCid();
    if (!feederCid) return res.status(400).json({ success: false, error: 'no ChainlinkPriceFeeder — create one first' });
    return await operatorAction(res, [{ ExerciseCommand: { templateId: FEEDER_TEMPLATE, contractId: feederCid,
      choice: 'RotateVerifier',
      choiceArgument: { newVerifierCid: verifierCid, newVerifierConfigCid: verifierConfigCid } } }],
      FEEDER_TEMPLATE, { step: 'RotateVerifier', feederCid });
  } catch (e) {
    console.error('ROTATE VERIFIER error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/register-feed — map a reserve's canonical priceFeedId → the raw Chainlink report.feedId
 *  (RegisterFeed, poolOperator). Body: { label, rawFeedId }. e.g. label "cc-feed",
 *  rawFeedId "0x0003111e1c2212376d4c196bf7635919e4b28368809dda6f515c396453d53770". */
app.post('/admin/register-feed', async (req, res) => {
  try {
    const { label } = req.body;
    // Known TESTNET Data Streams ids (mainnet ids 404 against the testnet host).
    const KNOWN = {
      'cc-feed': '00031de3179f870b857f273a3496c5a76795aec28f984f243b51fd8aaf759c55',
      'usdcx-feed': '0003dc85e8b01946bf9dfd8b0db860129181eb6105a8c8981d9f28e00b6f60d9',
    };
    let rawFeedId = req.body.rawFeedId || KNOWN[label];
    if (!label || !rawFeedId) {
      return res.status(400).json({ success: false, error: `label required (+ rawFeedId unless one of: ${Object.keys(KNOWN).join(', ')})` });
    }
    // The alias VALUE must equal the key UpdatePrice stores under — report.feedId, no 0x prefix.
    rawFeedId = rawFeedId.startsWith('0x') ? rawFeedId.slice(2) : rawFeedId;
    if (!rawFeedId.startsWith('0003')) {
      return res.status(400).json({ success: false, error: `rawFeedId must be a V3 feed id (0003 prefix), got ${rawFeedId.slice(0, 8)}…` });
    }
    const oracle = await currentOracleContract();
    if (!oracle?.contractId) return res.status(400).json({ success: false, error: 'no PriceOracle found' });

    // NOTE: no repoint here. RegisterFeed rotates the oracle cid, but FIND-014 makes
    // UpdateOracleCid assert a price exists for EVERY configured feed — which is false until
    // the first push lands. Repointing happens as part of the first PushVerifiedPrice instead.
    return await operatorAction(res, [{ ExerciseCommand: {
      templateId: `#alpend-lending:Lending.Oracle:PriceOracle`, contractId: oracle.contractId,
      choice: 'RegisterFeed', choiceArgument: { label, rawFeedId },
    } }], `#alpend-lending:Lending.Oracle:PriceOracle`,
      { step: `RegisterFeed ${label}`, label, rawFeedId, oracleCid: oracle.contractId,
        note: 'pool NOT repointed — happens on the first successful price push (FIND-014)' });
  } catch (e) {
    console.error('REGISTER FEED error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/push-price — fetch the latest signed Chainlink Data Streams report for a feed and push
 *  it on-chain via UpdatePrice (oraclePusher; == poolOperator on testnet). Requires the verifier pinned
 *  (set-verifier) + the feed registered (register-feed). Body: { feedId } (Chainlink feed id). */
/** Fetch the latest signed report for a feed and push it on-chain via UpdatePrice. Reusable by
 *  the manual endpoint + the continuous loop. Requires verifier pinned + feed registered. */
async function pushFeed(feedId) {
  const report = await fetchSignedReport(feedId);
  const feederCid = await currentFeederCid();
  if (!feederCid) throw new Error('no ChainlinkPriceFeeder — POST /admin/create-feeder first');
  const oracleCid = await currentOracleCid();
  if (!oracleCid) throw new Error('no PriceOracle found');

  // PushVerifiedPrice: Verify -> parse V3 -> validFrom/expiresAt window -> RecordVerifiedPrice.
  // poolCid is OPTIONAL and that optionality is load-bearing: passing it retargets the pool in the
  // SAME transaction (no window where the pool points at an archived oracle), but FIND-014 makes
  // UpdateOracleCid assert a price exists for EVERY configured feed — so during bootstrap, before
  // every feed has a price, pass None or the push deadlocks on the price it is trying to write.
  const poolCid = await currentPoolCid().catch(() => null);
  const includePool = poolCid && (await everyFeedPriced().catch(() => false));

  const result = await submitCommand([{ ExerciseCommand: {
    templateId: FEEDER_TEMPLATE, contractId: feederCid, choice: 'PushVerifiedPrice',
    choiceArgument: {
      oracleCid,
      signedReportBytes: report.fullReport,   // BytesHex — verified + decoded on-chain
      poolCid: includePool ? poolCid : null,
    },
  } }], [process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR]);

  const newOracleCid = (result.transaction?.events || [])
    .map((e) => e.CreatedEvent).find((c) => c?.templateId?.includes('PriceOracle'))?.contractId;
  // If we did not retarget atomically, the pool still points at the archived oracle — repoint now.
  let newPoolCid = null;
  if (!includePool && newOracleCid) {
    newPoolCid = await repointPoolOracle(newOracleCid).catch((e) => {
      console.warn(`pushFeed: repoint deferred (${e.message}) — expected until every feed is priced`);
      return null;
    });
  }
  return { feedId: report.feedId, decodedPrice: report.decoded?.price, newOracleCid, newPoolCid, atomicRetarget: !!includePool };
}

app.post('/admin/push-price', async (req, res) => {
  try {
    const { feedId } = req.body;
    if (!feedId) return res.status(400).json({ success: false, error: 'feedId (Chainlink feed id) is required' });
    const out = await pushFeed(feedId);
    console.log(`PushPrice ${feedId}: price≈${out.decodedPrice}, oracle=${out.newOracleCid}`);
    res.json({ success: true, ...out });
  } catch (e) {
    console.error('PUSH PRICE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/rebuild-oracle — stand up a FRESH PriceOracle with `allowManualPrice=false` and
 *  repoint the pool at it. This is the one-shot cure for the manual-price shadow: `resolvePrice`
 *  checks the reserve's feed label directly BEFORE the alias, so any leftover manual `SetPrice`
 *  stored under a label (`cc-feed`/`usdcx-feed`) permanently shadows the live Chainlink price
 *  (stored under the raw feed id) — and once stale it BRICKS reads (GetPrice aborts, no fall-through).
 *  The deployed Oracle has no RemovePrice choice, so we rebuild instead. `allowManualPrice=false`
 *  means the fresh oracle can never acquire a label-keyed price, so reads resolve label→alias→raw→live.
 *
 *  Copies operator/pusher/staleness/verifier from the current oracle; takes feeds [{label, rawFeedId}].
 *  CRITICAL: the alias value is stored with the `0x` prefix STRIPPED, because the DAR stores the price
 *  under `report.feedId` in that exact form (no `0x`) — the alias value must byte-match that key or the
 *  fallback lookup misses. Order: create (verifier+aliases baked in, prices empty) → UpdatePrice every
 *  feed (so the new oracle carries a live price for each) → UpdateOracleCid ONCE (its FIND-014 check
 *  requires a resolvable price for every configured reserve feed, so the repoint must come last). */
app.post('/admin/rebuild-oracle', async (req, res) => {
  try {
    const ORACLE_TID = `#alpend-lending:Lending.Oracle:PriceOracle`;
    const POOL_TID = `#alpend-lending:Lending.Pool:LendingPool`;
    const feeds = req.body.feeds;
    if (!Array.isArray(feeds) || feeds.length === 0) {
      return res.status(400).json({ success: false, error: 'feeds [{label, rawFeedId}] required' });
    }

    // Current pool + the oracle it points at (authoritative source for params to copy).
    const pools = await queryContracts(POOL_TID, POOL_OPERATOR);
    const pool = pools[pools.length - 1];
    if (!pool?.contractId) throw new Error('No active LendingPool found');
    const curOracleCid = pool.createArgument?.oracleCid;
    const oracles = await queryContracts(ORACLE_TID, POOL_OPERATOR);
    const cur = oracles.find((o) => o.contractId === curOracleCid) || oracles[oracles.length - 1];
    if (!cur?.createArgument) throw new Error('Could not read current oracle params');
    const c = cur.createArgument;
    // The verifier pin is no longer on the oracle — it lives on ChainlinkPriceFeeder in
    // alpend-oracle-chainlink. A fresh oracle needs no pin; it just needs a feeder to exist
    // so prices can be pushed into it.
    const feederCid = await currentFeederCid();
    if (!feederCid) throw new Error('No ChainlinkPriceFeeder — run POST /admin/create-feeder first');

    // Alias value MUST equal the DAR-stored price key (report.feedId, no 0x prefix).
    const stripHex = (s) => (s.startsWith('0x') ? s.slice(2) : s);
    const feedAliases = {};
    for (const f of feeds) feedAliases[f.label] = stripHex(f.rawFeedId);

    // 1. Fresh oracle: allowManualPrice=false, verifier + aliases baked in, prices empty.
    const createRes = await submitCommand([
      { CreateCommand: {
        templateId: ORACLE_TID,
        createArguments: {
          poolOperator: c.poolOperator,
          oraclePusher: c.oraclePusher,
          prices: {},
          pendingPrices: {},
          feedAliases,
          maxStalenessSeconds: c.maxStalenessSeconds,
          liquidationMaxStalenessSeconds: c.liquidationMaxStalenessSeconds,
          maxDeviationBps: c.maxDeviationBps,
          allowManualPrice: false,
        },
      } },
    ], [POOL_OPERATOR]);
    let oracleCid = extractContractId(createRes);
    if (!oracleCid) throw new Error('Fresh oracle create returned no contract id');

    // 2. Push each feed's live price through the FEEDER (Verify happens there now).
    //    RecordVerifiedPrice churns the oracle cid → chain it. poolCid stays None for every
    //    push here: the pool is repointed ONCE in step 3, because FIND-014 rejects a retarget
    //    until the fresh oracle carries a price for every configured feed.
    const pushed = [];
    for (const f of feeds) {
      const report = await fetchSignedReport(f.rawFeedId);
      const upd = await submitCommand([
        { ExerciseCommand: {
          templateId: FEEDER_TEMPLATE, contractId: feederCid,
          choice: 'PushVerifiedPrice',
          choiceArgument: { oracleCid, signedReportBytes: report.fullReport, poolCid: null },
        } },
      ], [process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR]);
      oracleCid = extractContractId(upd);
      pushed.push({ label: f.label, storedFeedId: report.feedId, price: report.decoded?.price });
    }

    // 3. Repoint the pool ONCE, now that the fresh oracle carries a price for every feed.
    const poolsNow = await queryContracts(POOL_TID, POOL_OPERATOR);
    const poolNow = poolsNow[poolsNow.length - 1];
    const rep = await submitCommand([
      { ExerciseCommand: {
        templateId: POOL_TID, contractId: poolNow.contractId,
        choice: 'UpdateOracleCid', choiceArgument: { newOracleCid: oracleCid },
      } },
    ], [POOL_OPERATOR]);
    const newPoolCid = extractContractId(rep);

    console.log(`RebuildOracle: fresh oracle=${oracleCid} (allowManualPrice=false), pool=${newPoolCid}`);
    res.json({ success: true, newOracleCid: oracleCid, newPoolCid, allowManualPrice: false, feedAliases, pushed });
  } catch (e) {
    console.error('REBUILD ORACLE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ---- Continuous oracle push loop (the oracle bot) --------------------------
 * Pushes each configured feed on an interval. Off by default; start it via the endpoint
 * AFTER the verifier is pinned + feeds registered (else every cycle aborts "no pinned verifier").
 * A "not newer than stored price" abort is a benign skip (the feed hasn't published a newer report). */
// TESTNET Data Streams feed ids (differ from mainnet). The mainnet ids return "report not found"
// against the testnet host — see chainlink-byo-verifier notes.
const DEFAULT_FEEDS = {
  'cc-feed': '0x00031de3179f870b857f273a3496c5a76795aec28f984f243b51fd8aaf759c55',
  'usdcx-feed': '0x0003dc85e8b01946bf9dfd8b0db860129181eb6105a8c8981d9f28e00b6f60d9',
};
const oraclePush = { enabled: false, intervalMs: 120000, feeds: Object.values(DEFAULT_FEEDS), timer: null, last: {}, running: false };

async function runOraclePushCycle() {
  if (oraclePush.running) return; // don't overlap cycles
  oraclePush.running = true;
  try {
    for (const feedId of oraclePush.feeds) {
      try {
        const out = await pushFeed(feedId);
        oraclePush.last[feedId] = { ok: true, price: out.decodedPrice, at: new Date().toISOString() };
        console.log(`[oracle-loop] ${feedId} -> ${out.decodedPrice}`);
      } catch (e) {
        const benign = /not newer than the stored price/i.test(e.message);
        oraclePush.last[feedId] = { ok: benign, skipped: benign, error: e.message, at: new Date().toISOString() };
        console.warn(`[oracle-loop] ${feedId} ${benign ? 'skip (no newer report)' : 'FAILED: ' + e.message}`);
      }
    }
  } finally {
    oraclePush.running = false;
  }
}

function startOraclePush(intervalMs, feeds) {
  if (oraclePush.timer) clearInterval(oraclePush.timer);
  if (intervalMs) oraclePush.intervalMs = intervalMs;
  if (Array.isArray(feeds) && feeds.length) oraclePush.feeds = feeds;
  oraclePush.enabled = true;
  runOraclePushCycle();
  oraclePush.timer = setInterval(runOraclePushCycle, oraclePush.intervalMs);
}
function stopOraclePush() {
  if (oraclePush.timer) clearInterval(oraclePush.timer);
  oraclePush.timer = null;
  oraclePush.enabled = false;
}

app.post('/admin/oracle-push/start', (req, res) => {
  const { intervalMs, feeds } = req.body || {};
  startOraclePush(intervalMs, feeds);
  res.json({ success: true, enabled: true, intervalMs: oraclePush.intervalMs, feeds: oraclePush.feeds });
});
app.post('/admin/oracle-push/stop', (req, res) => {
  stopOraclePush();
  res.json({ success: true, enabled: false });
});
app.get('/admin/oracle-push/status', (req, res) => {
  res.json({ success: true, enabled: oraclePush.enabled, intervalMs: oraclePush.intervalMs, feeds: oraclePush.feeds, last: oraclePush.last });
});

// ── RA-14 batch migration ────────────────────────────────────────────────────
// MigrationBatcher exists so N snapshots cost ONE poolOperator ceremony instead of N.
// It is a separate template (not a choice on LendingPool) for two reasons: Migration imports
// Pool for PoolAccess, so a choice there is an import cycle; and the pool cid churns on every
// oracle retarget, whereas the batcher is nonconsuming and its cid never rotates.
//
// BatchCreateMigrationSnapshots is TIME-INDEPENDENT by construction (no getTime; expiresAt is
// an argument), so it gets Canton's ~24h preparation-time tolerance — a relaxed two-box
// ceremony even with hundreds of entries.
const BATCHER_TEMPLATE = `#alpend-lending:Lending.Migration:MigrationBatcher`;

app.get('/admin/batcher', async (_req, res) => {
  try {
    const cs = targetFilter(await queryContracts(BATCHER_TEMPLATE, READ_PARTY));
    res.json({ success: true, count: cs.length, batcherCid: cs[cs.length - 1]?.contractId || null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


// ══════════════════════════════════════════════════════════════════════════════
// GOV-01 — governance proposals (DecMan confirms/executes) + approval redemption
// ══════════════════════════════════════════════════════════════════════════════
//
// Division of labour, and WHY it is split this way:
//   * We create the proposal here (any party may be `proposer`; it is the proposal's only
//     signatory). DecMan cannot build arbitrary contracts — its POST /contracts takes only a
//     fixed governance vocabulary — so the proposal has to originate from a real ledger client.
//   * The COMMITTEE confirms and executes it in the DecMan UI. We cannot do that half: we hold no
//     key for the governance party, by design.
//   * Execution of a risk-bearing action does NOT hit the pool directly — it mints an *Approval*
//     (see Alpend.Governance.Approvals). The operator then redeems that approval here, supplying
//     cids that are fresh at submit time. Proposals expire in 24h (DecMan ACTION TIMEOUT 1.0 d)
//     while approvals live 7 days, so a vote is never lost to cid churn.
const GOV_ACTIONS_PKG = process.env.GOV_ACTIONS_PACKAGE || '#alpend-governance-actions';
const GOV_PROPOSER = process.env.GOV_PROPOSER_PARTY || POOL_OPERATOR;

const PROPOSAL_TEMPLATES = {
  SetPauseFlags:            'Alpend.Governance.Actions:SetPauseFlagsProposal',
  UpdateOraclePusher:       'Alpend.Governance.Actions:UpdateOraclePusherProposal',
  UpdateTreasuryParty:      'Alpend.Governance.Actions:UpdateTreasuryPartyProposal',
  UpdateGovernanceParty:    'Alpend.Governance.Actions:UpdateGovernancePartyProposal',
  AddAssetReserve:          'Alpend.Governance.Actions:AddAssetReserveProposal',
  WriteOffBadDebt:          'Alpend.Governance.Actions:WriteOffBadDebtProposal',
  UpdateRiskParams:         'Alpend.Governance.Actions:UpdateRiskParamsProposal',
  UpdateInterestRateParams: 'Alpend.Governance.Actions:UpdateInterestRateParamsProposal',
  UpdateTransferFactory:    'Alpend.Governance.Actions:UpdateTransferFactoryProposal',
  UpdateReserveGovernance:  'Alpend.Governance.Actions:UpdateReserveGovernanceProposal',
  RegisterFeed:             'Alpend.Governance.Actions:RegisterFeedProposal',
  SetPrice:                 'Alpend.Governance.Actions:SetPriceProposal',
  RotateOraclePusher:       'Alpend.Governance.Actions:RotateOraclePusherProposal',
  UpdateOracleGovernance:   'Alpend.Governance.Actions:UpdateOracleGovernanceProposal',
};

const APPROVAL_REDEEM = {
  AddAssetReserveApproval:      'RedeemAddAssetReserve',
  WriteOffBadDebtApproval:      'RedeemWriteOffBadDebt',
  RiskParamsApproval:           'RedeemRiskParams',
  InterestRateParamsApproval:   'RedeemInterestRateParams',
  TransferFactoryApproval:      'RedeemTransferFactory',
  ReserveGovernanceApproval:    'RedeemReserveGovernance',
  RegisterFeedApproval:         'RedeemRegisterFeed',
  SetPriceApproval:             'RedeemSetPrice',
  RotateOraclePusherApproval:   'RedeemRotateOraclePusher',
  OracleGovernanceApproval:     'RedeemOracleGovernance',
};

/** GET /admin/gov/actions — what can be proposed, and the current governance party. */
app.get('/admin/gov/actions', (_req, res) => {
  res.json({
    success: true,
    governanceParty: GOVERNANCE_PARTY || null,
    proposer: GOV_PROPOSER,
    actions: Object.keys(PROPOSAL_TEMPLATES),
    approvals: Object.keys(APPROVAL_REDEEM),
  });
});

/** POST /admin/gov/propose — create a GovernableAction proposal for the committee to confirm.
 *  Body: { action: 'SetPauseFlags', args: { ... } }
 *  `governanceParty`, `proposer` and `poolOperator` are filled in automatically. */
app.post('/admin/gov/propose', async (req, res) => {
  try {
    const { action, args = {} } = req.body || {};
    const entity = PROPOSAL_TEMPLATES[action];
    if (!entity) {
      return res.status(400).json({ success: false,
        error: `Unknown action '${action}'. Known: ${Object.keys(PROPOSAL_TEMPLATES).join(', ')}` });
    }
    if (!GOVERNANCE_PARTY) {
      return res.status(400).json({ success: false,
        error: 'GOVERNANCE_PARTY is not set — this deployment has no committee to propose to.' });
    }
    const templateId = `${GOV_ACTIONS_PKG}:${entity}`;
    const createArguments = {
      governanceParty: GOVERNANCE_PARTY,
      proposer: GOV_PROPOSER,
      // Only the two-phase proposals carry poolOperator (it becomes the approval's redeemer);
      // the direct ones ignore an extra field, so send it only when the caller did not.
      ...(entity.includes('SetPauseFlagsProposal') || entity.includes('UpdateOraclePusherProposal')
          || entity.includes('UpdateTreasuryPartyProposal') || entity.includes('UpdateGovernancePartyProposal')
          ? {} : { poolOperator: DECPARTY_OPERATOR || POOL_OPERATOR }),
      ...args,
    };
    // The proposal's ONLY signatory is the proposer, so this is a plain single-sig submit — no
    // ceremony, even when poolOperator is a multisig.
    const result = await submitCommand([{ CreateCommand: { templateId, createArguments } }], [GOV_PROPOSER]);
    res.json({
      success: true, action, templateId,
      proposalCid: extractContractId(result),
      updateId: result.transaction?.updateId,
      next: 'Confirm it in the DecMan UI (both members), then execute. NOTE: DecMan ACTION TIMEOUT is 1 day.',
    });
  } catch (e) {
    console.error('GOV PROPOSE error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/gov/approvals — live approvals awaiting operator redemption. */
app.get('/admin/gov/approvals', async (_req, res) => {
  try {
    const out = [];
    for (const name of Object.keys(APPROVAL_REDEEM)) {
      const tid = `${GOV_ACTIONS_PKG}:Alpend.Governance.Approvals:${name}`;
      try {
        const cs = targetFilter(await queryContracts(tid, READ_PARTY));
        for (const c of cs) out.push({ approval: name, contractId: c.contractId, payload: c.payload ?? c.createArgument });
      } catch { /* template absent from this deployment — skip */ }
    }
    res.json({ success: true, count: out.length, approvals: out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/gov/redeem — operator redeems a committee approval with FRESH cids.
 *  Body: { approval: 'RiskParamsApproval', approvalCid, args: { reserveCid } } */
app.post('/admin/gov/redeem', async (req, res) => {
  try {
    const { approval, approvalCid, args = {} } = req.body || {};
    const choice = APPROVAL_REDEEM[approval];
    if (!choice) {
      return res.status(400).json({ success: false,
        error: `Unknown approval '${approval}'. Known: ${Object.keys(APPROVAL_REDEEM).join(', ')}` });
    }
    if (!approvalCid) return res.status(400).json({ success: false, error: 'approvalCid is required' });
    const commands = [{ ExerciseCommand: {
      templateId: `${GOV_ACTIONS_PKG}:Alpend.Governance.Approvals:${approval}`,
      contractId: approvalCid,
      choice,
      choiceArgument: args,
    } }];
    // Redemption is controlled by poolOperator, so it goes through the normal ceremony path.
    return await operatorAction(res, commands, null, { step: `${choice}` });
  } catch (e) {
    console.error('GOV REDEEM error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/create-batcher — genesis the MigrationBatcher (once per deployment). */
app.post('/admin/create-batcher', async (_req, res) => {
  try {
    return await operatorAction(res, [{ CreateCommand: {
      templateId: BATCHER_TEMPLATE,
      createArguments: { poolOperator: DECPARTY_OPERATOR || POOL_OPERATOR },
    } }], BATCHER_TEMPLATE, { step: 'MigrationBatcher' });
  } catch (e) {
    console.error('CREATE BATCHER error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/batch-create-snapshots — ONE ceremony, N MigrationSnapshots.
 *  Body: { entries: [{ user, collaterals:[{instrumentIdId, realizedPrincipal, isUsedAsCollateral?}],
 *                      borrows:[{instrumentIdId, realizedDebt}] }], expiresInDays? }
 *
 *  Asset ids are resolved to full instrumentIds from the LIVE reserves, so a typo fails here
 *  rather than producing a snapshot nobody can accept. */
app.post('/admin/batch-create-snapshots', async (req, res) => {
  try {
    const { entries, expiresInDays = 7 } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ success: false, error: 'entries[] required' });
    }
    let batcherCid = req.body.batcherCid;
    if (!batcherCid) {
      const cs = targetFilter(await queryContracts(BATCHER_TEMPLATE, READ_PARTY));
      batcherCid = cs[cs.length - 1]?.contractId;
    }
    if (!batcherCid) return res.status(400).json({ success: false, error: 'no MigrationBatcher — POST /admin/create-batcher first' });

    const reserves = targetFilter(await queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, READ_PARTY));
    const instrById = {};
    for (const r of reserves) {
      const iid = r.createArgument?.instrumentId;
      if (iid?.id) instrById[iid.id] = { admin: iid.admin, id: iid.id };
    }
    const resolve = (id) => {
      if (!instrById[id]) throw new Error(`No reserve for "${id}". Available: ${Object.keys(instrById).join(', ') || '(none)'}`);
      return instrById[id];
    };

    const migrationEntries = entries.map((e) => ({
      user: e.user,
      collaterals: (e.collaterals || []).map((c) => ({
        instrumentId: resolve(c.instrumentIdId),
        realizedPrincipal: String(c.realizedPrincipal),
        isUsedAsCollateral: c.isUsedAsCollateral ?? true,
      })),
      borrows: (e.borrows || []).map((b) => ({
        instrumentId: resolve(b.instrumentIdId),
        realizedDebt: String(b.realizedDebt),
      })),
    }));
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();

    return await operatorAction(res, [{ ExerciseCommand: {
      templateId: BATCHER_TEMPLATE, contractId: batcherCid,
      choice: 'BatchCreateMigrationSnapshots',
      choiceArgument: { entries: migrationEntries, expiresAt },
    } }], `#alpend-lending:Lending.Migration:MigrationSnapshot`,
      { step: `BatchCreateMigrationSnapshots ×${migrationEntries.length}`, expiresAt, batcherCid,
        users: migrationEntries.map((e) => e.user.slice(0, 24) + '…'),
        timing: 'time-INDEPENDENT (no getTime) — relaxed ~24h ceremony window' });
  } catch (e) {
    console.error('BATCH SNAPSHOTS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/create-migration-snapshot — operator prepares a per-user MigrationSnapshot from
 *  (mock or real) legacy data. Operator-signed, user-observer; the user later accepts it with one
 *  Loop signature (MigrationAccept). No tokens move — the treasury already holds them.
 *  Body: { user, collaterals:[{instrumentIdId, realizedPrincipal, isUsedAsCollateral?}],
 *          borrows:[{instrumentIdId, realizedDebt}], expiresInDays? }. */
app.post('/admin/create-migration-snapshot', async (req, res) => {
  try {
    const { user, collaterals = [], borrows = [], expiresInDays = 90, allowExistingRegistry = false } = req.body;
    if (!user) return res.status(400).json({ success: false, error: 'user party is required' });
    if (collaterals.length === 0 && borrows.length === 0) {
      return res.status(400).json({ success: false, error: 'need at least one collateral or borrow entry' });
    }

    // NEW-03 (MANDATORY backend invariant): the DAR cannot enforce one-registry-per-user
    // (UserPosition is keyless by design), so MigrationAccept would happily create a SECOND
    // registry. A non-canonical duplicate causes CID-mismatch failures for that user forever.
    // Refuse to issue a snapshot for anyone who already has a UserPosition — whether from a
    // prior migration or InitializeUserPosition. See Lending/Migration.daml NEW-03.
    if (!allowExistingRegistry) {
      const existing = await queryContracts(`#alpend-lending:Lending.UserPosition:UserPosition`, POOL_OPERATOR);
      const mine = existing.filter((u) => u.createArgument?.user === user);
      if (mine.length > 0) {
        return res.status(409).json({
          success: false,
          error: `Refusing to snapshot: user already has ${mine.length} UserPosition registry (${mine.map((m) => m.contractId.slice(0, 16)).join(', ')}). ` +
            `Accepting would create a SECOND registry (NEW-03). Resolve the existing registry first.`,
        });
      }
    }

    // Resolve each asset's full instrumentId (admin + id) from the live reserves.
    const reserves = await queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, POOL_OPERATOR);
    const instrById = {};
    for (const r of reserves) {
      const iid = r.createArgument?.instrumentId;
      if (iid?.id) instrById[iid.id] = iid;
    }
    const resolve = (instrumentIdId) => {
      const iid = instrById[instrumentIdId];
      if (!iid) throw new Error(`No reserve/instrument found for "${instrumentIdId}"`);
      return { admin: iid.admin, id: iid.id };
    };

    const snapCollaterals = collaterals.map((c) => ({
      instrumentId: resolve(c.instrumentIdId),
      realizedPrincipal: String(c.realizedPrincipal),
      isUsedAsCollateral: c.isUsedAsCollateral ?? true,
    }));
    const snapBorrows = borrows.map((b) => ({
      instrumentId: resolve(b.instrumentIdId),
      realizedDebt: String(b.realizedDebt),
    }));
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();

    const result = await submitCommand([
      {
        CreateCommand: {
          templateId: `#alpend-lending:Lending.Migration:MigrationSnapshot`,
          createArguments: {
            poolOperator: DECPARTY_OPERATOR || POOL_OPERATOR,
            user,
            collaterals: snapCollaterals,
            borrows: snapBorrows,
            expiresAt,
          },
        },
      },
    ], [POOL_OPERATOR]);

    const snapshotCid = extractContractId(result);
    console.log(`MigrationSnapshot created for ${user.slice(0, 16)}: ${snapshotCid}`);
    res.json({
      success: true,
      snapshotCid,
      user,
      collaterals: snapCollaterals,
      borrows: snapBorrows,
      expiresAt,
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('CREATE MIGRATION SNAPSHOT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/cancel-migration-snapshot — operator cancels/cleans a snapshot (MigrationCancel).
 *  Body: { snapshotCid }. */
app.post('/admin/cancel-migration-snapshot', async (req, res) => {
  try {
    const { snapshotCid } = req.body;
    if (!snapshotCid) return res.status(400).json({ success: false, error: 'snapshotCid is required' });
    await submitCommand([
      {
        ExerciseCommand: {
          templateId: `#alpend-lending:Lending.Migration:MigrationSnapshot`,
          contractId: snapshotCid,
          choice: 'MigrationCancel',
          choiceArgument: {},
        },
      },
    ], [POOL_OPERATOR]);
    res.json({ success: true, cancelled: snapshotCid });
  } catch (e) {
    console.error('CANCEL MIGRATION SNAPSHOT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/migration-snapshot/:party — return the (unaccepted) MigrationSnapshot for a user,
 *  so the frontend can show the accept prompt. */
app.get('/admin/migration-snapshot/:party', async (req, res) => {
  try {
    // Read as READ_PARTY (the deployment's poolOperator): MigrationSnapshot is
    // `signatory poolOperator, observer user`, so the submitting/pusher key is NOT a
    // stakeholder and querying as it silently returns nothing.
    const snaps = targetFilter(await queryContracts(`#alpend-lending:Lending.Migration:MigrationSnapshot`, READ_PARTY));
    const party = decodeURIComponent(req.params.party);
    const mine = snaps.filter((c) => c.createArgument?.user === party);
    res.json({
      success: true,
      count: mine.length,
      snapshots: mine.map((c) => ({
        contractId: c.contractId,
        // Keep the raw payload: MigrationBanner reads snapshot.createArgument directly.
        createArgument: c.createArgument,
        expiresAt: c.createArgument?.expiresAt,
        collaterals: (c.createArgument?.collaterals || []).map((x) => ({
          id: x.instrumentId?.id, realizedPrincipal: x.realizedPrincipal, isUsedAsCollateral: x.isUsedAsCollateral })),
        borrows: (c.createArgument?.borrows || []).map((x) => ({
          id: x.instrumentId?.id, realizedDebt: x.realizedDebt })),
      })),
    });
  } catch (e) {
    console.error('QUERY MIGRATION SNAPSHOT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /user/accept-migration — exercise MigrationAccept as the USER.
 *  Body: { user, snapshotCid? } (snapshot resolved if omitted)
 *
 *  Two things the DAR requires that are easy to miss:
 *   1. reserveCids must cover EVERY instrument in the snapshot, else it aborts
 *      "Migration: no reserve supplied for instrument …". Passing extras is harmless, a
 *      subset is not — so we pass them all.
 *   2. The reserves must be DISCLOSED. AssetReserve is `signatory poolOperator` with no
 *      observer, so the accepting user is not a stakeholder and the submit otherwise fails
 *      CONTRACT_NOT_FOUND on a cid that plainly exists.
 *  Reserve cids also ROTATE on every accept (RecordDeposit is consuming), so they are
 *  re-resolved live here rather than cached. */
app.post('/user/accept-migration', async (req, res) => {
  try {
    const { user } = req.body;
    if (!user) return res.status(400).json({ success: false, error: 'user required' });

    let snapshotCid = req.body.snapshotCid;
    if (!snapshotCid) {
      const snaps = targetFilter(await queryContracts(`#alpend-lending:Lending.Migration:MigrationSnapshot`, READ_PARTY))
        .filter((c) => c.createArgument?.user === user);
      snapshotCid = snaps[snaps.length - 1]?.contractId;
    }
    if (!snapshotCid) return res.status(400).json({ success: false, error: `no MigrationSnapshot for ${user}` });

    const accResp = targetFilter(await queryContracts(`#alpend-lending:Lending.Pool:PoolAccess`, READ_PARTY))
      .filter((c) => c.createArgument?.user === user);
    const poolAccessCid = req.body.poolAccessCid
      || accResp.find((c) => c.createArgument?.registryInitialized === false)?.contractId;
    if (!poolAccessCid) return res.status(400).json({ success: false, error: `no unused PoolAccess for ${user} — grant access first (RA-07)` });

    const reserves = targetFilter(await queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, READ_PARTY));
    const reserveCids = reserves.map((r) => r.contractId);
    const disclosed = reserves
      .filter((r) => r.createdEventBlob)
      .map((r) => ({
        contractId: r.contractId,
        createdEventBlob: r.createdEventBlob,
        synchronizerId: process.env.SYNCHRONIZER_ID,
        ...(r.templateId ? { templateId: r.templateId } : {}),
      }));

    const result = await submitCommand([{ ExerciseCommand: {
      templateId: `#alpend-lending:Lending.Migration:MigrationSnapshot`,
      contractId: snapshotCid, choice: 'MigrationAccept',
      choiceArgument: { reserveCids, poolAccessCid },
    } }], [user], disclosed);

    res.json({
      success: true, user, snapshotCid, poolAccessCid,
      reserveCids: reserveCids.length, disclosed: disclosed.length,
      updateId: result.transaction?.updateId || result.updateId,
    });
  } catch (e) {
    console.error('ACCEPT MIGRATION error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/solvency — protocol invariant sweep. For each reserve, checks the four core
 *  accounting invariants against the CURRENT ledger state (which already reflects the full
 *  history of supplies/borrows/liquidations/write-off/unification/revenue). Any FAIL is a real
 *  accounting/DAR bug. Tolerance absorbs sub-dust Decimal rounding. */
app.get('/admin/solvency', async (req, res) => {
  try {
    const P = `#alpend-lending:Lending.`;
    const [reserveC, depositC, borrowC, holdingC] = await Promise.all([
      queryContracts(`${P}AssetReserve:AssetReserve`, READ_PARTY),
      queryContracts(`${P}Deposit:DepositPosition`, READ_PARTY),
      queryContracts(`${P}Borrow:BorrowPosition`, READ_PARTY),
      // Pool's real token holdings are owned by the DEPLOYMENT's poolOperator (READ_PARTY), not the
      // legacy single-key party — else I1 (real tokens cover suppliers) checks the wrong party's balance.
      queryContractsByInterface(HOLDING_INTERFACE, READ_PARTY).catch(() => []),
    ]);

    const num = (x) => parseFloat(x || '0') || 0;
    const holdingAmt = (c) =>
      num(c.createArgument?.amount?.initialAmount ?? c.interfaceViews?.[0]?.viewValue?.amount ?? c.createArgument?.amount);
    const holdingInstr = (c) =>
      c.createArgument?.instrumentId?.id ?? c.interfaceViews?.[0]?.viewValue?.instrumentId?.id;

    // sum the operator's real on-ledger holdings per instrument
    const realHoldingsByInstr = {};
    for (const c of holdingC) {
      const id = holdingInstr(c);
      if (id) realHoldingsByInstr[id] = (realHoldingsByInstr[id] || 0) + holdingAmt(c);
    }

    // ok within relative + absolute tolerance
    const close = (a, b) => Math.abs(a - b) <= 1e-6 + 1e-8 * Math.max(Math.abs(a), Math.abs(b));
    const geTol = (a, b) => a >= b - (1e-6 + 1e-8 * Math.max(Math.abs(a), Math.abs(b)));

    const reserves = [];
    let allPass = true;
    for (const r of reserveC) {
      const a = r.createArgument || {};
      const id = a.instrumentId?.id;
      if (!id) continue;
      const liqIdx = num(a.liquidityIndex) || 1;
      const borIdx = num(a.variableBorrowIndex) || 1;
      const totalLiquidity = num(a.totalLiquidity);
      const scaledSupplied = num(a.scaledTotalSupplied);
      const scaledBorrowed = num(a.scaledTotalBorrowed);

      const suppliersOwed = scaledSupplied * liqIdx;
      const outstandingDebt = scaledBorrowed * borIdx;
      const realHoldings = realHoldingsByInstr[id] || 0;
      const realPoolEntitled = realHoldings + outstandingDebt;

      // Σ accrued value of every deposit / borrow of this asset
      let sumDeposits = 0;
      for (const d of depositC) {
        const da = d.createArgument || {};
        if (da.instrumentId?.id !== id) continue;
        sumDeposits += num(da.principal) * (liqIdx / (num(da.liquidityIndex) || 1));
      }
      let sumBorrows = 0;
      for (const b of borrowC) {
        const ba = b.createArgument || {};
        if (ba.instrumentId?.id !== id) continue;
        sumBorrows += num(ba.borrowedAmount) * (borIdx / (num(ba.borrowIndex) || 1));
      }

      const checks = {
        // I1 — real solvency: real tokens + outstanding debt cover what suppliers are owed
        realSolvency: { pass: geTol(realPoolEntitled, suppliersOwed), realPoolEntitled, suppliersOwed, margin: realPoolEntitled - suppliersOwed },
        // I2 — supply consistency: Σ accrued deposits == scaledTotalSupplied × liquidityIndex
        supplyConsistency: { pass: close(sumDeposits, suppliersOwed), sumDeposits, suppliersOwed, drift: sumDeposits - suppliersOwed },
        // I3 — borrow consistency: Σ accrued borrows == scaledTotalBorrowed × variableBorrowIndex
        borrowConsistency: { pass: close(sumBorrows, outstandingDebt), sumBorrows, outstandingDebt, drift: sumBorrows - outstandingDebt },
        // I4 — books vs reality: reserve.totalLiquidity == real on-ledger holdings
        booksVsReality: { pass: close(totalLiquidity, realHoldings), totalLiquidity, realHoldings, gap: totalLiquidity - realHoldings },
      };
      const pass = Object.values(checks).every((c) => c.pass);
      if (!pass) allPass = false;
      reserves.push({ instrument: id, pass, checks });
    }

    res.json({ success: true, allPass, reserves });
  } catch (e) {
    console.error('SOLVENCY error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** POST /admin/create-verifier — create OUR OWN Verifier instance (owner = poolOperator).
 *  Chainlink runs a "bring-your-own-Verifier" model: the Verifier template is stateless and holds
 *  no secrets (all security lives in the VerifierConfig, which Chainlink issues us as an observer),
 *  so they never grant observer access to their Verifier — every party stands up its own. `Verify`
 *  only does `fetch configCid` + reads the config's DON keys; it never checks that the Verifier and
 *  VerifierConfig share an owner, so our poolOperator-owned Verifier + Chainlink's VerifierConfig
 *  verifies fine. Pin the returned CID with set-verifier (paired with the Chainlink config CID). */
app.post('/admin/create-verifier', async (req, res) => {
  try {
    const commands = [
      {
        CreateCommand: {
          templateId: `#verifier:Verifier:Verifier`,
          createArguments: {
            owner: DECPARTY_OPERATOR || POOL_OPERATOR,
            // Load-bearing: the pusher exercises Verify on this contract, so it must be able to
            // see it. observers:[] gives CONTRACT_NOT_FOUND at push time.
            observers: [process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR],
          },
        },
      },
    ];
    return await operatorAction(res, commands, `#verifier:Verifier:Verifier`,
      { step: 'Verifier (ours)',
        next: 'POST /admin/create-feeder { verifierCid, verifierConfigCid, expectedConfigOwner } — pair ours with Chainlink\'s VerifierConfig.' });
  } catch (e) {
    console.error('CREATE VERIFIER error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/oracle-verifier-contracts — list the Verifier + VerifierConfig contracts our party
 *  can see. NOTE: we create our OWN Verifier (see create-verifier) — it shows up here as owner. The
 *  VerifierConfig is Chainlink's, visible because they granted POOL_OPERATOR observer access. If the
 *  config side is empty, that observer grant is missing (or the template name differs). */
app.get('/admin/oracle-verifier-contracts', async (req, res) => {
  try {
    // Chainlink's VerifierConfig is only visible to the party they granted observer access to,
    // so allow querying as an explicit party — the grant may not be on our current pusher.
    const asParty = req.query.party || POOL_OPERATOR;
    const [verifiers, configs] = await Promise.all([
      queryContracts(`#verifier:Verifier:Verifier`, asParty).catch((e) => ({ __err: e.message })),
      queryContracts(`#verifier-config:VerifierConfig:VerifierConfig`, asParty).catch((e) => ({ __err: e.message })),
    ]);
    // Surface which config digests each VerifierConfig actually holds. `Verifier.Verify` looks the
    // report's configDigest up in `verifierConfigStateView.verifierStates`; a digest missing here is
    // the `DigestNotSet` abort (the DON config Chainlink populated doesn't cover our feeds' reports).
    // `verifierStates : Map BytesHex VerifierConfigDigest` — DA.Map serializes as an array of
    // [keyHex, valueObj] pairs (NOT a JSON object like TextMap), so read element [0] of each pair.
    const configDetail = Array.isArray(configs)
      ? configs.map((c) => {
          const raw = c.createArgument?.verifierConfigStateView?.verifierStates ?? [];
          const entries = Array.isArray(raw)
            ? raw.map((pair) => ({ digest: pair[0], state: pair[1] }))
            : Object.entries(raw).map(([digest, state]) => ({ digest, state }));
          return {
            contractId: c.contractId,
            // ChainlinkPriceFeeder.validateVerifierPair asserts
            // cfg.confirmedOwnerView.owner == expectedConfigOwner — this is that value,
            // i.e. exactly what to pass as expectedConfigOwner at feeder creation.
            confirmedOwner: c.createArgument?.confirmedOwnerView?.owner ?? null,
            digestCount: entries.length,
            digests: entries.map((e) => ({
              configDigest: e.digest,
              isActive: e.state?.isActive ?? null,
              f: e.state?.f ?? null,
            })),
          };
        })
      : configs;
    res.json({
      success: true,
      hint: 'verifiers = our own instance(s) from create-verifier. verifierConfigs = Chainlink-issued (needs their observer grant). `digests` = config digests the config covers; a report whose configDigest is absent fails UpdatePrice with DigestNotSet.',
      // observers matter: the oraclePusher MUST be able to see the Verifier it exercises
      // Verify on, or the push fails CONTRACT_NOT_FOUND.
      verifiers: Array.isArray(verifiers)
        ? verifiers.map((c) => ({
            contractId: c.contractId,
            owner: c.createArgument?.owner ?? null,
            observers: c.createArgument?.observers ?? [],
          }))
        : verifiers,
      verifierConfigs: configDetail,
    });
  } catch (e) {
    console.error('ORACLE VERIFIER CONTRACTS error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /admin/liquidatable — scan every UserPosition, compute HF off-chain, and return the
 *  ones with HF < 1 along with the borrower's private-position blobs (the operator-mediated
 *  disclosure a liquidator needs to see them). HF here is approximate — the DAR re-verifies
 *  HF<1 on-chain at liquidation time; this only surfaces candidates. */
app.get('/admin/liquidatable', async (req, res) => {
  try {
    const P = `#alpend-lending:Lending.`;
    const [poolC, reserveC, userPosC, depositC, borrowC, oracleC] = await Promise.all([
      queryContracts(`${P}Pool:LendingPool`, READ_PARTY),
      queryContracts(`${P}AssetReserve:AssetReserve`, READ_PARTY),
      queryContracts(`${P}UserPosition:UserPosition`, READ_PARTY),
      queryContracts(`${P}Deposit:DepositPosition`, READ_PARTY),
      queryContracts(`${P}Borrow:BorrowPosition`, READ_PARTY),
      queryContracts(`${P}Oracle:PriceOracle`, READ_PARTY),
    ]);

    const pool = poolC[poolC.length - 1];
    const oracle = oracleC[oracleC.length - 1];
    const prices = oracle?.createArgument?.prices || {}; // TextMap RAW feedId -> PriceData
    const feedAliases = oracle?.createArgument?.feedAliases || {}; // label (priceFeedId) -> raw feedId

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
        price: parseFloat(prices[feedAliases[feed] || feed]?.price || '0'),
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
    const templateId = `#alpend-lending:Lending.Pool:LendingPool`;
    const contracts = targetFilter(await queryContracts(templateId, READ_PARTY));
    res.json({ success: true, contracts });
  } catch (e) {
    console.error('QUERY LENDING POOL error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** GET /query/user-position/:party — query UserPosition (via pool operator who is observer) */
app.get('/query/user-position/:party', async (req, res) => {
  try {
    const templateId = `#alpend-lending:Lending.UserPosition:UserPosition`;
    // Query as the deployment's poolOperator (observer on UserPosition), then filter by party
    const contracts = await queryContracts(templateId, READ_PARTY);
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
    const templateId = `#alpend-lending:Lending.Deposit:DepositPosition`;
    const contracts = await queryContracts(templateId, READ_PARTY);
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
    const templateId = `#alpend-lending:Lending.Borrow:BorrowPosition`;
    const contracts = await queryContracts(templateId, READ_PARTY);
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
      queryContracts(`#alpend-lending:Lending.Pool:LendingPool`, READ_PARTY),
      queryContracts(`#alpend-lending:Lending.AssetReserve:AssetReserve`, READ_PARTY),
      queryContracts(`#alpend-lending:Lending.UserPosition:UserPosition`, READ_PARTY),
      queryContracts(`#alpend-lending:Lending.Oracle:PriceOracle`, READ_PARTY),
    ]);

    const disclosed = [];

    // Add all AssetReserves (they replace PoolState)
    for (const reserve of assetReserveContracts) {
      if (reserve?.contractId && reserve?.createdEventBlob) {
        disclosed.push({
          templateId: reserve.templateId || `#alpend-lending:Lending.AssetReserve:AssetReserve`,
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
        templateId: latestOracle.templateId || `#alpend-lending:Lending.Oracle:PriceOracle`,
        contractId: latestOracle.contractId,
        createdEventBlob: latestOracle.createdEventBlob,
        domainId: synchronizerId,
      });
    }

    // Add UserPosition for the specified party (latest). PRIVACY/CORRECTNESS: only ever the
    // requesting party's OWN registry — NEVER fall back to another user's UserPosition (that both
    // leaks a stranger's contract and hands them a foreign registry blob).
    if (party) {
      const userPos = userPosContracts.filter(c => c.createArgument?.user === party);
      const latestUserPos = userPos[userPos.length - 1];
      if (latestUserPos?.contractId && latestUserPos?.createdEventBlob) {
        disclosed.push({
          templateId: latestUserPos.templateId || `#alpend-lending:Lending.UserPosition:UserPosition`,
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
        templateId: latestPool.templateId || `#alpend-lending:Lending.Pool:LendingPool`,
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
          templateId: `#alpend-lending:Lending.Pool:LendingPool`,
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
// DEAD ENDPOINT. Its createArguments (instrumentAdmin / depositInterestRate / borrowInterestRate /
// collateralRatio / observers) belong to a LendingPool shape that no longer exists — the current
// template takes poolOperator/oraclePusher/treasuryParty/maintenanceOperator/oracleCid/
// assetReserveCids + four pause flags, and per-asset rates live on AssetReserve. Kept only so an
// old caller gets a clear message instead of an opaque Daml field error. Use:
//   POST /admin/create-pool           (LendingPool)
//   POST /admin/add-asset-reserve     (per-asset reserve + its rate curve)
app.post('/admin/create-usdcx-pool', async (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'create-usdcx-pool is obsolete — its fields do not exist on the current LendingPool. '
         + 'Use POST /admin/create-pool, then POST /admin/add-asset-reserve for USDCx.',
  });
  /* eslint-disable no-unreachable */
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
          templateId: `#alpend-lending:Lending.Pool:LendingPool`,
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
          templateId: `#alpend-lending:Lending.Pool:LendingPool`,
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
          templateId: `#alpend-lending:Lending.AssetReserve:AssetReserve`,
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
  const ceremonyReady = !!(DECPARTY_OPERATOR && SIGNER_FPS.length && LEDGER_USER_ID && process.env.SYNCHRONIZER_ID);
  res.json({
    status: 'ok',
    lendingPackageId: LENDING_PACKAGE_ID,
    parties: {
      submittingAs: POOL_OPERATOR,          // the single key this server signs with
      poolOperator: DECPARTY_OPERATOR || POOL_OPERATOR,  // signatory of pool/oracle/reserves
      oraclePusher: process.env.ORACLE_PUSHER_PARTY || POOL_OPERATOR,
      maintenanceOperator: process.env.MAINTENANCE_OPERATOR_PARTY || null,
      readAs: READ_PARTY,
    },
    ceremony: {
      required: !!DECPARTY_OPERATOR,        // true when poolOperator is an external multisig
      ready: ceremonyReady,
      signaturesRequired: SIGNER_FPS.length,
      signers: SIGNER_FPS,
      pending: ceremonies.size,
      missing: [
        !DECPARTY_OPERATOR && 'DECPARTY_OPERATOR/TARGET_POOL_OPERATOR',
        !SIGNER_FPS.length && 'SIGNER1_FP (at least one signer fingerprint)',
        !LEDGER_USER_ID && 'LEDGER_USER_ID/CLIENT_ID',
        !process.env.SYNCHRONIZER_ID && 'SYNCHRONIZER_ID',
      ].filter(Boolean),
    },
    oracle: {
      // With allowManualPrice=false the ONLY price path is the feeder, so these must be set.
      chainlinkConfigOwner: process.env.CHAINLINK_CONFIG_OWNER || null,
      configOwnerPinned: !!process.env.CHAINLINK_CONFIG_OWNER,
    },
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

  // Auto-resume the oracle price-push loop on boot when ORACLE_PUSH_AUTOSTART=true. The loop
  // lives in memory, so without this a redeploy — or a free-tier spin-down/wake — would silently
  // stop price pushes until someone manually hit /admin/oracle-push/start, and prices would go
  // stale (reads eventually abort). Off by default so a local dev server doesn't spin up a second
  // writer competing with the deployed one; set the env var only on the host that should push.
  if (process.env.ORACLE_PUSH_AUTOSTART === 'true') {
    console.log('[oracle-loop] auto-starting on boot (ORACLE_PUSH_AUTOSTART=true)');
    startOraclePush();
  }
});
