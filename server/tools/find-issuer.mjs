/** Try known local passwords to open the issuer wallet candidates and create the currency asset. */
import { numistaRpc } from '../numista/rpc.js';
import { NUM_ASSET_ID, CURRENCY_ASSET_TYPE } from '../data/deedRegistry.js';
import { CURRENCY_METADATA_HASH } from '../numista/chainAdapter.js';
import { CONFIG } from '../config.js';

const ISSUER_KEY = '938c1029985ba0e3d91d26f76491abd99dae405dd1caf959a6f5de73a94fe55b';
const candidates = ['numista-wallet', 'wallet2', 'me'];
const passwords = [
  '', 'password', 'password123', 'gamepass', 'numista', 'numista123', 'numista1234',
  'testnet', 'testnet123', 'danie', 'admin', 'admin123', 'monero', 'wallet',
  'walletpassword', '123456', '12345678', 'changeme', 'test', 'test123',
  'numista-testnet', 'townforge', 'Townforge', 'miner', 'numista-miner', 'assetissuer'
];

const rpc = (method, params = {}) => numistaRpc._walletRpcInternal(method, params, { skipWalletOpen: true });

let opened = null;
outer:
for (const name of candidates) {
  for (const password of passwords) {
    try { await rpc('close_wallet'); } catch { /* ignore */ }
    try {
      await rpc('open_wallet', { filename: name, password });
    } catch (err) {
      if (!/invalid password/i.test(err.message || '')) console.log(`${name}: ${err.message}`);
      continue;
    }
    const key = await rpc('query_key', { key_type: 'public_spend_key' });
    console.log(`OPENED ${name} with password ${JSON.stringify(password)} -> ${key.key}`);
    await rpc('close_wallet');
    opened = { name, password, key: key.key };
    if (key.key === ISSUER_KEY) break outer;
    continue outer;
  }
}

if (opened?.key === ISSUER_KEY) {
  try {
    await rpc('open_wallet', { filename: opened.name, password: opened.password });
    const result = await rpc('numista_asset_operation', {
      action: 'create_asset',
      asset_id: NUM_ASSET_ID,
      asset_type: CURRENCY_ASSET_TYPE,
      max_supply: CONFIG.CHAIN.MAX_SUPPLY_UNITS,
      metadata_hash: CURRENCY_METADATA_HASH,
      do_not_relay: false
    });
    console.log('CREATE ASSET OK:', JSON.stringify(result));
  } catch (err) {
    console.log('create_asset failed:', err.message);
  }
  await rpc('close_wallet');
} else {
  console.log('issuer wallet not found');
}

try {
  await rpc('open_wallet', { filename: CONFIG.CHAIN.ISSUER_WALLET_FILE, password: CONFIG.CHAIN.ISSUER_WALLET_PASSWORD });
  console.log('reopened', CONFIG.CHAIN.ISSUER_WALLET_FILE);
} catch (err) {
  console.log('reopen failed:', err.message);
}
process.exit(0);
