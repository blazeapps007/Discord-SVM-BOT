# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Discord bot (discord.js v14) for the **SteemVM** chain — an EVM-compatible chain that mints STEEM sent to a Steem gateway account 1:1 as `asteem`. The bot provides a chain faucet, balance/validator/status lookups, and Steem testnet account creation, all as `!`-prefixed commands. The same process also runs a small public HTTP faucet endpoint (`webFaucet.js`, `node:http`, no framework) for a web frontend (e.g. `faucet.steemscanner.com`).

## Commands

```bash
npm install       # install dependencies
npm start          # run the bot (node index.js)
node check-wallet.js   # verify RPC_URL/CHAIN_ID/PRIVATE_KEY connectivity and print the wallet's balance
```

No build step, no test suite, no linter configured — this is a small set of plain CommonJS files run directly by Node.

Docker (production):
```bash
docker compose up -d --build   # build and run in the background
docker compose logs -f         # follow logs
docker compose down            # stop and remove
```
Never run the bot via both Docker and `npm start` at once — two processes on the same token both answer commands and double-reply. `faucet.db` persists in the `bot-data` named volume at `/app/data/faucet.db` (`FAUCET_DB_PATH`).

Configuration is entirely env-driven — copy `.env.example` to `.env`. Each integration (`wallet.js`, `cosmos.js`, `steem.js`) has an `isConfigured()` guard so missing env vars degrade to a friendly Discord error message rather than a crash.

## Architecture

Flat CommonJS module structure, no framework beyond discord.js:

- **`index.js`** — everything Discord-facing: client setup, the `commands` registry (object of `name: async (message, args) => ...` handlers), role gating, the `!create testnet` DM-confirmation flow, and the `MessageCreate`/`GuildMemberAdd` event handlers. **New `!` commands are added here** as entries in the `commands` object.
- **`wallet.js`** — EVM side: ethers.js provider/wallet singletons, bech32 (`steem1...`) ↔ hex (`0x...`) address conversion, balance queries, sending native coin.
- **`cosmos.js`** — reads the Cosmos SDK REST API (gRPC-gateway, default port 1317, same host as `RPC_URL` unless `COSMOS_REST_URL` is set) for validators, staking pool, total supply.
- **`blockscout.js`** — reads the Blockscout explorer's `/api/v2/stats` endpoint for block time / tx / address counts.
- **`steem.js`** — Steem testnet side via `dsteem`: username validation, key derivation, and broadcasting `account_create` operations funded by `initminer`.
- **`db.js`** — SQLite (Node's built-in `node:sqlite`, no ORM) storing faucet `claims`, `account_creations`, and `web_claims`. Contains an inline migration (runs at startup) from an old "one claim ever" UNIQUE-constrained schema to the current daily-reset schema — don't remove that migration path without confirming no deployment still has the old schema.
- **`webFaucet.js`** — the public web faucet HTTP server, started from `index.js` alongside the Discord client (same process, same `wallet.js`/`db.js`). `POST /faucet` sends a fixed `WEB_FAUCET_AMOUNT` to an address, once ever (checked/recorded in `web_claims`, separate from the Discord `claims` table — claiming via one doesn't affect the other). No API key by design (called directly from a public page); protected only by the per-address-ever DB constraint and in-process per-IP rate limiting. Built on bare `node:http`, not Express — there's no framework dependency in this repo and none was added for this (no `npm`/`node` was available in the environment this was built in to install/verify one anyway).

### Key conventions

- **Address duality**: the chain has two address formats for the same account — bech32 (`steem1...`, prefix from `BECH32_PREFIX`) and EVM hex (`0x...`). `wallet.toHexAddress()` normalizes either to checksummed hex; commands that gate by address (like `!faucet`) always compare on the lowercased hex form so both formats of one address count as one claim.
- **Role gating**: `COMMAND_ROLES` in `index.js` maps command name → required Discord role name, `null` meaning open to everyone. Commands not listed fall back to `DEFAULT_ROLE` (`ROLE_GENERAL` env var). `null` in `COMMAND_ROLES` is intentional and different from "unlisted."
- **Testnet note**: `attachTestnetNote()` monkey-patches `message.reply`/the reply's `.edit` for the duration of one incoming message so every outgoing reply automatically gets a "testnet only, 0 value" disclaimer appended — don't bypass `message.reply`/`sent.edit` with `message.channel.send` for user-facing replies unless intentionally skipping the note (as `!validators` does for its overflow chunks).
- **`!create testnet`**: private keys are only ever sent via DM, after two separate reaction-based confirmations (never posted in a public channel). One Steem testnet account per Discord account, enforced via `account_creations.discord_id UNIQUE` in `db.js`. `inFlightCreates`/`inFlightClaims` (in-memory `Set`s in `index.js`) guard against double-submission while an async flow is in progress — these are per-process and reset on restart, so they're a UX guard, not the source of truth (the DB is).
- **Faucet cooldown**: enforced per Discord account *and* per normalized address independently (`FAUCET_COOLDOWN_HOURS`, default 24h, resets rolling from last claim — not calendar-day).
- **Gas**: `wallet.sendCoins()` sends legacy transactions with a hardcoded `gasLimit` (21000, the fixed cost of a plain transfer) and a flat `gasPrice` derived from `GAS_FEE_AMOUNT` (total fee in `COIN_SYMBOL`, default 0.0001) rather than letting ethers auto-estimate — this chain's RPC (`evmd.steemscanner.com`) returned "exceeds block gas limit" for auto-estimated/zero-price sends, so don't remove the explicit gas params without confirming that's still needed. Also note `wallet.getProvider()` passes `{ batchMaxCount: 1 }` — this RPC doesn't handle batched JSON-RPC correctly, which otherwise surfaces as an opaque ethers "could not coalesce error".
- **Long replies**: Discord caps messages at 2000 chars; `!validators` chunks its table output at ~1900 chars per message, repeating the header on each chunk (see `index.js` for the pattern if adding other tabular commands).
