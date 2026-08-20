const dsteem = require('dsteem');

const RPC_URL = process.env.TESTNET_RPC_URL || 'https://testnet.blazeapps.org';
const CHAIN_ID = process.env.TESTNET_CHAIN_ID || '18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e';
const ADDRESS_PREFIX = process.env.TESTNET_ADDRESS_PREFIX || 'TST';
const CREATOR_ACCOUNT = process.env.TESTNET_CREATOR_ACCOUNT || 'initminer';

let client = null;
function getClient() {
  if (!client) {
    client = new dsteem.Client(RPC_URL, { chainId: CHAIN_ID, addressPrefix: ADDRESS_PREFIX });
  }
  return client;
}

function isConfigured() {
  return Boolean(process.env.TESTNET_ACTIVE_KEY);
}

// Steem account name rules: 3-16 chars, dot-separated segments, each segment
// starts with a lowercase letter and contains lowercase letters/digits/hyphens
// (no leading/trailing/double hyphens).
const USERNAME_RE = /^[a-z][a-z0-9-]*[a-z0-9](\.[a-z][a-z0-9-]*[a-z0-9])*$/;
function isValidUsername(name) {
  return (
    typeof name === 'string' &&
    name.length >= 3 &&
    name.length <= 16 &&
    !name.includes('--') &&
    USERNAME_RE.test(name)
  );
}

async function accountExists(username) {
  const accounts = await getClient().database.getAccounts([username]);
  return accounts.length > 0;
}

// 'P' prefix matches the Steem convention for master passwords
function generatePassword() {
  return 'P' + dsteem.PrivateKey.fromSeed(`${Date.now()}${Math.random()}`).toString();
}

function deriveKeys(username, password) {
  const keys = {};
  for (const role of ['owner', 'active', 'posting', 'memo']) {
    const priv = dsteem.PrivateKey.fromLogin(username, password, role);
    keys[role] = { private: priv.toString(), public: priv.createPublic(ADDRESS_PREFIX).toString() };
  }
  return keys;
}

// Pure, local — no network call. Safe to run before deciding whether to
// actually broadcast (e.g. to DM credentials first and only create the
// account on-chain once we know delivery succeeded).
function generateCredentials(username) {
  const password = generatePassword();
  return { password, keys: deriveKeys(username, password) };
}

async function broadcastAccountCreate(username, keys) {
  if (!isConfigured()) {
    throw new Error('Not configured — set TESTNET_ACTIVE_KEY in .env');
  }
  const { account_creation_fee } = await getClient().database.getChainProperties();

  const op = [
    'account_create',
    {
      fee: account_creation_fee,
      creator: CREATOR_ACCOUNT,
      new_account_name: username,
      owner: { weight_threshold: 1, account_auths: [], key_auths: [[keys.owner.public, 1]] },
      active: { weight_threshold: 1, account_auths: [], key_auths: [[keys.active.public, 1]] },
      posting: { weight_threshold: 1, account_auths: [], key_auths: [[keys.posting.public, 1]] },
      memo_key: keys.memo.public,
      json_metadata: '',
    },
  ];

  const creatorKey = dsteem.PrivateKey.fromString(process.env.TESTNET_ACTIVE_KEY);
  const result = await getClient().broadcast.sendOperations([op], creatorKey);
  return { txId: result.id, blockNum: result.block_num };
}

module.exports = {
  isConfigured,
  isValidUsername,
  accountExists,
  generateCredentials,
  broadcastAccountCreate,
  RPC_URL,
  CREATOR_ACCOUNT,
};
