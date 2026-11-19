/**
 * Unique, deterministic plot names for the UK land grid.
 *
 * Names are generated from fixed word lists and a seeded shuffle so that:
 *   - every one of the 3,500 plots has a stable, human-readable name;
 *   - no two plots ever share a name (case-insensitive);
 *   - the same seed always produces the same names across restarts;
 *   - hand-authored landmark names are never duplicated.
 */

export const NAME_ROOTS = [
  'ash', 'bracken', 'bram', 'cald', 'carr', 'cinder', 'cloud', 'cobble',
  'cress', 'dun', 'elder', 'ember', 'fen', 'fern', 'flint', 'fox',
  'glen', 'gorse', 'harrow', 'hawk', 'heather', 'hollow', 'holm', 'ingle',
  'iron', 'ivy', 'kestrel', 'kirk', 'lark', 'linden', 'marsh', 'moss',
  'nether', 'north', 'oak', 'otter', 'pen', 'pike', 'quarry', 'raven',
  'rid', 'rush', 'salt', 'sallow', 'stone', 'thorn', 'weald', 'willow'
];

export const NAME_SUFFIXES = [
  'bourne', 'by', 'combe', 'croft', 'dale', 'field', 'ford', 'gate',
  'gill', 'haven', 'hurst', 'mere', 'moor', 'reach', 'ridge', 'stead',
  'thorpe', 'ton', 'vale', 'wick'
];

export const NAME_FEATURES = [
  'Hollow', 'Reach', 'Green', 'Common', 'Rise', 'Bank', 'Fields', 'Wharf'
];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function capitalise(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function buildNamePool() {
  const seen = new Set();
  const pool = [];

  for (const root of NAME_ROOTS) {
    for (const suffix of NAME_SUFFIXES) {
      const stem = capitalise(root + suffix);
      for (const feature of NAME_FEATURES) {
        const name = `${stem} ${feature}`;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(name);
      }
    }
  }

  return pool;
}

/**
 * @param {number} count   number of names required
 * @param {number} seed    deterministic seed
 * @param {string[]} reserved names that must not be produced (landmarks)
 */
export function generatePlotNames(count, seed, reserved = []) {
  const reservedKeys = new Set(reserved.map(n => String(n).trim().toLowerCase()));
  const pool = buildNamePool().filter(n => !reservedKeys.has(n.toLowerCase()));

  if (pool.length < count) {
    throw new Error(`Plot name pool exhausted: need ${count}, have ${pool.length}`);
  }

  const rand = mulberry32((seed ^ 0x9E3779B9) >>> 0);
  shuffleInPlace(pool, rand);

  const names = pool.slice(0, count);

  // Defensive uniqueness assertion — generation should make this impossible.
  const check = new Set();
  for (const name of names) {
    const key = name.toLowerCase();
    if (check.has(key)) throw new Error(`Duplicate plot name generated: ${name}`);
    check.add(key);
  }

  return names;
}
