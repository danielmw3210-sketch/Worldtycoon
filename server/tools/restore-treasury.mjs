/** Restore the miner/treasury wallet from its polyseed and test whether it is the asset issuer. */
import { numistaRpc } from '../numista/rpc.js';
import { NUM_ASSET_ID, CURRENCY_ASSET_TYPE } from '../data/deedRegistry.js';
import { CURRENCY_METADATA_HASH } from '../numista/chainAdapter.js';
import { CONFIG } from '../config.js';

const SEED = 'govern squeeze crack fatal always bid wrap elder crack relief bulb stadium unit lumber fringe reform';
const NAME = 'numista-miner';

const rpc = (method, params = {}) => numistaRpc._walletRpcInternal(method, params, { skipWalletOpen: true });

try { await rpc('close_wallet'); } catch { /* ignore */ }

try {
  const restored = await rpc('restore_deterministic_wallet', {
    filename: NAME,
    password: '',
    seed: SEED,
    restore_height: 0,
    language: 'English'
  });
  console.log('restored:', JSON.stringify(restored));
} catch (err) {
  console.log('restore failed:', err.message);
  try { await rpc('open_wallet', { filename: NAME, password: '' }); console.log('opened existing', NAME); }
  catch (openErr) { console.log('open failed:', openErr.message); }
}

try {
  const address = await rpc('get_address', { account_index: 0 });
  console.log('address:', address.address);
  console.log('matches treasury:', address.address === 'Gt2AXeyZZ6DZn1tpMo6hS77cJ4BBQKTgSRfREqKkBBFcaqbkiEgh4QYMaFg7QfpY8852LfVyRmFfJHZu4CEqFUanCPvZjvN');
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
} catch (err) {
  console.log('create_asset:', err.message);
}

try { await rpc('close_wallet'); } catch { /* ignore */ }
try {
  await rpc('open_wallet', { filename: CONFIG.CHAIN.ISSUER_WALLET_FILE, password: CONFIG.CHAIN.ISSUER_WALLET_PASSWORD });
  console.log('reopened', CONFIG.CHAIN.ISSUER_WALLET_FILE);
} catch (err) {
  console.log('reopen failed:', err.message);
}
process.exit(0);
