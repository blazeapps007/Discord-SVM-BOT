# Discord SVM Bot

A basic Discord bot built with [discord.js](https://discord.js.org/) v14. It says Hi when you use `!hi` or tag the bot, and is structured so new `!` commands are easy to add.

## Setup

### 1. Create the bot on Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Under **Bot**, click **Reset Token** and copy the token.
3. Still under **Bot**, scroll to **Privileged Gateway Intents** and enable **Message Content Intent** (required to read `!` commands).
4. Invite the bot to your server with this URL (uses permissions integer `274877983808` — View Channels, Send Messages, Send Messages in Threads, Manage Messages, Read Message History, Add Reactions):

   ```
   https://discord.com/oauth2/authorize?client_id=1527302500045295686&scope=bot&permissions=274877983808
   ```

### 2. Configure and run

```bash
npm install
```

Copy `.env.example` to `.env` and paste your token:

```
DISCORD_TOKEN=your-bot-token-here
```

Then start the bot:

```bash
npm start
```

You should see `✅ Logged in as YourBot#1234`.

### Running with Docker instead

```bash
docker compose up -d --build
```

This builds the image and starts the bot in the background, restarting automatically unless stopped. `faucet.db` (claims + account creations) persists in the `bot-data` named volume across rebuilds and restarts, at `/app/data/faucet.db` inside the container (`FAUCET_DB_PATH`, set automatically by `docker-compose.yml`).

Useful commands:

```bash
docker compose logs -f      # follow bot logs
docker compose down         # stop and remove the container
docker compose up -d --build  # rebuild after code changes
```

Don't run the bot both via Docker and `npm start` at the same time — two processes logged in with the same token will both answer commands, causing duplicate replies.

## Usage

- `!hi` — the bot says Hi
- `!ping` — latency check
- `!faucet <steem1...|0x...>` — sends `FAUCET_AMOUNT_DEFAULT` STEEM (or `FAUCET_AMOUNT_VALIDATOR` for the `ROLE_FAUCET` role) to the address; one claim per Discord account and per address every `FAUCET_COOLDOWN_HOURS` (default 24h — resets daily)
- `!balance <address>` — balance of a steem1... or 0x... address
- `!wallet` — the bot wallet's EVM + bech32 addresses and balance
- `!validators` — all validators with status, jailed state, stake and share (Cosmos REST API on port 1317)
- `!status` — full chain stats: latest block, avg block time, total blocks/transactions/addresses (Blockscout), validators, bonded stake and supply (Cosmos)
- `!create testnet <username>` — creates a Steem testnet account (funded by `initminer`). Confirms via two DM reactions first (private keys are never posted publicly), and each Discord account may create only one testnet account, ever
- `@YourBot` — tag the bot anywhere in a message and it responds

## Web faucet endpoint

Alongside the Discord bot, the process also runs a small HTTP server (`webFaucet.js`) for a public web faucet — e.g. served behind `https://faucet.steemscanner.com`. Unlike `!faucet`, each address may claim **once, ever** (no daily reset), and there's no Discord account involved.

```
POST /faucet
Content-Type: application/json

{ "address": "steem1..." }  // or a 0x... address
```

Success (`200`):
```json
{ "success": true, "amount": "5000", "txHash": "0x...", "blockNumber": 123 }
```

Failure (`400`/`403`/`409`/`429`/`503`/`500`):
```json
{ "success": false, "error": "This address has already claimed from this faucet" }
```

`GET /health` returns `{ "ok": true }`.

There's no API key — the endpoint is meant to be called directly from a public page. It's protected by the one-claim-per-address rule (stored in `faucet.db`'s `web_claims` table, independent of `!faucet`'s claims) and by per-IP rate limiting (`WEB_FAUCET_RATE_LIMIT_MAX` requests per `WEB_FAUCET_RATE_LIMIT_WINDOW_MS`). See `.env.example` for `WEB_FAUCET_*` settings — set `WEB_FAUCET_CORS_ORIGIN` to your site's origin to restrict browser callers, and `WEB_FAUCET_TRUST_PROXY=true` only if deployed behind a reverse proxy you trust to set `X-Forwarded-For` (otherwise it can be spoofed to dodge rate limiting). The Docker Compose file publishes `WEB_FAUCET_PORT` (default `3000`) to the host.

## Adding new commands

Open `index.js` and add an entry to the `commands` object:

```js
const commands = {
  hi: (message) => message.reply(`Hi, ${message.author.displayName}! 👋`),
  ping: (message) => message.reply(`Pong! 🏓 Latency: ${client.ws.ping}ms`),
  // args is everything after the command name, split on spaces
  echo: (message, args) => message.reply(args.join(' ') || 'Nothing to echo!'),
};
```
