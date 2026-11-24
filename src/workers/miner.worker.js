let isMining = false;
let currentJob = null;
let hashesCalculated = 0;
let lastReportTime = performance.now();
function nonceToHexLE(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].map(b => b.toString(16).padStart(2, '0')).join('');
}
function fastMixHash(blobOrSeed, nonce) {
  const input = blobOrSeed && blobOrSeed.length >= 86 ? blobOrSeed.slice(0, 78) + nonceToHexLE(nonce >>> 0) + blobOrSeed.slice(86) : blobOrSeed + ':' + nonce;
  let h1 = 0xdeadbeef ^ (nonce >>> 0), h2 = 0x41c6ce57 ^ ((nonce >>> 0) << 1);
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const ax = (h1 >>> 0).toString(16).padStart(8, '0'), bx = (h2 >>> 0).toString(16).padStart(8, '0'), cx = ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0'), dx = ((h1 + h2) >>> 0).toString(16).padStart(8, '0');
  return ax + bx + cx + dx + dx + cx + bx + ax;
}
function runMiningLoop() {
  if (!isMining || !currentJob) return;
  const batchSize = 2500, startNonce = Math.floor(Math.random() * 0x7fffffff), prefix = currentJob.mode === 'solo' ? '0000' : '000';
  for (let i = 0; i < batchSize; i++) {
    const nonce = startNonce + i, hash = fastMixHash(currentJob.blockhashingBlob || currentJob.seed, nonce);
    hashesCalculated++;
    if (hash.startsWith(prefix)) {self.postMessage({type:'SHARE_FOUND',jobId:currentJob.jobId,nonce,hash});}
  }
  const now = performance.now();
  if (now - lastReportTime >= 400) {
    self.postMessage({type:'HASH_STATS',hashes:hashesCalculated,hashrate:Math.round(hashesCalculated / ((now - lastReportTime) / 1000))});
    hashesCalculated = 0; lastReportTime = now;
  }
  if (isMining) setTimeout(runMiningLoop, 0);
}
self.onmessage = function (e) {
  const {type, job} = e.data;
  if (type === 'START') {isMining=true;currentJob=job;hashesCalculated=0;lastReportTime=performance.now();runMiningLoop();}
  else if (type === 'UPDATE_JOB') {currentJob=job;}
  else if (type === 'STOP'){=isMining=false;currentJob=null;}
};