// Quick connectivity check: node check-wallet.js
require('dotenv').config();
const { ethers } = require('ethers');
const walletLib = require('./wallet');

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const network = await provider.getNetwork();
  console.log(`RPC:        ${process.env.RPC_URL}`);
  console.log(`Chain ID:   ${network.chainId} (from RPC) vs ${process.env.CHAIN_ID} (.env)`);
  if (network.chainId.toString() !== process.env.CHAIN_ID) {
    console.log('⚠️  CHAIN_ID in .env does not match the RPC — update .env!');
  }

  const w = walletLib.getWallet();
  console.log(`EVM addr:   ${w.address}`);
  console.log(`Bech32:     ${walletLib.toBech32Address(w.address)}`);

  const balance = await provider.getBalance(w.address);
  console.log(`Balance:    ${ethers.formatEther(balance)} ${walletLib.COIN_SYMBOL}`);
  process.exit(0);
})().catch((err) => {
  console.error('❌ Check failed:', err.shortMessage || err.message);
  process.exit(1);
});
