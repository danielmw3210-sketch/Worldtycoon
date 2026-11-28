/**
 * Deed registry helpers.
 *
 * Numista mints NFTs as on-chain *assets* (one collectible per deed), committed
 * with a 32-byte metadata hash. The metadata itself lives off-chain here and is
 * served by the game API, so it must be immutable and canonically encoded.
 *
 * Nothing mutable (owner, level, accrued income) belongs in deed metadata:
 * those change over time while `metadata_hash` is permanent.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';
import { buildingSprite, grandCastleSprite, itemSprite, resourceIcon, spriteReference } from '../../src/components/sprites.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const METADATA_DIR = process.env.NUMISTA_METADATA_DIR || path.join(__dirname, 'nftMetadata');

export const DEED_SCHEMA = 'townforge.numista.deed/v2';
export const CURRENCY_SCHEMA = 'townforge.numista.currency/v1';
export const APP_ID = 'townforge-numista';

/* ------------------------------------------------------------------ */
/* Hashing                                                            */
/* ------------------------------------------------------------------ */

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const keys = Object.keys(value).sort();
  const parts = keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${parts.join(',')}}`;
}

/* ------------------------------------------------------------------ */
/* Asset identity                                                     */
/* ------------------------------------------------------------------ */

/** 32-byte asset id for a plot deed. Stable for the life of the plot. */
export function deedAssetId(plotId) {
  return sha256Hex(`${APP_ID}:deed:v1:${plotId}`);
}

/** 32-byte asset id for the game currency (fungible NUM asset). */
export const NUM_ASSET_ID =
  CONFIG.CHAIN.CURRENCY_ASSET_ID || sha256Hex(`${APP_ID}:currency:v1`);

export const DEED_ASSET_TYPE = 'collectible';
export const CURRENCY_ASSET_TYPE = 'fungible';

/* ------------------------------------------------------------------ */
/* Amount conversion (asset quantities are integers)                  */
/* ------------------------------------------------------------------ */

export function toUnits(num) {
  return Math.round(Number(num || 0) * CONFIG.CHAIN.UNITS_PER_NUM);
}

export function fromUnits(units) {
  return Number(units || 0) / CONFIG.CHAIN.UNITS_PER_NUM;
}

/* ------------------------------------------------------------------ */
/* Metadata                                                           */
/* ------------------------------------------------------------------ */

/**
 * Immutable deed metadata. `buildingType` is rolled deterministically from the
 * plot id, so re-claiming a reverted plot cannot change the deed's metadata.
 */
export function deedMetadata(plot) {
  return {
    app: APP_ID,
    schema: DEED_SCHEMA,
    gridVersion: CONFIG.GRID.VERSION,
    gridSeed: CONFIG.GRID.SEED,
    plotId: plot.id,
    name: plot.name,
    label: plot.label,
    region: plot.region,
    coords: plot.coords,
    bounds: plot.bounds,
    rarity: plot.rarity,
    rarityKey: plot.rarityKey,
    rarityName: plot.rarityName,
    price: plot.price,
    buildingType: plot.buildingType || plot.building?.type || null,
    sprite: spriteReference(
      plot.isCastle || plot.building?.settlementForm === 'castle'
        ? grandCastleSprite(plot.id)
        : buildingSprite({ type: plot.buildingType || plot.building?.type })
    ),
    image: `https://townforge.local/deeds/${plot.id}.png`
  };
}

/** Sprite reference for non-deed assets (coins, bars, battle reports). */
export function assetSprite(kind, key) {
  const sprite = kind === 'item' ? itemSprite(key) : kind === 'resource' ? resourceIcon(key) : buildingSprite({ type: key });
  return spriteReference(sprite);
}

export function metadataHash(metadata) {
  return sha256Hex(canonicalJson(metadata));
}

export function ensureMetadataDir() {
  if (!fs.existsSync(METADATA_DIR)) fs.mkdirSync(METADATA_DIR, { recursive: true });
}

/** Writes metadata once. Existing files are never overwritten (immutability). */
export function saveDeedMetadata(assetId, metadata) {
  ensureMetadataDir();
  const file = path.join(METADATA_DIR, `${assetId}.json`);
  if (fs.existsSync(file)) return file;
  const payload = {
    assetId,
    metadataHash: metadataHash(metadata),
    metadata
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

export function readDeedMetadata(assetId) {
  if (!/^[a-f0-9]{64}$/.test(String(assetId || ''))) return null;
  const file = path.join(METADATA_DIR, `${assetId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const recomputed = metadataHash(payload.metadata);
    return {
      ...payload,
      verified: recomputed === payload.metadataHash
    };
  } catch {
    return null;
  }
}

/** Verifies that a metadata file still matches its committed hash. */
export function verifyDeedMetadata(assetId, expectedHash) {
  const payload = readDeedMetadata(assetId);
  if (!payload) return false;
  return payload.metadataHash === expectedHash && payload.verified;
}
