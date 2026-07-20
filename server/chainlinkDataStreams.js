// Chainlink Data Streams client — fetches the RAW signed report (fullReport hex) for a feed.
// Ported from alpend-backend.only-calculations/services/chainlinkService.js (ESM).
// UpdatePrice on the DAR verifies + decodes the raw report on-chain, so we pass fullReport
// straight through (unlike the old off-chain path which decoded the price client-side).
import crypto from 'crypto';
import https from 'https';

function getConfig() {
  return {
    apiUrl: process.env.CHAINLINK_ENDPOINT || 'https://api.dataengine.chain.link',
    clientId: process.env.CHAINLINK_API_KEY,
    clientSecret: process.env.CHAINLINK_USER_SECRET,
  };
}

// HMAC-SHA256 auth per Chainlink Data Streams: sign "METHOD PATH bodyHash clientId timestamp".
function generateHmac(method, path, clientId, clientSecret, timestamp) {
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const strToSign = `${method} ${path} ${bodyHash} ${clientId} ${timestamp}`;
  return crypto.createHmac('sha256', clientSecret).update(strToSign).digest('hex');
}

// Decode a V3 fullReport just for logging/sanity (price + observation time). The on-chain
// UpdatePrice does the authoritative verify+decode; this is not trusted for the ledger.
function decodeV3(fullReport) {
  const hex = fullReport.startsWith('0x') ? fullReport.slice(2) : fullReport;
  const reportDataOffset = parseInt(hex.slice(192, 256), 16) * 2;
  const reportData = hex.slice(reportDataOffset + 64);
  const observationsTs = BigInt('0x' + reportData.slice(128, 192));
  const benchmarkPrice = BigInt('0x' + reportData.slice(384, 448));
  return { price: Number(benchmarkPrice) / 1e18, observationsTimestamp: Number(observationsTs) };
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Failed to parse Data Streams response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Data Streams request timed out')); });
  });
}

/** Fetch the latest signed report for a feed id. Returns the RAW fullReport hex (for UpdatePrice)
 *  plus a client-side decoded {price, observationsTimestamp} for logging. */
export async function fetchSignedReport(feedId) {
  const { apiUrl, clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) {
    throw new Error('CHAINLINK_API_KEY and CHAINLINK_USER_SECRET must be set in server/.env');
  }
  const path = `/api/v1/reports/latest?feedID=${feedId}`;
  const timestamp = Date.now();
  const hmac = generateHmac('GET', path, clientId, clientSecret, timestamp);

  const data = await httpsGet(`${apiUrl}${path}`, {
    Authorization: clientId,
    'X-Authorization-Timestamp': String(timestamp),
    'X-Authorization-Signature-SHA256': hmac,
  });

  const report = data?.report;
  if (!report?.fullReport) throw new Error(`No fullReport returned for feed ${feedId}: ${JSON.stringify(data).slice(0, 200)}`);

  let decoded = null;
  try { decoded = decodeV3(report.fullReport); } catch { /* logging only */ }
  return { fullReport: report.fullReport, feedId: report.feedID || feedId, decoded };
}
