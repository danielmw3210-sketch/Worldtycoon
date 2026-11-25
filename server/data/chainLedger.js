import { mintQueue } from '../numista/mintQueue.js';
import { CURRENCY_ASSET_TYPE, toUnits } from '../data/deedRegistry.js';
/**
 * Chain ledger
 * ─────────────────────────────────────────────────────────────────────────────
 * The chain is the source of truth for balances; this ledger is the game-side
 * index and mirror:
 *
 *   chainSettled – confirmed on-chain NUM asset balance (minus locked spends)
 *   pending      – incoming mints waiting for confirmations
 *   locked       – outgoing spends reserved by an in-flight job
 *
 * Only confirmed chain balances are spendable. Pending and locked movements
 * remain separate until their chain jobs confirm or revert.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';
import { NUM_ASSET_ID, fromUnits } from '../data/deedRegistry.js';
import { userManager } from '../data/users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function round(n, places = 6) {
  return +(Number(n) || 0).toFixed(places);
}

class ChainLedger {
  constructor({ adapter = null, file } = {}) {
    this.adapter = adapter;
    this.file = file || process.env.NUMISTA_LEDGER_FILE || path.join(__dirname, '..', 'data', 'ledgerState.json');
    this.state = {
      bootstrapped: false,
      balances: {},
      usernames: {},
      txs: []
    };
    this.load();
  }

  configure({ adapter }) {
    if (adapter) this.adapter = adapter;
  }

  /* ---- persistence ---- */

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const balances = raw.balances || {};
      Object.values(balances).forEach(balance => {
        balance.chainSettled = Number(balance.chainSettled) || 0;
        balance.pending = Number(balance.pending) || 0;
        balance.locked = Number(balance.locked) || 0;
        delete balance.localDelta;
      });
      this.state = {
        bootstrapped: !!raw.bootstrapped,
        balances,
        usernames: raw.usernames || {},
        lastTreasuryHeight: Number(raw.lastTreasuryHeight) || 0,
        txs: Array.isArray(raw.txs) ? raw.txs : []
      };
    } catch (err) {
      console.warn('[ledger] Could not load ledger:', err.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        savedAt: new Date().toISOString(),
        ...this.state
      }), 'utf8');
    } catch (err) {
      console.warn('[ledger] Could not save ledger:', err.message);
    }
  }

  /* ---- accounts ---- */

  ensure(username) {
    const key = String(username || '').trim().toLowerCase();
    if (!key) throw new Error('Username is required');
    if (!this.state.balances[key]) {
      this.state.balances[key] = {
        chainSettled: 0,
        pending: 0,
        locked: 0
      };
    }
    return this.state.balances[key];
  }

  getBalance(username) {
    const rec = this.ensure(username);
    const settled = round(Math.max(0, rec.chainSettled));
    return {
      username: String(username).toLowerCase(),
      settled,
      pending: round(rec.pending),
      locked: round(rec.locked),
      available: settled,
      total: round(settled + rec.pending)
    };
  }

  /* ---- chain-backed movements ---- */

  lock(username, amount) {
    const rec = this.ensure(username);
    const value = round(Math.min(Number(amount) || 0, Math.max(0, rec.chainSettled)));
    if (value <= 0) throw new Error('Nothing available to lock');
    rec.chainSettled = round(rec.chainSettled - value);
    rec.locked = round(rec.locked + value);
    this.syncWallet(username);
    this.save();
    return value;
  }

  /** A locked spend was confirmed on-chain: the funds are gone. */
  settleSpend(username, amount) {
    const rec = this.ensure(username);
    const value = round(Math.min(Number(amount) || 0, rec.locked));
    rec.locked = round(rec.locked - value);
    this.syncWallet(username);
    this.save();
    return value;
  }

  /** A locked spend failed: return the reservation to the spendable balance. */
  unlock(username, amount) {
    const rec = this.ensure(username);
    const value = round(Math.min(Number(amount) || 0, rec.locked));
    rec.locked = round(rec.locked - value);
    rec.chainSettled = round(rec.chainSettled + value);
    this.syncWallet(username);
    this.save();
    return value;
  }

  addPending(username, amount) {
    const rec = this.ensure(username);
    rec.pending = round(rec.pending + (Number(amount) || 0));
    this.syncWallet(username);
    this.save();
  }

  settlePending(username, amount) {
    const rec = this.ensure(username);
    const value = round(Math.min(Number(amount) || 0, rec.pending));
    rec.pending = round(rec.pending - value);
    rec.chainSettled = round(rec.chainSettled + value);
    this.syncWallet(username);
    this.save();
    return value;
  }

  dropPending(username, amount) {
    const rec = this.ensure(username);
    rec.pending = round(Math.max(0, rec.pending - (Number(amount) || 0)));
    this.syncWallet(username);
    this.save();
  }

  /** Credit a confirmed on-chain balance (e.g. recipient of a transfer). */
  receiveChain(username, amount) {
    const rec = this.ensure(username);
    rec.chainSettled = round(rec.chainSettled + (Number(amount) || 0));
    this.syncWallet(username);
    this.save();
  }

  /* ---- tx index ---- */

  _record({ username, amount = 0, type, description, txHash = null, height = null, status = 'local', jobId = null, plotId = null, assetId = null, direction = null }) {
    const tx = {
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      username: username ? String(username).toLowerCase() : null,
      amount: round(amount),
      type: type || (amount >= 0 ? 'credit' : 'debit'),
      direction: direction || (amount >= 0 ? 'in' : 'out'),
      description: description || '',
      txHash,
      height,
      status,
      jobId,
      plotId,
      assetId,
      timestamp: new Date().toISOString()
    };
    this.state.txs.unshift(tx);
    this.state.txs = this.state.txs.slice(0, 2000);
    if (tx.username) this.syncWallet(tx.username);
    return tx;
  }

  recordChainMove({
    username,
    amount,
    description,
    txHash,
    height,
    status = 'confirmed',
    jobId,
    plotId,
    assetId,
    direction
  }) {
    const tx = this._record({
      username,
      amount,
      description,
      txHash,
      height,
      status,
      jobId,
      plotId,
      assetId,
      direction
    });
    this.save();
    return tx;
  }

  listFor(username, limit = 50) {
    const key = String(username || '').toLowerCase();
    return this.state.txs.filter(t => t.username === key).slice(0, limit);
  }

  /* ---- username registry ---- */

  getUsernameRecord(username) {
    return this.state.usernames[String(username || '').toLowerCase()] || null;
  }

  markUsernameRegistered(username, { key = null, jobId = null } = {}) {
    const clean = String(username || '').toLowerCase();
    this.state.usernames[clean] = {
      username: clean,
      key,
      jobId,
      registeredAt: new Date().toISOString()
    };
    this.save();
    return this.state.usernames[clean];
  }

  /* ---- mirroring & reconciliation ---- */

  syncWallet(username) {
    const user = userManager.getUser(username);
    if (!user) return;
    const balance = this.getBalance(username);
    user.wallet.balance = balance.available;
    user.wallet.unlockedBalance = balance.available;
    user.wallet.pendingBalance = balance.pending;
    user.wallet.lockedBalance = balance.locked;
    user.wallet.transfers = this.listFor(balance.username, 50).map(t => ({
      id: t.id,
      amount: t.amount,
      type: t.type,
      description: t.description,
      txHash: t.txHash,
      timestamp: t.timestamp,
      height: t.height,
      status: t.status
    }));
  }

  /**
   * Seed the ledger from simulated genesis balances once. Live mode never seeds:
   * balances are read from the node instead.
   */
  async bootstrap() {
    if (!this.adapter) return;
    const caps = await this.adapter.capabilities();

    if (caps.mode === 'live' || caps.mode === 'simulate') {
      const usernames = new Set([
        ...userManager.allUsernames(),
        CONFIG.CHAIN.TREASURY_USERNAME
      ]);
      for (const username of usernames) {
        if (this.getUsernameRecord(username)) continue;
        const record = await this.adapter.getUsernameKey(username);
        if (record) this.markUsernameRegistered(username, { key: record.key || null });
      }
    }

    if (!this.state.bootstrapped && caps.mode === 'simulate') {
      for (const username of Object.keys(CONFIG.SIM.GENESIS_BALANCES)) {
        const units = await this.adapter.getAssetBalance(NUM_ASSET_ID, username);
        const rec = this.ensure(username);
        const onChain = fromUnits(units);
        rec.chainSettled = round(onChain - rec.locked);
        this.syncWallet(username);
      }
    }

    if (caps.mode === 'live') {
      await this.reconcile();
    }

    this.state.bootstrapped = true;
    this.save();
  }

  /**
   * Reconcile mirrors against the chain. Chain truth wins: locked spends and
   * pending mints are not yet in the confirmed balance, so they are excluded.
   */
  async reconcile() {
    if (!this.adapter) return { checked: 0, mismatches: [] };
    const caps = await this.adapter.capabilities();
    if (caps.mode !== 'live' && caps.mode !== 'simulate') return { checked: 0, mismatches: [] };

    const usernames = new Set([
      ...Object.keys(this.state.balances),
      ...Object.keys(this.state.usernames),
      ...userManager.allUsernames()
    ]);

    const mismatches = [];
    for (const username of usernames) {
      const rec = this.ensure(username);
      // In-flight movements are not yet reflected as confirmed chain balance.
      if (rec.locked > 0 || rec.pending > 0) continue;
      try {
        const units = await this.adapter.getAssetBalance(NUM_ASSET_ID, username);
        const onChain = round(fromUnits(units));
        const expected = round(onChain - rec.locked);
        if (Math.abs(expected - rec.chainSettled) > 0.0005) {
          mismatches.push({
            username,
            db: rec.chainSettled,
            chain: expected,
            locked: rec.locked
          });
          rec.chainSettled = expected;
          this.syncWallet(username);
        }
      } catch { /* node hiccup: keep the mirror */ }
    }

    if (mismatches.length) {
      console.warn(`[ledger] Reconciled ${mismatches.length} balance mismatch(es)`);
      this.save();
    }
    // Mint per-block Crown Treasury NUM reward as new blocks settle
    const blockRate = Number(CONFIG.ECONOMY.TREASURY_BLOCK_REWARD_NUM) || 0;
    if (caps.mode === 'live' && blockRate > 0) {
      try {
        const tip = await this.adapter.getHeight();
        const settledHeight = Math.max(0, tip - (Number(CONFIG.CHAIN.CONFIRMATIONS) || 10));
        if (!this.state.lastTreasuryHeight) {
          this.state.lastTreasuryHeight = settledHeight;
          this.save();
        } else if (settledHeight > this.state.lastTreasuryHeight) {
          const treasuryUser = CONFIG.CHAIN.TREASURY_USERNAME;
          const activeTreasuryJob = mintQueue.jobs.some(j => j.type === 'treasury_block_reward');
          const assetExists = await this.adapter.getAsset(NUM_ASSET_ID);
          const treasuryRegistered = this.getUsernameRecord(treasuryUser) || await this.adapter.getUsernameKey(treasuryUser);
          if (!activeTreasuryJob && assetExists && treasuryRegistered) {
            const fromHeight = this.state.lastTreasuryHeight + 1;
            const blocksMined = settledHeight - this.state.lastTreasuryHeight;
            const reward = round(blocksMined * blockRate);
            if (reward > 0) {
              this.state.lastTreasuryHeight = settledHeight;
              this.addPending(treasuryUser, reward);
              this.save();
              mintQueue.enqueue({
                type: 'treasury_block_reward',
                username: treasuryUser,
                assetId: NUM_ASSET_ID,
                snapshot: { amount: reward, fromHeight, toHeight: settledHeight, blocksMined },
                meta: { name: `Crown Treasury block reward (#${fromHeight}-#${settledHeight})` },
                steps: [{
                  key: 'mint',
                  label: `Mint ${reward} NUM block reward (${blocksMined} block(s)) to @${treasuryUser}`,
                  operation: {
                    kind: 'mint',
                    assetId: NUM_ASSET_ID,
                    assetType: CURRENCY_ASSET_TYPE,
                    recipient: treasuryUser,
                    amountUnits: toUnits(reward)
                  }
                }]
              });
            }
          }
        }
      } catch (err) {
        console.warn('[ledger] Treasury block reward check failed:', err.message);
      }
    }

    return { checked: usernames.size, mismatches };
  }

  summary() {
    const balances = Object.keys(this.state.balances).map(username => this.getBalance(username));
    return {
      accounts: balances.length,
      pending: round(balances.reduce((s, b) => s + b.pending, 0)),
      locked: round(balances.reduce((s, b) => s + b.locked, 0)),
      txs: this.state.txs.length
    };
  }
}

export const chainLedger = new ChainLedger();
export { ChainLedger };
