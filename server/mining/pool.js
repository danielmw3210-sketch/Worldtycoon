import { CONFIG } from '../config.js';
import { numistaRpc } from '../numista/rpc.js';

/**
 * In-browser share accounting.
 *
 * Rewards are NOT credited here: gameStore.creditMiningReward batches them into
 * a real on-chain NUM asset mint (10 confirmations). This pool only validates
 * and counts shares.
 */
class MiningPoolManager {
  constructor() {
    this.totalSharesSubmitted = 0;
    this.totalMinedNum = 0;
    this.activeMiners = new Map();
    this.activeJobs = new Map();
    this.difficultyTarget = CONFIG.ECONOMY.MINING_DIFFICULTY;
    this.currentSeed = this.generateSeed();
  }

  generateSeed() {
    return Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('');
  }

  getJob(minerId = 'browser-worker-default') {
    const job = {
      jobId: 'job-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
      seed: this.currentSeed,
      blockHeight: numistaRpc.syncStatus.height || 0,
      targetDifficulty: this.difficultyTarget,
      rewardPerShare: CONFIG.ECONOMY.MINING_SHARE_REWARD,
      timestamp: Date.now()
    };

    this.activeMiners.set(minerId, { lastSeen: Date.now(), jobId: job.jobId });
    this.activeJobs.set(job.jobId, { ...job, minerId, expiresAt: Date.now() + 120000 });
    if (this.activeJobs.size > 500) {
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

  submitShare({ minerId, jobId, nonce, hash }) {
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
    if (!hash.startsWith('000') || this.fastMixHash(active.seed, nonceNumber) !== hash.toLowerCase()) {
      return { accepted: false, reason: 'Invalid proof of work' };
    }

    this.totalSharesSubmitted += 1;
    const reward = CONFIG.ECONOMY.MINING_SHARE_REWARD;
    this.totalMinedNum += reward;

    // 3.5% mining tax is forwarded to the global Town Hall treasury.
    const miningTax = +(reward * 0.035).toFixed(4);

    return {
      accepted: true,
      reward,
      miningTax,
      totalShares: this.totalSharesSubmitted,
      totalMined: this.totalMinedNum,
      newJob: this.getJob(minerId)
    };
  }

  getPoolStats() {
    return {
      difficultyTarget: this.difficultyTarget,
      totalSharesSubmitted: this.totalSharesSubmitted,
      totalMinedNum: +this.totalMinedNum.toFixed(4),
      activeWorkersCount: Math.max(1, this.activeMiners.size),
      blockHeight: numistaRpc.syncStatus.height || 0,
      networkDifficulty: numistaRpc.syncStatus.difficulty || this.difficultyTarget
    };
  }
}

export const miningPool = new MiningPoolManager();
