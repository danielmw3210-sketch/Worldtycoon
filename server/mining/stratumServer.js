import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { numistaRpc } from '../numista/rpc.js';
import { CONFIG } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PPLNS_FILE = path.join(__dirname, '..', 'data', 'pplnsStratum.json');

class NumistaPplnsPool {
  constructor() {
    this.windowSize = Number(CONFIG.ECONOMY.PPLNS_WINDOW_SIZE || 1000);
    this.poolFeeRate = Number(CONFIG.ECONOMY.MINING_POOL_FEE_RATE || 0.02);
    this.payoutThreshold = Number(CONFIG.ECONOMY.MINING_PAYOUT_THRESHOLD || 0.25);
    this.shares = [];       // [{ address, username, weight, height, ts }]
    this.pending = {};      // address -> numeric native NUM owed
    this.paidTotal = {};    // address -> numeric native NUM paid out
    this.payoutHistory = []; // [{ txHash, address, username, amount, height, ts }]
    this.blocksFound = 0;
    this.lastSettledHeight = 0;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(PPLNS_FILE)) {
        const d = JSON.parse(fs.readFileSync(PPLNS_FILE, 'utf8'));
        this.shares = Array.isArray(d.shares) ? d.shares.slice(-this.windowSize) : [];
        this.pending = d.pending && typeof d.pending === 'object' ? d.pending : {};
        this.paidTotal = d.paidTotal && typeof d.paidTotal === 'object' ? d.paidTotal : {};
        this.payoutHistory = Array.isArray(d.payoutHistory) ? d.payoutHistory.slice(0, 50) : [];
        this.blocksFound = Number(d.blocksFound || 0);
        this.lastSettledHeight = Number(d.lastSettledHeight || 0);
      }
    } catch {}
  }

  _save() {
    try {
      fs.writeFileSync(PPLNS_FILE, JSON.stringify({
        shares: this.shares.slice(-this.windowSize),
        pending: this.pending,
        paidTotal: this.paidTotal,
        payoutHistory: this.payoutHistory.slice(0, 50),
        blocksFound: this.blocksFound,
        lastSettledHeight: this.lastSettledHeight
      }, null, 2));
    } catch {}
  }

  recordShare({ address, username, weight = 1, height = 0 }) {
    if (!address || !(address.startsWith('S') || address.startsWith('U'))) return;
    this.shares.push({
      address,
      username: String(username || 'miner').toLowerCase(),
      weight: Math.max(1, Number(weight || 1)),
      height: Number(height || 0),
      ts: Date.now()
    });
    if (this.shares.length > this.windowSize) {
      this.shares = this.shares.slice(-this.windowSize);
    }
    this._save();
  }

  async settleBlockReward(blockHeight, grossRewardNum) {
    if (!this.shares.length || grossRewardNum <= 0) return [];
    if (blockHeight && blockHeight <= this.lastSettledHeight) return [];
    if (blockHeight) this.lastSettledHeight = blockHeight;
    this.blocksFound += 1;

    const fee = +(grossRewardNum * this.poolFeeRate).toFixed(6);
    const distributable = +(grossRewardNum - fee).toFixed(6);
    const totalWeight = this.shares.reduce((s, e) => s + e.weight, 0);
    if (totalWeight <= 0) return [];

    const byAddr = new Map();
    for (const s of this.shares) {
      const prev = byAddr.get(s.address) || { weight: 0, username: s.username };
      byAddr.set(s.address, { weight: prev.weight + s.weight, username: s.username });
    }

    for (const [addr, info] of byAddr.entries()) {
      const credit = +((info.weight / totalWeight) * distributable).toFixed(6);
      this.pending[addr] = +((this.pending[addr] || 0) + credit).toFixed(6);
    }

    const settled = [];
    for (const [addr, owed] of Object.entries(this.pending)) {
      if (owed >= this.payoutThreshold) {
        try {
          const tx = await numistaRpc.sendTransfer({
            accountIndex: 0,
            toAddress: addr,
            amountNum: owed
          });
          this.pending[addr] = 0;
          this.paidTotal[addr] = +((this.paidTotal[addr] || 0) + owed).toFixed(6);
          const entry = {
            txHash: tx.txHash,
            address: addr,
            username: byAddr.get(addr)?.username || 'miner',
            amount: owed,
            height: blockHeight,
            ts: new Date().toISOString()
          };
          this.payoutHistory.unshift(entry);
          settled.push(entry);
        } catch (err) {
          console.warn('[pplns-payout] deferred until vault unlocks:', err.message);
        }
      }
    }
    this._save();
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
      blocksFound: this.blocksFound,
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
  const jobs = new Map();
  const socketMiners = new Map();

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const req = JSON.parse(line);
          if (req.method === 'login') {
            const rawLogin = String(req.params?.login || '');
            const parts = rawLogin.split('.');
            const minerAddr = (parts.at(0)?.startsWith('S') || parts.at(0)?.startsWith('U')) ? parts.at(0) : CONFIG.CHAIN.TREASURY_ADDRESS;
            const workerName = parts.at(1) || 'worker';
            socketMiners.set(socket, { address: minerAddr, username: workerName });

            // Always mine block template to the pool vault (TREASURY_ADDRESS) so PPLNS can split rewards
            const tpl = await numistaRpc.getBlockTemplate(CONFIG.CHAIN.TREASURY_ADDRESS, 60).catch(() => null);
            const jobId = 'job-' + (tpl?.height || 0) + '-' + Math.floor(Math.random() * 99999);
            if (tpl?.blockTemplateBlob) jobs.set(jobId, { tpl });
            if (jobs.size > 200) jobs.delete(jobs.keys().next().value);

            socket.write(JSON.stringify({
              id: req.id,
              jsonrpc: '2.0',
              result: {
                id: 'numista-pplns-' + Date.now(),
                job: {
                  blob: tpl?.blockhashingBlob || '00'.repeat(76),
                  job_id: jobId,
                  target: 'b88d0600',
                  height: tpl?.height || numistaRpc.syncStatus.height || 0,
                  seed_hash: tpl?.seedHash || '00'.repeat(32)
                },
                status: 'OK'
              }
            }) + '\n');
          } else if (req.method === 'keepalived') {
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', result: { status: 'KEEPALIVED' } }) + '\n');
          } else if (req.method === 'submit') {
            const miner = socketMiners.get(socket) || { address: CONFIG.CHAIN.TREASURY_ADDRESS, username: 'miner' };
            const job = jobs.get(req.params?.job_id);
            const height = job?.tpl?.height || numistaRpc.syncStatus.height || 0;

            // Record share in PPLNS window
            pplnsPool.recordShare({ address: miner.address, username: miner.username, weight: 1, height });

            // If valid RandomX block candidate hits daemon difficulty, submit to monerod & settle PPLNS native NUM!
            const nonceHex = String(req.params?.nonce || '');
            if (job?.tpl?.blockTemplateBlob && nonceHex.length === 8) {
              const fullBlob = job.tpl.blockTemplateBlob.slice(0, 78) + nonceHex + job.tpl.blockTemplateBlob.slice(86);
              const sub = await numistaRpc.submitBlock(fullBlob).catch(() => null);
              if (sub?.status === 'OK') {
                const rewardNum = job.tpl.expectedReward ? +(job.tpl.expectedReward / 1e12).toFixed(6) : CONFIG.ECONOMY.MINING_ROUND_REWARD;
                console.log(`[stratum-server] Block #${height} accepted! Settling ${rewardNum} native NUM via PPLNS...`);
                await pplnsPool.settleBlockReward(height, rewardNum);
              }
            }
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', result: { status: 'OK' } }) + '\n');
          }
        } catch {}
      }
    });
    socket.on('close', () => socketMiners.delete(socket));
    socket.on('error', () => socketMiners.delete(socket));
  });

  server.on('error', (err) => console.warn('[stratum-server] port busy:', err.message));
server.listen(port, '0.0.0.0', () => console.log('[stratum-server] Numista PPLNS Stratum listening on tcp://0.0.0.0:' + port));
return server;
}