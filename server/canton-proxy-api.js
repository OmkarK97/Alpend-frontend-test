const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
    windowMs: 2 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

const SCAN_API = 'https://scan.sv-1.test.global.canton.network.digitalasset.com/api/scan';

// Cache for open rounds
let cachedRounds = null;
let lastRoundsFetch = 0;

// Cache for amulet rules
let cachedAmuletRules = null;
let lastAmuletRulesFetch = 0;

const CACHE_DURATION = 30 * 1000; // 30 seconds

// Open Mining Rounds endpoint
app.get('/api/open-rounds', async (req, res) => {
    try {
        const now = Date.now();
        
        if (cachedRounds && (now - lastRoundsFetch) < CACHE_DURATION) {
            return res.json(cachedRounds);
        }
        
        const response = await axios.post(`${SCAN_API}/v0/open-and-issuing-mining-rounds`, {
            cached_open_mining_round_contract_ids: [],
            cached_issuing_round_contract_ids: []
        });
        
        const rounds = response.data.open_mining_rounds;
        const sorted = Object.entries(rounds)
            .map(([key, value]) => ({
                round: value.contract.payload.round.number,
                opensAt: value.contract.payload.opensAt,
                cid: value.contract.contract_id,
                blob: value.contract.created_event_blob,
                templateId: value.contract.template_id
            }))
            .sort((a, b) => Number(a.round) - Number(b.round));
        
        cachedRounds = sorted[0];
        lastRoundsFetch = now;
        
        res.json(cachedRounds);
    } catch (error) {
        console.error('Open rounds error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Amulet Rules endpoint
app.get('/api/amulet-rules', async (req, res) => {
    try {
        const now = Date.now();
        
        if (cachedAmuletRules && (now - lastAmuletRulesFetch) < CACHE_DURATION) {
            return res.json(cachedAmuletRules);
        }
        
        const response = await axios.post(`${SCAN_API}/v0/amulet-rules`, {});
        
        const contract = response.data.amulet_rules_update.contract;
        
        cachedAmuletRules = {
            cid: contract.contract_id,
            blob: contract.created_event_blob,
            templateId: contract.template_id,
            dso: contract.payload.dso,
            configSchedule: contract.payload.configSchedule
        };
        lastAmuletRulesFetch = now;
        
        res.json(cachedAmuletRules);
    } catch (error) {
        console.error('Amulet rules error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Full amulet rules response (if needed)
app.get('/api/amulet-rules/full', async (req, res) => {
    try {
        const response = await axios.post(`${SCAN_API}/v0/amulet-rules`, {});
        res.json(response.data);
    } catch (error) {
        console.error('Amulet rules full error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Transfer Factory endpoint — returns factoryId, choiceContext, and disclosedContracts (including ExternalPartyConfigState)
const SCAN_REGISTRY = 'https://scan.sv-1.test.global.canton.network.digitalasset.com/registry';
app.post('/api/transfer-factory', async (req, res) => {
    try {
        const response = await axios.post(`${SCAN_REGISTRY}/transfer-instruction/v1/transfer-factory`, req.body || {});
        console.log('Transfer factory response keys:', Object.keys(response.data));
        res.json(response.data);
    } catch (error) {
        console.error('Transfer factory error:', error.response?.status, error.response?.data || error.message);
        res.status(error.response?.status || 500).json({ error: error.response?.data || error.message });
    }
});

// Generic proxy endpoint
app.post('/api/proxy', async (req, res) => {
    try {
        const { endpoint, data } = req.body;
        const response = await axios.post(`${SCAN_API}${endpoint}`, data);
        res.json(response.data);
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        cachedRounds: !!cachedRounds,
        cachedAmuletRules: !!cachedAmuletRules
    });
});

app.listen(4000, '0.0.0.0', () => {
    console.log('Canton Proxy running on port 4000');
    console.log('Endpoints:');
    console.log('  GET  /api/open-rounds     - Latest open mining round');
    console.log('  GET  /api/amulet-rules    - Amulet rules (cid + blob)');
    console.log('  GET  /api/amulet-rules/full - Full amulet rules response');
    console.log('  POST /api/proxy           - Generic scan API proxy');
    console.log('  GET  /health              - Health check');
});
