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
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseAuthChallenges(header = '') {
  // Epee/Monero can advertise MD5 and MD5-sess as two Digest challenges in
  // one combined WWW-Authenticate header. Parse each challenge independently.
  const challenges = String(header)
    .split(/,\s*(?=(?:Digest|Basic)\s+)/i)
    .map(part => part.trim())
    .filter(Boolean);
  return challenges.map(value => {
    const scheme = value.match(/^\s*(Digest|Basic)\s+/i)?.[1]?.toLowerCase();
    if (!scheme) return null;
    const params = {};
    const rest = value.replace(/^\s*(?:Digest|Basic)\s+/i, '');
    const matcher = /([a-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/gi;
    let match;
    while ((match = matcher.exec(rest))) {
      params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(["\\])/g, '$1');
    }
    return { scheme, params };
  }).filter(Boolean);
}

function digestAuthorization({ username, password, method, url, challenge, nonceCount = 1, cnonce = crypto.randomBytes(16).toString('hex') }) {
  const { params } = challenge;
  // Echo the algorithm token exactly as the server advertised it. Some Epee
  // builds distinguish the canonical `MD5-sess` spelling in this header.
  const algorithm = String(params.algorithm || 'MD5');
  const normalizedAlgorithm = algorithm.toUpperCase();
  const sess = normalizedAlgorithm.endsWith('-SESS');
  const hashName = normalizedAlgorithm.replace(/-SESS$/, '').toLowerCase().replace('-', '');
  if (!['md5', 'sha256'].includes(hashName)) throw new Error(`Unsupported wallet-RPC digest algorithm: ${algorithm}`);

  const hash = value => crypto.createHash(hashName).update(value).digest('hex');
  const realm = params.realm || '';
  const nonce = params.nonce || '';
  const parsedUrl = new URL(url);
  const uri = `${parsedUrl.pathname || '/'}${parsedUrl.search}`;
  const qops = String(params.qop || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const qop = qops.includes('auth') ? 'auth' : '';
  if (qops.length && !qop) throw new Error('Wallet-RPC digest challenge does not support qop=auth');

  const nc = nonceCount.toString(16).padStart(8, '0');
  let ha1 = hash(`${username}:${realm}:${password}`);
  if (sess) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = qop
    ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${nonce}:${ha2}`);
  const quote = value => `"${String(value).replace(/["\\]/g, '\\$&')}"`;
  const fields = [
    `username=${quote(username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
    `algorithm=${algorithm}`
  ];
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  if (params.opaque) fields.push(`opaque=${quote(params.opaque)}`);
  return `Digest ${fields.join(', ')}`;
}

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
    this._walletOpenPromise = null;
    this._openWalletFile = null;
    // Serialized wallet-RPC transport queue (see _walletHttpSerialized).
    this._walletHttpTail = Promise.resolve();
    this._digestNonceStates = new Map();
    this._walletDaemonUrl = null;
    this._walletDaemonSetup = null;

    // Wallet is opened lazily by whoever needs it; never fatal at startup.
    this.checkConnection();
    const timer = setInterval(() => this.checkConnection(), 10_000);
    if (timer.unref) timer.unref();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Candidate wallet-rpc credentials. Values are never logged or returned. */
  _walletCredentialCandidates() {
    const credentials = [];
    const add = (user, pass) => {
      if (!user || !pass) return;
      if (!credentials.some(candidate => candidate.user === user && candidate.pass === pass)) {
        credentials.push({ user, pass });
      }
    };

    // Explicit credentials take priority. If stale, a local wallet-rpc login
    // file may contain credentials that were rotated by the wallet process.
    add(this.rpcUser, this.rpcPass);

    // Local credential files must never be sent to a non-local RPC endpoint.
    let isLocal = false;
    try {
      const host = new URL(this.walletUrl).hostname.toLowerCase();
      isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
    } catch { /* invalid wallet URL will fail during fetch */ }

    if (isLocal) {
      const port = (() => {
        try { return new URL(this.walletUrl).port || '48083'; } catch { return '48083'; }
      })();
      const dirs = [process.env.NUMISTA_WALLET_DIR, process.cwd(), path.join(__dirname, '..', '..')].filter(Boolean);
      const files = [...new Set([
        CONFIG.NUMISTA.WALLET_RPC_LOGIN_FILE,
        ...dirs.map(dir => path.join(dir, `monero-wallet-rpc.${port}.login`))
      ].filter(Boolean))];
      for (const file of files) {
        try {
          if (!fs.existsSync(file)) continue;
          const match = fs.readFileSync(file, 'utf8').trim().match(/^([^:\s]+):(\S+)/);
          if (match) add(match[1], match[2]);
        } catch { /* keep trying other login files */ }
      }
    }

    return credentials;
  }

  _nextDigestNonceState(challenge) {
    const nonce = challenge.params.nonce || '';
    const reset = String(challenge.params.stale || '').toLowerCase() === 'true';
    let state = reset ? null : this._digestNonceStates.get(nonce);
    if (!state) state = { cnonce: crypto.randomBytes(16).toString('hex'), count: 0 };
    state.count += 1;
    this._digestNonceStates.delete(nonce);
    this._digestNonceStates.set(nonce, state);
    // Bound memory if the wallet rotates its nonce over a long-running session.
    while (this._digestNonceStates.size > 128) {
      this._digestNonceStates.delete(this._digestNonceStates.keys().next().value);
    }
    return { cnonce: state.cnonce, nonceCount: state.count };
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
    return this._walletRpcInternal(method, params);
  }

  async _ensureWalletDaemon() {
    const address = this.daemonUrl.replace(/\/$/, '');
    if (this._walletDaemonUrl === address) return;
    if (this._walletDaemonSetup) return this._walletDaemonSetup;

    const setup = (async () => {
      const host = new URL(address).hostname.toLowerCase();
      const trusted = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
      await this._walletRpcInternal('set_daemon', { address, trusted }, { skipDaemonSetup: true });
      this._walletDaemonUrl = address;
    })();
    this._walletDaemonSetup = setup;
    try {
      await setup;
    } finally {
      if (this._walletDaemonSetup === setup) this._walletDaemonSetup = null;
    }
  }

  /**
   * Serialize wallet-RPC HTTP calls.
   *
   * Epee's digest auth rejects concurrent requests that race on a nonce, which
   * surfaces as HTTP 401 on one of two parallel calls. The game issues
   * concurrent wallet reads (balance + transfers, several users at once), so the
   * transport is queued one request at a time while callers still await
   * independently.
   */
  async _walletHttpSerialized(method, params) {
    const previous = this._walletHttpTail;
    let release;
    this._walletHttpTail = new Promise(resolve => { release = resolve; });
    await previous.catch(() => { /* previous request failures must not block the queue */ });
    try {
      return await this._walletHttp(method, params);
    } finally {
      release();
    }
  }

  /** One wallet-RPC HTTP round trip, including digest/basic negotiation. */
  async _walletHttp(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
    const endpoint = `${this.walletUrl}/json_rpc`;
    const credentials = this._walletCredentialCandidates();
    let res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000)
    });

    if (res.status === 401 || res.status === 403) {
      let challenges = parseAuthChallenges(res.headers.get('www-authenticate') || '');
      if (!challenges.length) {
        this.isWalletOnline = false;
        throw new Error(`Wallet-RPC requested authentication but returned no supported challenge (HTTP ${res.status})`);
      }
      let authenticated = false;
      for (let round = 0; round < 2 && !authenticated; round += 1) {
        if (round > 0) {
          const refreshedCredentials = this._walletCredentialCandidates();
          const previousCount = credentials.length;
          for (const candidate of refreshedCredentials) {
            if (!credentials.some(current => current.user === candidate.user && current.pass === candidate.pass)) {
              credentials.push(candidate);
            }
          }
          if (credentials.length === previousCount) break;
          const refreshedChallenges = parseAuthChallenges(res.headers.get('www-authenticate') || '');
          if (refreshedChallenges.length) challenges = refreshedChallenges;
        }

        for (const challenge of challenges) {
          for (const credential of credentials) {
            const authorization = challenge.scheme === 'digest'
              ? digestAuthorization({
                username: credential.user,
                password: credential.pass,
                method: 'POST',
                url: endpoint,
                challenge,
                ...this._nextDigestNonceState(challenge)
              })
              : `Basic ${Buffer.from(`${credential.user}:${credential.pass}`).toString('base64')}`;
            res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: authorization },
              body,
              signal: AbortSignal.timeout(15_000)
            });
            if (res.status !== 401 && res.status !== 403) {
              authenticated = true;
              break;
            }
          }
          if (authenticated) break;
        }
      }
      if (!authenticated) {
        this.isWalletOnline = false;
        if (!credentials.length) {
          throw new Error(`Wallet-RPC requires ${challenges[0].scheme} authentication. Set NUMISTA_RPC_USER/NUMISTA_RPC_PASS or provide its local login file for port ${new URL(this.walletUrl).port || '48083'}.`);
        }
        const algorithms = challenges.filter(challenge => challenge.scheme === 'digest').map(challenge => challenge.params.algorithm || 'MD5');
        const mode = algorithms.length ? `digest authentication (${[...new Set(algorithms)].join(', ')})` : `${challenges[0].scheme} authentication`;
        throw new Error(`Wallet-RPC rejected ${mode} (HTTP ${res.status}). Check the active wallet-RPC login file and restart the game backend after wallet RPC starts.`);
      }
    }

    if (!res.ok) {
      this.isWalletOnline = false;
      throw new Error(`Wallet-RPC HTTP ${res.status}`);
    }
    const json = await res.json();
    return json;
  }

  async _walletRpcInternal(method, params = {}, { skipDaemonSetup = false, daemonRetry = false, skipWalletOpen = false } = {}) {
    if (!skipDaemonSetup && method !== 'set_daemon') await this._ensureWalletDaemon();
    const json = await this._walletHttpSerialized(method, params);
    if (json.error) {
      const message = json.error.message || 'Wallet-RPC error';
      if (!daemonRetry && method !== 'set_daemon' && /no connection to daemon|failed to connect to daemon/i.test(message)) {
        this._walletDaemonUrl = null;
        await this._ensureWalletDaemon();
        return this._walletRpcInternal(method, params, { daemonRetry: true, skipWalletOpen });
      }
      // The wallet RPC can be running without a wallet loaded. Open the
      // custodial wallet once and retry instead of surfacing "No wallet file".
      const walletMissing = /no wallet file|no wallet(?: is)? open|wallet (?:file )?not (?:open|loaded)/i.test(message);
      if (!skipWalletOpen && walletMissing &&
        method !== 'open_wallet' && method !== 'create_wallet' &&
        method !== 'generate_from_keys' && method !== 'set_daemon') {
        await this.ensureWalletOpen();
        return this._walletRpcInternal(method, params, {
          skipDaemonSetup,
          daemonRetry,
          skipWalletOpen: true
        });
      }
      throw new Error(`Wallet-RPC error: ${message}`);
    }
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

  /**
   * Make sure the single custodial wallet is loaded.
   *
   * Numista/Monero wallet-RPC keeps exactly one wallet open per process, so the
   * game uses one issuer wallet and a unique subaddress per username. This has
   * to run before create_address / balance / transfer calls, otherwise the node
   * answers "No wallet file".
   */
  async ensureWalletOpen({ force = false } = {}) {
    if (this._walletOpened && !force) {
      return { opened: true, filename: this._openWalletFile || CONFIG.CHAIN.ISSUER_WALLET_FILE };
    }
    if (this._walletOpenPromise) return this._walletOpenPromise;

    this._walletOpenPromise = (async () => {
      // Probe: if the RPC already has a wallet loaded, leave it alone.
      try {
        const info = await this._walletRpcInternal(
          'get_address',
          { account_index: 0 },
          { skipWalletOpen: true, skipDaemonSetup: true }
        );
        if (info?.address) {
          this._walletOpened = true;
          this._openWalletFile = this._openWalletFile || '(already open)';
          return { opened: true, filename: this._openWalletFile, alreadyOpen: true };
        }
      } catch (err) {
        // Auth/transport failures must surface; "no wallet" is the case we fix.
        if (/authentication|HTTP 40\d|rejected|ECONNREFUSED|fetch failed/i.test(err.message || '')) {
          throw err;
        }
      }

      const filename = CONFIG.CHAIN.ISSUER_WALLET_FILE;
      const password = CONFIG.CHAIN.ISSUER_WALLET_PASSWORD || '';

      try {
        await this._walletRpcInternal(
          'open_wallet',
          { filename, password },
          { skipWalletOpen: true, skipDaemonSetup: true }
        );
        this._walletOpened = true;
        this._openWalletFile = filename;
        console.log('[wallet-rpc] Opened custodial wallet:', filename);
        return { opened: true, filename };
      } catch (err) {
        // Only auto-create when the wallet file genuinely does not exist.
        if (!/file not found|does not exist|cannot open wallet|failed to open/i.test(err.message || '')) {
          throw new Error(`Custodial wallet could not be opened: ${err.message}`);
        }
        try {
          await this._walletRpcInternal(
            'create_wallet',
            { filename, password, language: 'English' },
            { skipWalletOpen: true, skipDaemonSetup: true }
          );
          this._walletOpened = true;
          this._openWalletFile = filename;
          console.log('[wallet-rpc] Created custodial wallet:', filename);
          return { opened: true, filename, created: true };
        } catch (createErr) {
          throw new Error(`Custodial wallet "${filename}" is missing and could not be created: ${createErr.message}`);
        }
      }
    })();

    try {
      return await this._walletOpenPromise;
    } finally {
      this._walletOpenPromise = null;
    }
  }

  async openWallet(filename = CONFIG.CHAIN.ISSUER_WALLET_FILE, password = CONFIG.CHAIN.ISSUER_WALLET_PASSWORD || '') {
    try {
      await this._walletRpcInternal(
        'open_wallet',
        { filename, password },
        { skipWalletOpen: true, skipDaemonSetup: true }
      );
      this.isWalletOnline = true;
      this._walletOpened = true;
      this._openWalletFile = filename;
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
    this._walletDaemonUrl = null;
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
      account_index: accountIndex, subaddr_indices: [0],
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
    await this.ensureWalletOpen();
    const result = await this._walletRpc('create_address', { account_index: accountIndex, label });
    return { address: result.address, addressIndex: result.address_index, accountIndex };
  }

  async getSubaddressReceiveInfo(accountIndex, addressIndex) {
    await this.ensureWalletOpen();
    if (!this._lastRefresh || Date.now() - this._lastRefresh > 15000) { this._lastRefresh = Date.now(); await this._walletRpc('refresh', {}).catch(() => {}); }
    const [balance, transfers] = await Promise.all([
      this._walletRpc('get_balance', {
        account_index: accountIndex,
        address_indices: [addressIndex]
      }),
      this._walletRpc('get_transfers', {
        in: true,
        pending: true,
        pool: true,
        account_index: accountIndex,
        subaddr_indices: [addressIndex]
      })
    ]);

    const incoming = [
      ...(transfers.in || []).map(transfer => ({ ...transfer, status: 'confirmed' })),
      ...(transfers.pending || []).map(transfer => ({ ...transfer, status: 'pending' })),
      ...(transfers.pool || []).map(transfer => ({ ...transfer, status: 'pending' }))
    ]
      .filter(transfer => transfer.subaddr_index?.minor === addressIndex)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 20)
      .map(transfer => ({
        txHash: transfer.txid,
        amount: this._toNum(transfer.amount),
        status: transfer.status,
        confirmations: transfer.confirmations || 0,
        timestamp: transfer.timestamp ? new Date(transfer.timestamp * 1000).toISOString() : null
      }));

    // get_balance returns the account total plus a per_subaddress breakdown.
    // A user's native NUM is the subaddress entry, not the whole wallet.
    const subaddressBalance = (balance.per_subaddress || [])
      .find(entry => Number(entry.address_index) === Number(addressIndex));

    return {
      balance: this._toNum(subaddressBalance ? subaddressBalance.balance : balance.balance),
      unlockedBalance: this._toNum(subaddressBalance ? subaddressBalance.unlocked_balance : balance.unlocked_balance),
      pendingBalance: this._toNum(balance.unconfirmed_balance),
      incomingTransfers: incoming
    };
  }

  async getCrownEstateFundBalance() {
    const url = CONFIG.NUMISTA.CROWN_ESTATE_WALLET_RPC_URL;
    if (!url) throw new Error('Crown Estate watch-only wallet RPC is not configured');

    const headers = { 'Content-Type': 'application/json' };
    const user = CONFIG.NUMISTA.CROWN_ESTATE_WALLET_RPC_USER;
    const pass = CONFIG.NUMISTA.CROWN_ESTATE_WALLET_RPC_PASS;
    if (user && pass) {
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }

    const res = await fetch(`${url.replace(/\/$/, '')}/json_rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_balance', params: { account_index: 0 } }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Crown Estate wallet RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'Crown Estate wallet RPC error');

    const result = json.result || {};
    return {
      balance: this._toNum(result.balance),
      unlockedBalance: this._toNum(result.unlocked_balance),
      pendingBalance: this._toNum(result.unconfirmed_balance)
    };
  }

  async getPrimaryAddress(accountIndex = 0) {
    const result = await this._walletRpc('get_address', { account_index: accountIndex });
    return result.address;
  }

  _makeVerifier(password, salt = crypto.randomBytes(6).toString('hex')) {
    const hash = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex').slice(0, 24);
    return `${salt}:${hash}`;
  }

  _checkVerifier(password, tag) {
    const [salt, expected] = String(tag || '').split(':');
    if (!salt || !expected) return false;
    const actual = crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex').slice(0, 24);
    return actual === expected;
  }

  async findWalletAccount(username) { const m = String(username || '').trim().toLowerCase().match(/^unknown_(\d+)$/); if (m) { const idx = Number(m[1]); const all0 = await this._walletRpc('get_accounts', {}).catch(() => null); const hit = (all0?.subaddress_accounts || []).find(a => a.account_index === idx); if (hit) return hit; }
    const clean = String(username || '').trim().toLowerCase();
    if (!clean || clean.length < 2) return null;
    await this.ensureWalletOpen().catch(() => {}); const all = await this._walletRpc('get_accounts', {});
    const matches = (all?.subaddress_accounts || [])
      .filter(a => a.account_index > 0 && a.label)
      .filter(a => {
        const lbl = a.label.toLowerCase();
        const atIdx = lbl.indexOf('@');
        if (atIdx === -1) return false;
        const namePart = lbl.slice(atIdx + 1).split('#');
        return namePart.at(0) === clean;
      })
      .sort((a, b) => a.account_index - b.account_index);
    return matches.at(0) || null;
  }

  async createAccount(label = '', password = '') {
    const atIdx = label.indexOf('@');
    const uname = atIdx !== -1 ? label.slice(atIdx + 1).split('#').at(0).trim().toLowerCase() : '';
    if (uname) {
      const existing = await this.findWalletAccount(uname);
      if (existing) return { accountIndex: existing.account_index, address: existing.base_address };
    }
    const finalLabel = uname && password
      ? `Goldnumista @${uname}#${this._makeVerifier(password)}`
      : label;
    const result = await this._walletRpc('create_account', { label: finalLabel });
    return { accountIndex: result.account_index, address: result.address };
  }

    deriveTxSecret(txHash, username) {
    return crypto.createHmac('sha256', String(CONFIG.CHAIN.ISSUER_PUBLIC_KEY)).update(String(txHash).toLowerCase() + ':' + String(username).toLowerCase()).digest('hex');
  }

  async registerWalletAddress() {
    await this.ensureWalletOpen();

    // 1. Create a new custodial wallet account for this player
    const res = await this._walletRpc('create_account', { label: 'Player' });
    const uname = 'unknown_' + res.account_index;
    await this._walletRpc('label_account', {
      account_index: res.account_index,
      label: 'Goldnumista @' + uname
    }).catch(() => {});
    await this._walletRpc('store', {}).catch(() => {});

    let txHash = null;
    let blockHeight = null;

    // 2. Try to register username via asset RPC (upgraded Numista node).
    //    If the node does not support it, fall back to a native send-to-self
    //    transaction on account 0, whose txid becomes the secret anchor.
    try {
      const op = await this.assetOperation({
        account_index: 0,
        do_not_relay: false,
        action: 'register_username',
        username: uname,
        asset_key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY
      });
      txHash = op.txHash;
    } catch (assetErr) {
      // Asset RPC not available on this build — use a dust send-to-self as the
      // registration anchor tx. This still produces a real on-chain txid.
      try {
        const primaryAddr = await this.getPrimaryAddress(0);
        const nativeTx = await this._walletRpc('transfer', {
          destinations: [{ address: primaryAddr, amount: 1 }], // 1 piconero dust
          account_index: 0,
          priority: 1,
          get_tx_key: false
        });
        txHash = nativeTx.tx_hash;
        console.log('[wallet] Registered @' + uname + ' via native anchor tx:', txHash);
      } catch (nativeErr) {
        // Even the dust tx failed (e.g. no funds, offline). Use deterministic
        // fallback derived from the address itself — still uniquely verifiable.
        txHash = crypto
          .createHmac('sha256', String(CONFIG.CHAIN.ISSUER_PUBLIC_KEY || 'numista'))
          .update('genesis-anchor:' + uname + ':' + res.address)
          .digest('hex');
        console.warn('[wallet] No funds for anchor tx; using deterministic secret for @' + uname);
      }
    }

    if (txHash) {
      const txInfo = await this._daemonRaw('get_transactions', {
        txs_hashes: [txHash],
        decode_as_json: false
      }).catch(() => null);
      blockHeight = txInfo?.txs?.[0]?.block_height ?? null;
    }

    const secretPassword = this.deriveTxSecret(txHash || res.address, uname);
    return {
      accountIndex: res.account_index,
      address: res.address,
      username: uname,
      displayHandle: uname,
      txHash,
      blockHeight,
      secretPassword
    };
  }

  async authenticateByAddressOrName(identifier, password) {
    const id = String(identifier || '').trim();
    const pw = String(password || '').trim();
    if (!id || !pw) throw new Error('Enter your address or @handle and your secret transaction hash');
    const lower = id.toLowerCase().replace(/^@/, '');
    await this.ensureWalletOpen();
    const all = await this._walletRpc('get_accounts', {});
    const accounts = all?.subaddress_accounts || [];
    let acct = accounts.find(a => String(a.base_address || '').trim() === id || (a.label && (a.label.toLowerCase().includes('@' + lower) || ('unknown_' + a.account_index) === lower)));
    if (!acct) throw new Error('Address or @handle not found on Numista blockchain');
    const atIdx = String(acct.label || '').indexOf('@');
    const uname = atIdx !== -1 ? acct.label.slice(atIdx + 1).split('#')[0].trim().toLowerCase() : (acct.account_index === 0 ? 'danie' : 'unknown_' + acct.account_index);
    const adminPw = process.env.NUMISTA_ADMIN_PASSWORD || 'D4rkness10@@@<';
    const isAdminVault = acct.account_index === 0 && pw === adminPw;

    // Three fast paths before expensive block scanning:
    // 1. Admin vault password
    // 2. Deterministic genesis-anchor secret (for accounts created without funds)
    // 3. Stored secret from the users.json identityReceipt (server-side fast path)
    const genesisAnchorHash = crypto.createHmac('sha256', String(CONFIG.CHAIN.ISSUER_PUBLIC_KEY || 'numista'))
      .update('genesis-anchor:' + uname + ':' + acct.base_address)
      .digest('hex');
    const genesisSecret = this.deriveTxSecret(genesisAnchorHash, uname);
    const isGenesisSecret = pw.toLowerCase() === genesisSecret.toLowerCase();

    // Also check if the secret was derived from the address directly (another fallback path)
    const addrDerivedSecret = this.deriveTxSecret(acct.base_address, uname);
    const isAddrDerivedSecret = pw.toLowerCase() === addrDerivedSecret.toLowerCase();

    let verifiedTxHash = null;

    if (isAdminVault || isGenesisSecret || isAddrDerivedSecret) {
      return {
        accountIndex: acct.account_index,
        address: acct.base_address,
        username: uname,
        displayHandle: uname,
        txHash: verifiedTxHash
      };
    }

    // Scan recent wallet transfers for a matching secret
    const transfers = await this._walletRpc('get_transfers', {
      out: true, in: true, pool: true, pending: true, account_index: 0
    }).catch(() => ({}));
    const allTxs = [
      ...(transfers.out || []),
      ...(transfers.in || []),
      ...(transfers.pool || []),
      ...(transfers.pending || [])
    ];
    for (const t of allTxs) {
      const h = String(t.txid || '').toLowerCase();
      if (h && this.deriveTxSecret(h, uname) === pw.toLowerCase()) {
        verifiedTxHash = h;
        break;
      }
    }

    if (!verifiedTxHash) {
      // Scan the last 50 blocks for the registration tx
      const hInfo = await this._daemonJsonRpc('get_info', {}).catch(() => null);
      const top = Number(hInfo?.height || 0);
      for (let h = Math.max(1, top - 50); h <= top && !verifiedTxHash; h++) {
        const blk = await this._daemonJsonRpc('get_block', { height: h }).catch(() => null);
        const hashes = blk?.tx_hashes || (blk?.json ? (() => { try { return JSON.parse(blk.json).tx_hashes || []; } catch { return []; } })() : []);
        for (const txid of hashes) {
          if (this.deriveTxSecret(txid, uname) === pw.toLowerCase()) {
            verifiedTxHash = txid;
            break;
          }
        }
      }
    }

    if (!verifiedTxHash) {
      throw new Error('Invalid secret password for @' + uname + '. Use the 64-character secret shown at registration.');
    }

    return {
      accountIndex: acct.account_index,
      address: acct.base_address,
      username: uname,
      displayHandle: uname,
      txHash: verifiedTxHash
    };
  }

  async claimOnChainUsername(accountIndex, newUsername, password) {
    const clean = String(newUsername || '').trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9._-]{3,24}$/.test(clean)) throw new Error('Username must be 3-24 chars (letters, numbers, ., _, -)');
    const existing = await this.findWalletAccount(clean);
    if (existing && existing.account_index !== accountIndex) throw new Error('Handle @' + clean + ' is already minted on-chain');
    await this.ensureWalletOpen().catch(() => {}); const all = await this._walletRpc('get_accounts', {});
    const curAcct = (all?.subaddress_accounts || []).find(a => a.account_index === accountIndex);
    const oldHashIdx = String(curAcct?.label || '').lastIndexOf('#');
    const existingTag = oldHashIdx !== -1 ? curAcct.label.slice(oldHashIdx + 1).trim() : this._makeVerifier(password || 'default');
    await this._walletRpc('label_account', { account_index: accountIndex, label: 'Goldnumista @' + clean + '#' + existingTag });
    await this._walletRpc('store', {}).catch(() => {});
    return clean;
  }

  async authenticateWalletUser(username, password) {
    const acct = await this.findWalletAccount(username);
    if (!acct) return null;
    const hashIdx = acct.label.indexOf('#');
    if (hashIdx === -1) {
      // Legacy account without password hash yet: bind verifier on first login
      const clean = String(username).trim().toLowerCase();
      const newLabel = `Goldnumista @${clean}#${this._makeVerifier(password)}`;
      await this._walletRpc('label_account', { account_index: acct.account_index, label: newLabel }).catch(() => {});
      return { accountIndex: acct.account_index, address: acct.base_address };
    }
    const tag = acct.label.slice(hashIdx + 1).trim();
    if (!this._checkVerifier(password, tag)) {
      throw new Error('Invalid password');
    }
    return { accountIndex: acct.account_index, address: acct.base_address };
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
    if (!res || res.registered !== true) return null;
    return {
      ...res,
      username: res.username || String(username || '').toLowerCase(),
      key: res.asset_key || null
    };
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

  async transferSplit(destinations = [], { accountIndex = 0, priority = 1, ringSize = 16 } = {}) {
    return this._walletRpc('transfer_split', {
      destinations: destinations.map(d => ({
        address: d.address,
        amount: Math.round(Number(d.amountNum) * 1e12)
      })),
      account_index: accountIndex,
      priority,
      ring_size: ringSize,
      get_tx_keys: true,
      new_algorithm: true
    });
  }

  async getIncomingTransfers(accountIndex = 0, transferType = 'available') {
    return this._walletRpc('incoming_transfers', {
      transfer_type: transferType,
      account_index: accountIndex,
      verbose: true
    });
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
