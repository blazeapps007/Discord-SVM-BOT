const { ethers } = require('ethers');

const DEFAULT_REST_PORT = process.env.COSMOS_REST_PORT || '1317';

function getRestUrl() {
  if (process.env.COSMOS_REST_URL) return process.env.COSMOS_REST_URL.replace(/\/$/, '');
  if (!process.env.RPC_URL) {
    throw new Error('Set COSMOS_REST_URL or RPC_URL in .env to reach the Cosmos REST API');
  }
  const { hostname } = new URL(process.env.RPC_URL);
  return `http://${hostname}:${DEFAULT_REST_PORT}`;
}

async function fetchJson(path) {
  const url = `${getRestUrl()}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Cosmos REST ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

const STATUS_LABELS = {
  BOND_STATUS_BONDED: '🟢 Active',
  BOND_STATUS_UNBONDING: '🟡 Unbonding',
  BOND_STATUS_UNBONDED: '🔴 Unbonded',
};

// Fetches all validators (paginating if needed) with stake share, health and jailed status
async function getValidators() {
  const validators = [];
  let nextKey = null;
  do {
    const query = nextKey
      ? `?pagination.limit=100&pagination.key=${encodeURIComponent(nextKey)}`
      : '?pagination.limit=100';
    const data = await fetchJson(`/cosmos/staking/v1beta1/validators${query}`);
    validators.push(...data.validators);
    nextKey = data.pagination?.next_key || null;
  } while (nextKey);

  const totalBonded = validators
    .filter((v) => v.status === 'BOND_STATUS_BONDED')
    .reduce((sum, v) => sum + BigInt(v.tokens), 0n);

  return validators
    .map((v) => {
      const tokens = BigInt(v.tokens);
      const shareBp = totalBonded > 0n ? Number((tokens * 10000n) / totalBonded) / 100 : 0; // basis points -> %
      return {
        moniker: v.description?.moniker || v.operator_address,
        operatorAddress: v.operator_address,
        jailed: v.jailed,
        status: v.status,
        statusLabel: v.jailed ? '⛔ Jailed' : STATUS_LABELS[v.status] || v.status,
        tokens,
        tokensFormatted: ethers.formatUnits(tokens, 18),
        stakeSharePercent: shareBp,
        commissionRate: v.commission?.commission_rates?.rate
          ? (Number(v.commission.commission_rates.rate) * 100).toFixed(2)
          : null,
      };
    })
    .sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0));
}

async function getStakingPool() {
  const data = await fetchJson('/cosmos/staking/v1beta1/pool');
  return {
    bondedTokens: BigInt(data.pool.bonded_tokens),
    notBondedTokens: BigInt(data.pool.not_bonded_tokens),
  };
}

async function getTotalSupply(denom = 'asteem') {
  const data = await fetchJson('/cosmos/bank/v1beta1/supply');
  const entry = data.supply.find((s) => s.denom === denom);
  return entry ? BigInt(entry.amount) : 0n;
}

module.exports = { getRestUrl, getValidators, getStakingPool, getTotalSupply };
