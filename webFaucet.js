// Public HTTP faucet endpoint (e.g. served behind https://faucet.steemscanner.com)
// for a frontend/script to POST an address and receive WEB_FAUCET_AMOUNT once,
// ever, per address. No API key — protected only by the one-claim-per-address
// rule (enforced by web_claims.address UNIQUE in db.js) and per-IP rate
// limiting below, since the endpoint is meant to be called directly from a
// public web page.
const http = require('node:http');
const walletLib = require('./wallet');
const claimsDb = require('./db');

const WEB_FAUCET_PORT = Number(process.env.WEB_FAUCET_PORT ?? 3000);
const WEB_FAUCET_AMOUNT = process.env.WEB_FAUCET_AMOUNT || '5000';
const CORS_ORIGIN = process.env.WEB_FAUCET_CORS_ORIGIN || '*';
const RATE_LIMIT_MAX = Number(process.env.WEB_FAUCET_RATE_LIMIT_MAX ?? 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.WEB_FAUCET_RATE_LIMIT_WINDOW_MS ?? 60 * 60 * 1000);
// Only trust X-Forwarded-For when actually deployed behind a reverse proxy —
// otherwise a caller can forge it to dodge per-IP rate limiting.
const TRUST_PROXY = process.env.WEB_FAUCET_TRUST_PROXY === 'true';
const MAX_BODY_BYTES = 10_000;

const inFlightAddresses = new Set(); // normalized hex addresses with a send currently in progress
const ipHits = new Map(); // ip -> timestamps of requests within the current window

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

// Drop IPs with no hits left in the window so this doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) {
    const fresh = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) ipHits.delete(ip);
    else ipHits.set(ip, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleFaucet(req, res) {
  if (!walletLib.isConfigured()) {
    return sendJson(res, 503, { success: false, error: 'Faucet not configured' });
  }

  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return sendJson(res, 429, { success: false, error: 'Too many requests — try again later' });
  }

  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
  }

  const address = body?.address;
  if (!address || typeof address !== 'string') {
    return sendJson(res, 400, { success: false, error: 'Missing "address" in request body' });
  }

  let normalizedAddress;
  try {
    normalizedAddress = walletLib.toHexAddress(address).toLowerCase();
  } catch {
    return sendJson(res, 400, {
      success: false,
      error: `"${address}" is not a valid ${walletLib.COIN_SYMBOL} or EVM address`,
    });
  }

  if (claimsDb.getWebClaimByAddress(normalizedAddress)) {
    return sendJson(res, 403, { success: false, error: 'This address has already claimed from this faucet' });
  }
  if (inFlightAddresses.has(normalizedAddress)) {
    return sendJson(res, 409, { success: false, error: 'A claim for this address is already being processed' });
  }

  inFlightAddresses.add(normalizedAddress);
  try {
    const { hash, blockNumber } = await walletLib.sendCoins(address, WEB_FAUCET_AMOUNT);
    claimsDb.recordWebClaim({
      address: normalizedAddress,
      addressInput: address,
      ip,
      amount: WEB_FAUCET_AMOUNT,
      txHash: hash,
    });
    return sendJson(res, 200, { success: true, amount: WEB_FAUCET_AMOUNT, txHash: hash, blockNumber });
  } catch (error) {
    console.error('Web faucet send failed:', error);
    return sendJson(res, 500, { success: false, error: error.shortMessage || error.message });
  } finally {
    inFlightAddresses.delete(normalizedAddress);
  }
}

function start() {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/faucet') {
      handleFaucet(req, res).catch((error) => {
        console.error('Unhandled web faucet error:', error);
        sendJson(res, 500, { success: false, error: 'Internal error' });
      });
      return;
    }
    sendJson(res, 404, { success: false, error: 'Not found' });
  });

  server.listen(WEB_FAUCET_PORT, () => {
    console.log(`🌐 Web faucet listening on port ${WEB_FAUCET_PORT} (POST /faucet, ${WEB_FAUCET_AMOUNT} ${walletLib.COIN_SYMBOL}/address)`);
  });

  return server;
}

module.exports = { start };
