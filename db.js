const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.FAUCET_DB_PATH || path.join(__dirname, 'faucet.db'));

const existingTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='claims'").get();

if (existingTable && existingTable.sql.includes('UNIQUE')) {
  // Migrating from the old "one claim ever" schema to the daily-reset
  // schema — keep claim history, drop the UNIQUE constraints.
  db.exec('ALTER TABLE claims RENAME TO claims_old');
  db.exec(`
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      discord_tag TEXT NOT NULL,
      address TEXT NOT NULL,       -- normalized lowercase 0x hex (same for steem1/0x forms)
      address_input TEXT NOT NULL, -- address exactly as the user typed it
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      claimed_at INTEGER NOT NULL  -- epoch ms
    )
  `);
  db.exec(`
    INSERT INTO claims (id, discord_id, discord_tag, address, address_input, amount, tx_hash, claimed_at)
    SELECT id, discord_id, discord_tag, address, address_input, amount, tx_hash,
           CAST(strftime('%s', claimed_at) AS INTEGER) * 1000
    FROM claims_old
  `);
  db.exec('DROP TABLE claims_old');
} else {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT NOT NULL,
      discord_tag TEXT NOT NULL,
      address TEXT NOT NULL,
      address_input TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    )
  `);
}

db.exec('CREATE INDEX IF NOT EXISTS idx_claims_discord_id ON claims(discord_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(address)');

db.exec(`
  CREATE TABLE IF NOT EXISTS account_creations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL UNIQUE,
    discord_tag TEXT NOT NULL,
    steem_username TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Claims made through the public web faucet endpoint (webFaucet.js) — kept
// separate from `claims` (the Discord !faucet, which resets every
// FAUCET_COOLDOWN_HOURS): here each address may only ever claim once, and
// there's no Discord account tied to it, only the normalized address + IP.
db.exec(`
  CREATE TABLE IF NOT EXISTS web_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    address_input TEXT NOT NULL,
    ip TEXT NOT NULL,
    amount TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
  )
`);

const stmtLatestByUser = db.prepare('SELECT * FROM claims WHERE discord_id = ? ORDER BY claimed_at DESC LIMIT 1');
const stmtLatestByAddress = db.prepare('SELECT * FROM claims WHERE address = ? ORDER BY claimed_at DESC LIMIT 1');
const stmtInsert = db.prepare(`
  INSERT INTO claims (discord_id, discord_tag, address, address_input, amount, tx_hash, claimed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const stmtStats = db.prepare('SELECT COUNT(*) AS count, TOTAL(amount) AS total FROM claims');

const stmtCreationByUser = db.prepare('SELECT * FROM account_creations WHERE discord_id = ?');
const stmtInsertCreation = db.prepare(`
  INSERT INTO account_creations (discord_id, discord_tag, steem_username, tx_hash, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

const stmtWebClaimByAddress = db.prepare('SELECT * FROM web_claims WHERE address = ?');
const stmtInsertWebClaim = db.prepare(`
  INSERT INTO web_claims (address, address_input, ip, amount, tx_hash, claimed_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function getLatestClaimByUser(discordId) {
  return stmtLatestByUser.get(discordId);
}

function getLatestClaimByAddress(normalizedHexAddress) {
  return stmtLatestByAddress.get(normalizedHexAddress);
}

function recordClaim({ discordId, discordTag, address, addressInput, amount, txHash }) {
  stmtInsert.run(discordId, discordTag, address, addressInput, amount, txHash, Date.now());
}

function getStats() {
  return stmtStats.get();
}

function getAccountCreationByUser(discordId) {
  return stmtCreationByUser.get(discordId);
}

function recordAccountCreation({ discordId, discordTag, username, txHash }) {
  stmtInsertCreation.run(discordId, discordTag, username, txHash, Date.now());
}

function getWebClaimByAddress(normalizedHexAddress) {
  return stmtWebClaimByAddress.get(normalizedHexAddress);
}

function recordWebClaim({ address, addressInput, ip, amount, txHash }) {
  stmtInsertWebClaim.run(address, addressInput, ip, amount, txHash, Date.now());
}

module.exports = {
  getLatestClaimByUser,
  getLatestClaimByAddress,
  recordClaim,
  getStats,
  getAccountCreationByUser,
  recordAccountCreation,
  getWebClaimByAddress,
  recordWebClaim,
};
