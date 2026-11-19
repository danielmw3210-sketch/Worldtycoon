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
    return job;
  }

  submitShare({ minerId, jobId, nonce, hash }) {
    if (!hash || typeof hash !== 'string' || hash.length < 32) {
      return { accepted: false, reason: 'Malformed hash proof' };
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
