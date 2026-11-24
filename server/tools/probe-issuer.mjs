/**
 * One-off operator probe: find the wallet that owns the compiled Numista asset
 * issuer key and create the game currency asset with it.
 *
 * Safe to re-run: create_asset is idempotent on the node for identical params.
 */
import { numistaRpc } from '../numista/rpc.js';
import { NUM_ASSET_ID, CURRENCY_ASSET_TYPE } from '../data/deedRegistry.js';
import { CURRENCY_METADATA_HASH } from '../numista/chainAdapter.js';
import { CONFIG } from '../config.js';

const candidates = ['numista-wallet', 'wallet2', 'me', 'admin'];

async function rpc(method, params = {}) {
  return numistaRpc._walletRpcInternal(method, params, { skipWalletOpen: true });
}

for (const name of candidates) {
  console.log(`\n=== ${name} ===`);
  try { await rpc('close_wallet'); } catch { /* no wallet open */ }
  try {
    await rpc('open_wallet', { filename: name, password: '' });
  } catch (err) {
    console.log('open failed:', err.message);
    continue;
  }
  try {
    const address = await rpc('get_address', { account_index: 0 });
    console.log('address:', address.address);
    const key = await rpc('query_key', { key_type: 'public_spend_key' });
    console.log('public spend key:', key.key);
  } catch (err) {
    console.log('read failed:', err.message);
  }
  try {
    const result = await rpc('numista_asset_operation', {
      action: 'create_asset',
      asset_id: NUM_ASSET_ID,
      asset_type: CURRENCY_ASSET_TYPE,
      max_supply: CONFIG.CHAIN.MAX_SUPPLY_UNITS,
      metadata_hash: CURRENCY_METADATA_HASH,
      do_not_relay: false
    });
    console.log('CREATE ASSET OK:', JSON.stringify(result));
    break;
  } catch (err) {
    console.log('create_asset:', err.message);
  }
}

// Always leave the mining/treasury wallet loaded.
try { await rpc('close_wallet'); } catch { /* ignore */ }
try {
  await rpc('open_wallet', { filename: CONFIG.CHAIN.ISSUER_WALLET_FILE, password: CONFIG.CHAIN.ISSUER_WALLET_PASSWORD });
  console.log('\nreopened', CONFIG.CHAIN.ISSUER_WALLET_FILE);
} catch (err) {
  console.log('\ncould not reopen admin:', err.message);
}
process.exit(0);
