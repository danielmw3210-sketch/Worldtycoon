let isMining = false;
let currentJob = null;
let rxMod = null, rxMem = null;
let rxReady = false;
let hashesCalculated = 0;
let lastReportTime = performance.now();

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function shareTarget(target) {
  if (!/^(?:[0-9a-f]{8}|[0-9a-f]{16})$/i.test(String(target || ''))) {
    throw new Error('Pool provided an unsupported share target');
  }
  const bytes = hexToBytes(target);
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return { value, bytes: bytes.length };
}

async function ensureRandomX(seedHex) {
  if (!/^[0-9a-f]{64}$/i.test(String(seedHex || ''))) {
    throw new Error('Pool provided an invalid RandomX seed');
  }
  if (!rxMod) {
    importScripts('/randomx.js');
    rxMem = new WebAssembly.Memory({ initial: 5120, maximum: 32768 }); rxMod = await createRandomXModule({ wasmMemory: rxMem, locateFile: (f) => '/' + f });
  }
  const seedBytes = hexToBytes(seedHex);
  const seedPtr = rxMod._malloc(32);
  new Uint8Array(rxMem.buffer).set(seedBytes.subarray(0, 32), seedPtr);
  const rc = rxMod._rx_init(seedPtr, 32);
  rxMod._free(seedPtr);
  rxReady = (rc === 0);
}

async function runMiningLoop() {
  if (!isMining || !currentJob) return;
  if (!rxReady) {
    await ensureRandomX(currentJob.seedHash);
    if (!isMining || !rxReady) return;
  }

  const blobBytes = hexToBytes(currentJob.blob);
  if (blobBytes.length < 43) {
    throw new Error('Pool provided an invalid mining blob');
  }
  const target = shareTarget(currentJob.target);

  const inPtr = rxMod._rx_get_input_ptr();
  const outPtr = rxMod._rx_get_output_ptr();
  new Uint8Array(rxMem.buffer).set(blobBytes, inPtr);

  const batchSize = 4; // Genuine RandomX rx/0 programs per tick
  let nonce = (Math.floor(Math.random() * 0x7fffffff)) >>> 0;

  for (let i = 0; i < batchSize && isMining; i++) {
    nonce = (nonce + 1) >>> 0;
    new Uint8Array(rxMem.buffer)[inPtr + 39] = nonce & 0xff;
    new Uint8Array(rxMem.buffer)[inPtr + 40] = (nonce >>> 8) & 0xff;
    new Uint8Array(rxMem.buffer)[inPtr + 41] = (nonce >>> 16) & 0xff;
    new Uint8Array(rxMem.buffer)[inPtr + 42] = (nonce >>> 24) & 0xff;

    rxMod._rx_hash(blobBytes.length);
    hashesCalculated++;

    const dv = new DataView(rxMem.buffer, outPtr + 32 - target.bytes, target.bytes);
    const top = target.bytes === 4 ? BigInt(dv.getUint32(0, true)) : dv.getBigUint64(0, true);
    if (top < target.value) {
      const nonceHex = bytesToHex(new Uint8Array(rxMem.buffer).subarray(inPtr + 39, inPtr + 43));
      const resultHex = bytesToHex(new Uint8Array(rxMem.buffer).subarray(outPtr, outPtr + 32));
      self.postMessage({ type: 'SHARE_FOUND', jobId: currentJob.jobId, nonceHex, resultHex });
    }
  }

  const now = performance.now();
  if (now - lastReportTime >= 250) {
    const secs = (now - lastReportTime) / 1000;
    self.postMessage({ type: 'HASH_STATS', hashes: hashesCalculated, hashrate: Math.round(hashesCalculated / secs) });
    hashesCalculated = 0;
    lastReportTime = now;
  }

  if (isMining) setTimeout(() => runMiningLoop().catch(reportError), 0);
}

function reportError(err) {
  isMining = false;
  self.postMessage({ type: 'ERROR', message: err.message });
}

self.onmessage = async function (e) {
  const { type, job } = e.data;
  if (type === 'START') {
    isMining = true;
    currentJob = job;
    rxReady = false;
    hashesCalculated = 0;
    lastReportTime = performance.now();
    runMiningLoop().catch(reportError);
  } else if (type === 'UPDATE_JOB') {
    const seedChanged = currentJob?.seedHash !== job?.seedHash;
    currentJob = job;
    if (seedChanged) rxReady = false;
  } else if (type === 'STOP') {
    isMining = false;
    currentJob = null;
  }
};