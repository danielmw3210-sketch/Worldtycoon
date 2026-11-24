#!/usr/bin/env node
/**
 * Numista Treasury UTXO Splitter
 * ─────────────────────────────────────────────────────────────────────────────
 * Prevents the Monero 10-block output lock error ("not enough unlocked money").
 * Splits monolithic wallet balances into multiple concurrent spendable UTXOs.
 *
 * Usage:
 *   node server/tools/split-treasury-utxos.mjs [count=10] [amountPerOutput=25]
 */

import { numistaRpc } from '../numista/rpc.js';
import { CONFIG } from '../config.js';

const count = Number(process.argv[2]) || 10;
const amountPerOutput = Number(process.argv[3]) || 25;

console.log('=== Numista Treasury UTXO Splitter ===');
console.log(`Target: create ${count} UTXOs of ${amountPerOutput} NUM each`);

try {
  const conn = await numistaRpc.checkConnection();
  if (!conn.daemon) throw new Error(`Daemon unreachable at ${CONFIG.NUMISTA.DAEMON_RPC_URL}`);
  if (!conn.wallet) throw new Error(`Wallet RPC unreachable at ${CONFIG.NUMISTA.WALLET_RPC_URL}`);

  await numistaRpc.ensureWalletOpen();
  const balance = await numistaRpc.getWalletBalance(0);
  const primary = await numistaRpc.getPrimaryAddress(0);

  console.log(`Wallet address: ${primary.address}`);
  console.log(`Total balance: ${balance.balance} NUM`);
  console.log(`Unlocked balance: ${balance.unlockedBalance} NUM`);

  const needed = count * amountPerOutput;
  if (balance.unlockedBalance < needed) {
    throw new Error(`Insufficient unlocked balance (${balance.unlockedBalance} NUM). Need at least ${needed} NUM.`);
  }

  // Check existing incoming available transfers
  let transfers = [];
  try {
    const res = await numistaRpc.getIncomingTransfers(0, 'available');
    transfers = res.transfers || [];
    console.log(`Existing unlocked UTXOs: ${transfers.length}`);
  } catch (err) {
    console.log(`Note: incoming_transfers check: ${err.message}`);
  }

  if (transfers.length >= count) {
    console.log(`Wallet already has ${transfers.length} unlocked UTXOs (>= ${count}). No split necessary.`);
    process.exit(0);
  }

  console.log(`\nSplitting balance into ${count} outputs of ${amountPerOutput} NUM...`);
  const destinations = Array.from({ length: count }, () => ({
    address: primary.address,
    amountNum: amountPerOutput
  }));

  const splitResult = await numistaRpc.transferSplit(destinations, {
    accountIndex: 0,
    priority: 1,
    ringSize: 16
  });

  console.log('SUCCESS! Split transactions generated:');
  const txList = splitResult.tx_hash_list || (splitResult.tx_hash ? [splitResult.tx_hash] : []);
  for (const tx of txList) {
    console.log(` - Tx Hash: ${tx}`);
  }
  console.log(`Total fee: ${splitResult.fee_list ? splitResult.fee_list.reduce((a, b) => a + b, 0) / 1e12 : (splitResult.fee || 0) / 1e12} NUM`);
  console.log(`Note: New outputs will unlock in 10 blocks (~20 minutes) for concurrent spending.`);
} catch (err) {
  console.error('\nERROR:', err.message);
  process.exit(1);
}
