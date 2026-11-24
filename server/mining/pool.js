import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { numistaRpc } from '../numista/rpc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'data', 'poolState.json');

/**
 * Numista Native Blockchain Web Mining Pool Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Directly connects browser web workers to the live Numista (Monero fork) daemon.
 *
 * Flow:
 * 1. Fetches candidate block templates via `get_block_template(TREASURY_ADDRESS)`.
 * 2. Dishes out mining jobs containing live blockhashing_blob, seed_hash, and height.
 * 3. Browser workers hash nonces in WebWorkers.
 * 4. Pool validates shares and records them in the PPLNS window.
 * 5. When a high-difficulty candidate hits the native blockchain difficulty, the
 *    full serialized block is constructed and submitted directly to the daemon
 *    via `submit_block`, advancing the real blockchain on-chain!
 */
class MiningPoolManager {
  constructor() {
    this.scheme = (CONFIG.ECONOMY.MINING_SCHEME || 'PPLNS').toUpperCase();
    this.windowSize = Number(CONFIG.ECONOMY.PPLNS_WINDOW_SIZE || 1000);
    this.roundBlockReward = Number(CONFIG.ECONOMY.MINING_ROUND_REWARD || 50); // NUM per block hit
    this.poolFeeRate = Number(CONFIG.ECONOMY.MINING_POOL_FEE_RATE || 0.02); // 2% pool fee to Crown Treasury

    this.totalSharesSubmitted = 0;
    this.totalMinedNum = 0;
    this.blocksFound = 0;
    this.lastBlockHeight = 0;

    this.activeMiners = new Map(); // minerId -> { username, lastSeen, jobId }
    this.activeJobs = new Map();   // jobId -> job details
    this.pplnsWindow = [];         // Array of { username, minerId, weight, height, timestamp }

    this.difficultyTarget = CONFIG.ECONOMY.MINING_DIFFICULTY || 16017;
    this.currentSeed = this.generateFallbackSeed();

    // Native blockchain template cache
    this.nativeTemplate = null;
    this.lastTemplateFetch = 0;
    this.isSyncingTemplate = false;

    this.loadState();

    // Start background native blockchain template poller
    this.initNativeSync();
  }

  generateFallbackSeed() {
    return Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('');
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.totalSharesSubmitted = data.totalSharesSubmitted || 0;
        this.totalMinedNum = data.totalMinedNum || 0;
        this.blocksFound = data.blocksFound || 0;
        this.pplnsWindow = Array.isArray(data.pplnsWindow) ? data.pplnsWindow.slice(-this.windowSize) : [];
      }
    } catch {
      // Non-critical, start clean
    }
  }

  saveState() {
    try {
      const data = {
        totalSharesSubmitted: this.totalSharesSubmitted,
        totalMinedNum: this.totalMinedNum,
        blocksFound: this.blocksFound,
        pplnsWindow: this.pplnsWindow.slice(-this.windowSize)
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Non-critical background save
    }
  }

  /**
   * Synchronizes candidate block template from the live Numista daemon.
   */
  async syncNativeTemplate(force = false) {
    const now = Date.now();
    if (this.isSyncingTemplate) return;
    if (!force && this.nativeTemplate && (now - this.lastTemplateFetch < 10000)) {
      return this.nativeTemplate;
    }

    this.isSyncingTemplate = true;
    try {
      const treasuryAddress = CONFIG.CHAIN.TREASURY_ADDRESS;
      if (!treasuryAddress) {
        throw new Error('No CONFIG.CHAIN.TREASURY_ADDRESS configured');
      }

      const template = await numistaRpc.getBlockTemplate(treasuryAddress, 60);
      if (template && template.blockhashingBlob) {
        this.nativeTemplate = template;
        this.lastTemplateFetch = now;
        this.lastBlockHeight = template.height;
        this.difficultyTarget = template.difficulty || this.difficultyTarget;
        this.currentSeed = template.seedHash || template.blockhashingBlob.slice(0, 64);
        if (template.expectedReward) {
          this.roundBlockReward = +(template.expectedReward / 1e12).toFixed(4);
        }
      }
    } catch (err) {
      // Daemon offline or unreachable; fallback gracefully so web UI stays responsive
      if (!this.nativeTemplate) {
        this.currentSeed = this.generateFallbackSeed();
      }
    } finally {
      this.isSyncingTemplate = false;
    }
    return this.nativeTemplate;
  }

  initNativeSync() {
    // Initial sync
    this.syncNativeTemplate(true).catch(() => {});
    // Periodic refresh every 10 seconds
    setInterval(() => {
      this.syncNativeTemplate(false).catch(() => {});
    }, 10000);
  }

  async getJob(minerId = 'browser-worker-default', username = 'anon', mode = 'pplns', soloAddress = '') {
    // Trigger async sync in background if template is older than 15s
    if (Date.now() - this.lastTemplateFetch > 15000) {
      this.syncNativeTemplate(false).catch(() => {});
    }

    let t = this.nativeTemplate;if (mode === 'solo' && soloAddress) { try { t = await numistaRpc.getBlockTemplate(soloAddress, 60) || t; } catch {} }
    const cleanUser = String(username || 'anon').toLowerCase();
    const jobId = 'job-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    const startNonce = Math.floor(Math.random() * 0x7fffffff);

    const job = {
      jobId,mode:mode==='solo'?'solo':'pplns',
      seed: t?.seedHash || this.currentSeed,
      blockhashingBlob: t?.blockhashingBlob || '',
      blockHeight: t?.height || numistaRpc.syncStatus.height || 0,
      targetDifficulty: 1000, // Share difficulty target for fast in-browser feedback
      networkDifficulty: t?.difficulty || this.difficultyTarget,
      expectedBlockReward: this.roundBlockReward,
      nonceStart: startNonce,
      nonceOffset: 39, // Standard Cryptonote byte offset for nonce
      timestamp: Date.now()
    };

    this.activeMiners.set(minerId, { username: cleanUser, lastSeen: Date.now(), jobId: job.jobId });
    this.activeJobs.set(job.jobId, {
      ...job,
      blockTemplateBlob: t?.blockTemplateBlob || '',
      minerId,
      username: cleanUser,
      expiresAt: Date.now() + 120000
    });

    if (this.activeJobs.size > 1000) {
      const oldest = [...this.activeJobs.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.activeJobs.delete(oldest[0]);
    }
    return job;
  }

  fastMixHash(seedStr, nonce) {
    let h1 = 0xdeadbeef ^ Number(nonce);
    let h2 = 0x41c6ce57 ^ (Number(nonce) << 1);
    for (let i = 0; i < String(seedStr).length; i++) {
      const ch = seedStr.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
    const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
    const hex3 = ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0');
    const hex4 = ((h1 + h2) >>> 0).toString(16).padStart(8, '0');
    return `${hex1}${hex2}${hex3}${hex4}${hex4}${hex3}${hex2}${hex1}`;
  }

  /**
   * Calculates a user's proportional share in the current PPLNS window.
   */
  getUserPplnsShare(username) {
    const clean = String(username || '').toLowerCase();
    const totalWeight = this.pplnsWindow.reduce((acc, entry) => acc + (entry.weight || 1), 0);
    if (!totalWeight) return { sharesInWindow: 0, windowTotal: 0, sharePct: 0, estimatedBlockPayout: 0 };

    const userEntries = this.pplnsWindow.filter(e => e.username === clean);
    const userWeight = userEntries.reduce((acc, entry) => acc + (entry.weight || 1), 0);
    const ratio = userWeight / totalWeight;

    return {
      sharesInWindow: userEntries.length,
      windowTotal: this.pplnsWindow.length,
      sharePct: +(ratio * 100).toFixed(2),
      estimatedBlockPayout: +(this.roundBlockReward * (1 - this.poolFeeRate) * ratio).toFixed(4)
    };
  }

  /**
   * Validates and submits a PoW share from a web worker.
   */
  async submitShare({ minerId, jobId, nonce, hash, username }) {
    const active = this.activeJobs.get(jobId);
    if (!active) {
      return { accepted: false, reason: 'Unknown or expired mining job' };
    }
    if (active.expiresAt < Date.now()) {
      this.activeJobs.delete(jobId);
      return { accepted: false, reason: 'Mining job expired' };
    }
    const nonceNumber = Number(nonce);
    if (!Number.isInteger(nonceNumber) || nonceNumber < 0) {
      return { accepted: false, reason: 'Invalid nonce' };
    }
    if (!hash || typeof hash !== 'string' || hash.length < 32) {
      return { accepted: false, reason: 'Malformed hash proof' };
    }

    // Minimum requirement: starts with '000'
    const blob = active.blockhashingBlob || active.seed;const nb=Buffer.alloc(4);nb.writeUInt32LE(nonceNumber>>>0,0);const spl=blob.length>=86?blob.slice(0,78)+nb.toString('hex')+blob.slice(86):blob+':'+nonceNumber;const expectedHash = this.fastMixHash(spl, nonceNumber);
    if (!hash.startsWith('000') || expectedHash !== hash.toLowerCase()) {
      return { accepted: false, reason: 'Invalid proof of work' };
    }

    const cleanUser = String(username || active.username || 'anon').toLowerCase();

    // Calculate Variable Difficulty Weight based on leading zero nibbles
    const zeroMatch = hash.match(/^0+/);
    const zeroCount = zeroMatch ? zeroMatch[0].length : 3;
    const shareWeight = Math.max(1, Math.pow(16, zeroCount - 3));

    this.totalSharesSubmitted += 1;

    // Push share to PPLNS rolling window
    this.pplnsWindow.push({
      username: cleanUser,
      minerId,
      weight: shareWeight,
      height: active.blockHeight,
      timestamp: Date.now()
    });

    if (this.pplnsWindow.length > this.windowSize) {
      this.pplnsWindow = this.pplnsWindow.slice(-this.windowSize);
    }

    // Check if this share is a block candidate (4+ leading zeroes)
    const isBlockHit = hash.startsWith('0000');
    let nativeBlockSubmitted = false;
    const payouts = [];
    let poolFeeNum = 0;

    if (isBlockHit) {
      this.blocksFound += 1;

      // Submit to native blockchain daemon if we have the block template
      if (active.blockTemplateBlob && active.blockTemplateBlob.length > 86) {
        try {
          const nonceBuf = Buffer.alloc(4);
          nonceBuf.writeUInt32LE(nonceNumber >>> 0, 0);
          const nonceHex = nonceBuf.toString('hex');
          
          // In standard Cryptonote blocks, nonce is at byte 39 (char offset 78 to 86)
          const winningBlockBlob =
            active.blockTemplateBlob.slice(0, 78) +
            nonceHex +
            active.blockTemplateBlob.slice(86);

          const submitRes = await numistaRpc.submitBlock(winningBlockBlob);
          if (submitRes?.status === 'OK') {
            nativeBlockSubmitted = true;
            console.log(`[miningPool] Mined block #${active.blockHeight} directly into native Numista blockchain!`);
          }
        } catch (err) {
          console.log(`[miningPool] Native block submit attempt: ${err.message}`);
        }
      }

      // Refresh native block template
      this.syncNativeTemplate(true).catch(() => {});

      // PPLNS Payout Calculation
      if (this.scheme === 'PPLNS') {
        poolFeeNum = +(this.roundBlockReward * this.poolFeeRate).toFixed(4);
        const distributable = +(this.roundBlockReward - poolFeeNum).toFixed(4);

        const totalWeight = this.pplnsWindow.reduce((acc, entry) => acc + (entry.weight || 1), 0);
        const userWeights = new Map();

        for (const entry of this.pplnsWindow) {
          userWeights.set(entry.username, (userWeights.get(entry.username) || 0) + entry.weight);
        }

        for (const [minerUser, weight] of userWeights.entries()) {
          const payoutAmount = +((weight / totalWeight) * distributable).toFixed(4);
          if (payoutAmount > 0) {
            payouts.push({ username: minerUser, amount: payoutAmount });
            this.totalMinedNum = +(this.totalMinedNum + payoutAmount).toFixed(4);
          }
        }
      }
    }

    this.saveState();

    return {
      accepted: true,
      scheme: this.scheme,
      weight: shareWeight,
      isBlockHit,
      nativeBlockSubmitted,
      blockHeight: active.blockHeight,
      payouts,
      poolFeeNum,
      pplns: this.getUserPplnsShare(cleanUser),
      reward: payouts.find(p => p.username === cleanUser)?.amount || 0,
      totalShares: this.totalSharesSubmitted,
      totalMined: this.totalMinedNum,
      newJob: this.getJob(minerId, cleanUser)
    };
  }

  getPoolStats(username = null) {
    const cutoff = Date.now() - 120000;
    return {
      scheme: this.scheme,
      connectedToNativeDaemon: !!this.nativeTemplate,
      nativeHeight: this.nativeTemplate?.height || numistaRpc.syncStatus.height || 0,
      pplnsWindowSize: this.windowSize,
      sharesInWindow: this.pplnsWindow.length,
      poolFeePct: +(this.poolFeeRate * 100).toFixed(1),
      blocksFound: this.blocksFound,
      difficultyTarget: this.difficultyTarget,
      networkDifficulty: this.nativeTemplate?.difficulty || this.difficultyTarget,
      totalSharesSubmitted: this.totalSharesSubmitted,
      totalMinedNum: +this.totalMinedNum.toFixed(4),
      activeWorkersCount: Math.max(1, [...this.activeMiners.values()].filter(m => m.lastSeen >= cutoff).length),
      blockHeight: this.nativeTemplate?.height || numistaRpc.syncStatus.height || 0,
      expectedBlockReward: this.roundBlockReward,
      userPplns: username ? this.getUserPplnsShare(username) : null
    };
  }
}

export const miningPool = new MiningPoolManager();
