const { ethers } = require('ethers');
const { fromBech32, toBech32 } = require('@cosmjs/encoding');

const BECH32_PREFIX = process.env.BECH32_PREFIX || 'steem';
const COIN_SYMBOL = process.env.COIN_SYMBOL || 'STEEM';

const GAS_LIMIT = 21000n; // standard cost of a plain value transfer, no calldata
const GAS_FEE_AMOUNT = process.env.GAS_FEE_AMOUNT || '0.0001'; // total tx fee (gasLimit * gasPrice), in COIN_SYMBOL
const GAS_PRICE = ethers.parseEther(GAS_FEE_AMOUNT) / GAS_LIMIT;

let provider = null;
let wallet = null;

function isConfigured() {
  return Boolean(process.env.RPC_URL && process.env.CHAIN_ID && process.env.PRIVATE_KEY);
}

function getProvider() {
  if (!process.env.RPC_URL) {
    throw new Error('RPC_URL not set in .env');
  }
  if (!provider) {
    provider = new ethers.JsonRpcProvider(
      process.env.RPC_URL,
      process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
      // This chain's RPC doesn't handle batched JSON-RPC requests correctly —
      // ethers v6 batches by default, which surfaces as the opaque
      // "could not coalesce error". Send each call individually instead.
      { batchMaxCount: 1 }
    );
  }
  return provider;
}

function getWallet() {
  if (!isConfigured()) {
    throw new Error('Wallet not configured — set RPC_URL, CHAIN_ID and PRIVATE_KEY in .env');
  }
  if (!wallet) {
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, getProvider());
  }
  return wallet;
}

// Accepts either 0x... or bech32 (steem1...) and returns a checksummed 0x address
function toHexAddress(address) {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return ethers.getAddress(address);
  }
  const { prefix, data } = fromBech32(address);
  if (data.length !== 20) {
    throw new Error(`Address "${address}" does not decode to a 20-byte EVM address`);
  }
  return ethers.getAddress(ethers.hexlify(data));
}

function toBech32Address(hexAddress) {
  return toBech32(BECH32_PREFIX, ethers.getBytes(hexAddress));
}

async function getBalance(address) {
  const w = getWallet();
  const hex = toHexAddress(address || w.address);
  const balance = await w.provider.getBalance(hex);
  return ethers.formatEther(balance);
}

// amount is a human string like "1" or "0.5" (native coin, 18 decimals)
async function sendCoins(to, amount) {
  const w = getWallet();
  const tx = await w.sendTransaction({
    to: toHexAddress(to),
    value: ethers.parseEther(amount),
    gasLimit: GAS_LIMIT,
    gasPrice: GAS_PRICE,
  });
  const receipt = await tx.wait();
  return { hash: tx.hash, blockNumber: receipt.blockNumber };
}

module.exports = {
  isConfigured,
  getProvider,
  getWallet,
  toHexAddress,
  toBech32Address,
  getBalance,
  sendCoins,
  COIN_SYMBOL,
};
