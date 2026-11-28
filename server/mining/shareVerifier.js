import { randomx_create_vm, randomx_init_cache } from 'randomx.js';

const MAX_CACHED_SEEDS = 2;
const vms = new Map(); // seedHashHex -> vm (insertion ordered, oldest evicted first)

function getVm(seedHashHex) {
  const key = seedHashHex.toLowerCase();
  let vm = vms.get(key);
  if (!vm) {
    const cache = randomx_init_cache(Buffer.from(key, 'hex'));
    vm = randomx_create_vm(cache);
    vms.set(key, vm);
    if (vms.size > MAX_CACHED_SEEDS) vms.delete(vms.keys().next().value);
  }
  return vm;
}

export function isHex(value, length) {
  return typeof value === 'string' && /^[0-9a-f]*$/i.test(value) && (length == null || value.length === length);
}

/** Writes a 4-byte nonce (given as 8 hex chars) into the hashing blob at byte 39. */
export function applyNonce(blobHex, nonceHex) {
  return blobHex.slice(0, 78) + nonceHex.toLowerCase() + blobHex.slice(86);
}

export function randomxHash(blobHex, seedHashHex) {
  return Buffer.from(getVm(seedHashHex).calculate_hash(Buffer.from(blobHex, 'hex'))).toString('hex');
}

/**
 * Cryptonote difficulty check: hash (as a little-endian 256-bit integer) * difficulty < 2^256.
 */
export function hashMeetsDifficulty(hashHex, difficulty) {
  const diff = BigInt(difficulty);
  if (diff <= 0n) return true;
  const bytes = Buffer.from(hashHex, 'hex');
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value * diff < (1n << 256n);
}

/** Compact 4-byte little-endian stratum target for a share difficulty. */
export function difficultyToTarget(difficulty) {
  const d = Math.max(1, Math.floor(Number(difficulty) || 1));
  const t = Math.min(0xffffffff, Math.floor(0xffffffff / d));
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(t >>> 0, 0);
  return buf.toString('hex');
}
