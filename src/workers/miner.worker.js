/**
 * Townforge Numista - In-Browser Proof-of-Work Mining Worker
 * Runs intensive hashing loops inside Web Workers
 */

let isMining = false;
let currentJob = null;
let hashesCalculated = 0;
let lastReportTime = performance.now();

// Pseudo-RandomX / CryptoNight light hashing mixer (pure JS bitwise proof-of-work)
function fastMixHash(seedStr, nonce) {
  let h1 = 0xdeadbeef ^ nonce;
  let h2 = 0x41c6ce57 ^ (nonce << 1);

  for (let i = 0; i < seedStr.length; i++) {
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

  // Produce 64-character hex hash string
  return `${hex1}${hex2}${hex3}${hex4}${hex4}${hex3}${hex2}${hex1}`;
}

function runMiningLoop() {
  if (!isMining || !currentJob) return;

  const batchSize = 2500;
  const startNonce = Math.floor(Math.random() * 0x7fffffff);

  for (let i = 0; i < batchSize; i++) {
    const nonce = startNonce + i;
    const hash = fastMixHash(currentJob.seed, nonce);
    hashesCalculated++;

    // Check difficulty: first 3 hex characters must be zeros for valid share
    if (hash.startsWith('000')) {
      self.postMessage({
        type: 'SHARE_FOUND',
        jobId: currentJob.jobId,
        nonce,
        hash
      });
    }
  }

  // Periodic hashrate report
  const now = performance.now();
  if (now - lastReportTime >= 400) {
    const elapsedSecs = (now - lastReportTime) / 1000;
    const hashrate = hashesCalculated / elapsedSecs;
    self.postMessage({
      type: 'HASH_STATS',
      hashes: hashesCalculated,
      hashrate: Math.round(hashrate)
    });
    hashesCalculated = 0;
    lastReportTime = now;
  }

  // Schedule next batch
  if (isMining) {
    setTimeout(runMiningLoop, 0);
  }
}

self.onmessage = function (e) {
  const { type, job } = e.data;

  if (type === 'START') {
    isMining = true;
    currentJob = job;
    hashesCalculated = 0;
    lastReportTime = performance.now();
    runMiningLoop();
  } else if (type === 'UPDATE_JOB') {
    currentJob = job;
  } else if (type === 'STOP') {
    isMining = false;
    currentJob = null;
  }
};
