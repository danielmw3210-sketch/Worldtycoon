import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { numistaRpc } from '../numista/rpc.js';
import { CONFIG } from '../config.js';
import {
  applyNonce,
  difficultyToTarget,
  hashMeetsDifficulty,
  isHex,
  randomxHash
} from './shareVerifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PPLNS_FILE = process.env.NUMISTA_PPLNS_FILE || path.join(__dirname, '..', 'data', 'pplnsStratum.json');
const ATOMIC_UNITS = 1e12;
const TEMPLATE_REFRESH_MS = 10000;
const MAX_INVALID_SHARES = 20;
const MAX_JOBS = 200;

const SHARE_DIFFICULTY = Number(process.env.NUMISTA_SHARE_DIFFICULTY || CONFIG.ECONOMY.MINING_SHARE_DIFFICULTY || 100);
const CONFIRMATIONS = Number(process.env.NUMISTA_PAYOUT_CONFIRMATIONS || CONFIG.ECONOMY.MINING_CONFIRMATIONS || 10);

function isMinerAddress(address) {
  return typeof address === 'string' && /^[SU][1-9A-HJ-NP-Za-km-z]{50,120}$/.test(address);
}

export class NumistaPplnsPool {
  constructor({ file = PPLNS_FILE } = {}) {
    this.file = file;
    this.windowSize = Number(CONFIG.ECONOMY.PPLNS_WINDOW_SIZE || 1000);
    this.poolFeeRate = Number(CONFIG.ECONOMY.MINING_POOL_FEE_RATE || 0.02);
    this.payoutThreshold = Number(CONFIG.ECONOMY.MINING_PAYOUT_THRESHOLD || 0.25);
    this.shares = [];         // [{ address, username, weight, height, ts }]
    this.names = {};          // address -> last seen worker name
    this.pending = {};        // address -> NUM owed (confirmed rewards only)
    this.paidTotal = {};      // address -> NUM paid out
    this.payoutHistory = [];  // [{ txHash, address, username, amount, ts }]
    this.pendingBlocks = [];  // blocks submitted but not yet confirmed
    this.blocksFound = 0;
    this.blocksConfirmed = 0;
    this.blocksOrphaned = 0;
    this.totalValidShares = 0;
    this.totalInvalidShares = 0;
    this._paying = false;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.shares = Array.isArray(d.shares) ? d.shares.slice(-this.windowSize) : [];
      this.names = d.names && typeof d.names === 'object' ? d.names : {};
      this.pending = d.pending && typeof d.pending === 'object' ? d.pending : {};
      this.paidTotal = d.paidTotal && typeof d.paidTotal === 'object' ? d.paidTotal : {};
      this.payoutHistory = Array.isArray(d.payoutHistory) ? d.payoutHistory.slice(0, 50) : [];
      this.pendingBlocks = Array.isArray(d.pendingBlocks) ? d.pendingBlocks : [];
      this.blocksFound = Number(d.blocksFound || 0);
      this.blocksConfirmed = Number(d.blocksConfirmed || 0);
      this.blocksOrphaned = Number(d.blocksOrphaned || 0);
      this.totalValidShares = Number(d.totalValidShares || 0);
      this.totalInvalidShares = Number(d.totalInvalidShares || 0);
    } catch (err) {
      console.warn('[pplns] Failed to load pool state:', err.message);
    }
  }

  _save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        shares: this.shares.slice(-this.windowSize),
        names: this.names,
        pending: this.pending,
        paidTotal: this.paidTotal,
        payoutHistory: this.payoutHistory.slice(0, 50),
        pendingBlocks: this.pendingBlocks,
        blocksFound: this.blocksFound,
        blocksConfirmed: this.blocksConfirmed,
        blocksOrphaned: this.blocksOrphaned,
        totalValidShares: this.totalValidShares,
        totalInvalidShares: this.totalInvalidShares
      }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[pplns] Failed to save pool state:', err.message);
    }
  }

  recordShare({ address, username, weight = 1, height = 0 }) {
    if (!isMinerAddress(address)) return;
    const name = String(username || 'miner').toLowerCase();
    this.names[address] = name;
    this.shares.push({ address, username: name, weight: Math.max(1, Number(weight || 1)), height: Number(height || 0), ts: Date.now() });
    if (this.shares.length > this.windowSize) {
      this.shares = this.shares.slice(-this.windowSize);
    }
    this.totalValidShares += 1;
    this._save();
  }

  recordInvalidShare() {
    this.totalInvalidShares += 1;
  }

  /** Snapshot the PPLNS window when a block is found; rewards are credited only once it confirms. */
  registerFoundBlock({ height, nonceHex, grossRewardNum }) {
    const weights = {};
    for (const s of this.shares) {
      weights[s.address] = (weights[s.address] || 0) + s.weight;
    }
    this.blocksFound += 1;
    this.pendingBlocks.push({ height, nonceHex: nonceHex.toLowerCase(), grossRewardNum, weights, foundAt: Date.now() });
    this._save();
  }

  /**
   * Checks each submitted block against the chain. Confirmed blocks credit the
   * snapshot allocations; orphaned blocks are dropped. Safe to call repeatedly.
   */
  async processPendingBlocks() {
    if (!this.pendingBlocks.length) {
      await this.payOut();
      return;
    }
    let tip;
    try {
      tip = Number((await numistaRpc.getBlockCount()).count) - 1;
    } catch {
      return;
    }
    const remaining = [];
    for (const block of this.pendingBlocks) {
      if (tip < block.height) {
        remaining.push(block);
        continue;
      }
      let header;
      try {
        header = (await numistaRpc.getBlockHeaderByHeight(block.height)).block_header;
      } catch {
        remaining.push(block);
        continue;
      }
      const nonceBuf = Buffer.alloc(4);
      nonceBuf.writeUInt32LE(Number(header.nonce) >>> 0, 0);
      const ours = nonceBuf.toString('hex') === block.nonceHex && !header.orphan_status;
      if (!ours) {
        // Allow a couple of blocks for the daemon to settle before declaring the block lost.
        if (tip - block.height >= 2) {
          this.blocksOrphaned += 1;
          console.warn(`[pplns] Block #${block.height} did not make the main chain; no rewards credited.`);
        } else {
          remaining.push(block);
        }
        continue;
      }
      if (tip - block.height + 1 < CONFIRMATIONS) {
        remaining.push(block);
        continue;
      }
      this._creditBlock(block);
    }
    this.pendingBlocks = remaining;
    this._save();
    await this.payOut();
  }

  _creditBlock(block) {
    const totalWeight = Object.values(block.weights).reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) return;
    const fee = +(block.grossRewardNum * this.poolFeeRate).toFixed(6);
    const distributable = +(block.grossRewardNum - fee).toFixed(6);
    for (const [addr, weight] of Object.entries(block.weights)) {
      const credit = +((weight / totalWeight) * distributable).toFixed(6);
      this.pending[addr] = +((this.pending[addr] || 0) + credit).toFixed(6);
    }
    this.blocksConfirmed += 1;
    console.log(`[pplns] Block #${block.height} confirmed; credited ${distributable} NUM to ${Object.keys(block.weights).length} miner(s).`);
  }

  async payOut() {
    if (this._paying) return [];
    this._paying = true;
    const settled = [];
    try {
      for (const [addr, owed] of Object.entries(this.pending)) {
        if (owed < this.payoutThreshold) continue;
        // Zero the balance before sending so a failure mid-send can never double pay.
        this.pending[addr] = 0;
        this._save();
        try {
          const tx = await numistaRpc.sendTransfer({ accountIndex: 0, toAddress: addr, amountNum: owed });
          this.paidTotal[addr] = +((this.paidTotal[addr] || 0) + owed).toFixed(6);
          const entry = { txHash: tx.txHash, address: addr, username: this.names[addr] || 'miner', amount: owed, ts: new Date().toISOString() };
          this.payoutHistory.unshift(entry);
          settled.push(entry);
        } catch (err) {
          this.pending[addr] = +((this.pending[addr] || 0) + owed).toFixed(6);
          console.warn('[pplns-payout] deferred:', err.message);
        }
      }
      this._save();
    } finally {
      this._paying = false;
    }
    return settled;
  }

  getMinerStats(address = '') {
    const totalWeight = this.shares.reduce((s, e) => s + e.weight, 0);
    const minerShares = address ? this.shares.filter(e => e.address === address) : [];
    const minerWeight = minerShares.reduce((s, e) => s + e.weight, 0);
    const sharePct = totalWeight > 0 ? +((minerWeight / totalWeight) * 100).toFixed(2) : 0;
    return {
      scheme: 'PPLNS',
      windowSize: this.windowSize,
      sharesInWindow: this.shares.length,
      poolFeePct: +(this.poolFeeRate * 100).toFixed(2),
      payoutThreshold: this.payoutThreshold,
      shareDifficulty: SHARE_DIFFICULTY,
      confirmationsRequired: CONFIRMATIONS,
      blocksFound: this.blocksFound,
      blocksConfirmed: this.blocksConfirmed,
      blocksOrphaned: this.blocksOrphaned,
      blocksAwaitingConfirmation: this.pendingBlocks.length,
      validShares: this.totalValidShares,
      invalidShares: this.totalInvalidShares,
      minerShares: minerShares.length,
      minerSharePct: sharePct,
      pendingNativeNum: address ? +(this.pending[address] || 0).toFixed(6) : 0,
      paidNativeNum: address ? +(this.paidTotal[address] || 0).toFixed(6) : 0,
      recentPayouts: this.payoutHistory.slice(0, 10)
    };
  }
}

export const pplnsPool = new NumistaPplnsPool();

export function startBuiltInStratumServer(port = Number(process.env.NUMISTA_STRATUM_PORT || 3333)) {
  const jobs = new Map();    // jobId -> { tpl, nonces:Set }
  const sockets = new Map(); // socket -> miner session
  const targetHex = difficultyToTarget(SHARE_DIFFICULTY);
  // Difficulty actually implied by the rounded compact target sent to miners.
  const effectiveShareDiff = Math.floor(0xffffffff / Buffer.from(targetHex, 'hex').readUInt32LE(0));

  let template = null;
  let templateAt = 0;
  let templateLoading = null;

  function getTemplate() {
    if (template && Date.now() - templateAt < TEMPLATE_REFRESH_MS) return Promise.resolve(template);
    if (!templateLoading) {
      templateLoading = numistaRpc.getBlockTemplate(CONFIG.CHAIN.TREASURY_ADDRESS, 60)
        .then(tpl => {
          if (tpl?.blockTemplateBlob && tpl.blockhashingBlob && tpl.seedHash) {
            const changed = !template || template.height !== tpl.height || template.blockhashingBlob !== tpl.blockhashingBlob;
            template = tpl;
            templateAt = Date.now();
            if (changed) broadcastJob();
          }
          return template;
        })
        .catch(err => {
          console.warn('[stratum-server] block template unavailable:', err.message);
          return template;
        })
        .finally(() => { templateLoading = null; });
    }
    return templateLoading;
  }

  function createJob(tpl) {
    const jobId = `${tpl.height}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    jobs.set(jobId, { tpl, nonces: new Set() });
    while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
    return { blob: tpl.blockhashingBlob, job_id: jobId, target: targetHex, height: tpl.height, seed_hash: tpl.seedHash, algo: 'rx/0' };
  }

  function broadcastJob() {
    for (const [socket, miner] of sockets) {
      if (socket.destroyed) continue;
      socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'job', params: { ...createJob(template), id: miner.rpcId } }) + '\n');
    }
  }

  const reply = (socket, id, result, error) =>
    socket.write(JSON.stringify(error
      ? { id, jsonrpc: '2.0', error: { code: -1, message: error } }
      : { id, jsonrpc: '2.0', result }) + '\n');

  async function handleLogin(socket, req) {
    const [address, worker] = String(req.params?.login || '').split('.');
    if (!isMinerAddress(address)) {
      reply(socket, req.id, null, 'Login must be a valid Numista address (optionally address.worker)');
      return socket.end();
    }
    const tpl = await getTemplate();
    if (!tpl) {
      reply(socket, req.id, null, 'Pool has no block template yet (daemon unavailable)');
      return socket.end();
    }
    const miner = {
      rpcId: `numista-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      address,
      username: (worker || 'worker').slice(0, 64),
      invalid: 0
    };
    sockets.set(socket, miner);
    reply(socket, req.id, { id: miner.rpcId, job: createJob(tpl), status: 'OK' });
  }

  async function handleSubmit(socket, req) {
    const miner = sockets.get(socket);
    if (!miner || req.params?.id !== miner.rpcId) return reply(socket, req.id, null, 'Unauthenticated');

    const reject = (message) => {
      pplnsPool.recordInvalidShare();
      miner.invalid += 1;
      reply(socket, req.id, null, message);
      if (miner.invalid >= MAX_INVALID_SHARES) socket.destroy();
    };

    const job = jobs.get(String(req.params.job_id || ''));
    const nonceHex = String(req.params.nonce || '').toLowerCase();
    if (!job) return reject('Invalid or expired job');
    if (!isHex(nonceHex, 8)) return reject('Malformed nonce');
    if (job.nonces.has(nonceHex)) return reject('Duplicate share');
    job.nonces.add(nonceHex);

    const { tpl } = job;
    const hash = randomxHash(applyNonce(tpl.blockhashingBlob, nonceHex), tpl.seedHash);
    const claimed = req.params.result;
    if (claimed && String(claimed).toLowerCase() !== hash) return reject('Bad hash result');
    if (!hashMeetsDifficulty(hash, effectiveShareDiff)) return reject('Low difficulty share');

    pplnsPool.recordShare({ address: miner.address, username: miner.username, weight: effectiveShareDiff, height: tpl.height });
    miner.invalid = 0;

    if (hashMeetsDifficulty(hash, tpl.difficulty)) {
      try {
        await numistaRpc.submitBlock(applyNonce(tpl.blockTemplateBlob, nonceHex));
        const rewardNum = tpl.expectedReward ? +(tpl.expectedReward / ATOMIC_UNITS).toFixed(6) : CONFIG.ECONOMY.MINING_ROUND_REWARD;
        pplnsPool.registerFoundBlock({ height: tpl.height, nonceHex, grossRewardNum: rewardNum });
        console.log(`[stratum-server] Block #${tpl.height} submitted by ${miner.address}; awaiting ${CONFIRMATIONS} confirmations.`);
        templateAt = 0;
      } catch (err) {
        // The share is valid even if the block lost the race or went stale.
        console.warn(`[stratum-server] Block candidate #${tpl.height} rejected: ${err.message}`);
      }
    }
    reply(socket, req.id, { status: 'OK' });
  }

  const server = net.createServer((socket) => {
    let buf = '';
    socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
    socket.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > 65536) return socket.destroy();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const req = JSON.parse(line);
          if (req.method === 'login') await handleLogin(socket, req);
          else if (req.method === 'keepalived') reply(socket, req.id, { status: 'KEEPALIVED' });
          else if (req.method === 'submit') await handleSubmit(socket, req);
        } catch (err) {
          console.warn('[stratum-server] request error:', err.message);
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  server.on('error', (err) => console.warn('[stratum-server] cannot listen:', err.message));
  server.listen(port, '0.0.0.0', () => console.log('[stratum-server] Numista PPLNS Stratum listening on tcp://0.0.0.0:' + port));

  const poll = setInterval(() => {
    getTemplate().catch(() => {});
    pplnsPool.processPendingBlocks().catch(err => console.warn('[pplns] settle error:', err.message));
  }, TEMPLATE_REFRESH_MS);
  poll.unref();
  server.on('close', () => clearInterval(poll));
  server.minerCount = () => sockets.size;
  return server;
}
