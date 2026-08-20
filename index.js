require('dotenv').config();
const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
const { ethers } = require('ethers');
const walletLib = require('./wallet');
const claimsDb = require('./db');
const cosmosLib = require('./cosmos');
const blockscoutLib = require('./blockscout');
const steemLib = require('./steem');
const webFaucet = require('./webFaucet');

const PREFIX = '!';
const FAUCET_AMOUNT_DEFAULT = process.env.FAUCET_AMOUNT_DEFAULT || '1000';
const FAUCET_AMOUNT_VALIDATOR = process.env.FAUCET_AMOUNT_VALIDATOR || '5000'; // bonus for ROLE_FAUCET holders
const FAUCET_COOLDOWN_HOURS = Number(process.env.FAUCET_COOLDOWN_HOURS ?? 24);
const inFlightClaims = new Set(); // userIds with a send currently in progress
const inFlightCreates = new Set(); // userIds with an account-creation confirmation pending
const CREATE_CONFIRM_TIMEOUT_MS = Number(process.env.CREATE_CONFIRM_TIMEOUT_MS ?? 60_000);

// Role gating: which role a command requires. null = anyone can use it.
// Commands not listed here fall back to DEFAULT_ROLE.
const DEFAULT_ROLE = process.env.ROLE_GENERAL || 'EVM Assistant';
const COMMAND_ROLES = {
  wallet: null,
  balance: null,
  validators: null,
  status: null,
  faucet: null, // anyone can claim; holders of ROLE_FAUCET just get a bigger amount
};

const VALIDATOR_BONUS_ROLE = process.env.ROLE_FAUCET || 'Validators';

const TESTNET_NOTE = '\n-# ⚠️ Note: These are only Testnet values and carry 0 value.';

// Wraps message.reply (and .edit on the sent reply) so every outgoing
// message automatically ends with the testnet note.
function attachTestnetNote(message) {
  const originalReply = message.reply.bind(message);
  message.reply = async (content) => {
    const sent = await originalReply(typeof content === 'string' ? content + TESTNET_NOTE : content);
    const originalEdit = sent.edit.bind(sent);
    sent.edit = (newContent) =>
      originalEdit(typeof newContent === 'string' ? newContent + TESTNET_NOTE : newContent);
    return sent;
  };
}

function hasRole(message, roleName) {
  if (!roleName) return true;
  if (!message.member) return false; // DMs have no roles
  return message.member.roles.cache.some((role) => role.name.toLowerCase() === roleName.toLowerCase());
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // requires "Server Members Intent" in the Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// Waits for a reaction from `user` on `msg`. If `emojis` is given, only those
// reactions count. Returns the emoji name reacted with, or null on timeout.
async function awaitReactionChoice(msg, user, timeoutMs, emojis = null) {
  try {
    const collected = await msg.awaitReactions({
      filter: (reaction, reactingUser) =>
        reactingUser.id === user.id && (!emojis || emojis.includes(reaction.emoji.name)),
      max: 1,
      time: timeoutMs,
      errors: ['time'],
    });
    return collected.first().emoji.name;
  } catch {
    return null; // timed out
  }
}

const GREETING_CHANNEL = process.env.GREETING_CHANNEL || 'greetings';

function welcomeMessage(member) {
  return (
    `Welcome <@${member.id}> to **Discussions on Steem Virtual Machine**! 🚀\n\n` +
    `**SteemVM** is an EVM-compatible chain that brings the Steem blockchain's STEEM token onto a smart-contract platform.\n\n` +
    `Steem is a fast, fee-less social blockchain, but it has no virtual machine — you cannot write contracts against STEEM. **SteemVM fixes that.**\n\n` +
    `🔄 **How it works:**\n` +
    `STEEM sent to a gateway account on Steem is attested by SteemVM's validators and minted 1:1 as **asteem**, the chain's native gas and staking token. From there, it behaves like any EVM-native asset: send it from MetaMask, use it in Solidity contracts, stake it, or bridge it back out to Steem.\n\n` +
    `🔗 **Resources:**\n` +
    `• **GitHub:** https://github.com/blazeapps007/SteemVirtualMachine-EVM\n` +
    `• **Testnet Block Explorer:** https://evmscan.steemscanner.com\n\n` +
    `Feel free to ask questions and join the conversation!`
  );
}

// Command registry — add new commands here as { name: handler }
const commands = {
  hi: (message) => message.reply(`Hi, ${message.author.displayName}! 👋`),
  ping: (message) => message.reply(`Pong! 🏓 Latency: ${client.ws.ping}ms`),

  // !wallet — show the bot wallet's addresses and balance
  wallet: async (message) => {
    if (!walletLib.isConfigured()) {
      return message.reply('⚠️ Wallet not configured. Set `RPC_URL`, `CHAIN_ID` and `PRIVATE_KEY` in `.env`.');
    }
    const w = walletLib.getWallet();
    const balance = await walletLib.getBalance(w.address);
    return message.reply(
      `**Bot wallet**\n` +
        `EVM: \`${w.address}\`\n` +
        `Bech32: \`${walletLib.toBech32Address(w.address)}\`\n` +
        `Balance: **${balance} ${walletLib.COIN_SYMBOL}**`
    );
  },

  // !balance <address> — balance of any steem1... or 0x... address
  balance: async (message, args) => {
    if (!walletLib.isConfigured()) {
      return message.reply('⚠️ Wallet not configured. Set `RPC_URL`, `CHAIN_ID` and `PRIVATE_KEY` in `.env`.');
    }
    const address = args[0];
    if (!address) {
      return message.reply('Usage: `!balance <steem1...|0x...>`');
    }
    let hexAddress;
    try {
      hexAddress = walletLib.toHexAddress(address);
    } catch {
      return message.reply(`❌ \`${address}\` is not a valid ${walletLib.COIN_SYMBOL} or EVM address.`);
    }
    const balance = await walletLib.getBalance(hexAddress);
    return message.reply(
      `**${address}**\n` +
        `EVM: \`${hexAddress}\` | Bech32: \`${walletLib.toBech32Address(hexAddress)}\`\n` +
        `Balance: **${balance} ${walletLib.COIN_SYMBOL}**`
    );
  },

  // !validators — list validators with stake share, status and jailed state (Cosmos REST API)
  validators: async (message) => {
    let validators;
    try {
      validators = await cosmosLib.getValidators();
    } catch (error) {
      console.error('Failed to fetch validators:', error);
      return message.reply(`⚠️ Could not reach the Cosmos REST API: ${error.message}`);
    }
    if (validators.length === 0) {
      return message.reply('No validators found.');
    }

    const monikerWidth = Math.min(24, Math.max(...validators.map((v) => v.moniker.length), 8));
    const header =
      `${'Moniker'.padEnd(monikerWidth)}  ${'Status'.padEnd(12)}  ${'Share'.padStart(7)}  ${'Stake'.padStart(16)}  Commission\n` +
      `${'-'.repeat(monikerWidth)}  ${'-'.repeat(12)}  ${'-'.repeat(7)}  ${'-'.repeat(16)}  ${'-'.repeat(10)}`;

    const lines = validators.map((v) => {
      const moniker = v.moniker.length > monikerWidth ? v.moniker.slice(0, monikerWidth - 1) + '…' : v.moniker;
      const share = `${v.stakeSharePercent.toFixed(2)}%`;
      const stake = Number(v.tokensFormatted).toLocaleString(undefined, { maximumFractionDigits: 0 });
      const commission = v.commissionRate !== null ? `${v.commissionRate}%` : 'n/a';
      return `${moniker.padEnd(monikerWidth)}  ${v.statusLabel.padEnd(12)}  ${share.padStart(7)}  ${stake.padStart(16)}  ${commission}`;
    });

    // Chunk into <=1900-char code blocks so we stay under Discord's 2000-char limit;
    // repeat the header on every chunk so each message is readable on its own
    const chunks = [];
    let current = [header];
    let currentLength = header.length;
    for (const line of lines) {
      if (currentLength + line.length + 1 > 1900) {
        chunks.push(current);
        current = [header];
        currentLength = header.length;
      }
      current.push(line);
      currentLength += line.length + 1;
    }
    chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      const body = '```\n' + chunks[i].join('\n') + '\n```';
      const text = i === 0 ? `**Validators (${validators.length}):**\n${body}` : body;
      if (i === 0) {
        await message.reply(text);
      } else {
        await message.channel.send(text);
      }
    }
  },

  // !status — full chain stats: EVM RPC + Blockscout explorer + Cosmos staking
  status: async (message) => {
    const [blockNumberResult, statsResult, validatorsResult, poolResult, supplyResult] = await Promise.allSettled([
      Promise.resolve().then(() => walletLib.getProvider().getBlockNumber()),
      blockscoutLib.getStats(),
      cosmosLib.getValidators(),
      cosmosLib.getStakingPool(),
      cosmosLib.getTotalSupply(),
    ]);

    const fmt = (bigintAmount) =>
      Number(ethers.formatUnits(bigintAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 });

    const lines = [`**🔗 SteemVM Chain Status**`, ''];

    lines.push(
      blockNumberResult.status === 'fulfilled'
        ? `**Latest block:** ${blockNumberResult.value.toLocaleString()}`
        : `**Latest block:** ⚠️ unavailable`
    );
    lines.push(`**Chain ID:** ${process.env.CHAIN_ID || 'n/a'}`);

    if (statsResult.status === 'fulfilled') {
      const s = statsResult.value;
      lines.push('');
      lines.push(`**Avg block time:** ${(Number(s.average_block_time) / 1000).toFixed(1)}s`);
      lines.push(`**Total blocks:** ${Number(s.total_blocks).toLocaleString()}`);
      lines.push(
        `**Total transactions:** ${Number(s.total_transactions).toLocaleString()} (${Number(s.transactions_today).toLocaleString()} today)`
      );
      lines.push(`**Total addresses:** ${Number(s.total_addresses).toLocaleString()}`);
      if (s.gas_prices?.average != null) {
        lines.push(`**Gas price:** ${s.gas_prices.average} gwei`);
      }
    } else {
      lines.push('', `**Explorer stats:** ⚠️ unavailable`);
    }

    lines.push('');
    if (validatorsResult.status === 'fulfilled') {
      const vs = validatorsResult.value;
      const active = vs.filter((v) => v.status === 'BOND_STATUS_BONDED' && !v.jailed).length;
      const jailed = vs.filter((v) => v.jailed).length;
      lines.push(`**Validators:** ${vs.length} total (${active} active, ${jailed} jailed)`);
    } else {
      lines.push(`**Validators:** ⚠️ unavailable`);
    }

    if (poolResult.status === 'fulfilled' && supplyResult.status === 'fulfilled') {
      const { bondedTokens } = poolResult.value;
      const totalSupply = supplyResult.value;
      const bondedRatio = totalSupply > 0n ? Number((bondedTokens * 10000n) / totalSupply) / 100 : 0;
      lines.push(`**Bonded stake:** ${fmt(bondedTokens)} ${walletLib.COIN_SYMBOL} (${bondedRatio.toFixed(2)}% of supply)`);
      lines.push(`**Total supply:** ${fmt(totalSupply)} ${walletLib.COIN_SYMBOL}`);
    } else {
      lines.push(`**Staking pool:** ⚠️ unavailable`);
    }

    lines.push('', `Explorer: ${blockscoutLib.BASE_URL}`);

    return message.reply(lines.join('\n'));
  },

  // !create testnet <username> — creates a Steem testnet account funded by
  // `initminer`. Confirms via DM reactions first (since Discord's public
  // channel is never safe for private keys), and only one account may ever
  // be created per Discord account.
  create: async (message, args) => {
    if (!steemLib.isConfigured()) {
      return message.reply('⚠️ Testnet account creation not configured. Set `TESTNET_ACTIVE_KEY` in `.env`.');
    }
    const [network, username] = args;
    if (network !== 'testnet' || !username) {
      return message.reply('Usage: `!create testnet <username>`');
    }
    if (!steemLib.isValidUsername(username)) {
      return message.reply(
        '❌ Invalid Steem username — 3-16 chars, lowercase letters/digits/hyphens, dot-separated segments (e.g. `my-account` or `foo.bar`).'
      );
    }
    if (claimsDb.getAccountCreationByUser(message.author.id)) {
      return message.reply('🚫 You have already created a testnet account — only one per Discord account, ever.');
    }
    if (inFlightCreates.has(message.author.id)) {
      return message.reply('⏳ You already have a pending account creation request — check your DMs.');
    }

    let exists;
    try {
      exists = await steemLib.accountExists(username);
    } catch (error) {
      console.error('Account lookup failed:', error);
      return message.reply(`😵 Could not reach the testnet RPC: ${error.message}`);
    }
    if (exists) {
      return message.reply(`❌ Account \`${username}\` already exists.`);
    }

    inFlightCreates.add(message.author.id);
    try {
      let hiMessage;
      try {
        hiMessage = await message.author.send('👋 Hi! React to this message to continue.');
      } catch {
        return message.reply('❌ I could not DM you. Please enable DMs from server members and try again.');
      }
      await message.reply('📬 Check your DMs to continue.');

      const ack = await awaitReactionChoice(hiMessage, message.author, CREATE_CONFIRM_TIMEOUT_MS);
      if (!ack) {
        await message.author.send('⌛ Timed out. Run `!create testnet ' + username + '` again if you still want an account.');
        return;
      }

      const confirmMessage = await message.author.send(
        `Hi, did you just request to create the Steem testnet account **${username}**? React ✅ to confirm or ❌ to cancel.`
      );
      await confirmMessage.react('✅');
      await confirmMessage.react('❌');
      const choice = await awaitReactionChoice(confirmMessage, message.author, CREATE_CONFIRM_TIMEOUT_MS, ['✅', '❌']);
      if (choice !== '✅') {
        await message.author.send(choice === '❌' ? '❌ Cancelled — no account created.' : '⌛ Timed out — no account created.');
        return;
      }

      const { password, keys } = steemLib.generateCredentials(username);
      const dmText =
        `🔑 **Steem testnet account: ${username}**\n\n` +
        `**Master password** (save this — it derives all your keys):\n\`${password}\`\n\n` +
        `**Owner private key:** \`${keys.owner.private}\`\n` +
        `**Active private key:** \`${keys.active.private}\`\n` +
        `**Posting private key:** \`${keys.posting.private}\`\n` +
        `**Memo private key:** \`${keys.memo.private}\`\n\n` +
        `⚠️ Anyone with these keys controls this account. Store them somewhere safe — this is the only time they'll be shown.`;

      try {
        await message.author.send(dmText);
      } catch {
        await message.author.send('❌ Could not deliver your keys — no account was created. Please try again.');
        return;
      }

      await message.author.send(`⏳ Creating \`${username}\` on-chain...`);
      try {
        const { txId, blockNum } = await steemLib.broadcastAccountCreate(username, keys);
        claimsDb.recordAccountCreation({
          discordId: message.author.id,
          discordTag: message.author.tag,
          username,
          txHash: txId,
        });
        await message.author.send(`✅ Created! Tx: \`${txId}\` (block ${blockNum})`);
      } catch (error) {
        console.error('Account creation broadcast failed:', error);
        await message.author.send(`😵 Account creation failed: ${error.message}`);
      }
    } finally {
      inFlightCreates.delete(message.author.id);
    }
  },

  // !faucet <address> — anyone can claim once per day; each address can also
  // only receive once per day, regardless of who claims or which address
  // format (steem1.../0x...) they use, recorded in SQLite
  faucet: async (message, args) => {
    if (!walletLib.isConfigured()) {
      return message.reply('⚠️ Faucet not configured. Set `RPC_URL`, `CHAIN_ID` and `PRIVATE_KEY` in `.env`.');
    }
    const amount = hasRole(message, VALIDATOR_BONUS_ROLE) ? FAUCET_AMOUNT_VALIDATOR : FAUCET_AMOUNT_DEFAULT;

    const to = args[0];
    if (!to) {
      return message.reply(
        `Usage: \`!faucet <steem1...|0x...>\`\n` +
          `• Default → **${FAUCET_AMOUNT_DEFAULT} ${walletLib.COIN_SYMBOL}**\n` +
          `• **${VALIDATOR_BONUS_ROLE}** role → **${FAUCET_AMOUNT_VALIDATOR} ${walletLib.COIN_SYMBOL}**\n` +
          `One claim per Discord account and per address every ${FAUCET_COOLDOWN_HOURS}h.`
      );
    }

    // Normalize to lowercase hex so steem1... and 0x... forms of the same
    // account count as one address (blocks the "claim once per format" trick)
    let normalizedAddress;
    try {
      normalizedAddress = walletLib.toHexAddress(to).toLowerCase();
    } catch {
      return message.reply(`❌ \`${to}\` is not a valid ${walletLib.COIN_SYMBOL} or EVM address.`);
    }

    const cooldownMs = FAUCET_COOLDOWN_HOURS * 60 * 60 * 1000;
    const hoursRemaining = (lastClaimedAt) => Math.ceil((lastClaimedAt + cooldownMs - Date.now()) / (60 * 60 * 1000));

    const lastByUser = claimsDb.getLatestClaimByUser(message.author.id);
    if (lastByUser && Date.now() - lastByUser.claimed_at < cooldownMs) {
      return message.reply(`🕒 You've already claimed today. Try again in ~${hoursRemaining(lastByUser.claimed_at)}h.`);
    }
    const lastByAddress = claimsDb.getLatestClaimByAddress(normalizedAddress);
    if (lastByAddress && Date.now() - lastByAddress.claimed_at < cooldownMs) {
      return message.reply(
        `🕒 That address already claimed today (regardless of address format). Try again in ~${hoursRemaining(lastByAddress.claimed_at)}h.`
      );
    }
    if (inFlightClaims.has(message.author.id)) {
      return message.reply('⏳ Your claim is already being processed.');
    }

    inFlightClaims.add(message.author.id);
    const pending = await message.reply(`⏳ Sending **${amount} ${walletLib.COIN_SYMBOL}** to \`${to}\`...`);
    try {
      const { hash, blockNumber } = await walletLib.sendCoins(to, amount);
      claimsDb.recordClaim({
        discordId: message.author.id,
        discordTag: message.author.tag,
        address: normalizedAddress,
        addressInput: to,
        amount,
        txHash: hash,
      });
      return pending.edit(
        `🚰 Sent **${amount} ${walletLib.COIN_SYMBOL}** to \`${to}\`\n` +
          `Tx: \`${hash}\` (block ${blockNumber})`
      );
    } catch (error) {
      console.error('Faucet send failed:', error);
      return pending.edit(`😵 Faucet failed: ${error.shortMessage || error.message}`);
    } finally {
      inFlightClaims.delete(message.author.id);
    }
  },
};

client.once(Events.ClientReady, (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  console.log(`📋 In ${readyClient.guilds.cache.size} server(s):`);
  for (const guild of readyClient.guilds.cache.values()) {
    console.log(`   - ${guild.name} (id: ${guild.id}, members: ${guild.memberCount})`);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  console.log(`👤 New member: ${member.user.tag} joined ${member.guild.name}`);
  const channel = member.guild.channels.cache.find(
    (ch) => ch.name === GREETING_CHANNEL && ch.isTextBased()
  );
  if (!channel) {
    console.warn(`⚠️ Greeting channel "#${GREETING_CHANNEL}" not found in ${member.guild.name}`);
    return;
  }
  try {
    await channel.send(welcomeMessage(member));
  } catch (error) {
    console.error(`Failed to send welcome message in #${GREETING_CHANNEL}:`, error);
  }
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`🎉 Joined server: ${guild.name} (id: ${guild.id}, members: ${guild.memberCount})`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  attachTestnetNote(message);

  console.log(
    `💬 [${message.guild?.name ?? 'DM'} #${message.channel.name ?? ''}] ${message.author.tag}: ${message.content || '(empty — Message Content Intent off?)'}`
  );

  // Respond when the bot is mentioned/tagged
  if (message.mentions.has(client.user) && !message.mentions.everyone) {
    await message.reply(`Hi, ${message.author.displayName}! 👋 You called?`);
    return;
  }

  // Prefix commands: !hi, !ping, ...
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const commandName = args.shift().toLowerCase();

  const command = commands[commandName];
  if (!command) return;

  const requiredRole = commandName in COMMAND_ROLES ? COMMAND_ROLES[commandName] : DEFAULT_ROLE;
  if (!hasRole(message, requiredRole)) {
    await message.reply(`⛔ You need the **${requiredRole}** role to use \`${PREFIX}${commandName}\`.`);
    return;
  }

  try {
    await command(message, args);
  } catch (error) {
    console.error(`Error running command "${commandName}":`, error);
    const reason = error.shortMessage || error.message || 'unknown error';
    await message.reply(`😵 Command failed: ${reason}`);
  }
});

webFaucet.start();
client.login(process.env.DISCORD_TOKEN);
