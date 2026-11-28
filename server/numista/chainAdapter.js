/**
 * Numista chain adapter
 * ─────────────────────────────────────────────────────────────────────────────
 * The upgraded Numista node mints NFTs as *assets* through
 * `numista_asset_operation` (wallet RPC) and exposes read-only asset lookups on
 * the daemon:
 *
 *   get_numista_asset
 *   get_numista_asset_balance
 *   get_numista_asset_username_key
 *
 * Until that build is connected, the adapter runs a deterministic local
 * simulated chain that implements the exact same operations, including
 * confirmation depth and failure modes. The game code never needs to know which
 * mode is active.
 *
 * Modes (CONFIG.CHAIN.MODE):
 *   auto     – live if the node + wallet support asset operations, otherwise off
 *   live     – require the real node
 *   simulate – always use the local chain
 *   off      – minting disabled
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';
import { numistaRpc } from './rpc.js';
import {
  sha256Hex,
  canonicalJson,
  NUM_ASSET_ID,
  CURRENCY_ASSET_TYPE,
  CURRENCY_SCHEMA,
  APP_ID,
  toUnits,
  fromUnits
} from '../data/deedRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CURRENCY_METADATA = {
  app: APP_ID,
  schema: CURRENCY_SCHEMA,
  ticker: CONFIG.NUMISTA.TICKER,
  unitsPerNum: CONFIG.CHAIN.UNITS_PER_NUM
};
export const CURRENCY_METADATA_HASH = 'e8d001d030951e25df83089cf0edfb281f34f063e527ab0c1eee7964e863de0c';

/* ------------------------------------------------------------------ */
/* Simulated chain                                                    */
/* ------------------------------------------------------------------ */

class SimulatedChain {
  constructor({ file, blockMs, genesisBalances }) {
    this.file = file;
    this.blockMs = blockMs;
    this.height = 0;
    this.nonce = 0;
    this.failNext = 0;
    this.assets = new Map();     // assetId -> asset record
    this.balances = new Map();   // `${assetId}|${username}` -> integer units
    this.txs = new Map();        // txHash -> tx record
    this.pendingTxs = new Map(); // txHash -> tx record
    this.usernames = new Map();  // username -> { key, registeredHeight }

    this._saveTimer = null;
    this._loaded = this._load();

    if (!this._loaded || this.height === 0) {
      this._seedGenesis(genesisBalances);
    }

    this._timer = setInterval(() => this.mine(1), this.blockMs);
    if (this._timer.unref) this._timer.unref();
  }

  /* ---- persistence ---- */

  _load() {
    try {
      if (!this.file || !fs.existsSync(this.file)) return false;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.height = Number(raw.height) || 0;
      this.nonce = Number(raw.nonce) || 0;
      (raw.assets || []).forEach(a => this.assets.set(a.assetId, a));
      Object.entries(raw.balances || {}).forEach(([k, v]) => this.balances.set(k, Number(v) || 0));
      (raw.txs || []).forEach(tx => this.txs.set(tx.txHash, tx));
      // Transactions that were mined but not persisted as applied are safe to
      // re-apply because every operation is idempotent by tx hash.
      (raw.pendingTxs || []).forEach(tx => this.pendingTxs.set(tx.txHash, tx));
      (raw.usernames || []).forEach(u => this.usernames.set(u.username, u));
      return true;
    } catch (err) {
      console.warn('[sim-chain] Could not load state:', err.message);
      return false;
    }
  }

  _saveNow() {
    if (!this.file) return;
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        height: this.height,
        nonce: this.nonce,
        assets: [...this.assets.values()],
        balances: Object.fromEntries(this.balances),
        txs: [...this.txs.values()].slice(-2000),
        pendingTxs: [...this.pendingTxs.values()],
        usernames: [...this.usernames.values()]
      };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(payload), 'utf8');
    } catch (err) {
      console.warn('[sim-chain] Could not save state:', err.message);
    }
  }

  _saveSoon() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 400);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /* ---- lifecycle ---- */

  _seedGenesis(genesisBalances = {}) {
    this.height = this.height || 1;
    if (!this.assets.has(NUM_ASSET_ID)) {
      this.assets.set(NUM_ASSET_ID, {
        assetId: NUM_ASSET_ID,
        assetType: CURRENCY_ASSET_TYPE,
        maxSupply: CONFIG.CHAIN.MAX_SUPPLY_UNITS,
        metadataHash: CURRENCY_METADATA_HASH,
        issued: 0,
        createdHeight: 1
      });
    }

    Object.entries(genesisBalances || {}).forEach(([username, amount]) => {
      const units = toUnits(amount);
      if (units > 0) this._credit(NUM_ASSET_ID, username, units);
    });

    this._saveSoon();
  }

  mine(blocks = 1) {
    const n = Math.max(1, Number(blocks) || 1);
    this.height += n;
    this._settleInclusions();
    this._saveSoon();
    return this.height;
  }

  _settleInclusions() {
    for (const [hash, tx] of [...this.pendingTxs.entries()]) {
      if (tx.includeHeight > this.height) continue;
      this.pendingTxs.delete(hash);
      if (tx.forceFail) {
        tx.status = 'failed';
        tx.error = tx.error || 'simulated transaction failure';
        tx.includedHeight = tx.includeHeight;
      } else {
        try {
          this._apply(tx.op);
          tx.status = 'confirmed';
          tx.error = null;
          tx.includedHeight = tx.includeHeight;
        } catch (err) {
          tx.status = 'failed';
          tx.error = err.message;
          tx.includedHeight = tx.includeHeight;
        }
      }
      this.txs.set(hash, tx);
    }
  }

  _apply(op) {
    const kind = op.kind;

    if (kind === 'create_asset') {
      const existing = this.assets.get(op.assetId);
      if (existing) {
        const same = existing.metadataHash === op.metadataHash &&
          Number(existing.maxSupply) === Number(op.maxSupply) &&
          existing.assetType === op.assetType;
        if (!same) throw new Error('Asset id already exists with different parameters');
        return;
      }
      this.assets.set(op.assetId, {
        assetId: op.assetId,
        assetType: op.assetType,
        maxSupply: Number(op.maxSupply),
        metadataHash: op.metadataHash,
        issued: 0,
        createdHeight: this.height
      });
      return;
    }

    if (kind === 'register_username') {
      const existing = this.usernames.get(op.username);
      if (existing && op.key && existing.key !== op.key) {
        throw new Error(`Username "${op.username}" is already registered to a different key`);
      }
      if (!existing) {
        this.usernames.set(op.username, {
          username: op.username,
          key: op.key || 'sim-custodian-key',
          registeredHeight: this.height
        });
      }
      return;
    }

    const asset = this.assets.get(op.assetId);
    if (!asset) throw new Error(`Unknown asset ${op.assetId}`);

    if (kind === 'mint') {
      const amount = Number(op.amountUnits);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid mint amount');
      if (asset.assetType === 'collectible') {
        if (Number(asset.maxSupply) !== 1) throw new Error('Collectible cap must be 1');
        if (amount !== 1) throw new Error('Collectibles must be minted one at a time');
      }
      if (asset.issued + amount > Number(asset.maxSupply)) {
        throw new Error(`Mint would exceed max supply for ${op.assetId}`);
      }
      asset.issued += amount;
      this._credit(op.assetId, op.recipient, amount);
      return;
    }

    if (kind === 'transfer') {
      const amount = Number(op.amountUnits);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid transfer amount');
      const key = `${op.assetId}|${op.from}`;
      const balance = this.balances.get(key) || 0;
      if (balance < amount) {
        throw new Error(`Insufficient ${asset.assetType} balance for @${op.from}`);
      }
      this.balances.set(key, balance - amount);
      this._credit(op.assetId, op.to, amount);
      return;
    }

    throw new Error(`Unsupported operation: ${kind}`);
  }

  _credit(assetId, username, amount) {
    const key = `${assetId}|${username}`;
    this.balances.set(key, (this.balances.get(key) || 0) + Number(amount));
  }

  /* ---- ops ---- */

  submit(op) {
    this._settleInclusions();
    const nonce = ++this.nonce;
    const txHash = sha256Hex(canonicalJson({
      op,
      nonce,
      submitHeight: this.height,
      network: 'numista-sim'
    }));

    if (this.txs.has(txHash) || this.pendingTxs.has(txHash)) {
      return { txHash, acceptedAtHeight: this.height };
    }

    const forceFail = this.failNext > 0;
    if (forceFail) this.failNext -= 1;

    this.pendingTxs.set(txHash, {
      txHash,
      op,
      submittedHeight: this.height,
      includeHeight: this.height + 1,
      status: 'pending',
      forceFail,
      error: forceFail ? 'simulated transaction failure' : null,
      createdAt: new Date().toISOString()
    });
    this._saveSoon();
    return { txHash, acceptedAtHeight: this.height };
  }

  injectFailure(count = 1) {
    this.failNext += Math.max(1, Number(count) || 1);
    return this.failNext;
  }

  getTxStatus(txHash) {
    this._settleInclusions();
    const tx = this.txs.get(txHash) || this.pendingTxs.get(txHash);
    if (!tx) return { status: 'not_found', confirmations: 0, includedHeight: null };

    if (tx.status === 'pending') {
      return {
        status: 'pending',
        confirmations: 0,
        includedHeight: null,
        submittedHeight: tx.submittedHeight
      };
    }
    if (tx.status === 'failed') {
      return {
        status: 'failed',
        confirmations: 0,
        includedHeight: tx.includedHeight || null,
        error: tx.error
      };
    }

    const confirmations = Math.max(1, this.height - (tx.includedHeight ?? this.height) + 1);
    return {
      status: 'confirmed',
      confirmations,
      includedHeight: tx.includedHeight,
      confirmationsRequired: CONFIG.CHAIN.CONFIRMATIONS
    };
  }

  getAsset(assetId) {
    return this.assets.get(assetId) || null;
  }

  getBalance(assetId, username) {
    return this.balances.get(`${assetId}|${username}`) || 0;
  }

  getUsernameKey(username) {
    return this.usernames.get(username) || null;
  }

  getUserAssets(username) {
    const suffix = `|${username}`;
    const out = [];
    for (const [key, units] of this.balances.entries()) {
      if (!key.endsWith(suffix) || units <= 0) continue;
      out.push({ assetId: key.slice(0, key.length - suffix.length), units });
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Adapter                                                            */
/* ------------------------------------------------------------------ */

class ChainAdapter {
  constructor() {
    this.requestedMode = CONFIG.CHAIN.MODE;
    this.mode = 'off';
    this.reason = 'not initialised';
    this.sim = null;
    this.live = null;
    this._probe = null;
    this._initPromise = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    const requested = this.requestedMode;

    if (requested === 'off') {
      this.mode = 'off';
      this.reason = 'Chain minting disabled by NUMISTA_CHAIN_MODE=off';
      return this.capabilitiesSnapshot();
    }

    if (requested === 'simulate') {
      this._startSim();
      return this.capabilitiesSnapshot();
    }

    const probe = await this.probeLive();
    this._probe = probe;

    if (probe.ready) {
      this.mode = 'live';
      this.reason = `Live Numista node at ${CONFIG.NUMISTA.DAEMON_RPC_URL}`;
      return this.capabilitiesSnapshot();
    }

    if (requested === 'live' || requested === 'auto') {
      this.mode = 'off';
      this.reason = `Live mode requested but not ready: ${probe.reason}`;
      return this.capabilitiesSnapshot();
    }
    this.mode = 'off';
    this.reason = `Unknown chain mode "${requested}"`;
    return this.capabilitiesSnapshot();
  }

  _startSim(reason) {
    const simFile = CONFIG.SIM.FILE || path.join(__dirname, '..', 'data', 'simChain.json');
    this.sim = new SimulatedChain({
      file: simFile,
      blockMs: CONFIG.SIM.BLOCK_MS,
      genesisBalances: CONFIG.SIM.GENESIS_BALANCES
    });
    this.mode = 'simulate';
    this.reason = reason || 'Local simulated Numista chain (10-block confirmation flow enabled)';
    console.log(`[chain] Mode=simulate height=${this.sim.height} file=${simFile}`);
  }

  async probeLive() {
    const out = {
      daemonOnline: false,
      walletOnline: false,
      assetRpc: false,
      buildVersion: null,
      walletVersion: null,
      height: 0,
      nettype: null,
      issuerConfigured: !!CONFIG.CHAIN.ISSUER_PUBLIC_KEY,
      ready: false,
      reason: ''
    };

    const mainnet = CONFIG.NUMISTA.NETTYPE === 'numista-mainnet';
    const missingConfig = [];
    if (!CONFIG.NUMISTA.DAEMON_RPC_URL) missingConfig.push('NUMISTA_DAEMON_RPC is required');
    if (!CONFIG.NUMISTA.WALLET_RPC_URL) missingConfig.push('NUMISTA_WALLET_RPC is required');
    if (!CONFIG.CHAIN.ISSUER_PUBLIC_KEY) missingConfig.push('NUMISTA_ISSUER_PUBLIC_KEY is required');
    if (!CONFIG.CHAIN.ISSUER_WALLET_FILE) missingConfig.push('NUMISTA_ISSUER_WALLET is required');
    if (mainnet && !CONFIG.CHAIN.TREASURY_ADDRESS) missingConfig.push('NUMISTA_TREASURY_ADDRESS is required');
    if (mainnet && !CONFIG.CHAIN.TREASURY_USERNAME) missingConfig.push('NUMISTA_TREASURY_USER is required');
    if (mainnet && !CONFIG.CHAIN.CURRENCY_ASSET_ID) missingConfig.push('NUMISTA_CURRENCY_ASSET_ID is required');
    if (missingConfig.length) {
      out.reason = missingConfig.join('; ');
      return out;
    }

    try {
      const info = await this._daemonRaw('get_info');
      out.daemonOnline = true;
      out.height = info.height || 0;
      out.nettype = info.nettype || null;
      const actualNetwork = String(out.nettype || '').trim().toLowerCase();
      const acceptedNetworks = mainnet
        ? ['mainnet', 'numista-mainnet', 'numista mainnet']
        : ['testnet', 'numista-testnet'];
      if (!acceptedNetworks.includes(actualNetwork)) {
        out.reason = actualNetwork
          ? `daemon is on "${out.nettype}", expected ${CONFIG.NUMISTA.NETTYPE}`
          : `daemon did not report its network; expected ${CONFIG.NUMISTA.NETTYPE}`;
        return out;
      }
      if (info.synchronized === false) {
        out.reason = 'Numista daemon is not synchronized';
        return out;
      }
    } catch (err) {
      out.reason = `daemon unreachable at ${CONFIG.NUMISTA.DAEMON_RPC_URL}`;
      return out;
    }

    try {
      const version = await this._daemonJsonRpc('get_version');
      out.buildVersion = version.version || null;
    } catch { /* non-fatal */ }

    try {
      await this._daemonJsonRpc('get_numista_asset', { asset_id: '0'.repeat(64) });
      out.assetRpc = true;
    } catch (err) {
      // A parameter error still proves the method exists. "Method not found"
      // means the node build predates asset support.
      out.assetRpc = !/method not found|unknown method|-32601/i.test(err.message || '');
    }

    let currencyAssetMatches = false;
    if (mainnet && out.assetRpc) {
      try {
        const asset = await this._daemonJsonRpc('get_numista_asset', { asset_id: NUM_ASSET_ID });
        currencyAssetMatches = asset?.found === true &&
          asset.asset_type === CURRENCY_ASSET_TYPE &&
          asset.metadata_hash === CURRENCY_METADATA_HASH;
      } catch {
        currencyAssetMatches = false;
      }
    }

    try {
      const version = await this._walletJsonRpc('get_version');
      out.walletOnline = true;
      out.walletVersion = version.version || null;
    } catch { /* wallet optional for probing */ }

    const missing = [];
    if (!out.assetRpc) missing.push('daemon lacks get_numista_asset (old build)');
    if (mainnet && !currencyAssetMatches) {
      missing.push('configured NUMISTA_CURRENCY_ASSET_ID is missing or does not match the NUM asset metadata');
    }
    if (!out.walletOnline) missing.push(`wallet RPC unreachable at ${CONFIG.NUMISTA.WALLET_RPC_URL}`);
    if (!out.issuerConfigured) missing.push('NUMISTA_ISSUER_PUBLIC_KEY is not set');

    out.ready = missing.length === 0;
    out.reason = out.ready ? 'live node supports Numista assets' : missing.join('; ');
    return out;
  }

  async capabilities() {
    await this.init();
    return this.capabilitiesSnapshot();
  }

  capabilitiesSnapshot() {
    const sim = this.sim;
    return {
      requestedMode: this.requestedMode,
      mode: this.mode,
      ready: this.mode === 'live' || this.mode === 'simulate',
      reason: this.reason,
      confirmationsRequired: CONFIG.CHAIN.CONFIRMATIONS,
      assetMinting: this.mode === 'live' || this.mode === 'simulate',
      issuerConfigured: this.mode === 'simulate' ? true : !!CONFIG.CHAIN.ISSUER_PUBLIC_KEY,
      currencyAssetId: NUM_ASSET_ID,
      unitsPerNum: CONFIG.CHAIN.UNITS_PER_NUM,
      chainHeight: sim ? sim.height : (this._probe?.height || 0),
      node: {
        daemonUrl: CONFIG.NUMISTA.DAEMON_RPC_URL,
        walletUrl: CONFIG.NUMISTA.WALLET_RPC_URL,
        nettype: this._probe?.nettype || (sim ? 'simulated' : null),
        online: this.mode === 'live' || !!this._probe?.daemonOnline,
        assetRpc: this.mode === 'live' ? true : !!this._probe?.assetRpc,
        buildVersion: this._probe?.buildVersion || null,
        walletOnline: this.mode === 'live' ? true : !!this._probe?.walletOnline
      }
    };
  }

  /* ---- operation execution ---- */

  async execute(op) {
    await this.init();
    if (this.mode === 'simulate') return this.sim.submit(op);
    if (this.mode === 'live') return this._executeLive(op);
    throw new Error(`Chain unavailable: ${this.reason}`);
  }

  async getTxStatus(txHash) {
    await this.init();
    if (this.mode === 'simulate') return this.sim.getTxStatus(txHash);
    if (this.mode !== 'live') return { status: 'pending', confirmations: 0 };

    if (!/^[a-f0-9]{64}$/i.test(String(txHash || ''))) {
      return { status: 'failed', confirmations: 0, error: 'Invalid transaction hash' };
    }

    try {
      const res = await this._daemonRaw('get_transactions', {
        txs_hashes: [txHash],
        decode_as_json: false
      });
      const tx = (res.txs || [])[0];
      if (tx && Number(tx.block_height) > 0 && tx.block_height !== 0) {
        const height = await this.getHeight();
        const confirmations = Math.max(1, height - tx.block_height + 1);
        return { status: 'confirmed', confirmations, includedHeight: tx.block_height };
      }
      const pool = await this._daemonRaw('get_transaction_pool_hashes');
      const hashes = pool.tx_hashes || [];
      if (hashes.includes(txHash)) {
        return { status: 'pending', confirmations: 0 };
      }
      return { status: 'dropped', confirmations: 0 };
    } catch (err) {
      return { status: 'pending', confirmations: 0, error: err.message };
    }
  }

  async getHeight() {
    await this.init();
    if (this.mode === 'simulate') return this.sim.height;
    const info = await this._daemonRaw('get_info');
    return info.height || 0;
  }

  async mineSimBlocks(n = 1) {
    await this.init();
    if (this.mode !== 'simulate' || !this.sim) {
      throw new Error('mineSimBlocks is only available on the simulated chain');
    }
    return this.sim.mine(n);
  }

  async injectFailure(n = 1) {
    await this.init();
    if (this.mode !== 'simulate' || !this.sim) return 0;
    return this.sim.injectFailure(n);
  }

  async getAsset(assetId) {
    await this.init();
    if (this.mode === 'simulate') return this.sim.getAsset(assetId);
    if (this.mode !== 'live') return null;
    try {
      const res = await this._daemonJsonRpc('get_numista_asset', { asset_id: assetId });
      return res.found ? res : null;
    } catch {
      return null;
    }
  }

  async getAssetBalance(assetId, username) {
    await this.init();
    if (this.mode === 'simulate') return this.sim.getBalance(assetId, username);
    if (this.mode !== 'live') return 0;
    try {
      const res = await this._daemonJsonRpc('get_numista_asset_balance', {
        asset_id: assetId,
        username
      });
      return Number(res.balance ?? res.amount ?? 0);
    } catch {
      return 0;
    }
  }

  async getUsernameKey(username) {
    await this.init();
    if (this.mode === 'simulate') return this.sim.getUsernameKey(username);
    if (this.mode !== 'live') return null;
    try {
      const res = await this._daemonJsonRpc('get_numista_asset_username_key', { username });
      if (!res || res.registered !== true) return null;
      return {
        ...res,
        username: res.username || String(username || '').toLowerCase(),
        key: res.asset_key || null
      };
    } catch {
      return null;
    }
  }

  /* ---- live transport ---- */

  async _executeLive(op) {
    const base = {
      account_index: Number(op.accountIndex) || 0,
      do_not_relay: false,
      get_tx_key: false,
      get_tx_hex: false
    };

    let params;
    if (op.kind === 'create_asset') {
      const existingAsset = await this.getAsset(op.assetId).catch(() => null);
      if (existingAsset) {
        return {
          skip: true,
          txHash: null,
          acceptedAtHeight: await this.getHeight(),
          reason: 'asset already exists on-chain'
        };
      }
      params = {
        ...base,
        action: 'create_asset',
        asset_id: op.assetId,
        asset_type: op.assetType,
        max_supply: Number(op.maxSupply),
        metadata_hash: op.metadataHash
      };
    } else if (op.kind === 'mint') {
      // A collectible is unique. If the recipient already holds it, a previous
      // attempt was mined but the queue did not record the confirmation.
      if (op.assetType === 'collectible') {
        const held = Number(await this.getAssetBalance(op.assetId, op.recipient).catch(() => 0));
        if (held >= Number(op.amountUnits)) {
          return {
            skip: true,
            txHash: null,
            acceptedAtHeight: await this.getHeight(),
            reason: 'collectible already minted to recipient'
          };
        }
      }
      params = {
        ...base,
        action: 'mint',
        asset_id: op.assetId,
        asset_type: op.assetType,
        recipient_username: op.recipient,
        amount: Number(op.amountUnits)
      };
    } else if (op.kind === 'transfer') {
      params = {
        ...base,
        action: 'transfer',
        asset_id: op.assetId,
        asset_type: op.assetType,
        username: op.from,
        recipient_username: op.to,
        amount: Number(op.amountUnits)
      };
    } else if (op.kind === 'register_username') {
      const existing = await this.getUsernameKey(op.username).catch(() => null);
      if (existing) {
        if (op.key && existing.key && String(existing.key).toLowerCase() !== String(op.key).toLowerCase()) {
          throw new Error(`Username @${op.username} is already registered with a different on-chain key`);
        }
        return {
          skip: true,
          txHash: null,
          acceptedAtHeight: await this.getHeight(),
          reason: 'username already registered on-chain'
        };
      }
      params = {
        ...base,
        action: 'register_username',
        username: op.username,
        asset_key: op.key || CONFIG.CHAIN.ISSUER_PUBLIC_KEY
      };
    } else {
      throw new Error(`Unsupported chain operation: ${op.kind}`);
    }

    const result = await this._walletJsonRpc('numista_asset_operation', params);
    const txHash = String(result.tx_hash || result.txid || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(txHash)) {
      throw new Error('Wallet RPC returned no valid transaction hash');
    }
    return {
      txHash: txHash.toLowerCase(),
      fee: result.fee,
      raw: result,
      acceptedAtHeight: await this.getHeight()
    };
  }

  async _daemonRaw(endpoint, body = {}) {
    const res = await fetch(`${CONFIG.NUMISTA.DAEMON_RPC_URL}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Daemon HTTP ${res.status}`);
    return res.json();
  }

  async _daemonJsonRpc(method, params = {}) {
    const res = await fetch(`${CONFIG.NUMISTA.DAEMON_RPC_URL}/json_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Daemon HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'Daemon RPC error');
    return json.result;
  }

  async _walletJsonRpc(method, params = {}) {
    return numistaRpc.callWallet(method, params);
  }
}

export const chainAdapter = new ChainAdapter();
export { SimulatedChain, CURRENCY_METADATA };
