/**
 * NumistaRpcBridge
 * ─────────────────────────────────────────────────────────────────────────────
 * Telemetry and wallet I/O for the live Numista (Monero-fork) node.
 *
 * Daemon RPC  → http://127.0.0.1:48081   (monerod --numista-testnet)
 * Wallet RPC  → operator-chosen port (48083 by default). Note: 48082 is the
 *               daemon's ZMQ port on Numista testnet, not wallet RPC.
 *
 * Game balances live in the on-chain NUM asset (see chainLedger / chainAdapter).
 * Deeds are Numista assets too — this file deliberately contains NO tx_extra NFT
 * encoding and NO fabricated transaction hashes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class NumistaRpcBridge {
  constructor() {
    this.daemonUrl  = CONFIG.NUMISTA.DAEMON_RPC_URL;
    this.walletUrl  = CONFIG.NUMISTA.WALLET_RPC_URL;
    this.rpcUser    = CONFIG.NUMISTA.RPC_USER;
    this.rpcPass    = CONFIG.NUMISTA.RPC_PASS;

    this.isDaemonOnline = false;
    this.isWalletOnline = false;
    this.lastChecked    = null;
    this.syncStatus     = { synchronized: false, height: 0, targetHeight: 0 };
    this.liveInfo       = null;

    this._walletOpened = false;

    // Wallet is opened lazily by whoever needs it; never fatal at startup.
    this.checkConnection();
    const timer = setInterval(() => this.checkConnection(), 10_000);
    if (timer.unref) timer.unref();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Authorization header for wallet-rpc basic auth (if set). */
  _authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (this.rpcUser && this.rpcPass) {
      h['Authorization'] = 'Basic ' + Buffer.from(`${this.rpcUser}:${this.rpcPass}`).toString('base64');
      return h;
    }

    // Fall back to monero-wallet-rpc.<port>.login next to the app or wallet dir.
    const port = (() => {
      try { return new URL(this.walletUrl).port || '48083'; } catch { return '48083'; }
    })();
    const candidates = [
      process.env.NUMISTA_WALLET_DIR,
      process.cwd(),
      path.join(__dirname, '..', '..')
    ].filter(Boolean).map(dir => path.join(dir, `monero-wallet-rpc.${port}.login`));

    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const match = fs.readFileSync(file, 'utf8').trim().match(/^([^:\s]+):(\S+)/);
        if (match) {
          h['Authorization'] = 'Basic ' + Buffer.from(`${match[1]}:${match[2]}`).toString('base64');
          break;
        }
      } catch { /* keep looking */ }
    }
    return h;
  }

  async _daemonJsonRpc(method, params = {}) {
    const res = await fetch(`${this.daemonUrl}/json_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Daemon HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`Daemon RPC error: ${json.error.message}`);
    return json.result;
  }

  async _daemonRaw(endpoint, body = {}) {
    const res = await fetch(`${this.daemonUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Daemon HTTP ${res.status}`);
    return res.json();
  }

  async _walletRpc(method, params = {}) {
    const res = await fetch(`${this.walletUrl}/json_rpc`, {
      method: 'POST',
      headers: this._authHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) throw new Error(`Wallet-RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`Wallet-RPC error: ${json.error.message}`);
    this.isWalletOnline = true;
    return json.result;
  }

  /** Convert piconero (atomic units, 10^12) to NUM float. */
  _toNum(atomic) {
    return Number(atomic || 0) / 1e12;
  }

  /** Convert NUM float to piconero. */
  _toPico(num) {
    return Math.round(Number(num || 0) * 1e12);
  }

  // ── Wallet open ───────────────────────────────────────────────────────────

  async openWallet(filename = CONFIG.CHAIN.ISSUER_WALLET_FILE, password = '') {
    try {
      await this._walletRpc('open_wallet', { filename, password });
      this.isWalletOnline = true;
      this._walletOpened = true;
      console.log('[wallet-rpc] Opened wallet:', filename);
      return { opened: true, filename };
    } catch (err) {
      console.warn('[wallet-rpc] Could not open wallet:', err.message);
      return { opened: false, filename, error: err.message };
    }
  }

  // ── Connection / sync status ──────────────────────────────────────────────

  async checkConnection() {
    try {
      const data = await this._daemonRaw('get_info');
      this.liveInfo = data;
      this.isDaemonOnline = (data.status === 'OK');
      this.lastChecked = new Date().toISOString();

      const target = data.target_height > 0 ? data.target_height : data.height;
      const pct = target > 0 ? Math.min(100, +((data.height / target) * 100).toFixed(1)) : 100;

      this.syncStatus = {
        synchronized: data.synchronized !== undefined ? data.synchronized : true,
        height: data.height,
        targetHeight: target,
        syncPercentage: pct,
        difficulty: data.difficulty,
        topBlockHash: data.top_block_hash,
        nettype: data.nettype || 'numista-testnet',
        version: data.version,
        txPoolSize: data.tx_pool_size || 0,
        adjustedTime: data.adjusted_time
      };
      return true;
    } catch {
      this.isDaemonOnline = false;
      return false;
    }
  }

  async getNetworkInfo() {
    await this.checkConnection();

    if (this.isDaemonOnline && this.liveInfo) {
      return {
        online: true,
        mode: 'live_online_blockchain',
        nettype: this.liveInfo.nettype || 'numista-testnet',
        height: this.liveInfo.height,
        difficulty: this.liveInfo.difficulty,
        topBlockHash: this.liveInfo.top_block_hash,
        txPoolSize: this.liveInfo.tx_pool_size || 0,
        version: this.liveInfo.version,
        target: this.liveInfo.target || 120,
        syncStatus: this.syncStatus,
        daemonAddress: this.daemonUrl
      };
    }
    return {
      online: false,
      mode: 'node_offline',
      nettype: 'numista-testnet',
      syncStatus: this.syncStatus,
      daemonAddress: this.daemonUrl
    };
  }

  setDaemonUrl(url) {
    if (!url || !url.startsWith('http')) throw new Error('Invalid Node URL');
    this.daemonUrl = url.replace(/\/$/, '');
    this.checkConnection();
    return { daemonUrl: this.daemonUrl, status: 'UPDATED' };
  }

  // ── Wallet-RPC: balances ──────────────────────────────────────────────────

  async getWalletBalance(accountIndex = 0) {
    try {
      const result = await this._walletRpc('get_balance', { account_index: accountIndex });
      return {
        balance: this._toNum(result.balance),
        unlockedBalance: this._toNum(result.unlocked_balance),
        isLiveDaemonConnected: this.isDaemonOnline,
        daemonHeight: this.syncStatus.height || 0,
        source: 'wallet_rpc_live'
      };
    } catch (err) {
      this.isWalletOnline = false;
      return {
        balance: 0,
        unlockedBalance: 0,
        isLiveDaemonConnected: this.isDaemonOnline,
        daemonHeight: this.syncStatus.height || 0,
        source: 'unavailable',
        error: `wallet-rpc unreachable: ${err.message}`
      };
    }
  }

  async getTransferHistory(accountIndex = 0, limit = 20) {
    try {
      const result = await this._walletRpc('get_transfers', {
        in: true,
        out: true,
        pending: true,
        pool: true,
        account_index: accountIndex
      });

      const all = [
        ...(result.in || []).map(t => ({ ...t, direction: 'in' })),
        ...(result.out || []).map(t => ({ ...t, direction: 'out' })),
        ...(result.pending || []).map(t => ({ ...t, direction: 'pending' })),
        ...(result.pool || []).map(t => ({ ...t, direction: 'pool' }))
      ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit);

      return all.map(t => ({
        txHash: t.txid,
        amount: this._toNum(t.amount),
        type: t.direction === 'in' ? 'credit' : 'debit',
        direction: t.direction,
        height: t.height || t.block_height,
        timestamp: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null,
        confirmations: t.confirmations || 0,
        fee: t.fee ? this._toNum(t.fee) : 0,
        note: t.note || ''
      }));
    } catch {
      return [];
    }
  }

  // ── Wallet-RPC: native-coin transfer (gas / treasury operations) ──────────

  async sendTransfer({ toAddress, amountNum, paymentId = '', priority = 1, accountIndex = 0 }) {
    if (!toAddress) throw new Error('A destination address is required');
    const result = await this._walletRpc('transfer', {
      destinations: [{ address: toAddress, amount: this._toPico(amountNum) }],
      account_index: accountIndex,
      priority,
      get_tx_key: true,
      payment_id: paymentId
    });
    return {
      txHash: result.tx_hash,
      txKey: result.tx_key,
      fee: this._toNum(result.fee),
      amount: amountNum
    };
  }

  async createSubaddress(label = '', accountIndex = 0) {
    const result = await this._walletRpc('create_address', { account_index: accountIndex, label });
    return { address: result.address, addressIndex: result.address_index, accountIndex };
  }

  async getPrimaryAddress(accountIndex = 0) {
    const result = await this._walletRpc('get_address', { account_index: accountIndex });
    return result.address;
  }

  async createAccount(label = '') {
    const result = await this._walletRpc('create_account', { label });
    return { accountIndex: result.account_index, address: result.address };
  }

  // ── Numista asset RPC (upgraded node) ─────────────────────────────────────

  /**
   * Issues an asset operation on the custodial issuer wallet. This is the ONLY
   * entry point the game uses to create assets, mint, transfer or register
   * usernames. Returns the real transaction hash from the wallet.
   */
  async assetOperation(params) {
    const result = await this._walletRpc('numista_asset_operation', params);
    return {
      txHash: result.tx_hash || result.txid,
      fee: this._toNum(result.fee),
      raw: result
    };
  }

  async getAsset(assetId) {
    const res = await this._daemonJsonRpc('get_numista_asset', { asset_id: assetId });
    return res.found ? res : null;
  }

  async getAssetBalance(assetId, username) {
    const res = await this._daemonJsonRpc('get_numista_asset_balance', { asset_id: assetId, username });
    return Number(res.balance ?? res.amount ?? 0);
  }

  async getAssetUsernameKey(username) {
    const res = await this._daemonJsonRpc('get_numista_asset_username_key', { username });
    return res.found ? res : null;
  }

  // ── Daemon: mining ────────────────────────────────────────────────────────

  async submitBlock(blockBlobHex) {
    const result = await this._daemonRaw('submit_block', [blockBlobHex]);
    if (result.status !== 'OK') throw new Error(`submit_block failed: ${JSON.stringify(result)}`);
    return result;
  }

  async getBlockTemplate(walletAddress, reserveSize = 60) {
    const result = await this._daemonJsonRpc('get_block_template', {
      wallet_address: walletAddress,
      reserve_size: reserveSize
    });
    return {
      blockTemplateBlob: result.blocktemplate_blob,
      blockhashingBlob: result.blockhashing_blob,
      difficulty: result.difficulty,
      height: result.height,
      expectedReward: result.expected_reward,
      seedHash: result.seed_hash,
      seedHeight: result.seed_height,
      reservedOffset: result.reserved_offset,
      nextSeedHash: result.next_seed_hash
    };
  }

  async getLastBlockHeader() {
    const result = await this._daemonJsonRpc('get_last_block_header');
    return result.block_header;
  }

  async getTxPoolStats() {
    try {
      const result = await this._daemonRaw('get_transaction_pool_stats');
      return result.pool_stats || {};
    } catch {
      return {};
    }
  }

  async getTransaction(txHash) {
    try {
      const result = await this._daemonRaw('get_transactions', {
        txs_hashes: [txHash],
        decode_as_json: true
      });
      return result.txs?.[0] || null;
    } catch {
      return null;
    }
  }

  async getPeers() {
    try {
      const result = await this._daemonRaw('get_peer_list');
      return { whitelist: result.white_list || [], graylist: result.gray_list || [] };
    } catch {
      return { whitelist: [], graylist: [] };
    }
  }

  // ── Extended daemon RPC ───────────────────────────────────────────────────

  async getDaemonInfoRaw() { return this._daemonRaw('get_info'); }
  async getVersion() { return this._daemonJsonRpc('get_version'); }
  async getHardForkInfo() { return this._daemonJsonRpc('hard_fork_info'); }
  async getSyncInfo() { return this._daemonJsonRpc('sync_info'); }
  async getFeeEstimate(graceBlocks = 10) { return this._daemonJsonRpc('get_fee_estimate', { grace_blocks: graceBlocks }); }
  async getHeight() { return this._daemonRaw('get_height'); }
  async getBlockCount() { return this._daemonJsonRpc('get_block_count'); }
  async getCoinbaseTxSum(height, count = 1) { return this._daemonJsonRpc('get_coinbase_tx_sum', { height, count }); }
  async getBlockHeaderByHeight(height) { return this._daemonJsonRpc('get_block_header_by_height', { height }); }
  async getBlockHeaderByHash(hash) { return this._daemonJsonRpc('get_block_header_by_hash', { hash }); }
  async getBlock(params = {}) { return this._daemonJsonRpc('get_block', params); }
  async getConnections() { return this._daemonJsonRpc('get_connections'); }
  async getTransactionPool() { return this._daemonRaw('get_transaction_pool'); }
  async getTxPoolBacklog() { return this._daemonRaw('get_txpool_backlog'); }

  async getOutputHistogram(amounts = [], minCount = 0, maxCount = 0, unlocked = false, recentCutoff = 0) {
    return this._daemonJsonRpc('get_output_histogram', {
      amounts, min_count: minCount, max_count: maxCount, unlocked, recent_cutoff: recentCutoff
    });
  }

  async getOutputDistribution(amounts = [], cumulative = false, fromHeight = 0, toHeight = 0) {
    return this._daemonJsonRpc('get_output_distribution', {
      amounts, cumulative, from_height: fromHeight, to_height: toHeight
    });
  }

  async getAlternateChains() { return this._daemonJsonRpc('get_alternate_chains'); }
  async getMinerData() { return this._daemonRaw('get_miner_data'); }

  async getMiningStatus() {
    try { return await this._daemonRaw('mining_status'); }
    catch { return { active: false, status: 'UNAVAILABLE' }; }
  }

  async getBans() {
    try { return await this._daemonJsonRpc('get_bans'); }
    catch { return { bans: [] }; }
  }

  async getNetStats() {
    try { return await this._daemonJsonRpc('get_net_stats'); }
    catch { return {}; }
  }

  async getLimit() {
    try { return await this._daemonJsonRpc('get_limit'); }
    catch { return {}; }
  }

  async relayTx(txids = []) { return this._daemonJsonRpc('relay_tx', { txids }); }

  async callDaemon(method, params = {}, useJsonRpc = true) {
    if (useJsonRpc) return this._daemonJsonRpc(method, params);
    return this._daemonRaw(method, params);
  }

  // ── Extended wallet RPC ───────────────────────────────────────────────────

  async getWalletHeight() { return this._walletRpc('get_height'); }
  async getWalletAccounts(tag = '') { return this._walletRpc('get_accounts', tag ? { tag } : {}); }

  async getWalletAddress(accountIndex = 0, addressIndices = []) {
    const params = { account_index: accountIndex };
    if (Array.isArray(addressIndices) && addressIndices.length) params.address_index = addressIndices;
    return this._walletRpc('get_address', params);
  }

  async refreshWallet(startHeight) {
    const params = {};
    if (typeof startHeight === 'number') params.start_height = startHeight;
    return this._walletRpc('refresh', params);
  }

  async rescanBlockchain() { return this._walletRpc('rescan_blockchain'); }
  async rescanSpent() { return this._walletRpc('rescan_spent'); }
  async storeWallet() { return this._walletRpc('store'); }
  async getTransferByTxid(txid, accountIndex = 0) { return this._walletRpc('get_transfer_by_txid', { txid, account_index: accountIndex }); }
  async getPayments(paymentId) { return this._walletRpc('get_payments', { payment_id: paymentId }); }

  async makeIntegratedAddress(standardAddress = '', paymentId = '') {
    return this._walletRpc('make_integrated_address', { standard_address: standardAddress, payment_id: paymentId });
  }

  async splitIntegratedAddress(integratedAddress) {
    return this._walletRpc('split_integrated_address', { integrated_address: integratedAddress });
  }

  async queryKey(keyType = 'view_key') { return this._walletRpc('query_key', { key_type: keyType }); }
  async getWalletVersion() { return this._walletRpc('get_version'); }

  async validateAddress(address, anyNetType = false, allowOpenalias = false) {
    return this._walletRpc('validate_address', { address, any_net_type: anyNetType, allow_openalias: allowOpenalias });
  }

  async signTransfer(unsignedTxset, exportRaw = false) {
    return this._walletRpc('sign_transfer', { unsigned_txset: unsignedTxset, export_raw: exportRaw });
  }

  async submitTransfer(txDataHex) { return this._walletRpc('submit_transfer', { tx_data_hex: txDataHex }); }
  async describeTransfer(unsignedTxset = '', multisigTxset = '') {
    return this._walletRpc('describe_transfer', { unsigned_txset: unsignedTxset, multisig_txset: multisigTxset });
  }

  async sweepAll(address, accountIndex = 0, priority = 1, ringSize = 11) {
    return this._walletRpc('sweep_all', { address, account_index: accountIndex, priority, ring_size: ringSize, get_tx_keys: true });
  }

  async setAccountLabel(accountIndex, label) { return this._walletRpc('label_account', { account_index: accountIndex, label }); }
  async setSubaddressLabel(accountIndex, addressIndex, label) {
    return this._walletRpc('label_address', { account_index: accountIndex, address_index: [addressIndex], label });
  }

  async callWallet(method, params = {}) { return this._walletRpc(method, params); }

  async getNetworkDetails() {
    const [network, fee, hf, sync, peers, txPool, version, mining] = await Promise.allSettled([
      this.getNetworkInfo(),
      this.getFeeEstimate(),
      this.getHardForkInfo(),
      this.getSyncInfo(),
      this.getPeers(),
      this.getTxPoolStats(),
      this.getVersion(),
      this.getMiningStatus()
    ]);
    return {
      network: network.status === 'fulfilled' ? network.value : null,
      fee: fee.status === 'fulfilled' ? fee.value : null,
      hardFork: hf.status === 'fulfilled' ? hf.value : null,
      syncInfo: sync.status === 'fulfilled' ? sync.value : null,
      peers: peers.status === 'fulfilled' ? peers.value : null,
      txPoolStats: txPool.status === 'fulfilled' ? txPool.value : null,
      version: version.status === 'fulfilled' ? version.value : null,
      miningStatus: mining.status === 'fulfilled' ? mining.value : null
    };
  }
}

export const numistaRpc = new NumistaRpcBridge();
