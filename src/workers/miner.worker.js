let isMining = false;
let currentJob = null;
let hashesCalculated = 0;
let lastReportTime = performance.now();

function nonceToHexLE(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hashBlob(blob, nonce) {
  const nonceHex = nonceToHexLE(nonce >>> 0);
  const input = blob && blob.length >= 86 ? blob.slice(0, 78) + nonceHex + blob.slice(86) : `${blob}:${nonceHex}`;
  let h1 = 0xdeadbeef ^ (nonce >>> 0), h2 = 0x41c6ce57 ^ ((nonce >>> 0) << 1);
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const ax = (h1 >>> 0).toString(16).padStart(8, '0'), bx = (h2 >>> 0).toString(16).padStart(8, '0'), cx = ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0'), dx = ((h1 + h2) >>> 0).toString(16).padStart(8, '0');
  return { nonceHex, resultHex: ax + bx + cx + dx + dx + cx + bx + ax };
}

function runMiningLoop() {
  if (!isMining || !currentJob) return;
  const batchSize = 4000;
  const startNonce = Math.floor(Math.random() * 0x7fffffff);
  for (let i = 0; i < batchSize; i++) {
    const nonce = startNonce + i;
    const { nonceHex, resultHex } = hashBlob(currentJob.blob || currentJob.seed || '', nonce);
    hashesCalculated++;
    if (resultHex.startsWith('00000')) {
      self.postMessage({ type: 'SHARE_FOUND', jobId: currentJob.jobId, nonceHex, resultHex });
    }
  }
  const now = performance.now();
  if (now - lastReportTime >= 500) {
    self.postMessage({ type: 'HASH_STATS', hashes: hashesCalculated, hashrate: Math.round(hashesCalculated / ((now - lastReportTime) / 1000)) });
    hashesCalculated = 0;
    lastReportTime = now;
  }
  if (isMining) setTimeout(runMiningLoop, 0);
}

self.onmessage = function (e) {
  const { type, job } = e.data;
  if (type === 'START') { isMining = true; currentJob = job; hashesCalculated = 0; lastReportTime = performance.now(); runMiningLoop(); }
  else if (type === 'UPDATE_JOB') { currentJob = job; }
  else if (type === 'STOP') { isMining = false; currentJob = null; }
};