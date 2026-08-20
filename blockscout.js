const BASE_URL = (process.env.BLOCKSCOUT_API_URL || 'https://evmscan.steemscanner.com').replace(/\/$/, '');

// Blockscout's built-in stats endpoint already aggregates average block
// time, total addresses/blocks/transactions, so there's no need to compute
// those manually from raw block data.
async function getStats() {
  const res = await fetch(`${BASE_URL}/api/v2/stats`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Blockscout API ${res.status} ${res.statusText}`);
  }
  return res.json();
}

module.exports = { getStats, BASE_URL };
