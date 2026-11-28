import { CONFIG } from '../config.js';
import { INITIAL_PLOTS } from './defaultPlots.js';
import { generatePlotNames } from './plotNames.js';
import { deedAssetId } from './deedRegistry.js';

/**
 * Worldtycoon UK land grid.
 *
 * The map is divided into a deterministic grid of square plots (50 x 70 = 3,500).
 * Plot rarity and prices are generated from a fixed seed, so the same plots,
 * labels, rarities and prices exist on every server restart.
 */

export const RARITY_TIERS = [
  { tier: 1, key: 'common',       name: 'Common',       price: 50,         weight: 40, color: '#94a3b8' },
  { tier: 2, key: 'uncommon',     name: 'Uncommon',     price: 500,        weight: 25, color: '#4ade80' },
  { tier: 3, key: 'rare',         name: 'Rare',         price: 5000,       weight: 15, color: '#38bdf8' },
  { tier: 4, key: 'super_rare',   name: 'Super Rare',   price: 50000,      weight: 8,  color: '#a78bfa' },
  { tier: 5, key: 'epic',         name: 'Epic',         price: 500000,     weight: 5,  color: '#f472b6' },
  { tier: 6, key: 'legendary',    name: 'Legendary',    price: 5000000,    weight: 4,  color: '#fbbf24' },
  { tier: 7, key: 'mythic',       name: 'Mythic',       price: 50000000,   weight: 2,  color: '#fb7185' },
  { tier: 8, key: 'transcendent', name: 'Transcendent', price: 500000000,  weight: 1,  color: '#22d3ee' }
];

export const RARITY_BY_TIER = Object.fromEntries(RARITY_TIERS.map(r => [r.tier, r]));
export const RARITY_BY_KEY = Object.fromEntries(RARITY_TIERS.map(r => [r.key, r]));

export function rarityByTier(tier) {
  return RARITY_BY_TIER[Number(tier)] || RARITY_BY_TIER[1];
}

export function rarityByKey(key) {
  return RARITY_BY_KEY[key] || RARITY_BY_TIER[1];
}

/**
 * Income property catalog. `incomeFactor` nudges the payout relative to the
 * price-derived base rate; utilities additionally pay a Monopoly-style dice
 * multiplier when income is collected.
 */
export const BUILDING_CATALOG = {
  cottage: {
    name: 'Country Cottage', category: 'housing', incomeFactor: 1.0,
    description: 'A modest rural home rented to farming families. Steady, dependable income.'
  },
  terraced_row: {
    name: 'Terraced Row', category: 'housing', incomeFactor: 1.02,
    description: 'A row of brick workers cottages close to the mills. Reliable weekly rents.'
  },
  townhouse: {
    name: 'Georgian Townhouse', category: 'housing', incomeFactor: 1.04,
    description: 'An elegant townhouse let to merchants and clerks.'
  },
  manor: {
    name: 'Country Manor', category: 'housing', incomeFactor: 1.06,
    description: 'A grand manor with tenant farms and gardens producing premium rents.'
  },
  villa: {
    name: 'Riverside Villa', category: 'housing', incomeFactor: 1.08,
    description: 'A luxurious riverside villa for the rising professional class.'
  },
  estate: {
    name: 'Noble Estate', category: 'housing', incomeFactor: 1.10,
    description: 'Vast landed estate with game rights, farms and a private village.'
  },
  palace: {
    name: 'Royal Palace', category: 'housing', incomeFactor: 1.15,
    description: 'A royal residence collecting state apartments rent and ceremonial fees.'
  },

  water_works: {
    name: 'Water Works', category: 'utility', incomeFactor: 0.90, variableYield: true,
    description: 'Pumps clean water to the district. Payout rolls like Monopoly utilities (2d6).'
  },
  electric_company: {
    name: 'Electric Company', category: 'utility', incomeFactor: 0.92, variableYield: true,
    description: 'Powers the district grid. Payout rolls like Monopoly utilities (2d6).'
  },

  railway_station: {
    name: 'Railway Station', category: 'transport', incomeFactor: 0.88,
    description: 'A trunk-line station collecting passenger and freight platform dues.'
  },
  docks: {
    name: 'Docks & Wharves', category: 'transport', incomeFactor: 0.92,
    description: 'Deep-water wharves levying cargo handling and berthing fees.'
  },
  salvage_yard: {
    name: 'Salvage Yard', category: 'transport', incomeFactor: 0.84,
    description: 'Coastal salvage operation stripping wrecks for valuable materials.'
  },

  market: {
    name: 'Market Hall', category: 'commerce', incomeFactor: 1.0,
    description: 'A covered market collecting stall rents from traders.'
  },
  theatre: {
    name: 'Grand Theatre', category: 'leisure', incomeFactor: 1.10,
    description: 'A playhouse drawing crowds from across the region.'
  },
  hotel: {
    name: 'Grand Hotel', category: 'leisure', incomeFactor: 1.14,
    description: 'A luxury hotel with dining rooms and a ballroom.'
  },
  casino: {
    name: 'Casino', category: 'leisure', incomeFactor: 1.20,
    description: 'A licensed gaming house taking a house edge on every table.'
  },
  amusement_park: {
    name: 'Amusement Park', category: 'leisure', incomeFactor: 1.12,
    description: 'A seaside pleasure park with rides and attractions.'
  },

  quarry: {
    name: 'Stone Quarry', category: 'resource', incomeFactor: 1.0,
    description: 'Granite and limestone workings supplying the building trade.'
  },
  coal_mine: {
    name: 'Coal Mine', category: 'resource', incomeFactor: 1.10,
    description: 'A deep coal seam feeding the industrial furnaces.'
  },
  fishery: {
    name: 'Fishery', category: 'resource', incomeFactor: 0.80,
    description: 'Coastal fishing grounds and a smokehouse curing the catch.'
  },

  silver_mint: {
    name: 'Silver Mint', category: 'mint', incomeFactor: 1.20, metal: 'silver', adminOnly: true,
    description: 'Strikes silver coins. Minting requires an administrator. Owner earns seigniorage.'
  },
  gold_mint: {
    name: 'Royal Gold Mint', category: 'mint', incomeFactor: 1.28, metal: 'gold', adminOnly: true,
    description: 'Strikes gold coins. Minting requires an administrator. Owner earns seigniorage.'
  }
};

export const RARITY_BUILDING_POOLS = {
  1: ['cottage', 'terraced_row', 'water_works', 'fishery'],
  2: ['townhouse', 'electric_company', 'market', 'railway_station'],
  3: ['manor', 'docks', 'theatre', 'quarry'],
  4: ['villa', 'hotel', 'amusement_park', 'coal_mine'],
  5: ['estate', 'casino', 'salvage_yard'],
  6: ['palace', 'silver_mint'],
  7: ['palace', 'gold_mint'],
  8: ['gold_mint', 'silver_mint']
};

export function rollBuildingForRarity(tier, rand = Math.random) {
  const pool = RARITY_BUILDING_POOLS[Number(tier)] || RARITY_BUILDING_POOLS[1];
  const key = pool[Math.floor(rand() * pool.length)] || pool[0];
  const def = BUILDING_CATALOG[key];
  return { key, ...def };
}

/**
 * Building rolls are seeded from the plot id, not Math.random(). A plot always
 * discovers the same building, which keeps the deed metadata immutable even if
 * a failed claim is reverted and re-claimed later.
 */
export function rollBuildingDeterministic(tier, plotId) {
  const seed = hashString(plotId);
  return rollBuildingForRarity(tier, mulberry32(seed));
}

const PLOT_RESOURCE_TYPES = ['wood', 'iron', 'tin', 'copper', 'silver', 'gold'];

export function generateResourceDeposits(seed, tier) {
  const rand = mulberry32(hashString(`${seed}:resources`));
  const count = 2 + (Number(tier) >= 5 ? 1 : 0) + (Number(tier) >= 8 ? 1 : 0);
  const shuffled = PLOT_RESOURCE_TYPES.filter(resource => resource !== 'wood');
  shuffleInPlace(shuffled, rand);
  const deposits = {};
  for (const resource of ['wood', ...shuffled.slice(0, count - 1)]) {
    const rarityBonus = Math.max(0, Number(tier) - 1);
    const base = resource === 'gold' ? 25 : resource === 'silver' ? 50 : resource === 'copper' ? 80 : 120;
    deposits[resource] = Math.round(base * (1 + rarityBonus * 0.2) * (0.75 + rand() * 0.5));
  }
  return deposits;
}

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function baseIncomeForPrice(price, tier, incomeFactor = 1) {
  const payback = CONFIG.ECONOMY.INCOME_PAYBACK_HOURS || 240;
  const base = (Number(price) || CONFIG.ECONOMY.PLOT_CLAIM_PRICE_NUM) / payback;
  return +Math.max(0.0001, base * (incomeFactor || 1)).toFixed(4);
}

export function incomePerHourFor(baseIncomePerHour, level) {
  const step = CONFIG.ECONOMY.UPGRADE_INCOME_STEP || 1.5;
  return +(baseIncomePerHour * Math.pow(step, Math.max(0, (level || 1) - 1))).toFixed(4);
}

export function upgradeCostFor(price, currentLevel) {
  return +((Number(price) || 0) * (CONFIG.ECONOMY.UPGRADE_COST_RATE || 0.4) * (currentLevel || 1)).toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Deterministic generation                                           */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
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

export function columnLabel(col) {
  let label = '';
  let n = col;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export function regionFor(lat, lng) {
  if (lat >= 58.6) return 'Shetland & Orkney';
  if (lat >= 57.0) return 'Highlands & Islands';
  if (lat >= 55.8) return 'Central Scotland';
  if (lat >= 54.8) return 'Southern Scotland';
  if (lng < -3.0 && lat >= 53.0) return 'North West England';
  if (lat >= 54.0) return 'North East England';
  if (lng < -2.6 && lat >= 51.3) return 'Wales';
  if (lng >= -0.6 && lng <= 0.4 && lat >= 51.2 && lat <= 51.8) return 'Greater London';
  if (lng >= 0.4) return 'East Anglia';
  if (lat >= 52.0) return 'Midlands';
  if (lng < -1.5) return 'South West England';
  return 'South East England';
}

const LANDMARK_RARITY = {
  town_hall: 6,
  bank: 5,
  auction_house: 4,
  stock_broker: 3,
  silver_mint: 6,
  gold_mint: 8
};

// Public mint landmarks so admins can actually strike coins without having to
// buy a multi-million NUM transcendent plot first.
const MINT_LANDMARKS = [
  {
    id: 'UK-MINT-GOLD-01',
    name: 'Royal Gold Mint · Tower Hill',
    region: 'Greater London',
    coords: [51.5085, -0.0761],
    owner: 'crown_treasury',
    isClaimed: true,
    building: {
      type: 'gold_mint',
      category: 'mint',
      metal: 'gold',
      name: 'Royal Gold Mint · Tower Hill',
      level: 1,
      adminOnly: true,
      description: 'The sovereign gold mint. Administrators may strike gold coins here; seigniorage feeds the public treasury.',
      baseIncomePerHour: 4,
      incomePerHour: 4,
      stats: { accruedIncome: 0, totalIncomeCollected: 0 }
    },
    nftState: { stage: 'offchain', tokenId: 'NFT-NUM-MINT-GOLD-01', mintedAt: null, txHash: null, blockHeight: null }
  },
  {
    id: 'UK-MINT-SILVER-01',
    name: 'Edinburgh Silver Mint',
    region: 'Southern Scotland',
    coords: [55.9533, -3.1883],
    owner: 'crown_treasury',
    isClaimed: true,
    building: {
      type: 'silver_mint',
      category: 'mint',
      metal: 'silver',
      name: 'Edinburgh Silver Mint',
      level: 1,
      adminOnly: true,
      description: 'The royal silver mint. Administrators may strike silver coins here; seigniorage feeds the public treasury.',
      baseIncomePerHour: 2,
      incomePerHour: 2,
      stats: { accruedIncome: 0, totalIncomeCollected: 0 }
    },
    nftState: { stage: 'offchain', tokenId: 'NFT-NUM-MINT-SILVER-01', mintedAt: null, txHash: null, blockHeight: null }
  }
];


function buildGridCells() {
  const { COLS, ROWS, MIN_LAT, MAX_LAT, CENTER_LNG } = CONFIG.GRID;

  const latStep = (MAX_LAT - MIN_LAT) / ROWS;
  const midLat = (MIN_LAT + MAX_LAT) / 2;
  // Keep cells roughly square: 1 degree of longitude shrinks by cos(latitude).
  const lngStep = latStep / Math.cos((midLat * Math.PI) / 180);
  const totalLng = lngStep * COLS;
  const minLng = CENTER_LNG - totalLng / 2;

  const cells = [];
  let index = 0;

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const south = MIN_LAT + row * latStep;
      const north = south + latStep;
      const west = minLng + col * lngStep;
      const east = west + lngStep;
      const centerLat = (south + north) / 2;
      const centerLng = (west + east) / 2;
      const label = `${columnLabel(col)}-${row + 1}`;

      cells.push({
        index,
        row,
        col,
        label,
        id: `UK-${String(index + 1).padStart(4, '0')}`,
        region: regionFor(centerLat, centerLng),
        coords: [+centerLat.toFixed(6), +centerLng.toFixed(6)],
        bounds: [
          [+south.toFixed(6), +west.toFixed(6)],
          [+north.toFixed(6), +east.toFixed(6)]
        ]
      });
      index++;
    }
  }

  // Every parcel gets a unique, deterministic UK-style name.
  const reserved = [...INITIAL_PLOTS, ...MINT_LANDMARKS].map(p => p.name).filter(Boolean);
  const names = generatePlotNames(cells.length, CONFIG.GRID.SEED || 20261119, reserved);
  cells.forEach((cell, i) => { cell.name = names[i]; });

  return cells;
}

/**
 * Build the full 3,500 plot registry, then pin the hand-authored landmark
 * plots (town halls, banks, auction houses, stock brokers) onto the nearest
 * grid cell so existing auctions/modals keep referencing real plots.
 */
export function generateGridPlots() {
  const rand = mulberry32(CONFIG.GRID.SEED || 20261119);
  const cells = buildGridCells();
  const total = cells.length;

  // Exact weighted distribution: 40/25/15/8/5/4/2/1 across 3,500 plots.
  const tierBag = [];
  RARITY_TIERS.forEach(tier => {
    const count = Math.round((tier.weight / 100) * total);
    for (let i = 0; i < count; i++) tierBag.push(tier.tier);
  });
  // Guard against rounding drift.
  while (tierBag.length < total) tierBag.push(1);
  tierBag.length = total;
  shuffleInPlace(tierBag, rand);

  const plots = cells.map((cell, i) => {
    const tier = rarityByTier(tierBag[i]);
    return {
      ...cell,
      rarity: tier.tier,
      rarityKey: tier.key,
      rarityName: tier.name,
      price: tier.price,
      resourceSeed: cell.id,
      resourceDeposits: generateResourceDeposits(cell.id, tier.tier),
      stockpile: { wood: 24, iron: 6, tin: 0, copper: 0, silver: 0, gold: 0 },
      structures: [],
      isClaimed: false,
      isLandmark: false,
      owner: null,
      building: null,
      assetId: deedAssetId(cell.id),
      nftState: {
        stage: 'unminted',
        assetId: deedAssetId(cell.id),
        tokenId: deedAssetId(cell.id),
        metadataHash: null,
        mintedAt: null,
        txHash: null,
        blockHeight: null,
        confirmations: 0
      }
    };
  });

  pinLandmarks(plots);
  plots.forEach(plot => {
    plot.assetId = deedAssetId(plot.id);
    if (plot.nftState) plot.nftState.assetId = plot.assetId;
  });
  return plots;
}

function pinLandmarks(plots) {
  const used = new Set();

  [...INITIAL_PLOTS, ...MINT_LANDMARKS].forEach(landmark => {
    const [lat, lng] = landmark.coords || [54.3, -2.4];

    let best = null;
    let bestDist = Infinity;

    plots.forEach((plot, i) => {
      if (used.has(i)) return;
      const dLat = plot.coords[0] - lat;
      const dLng = (plot.coords[1] - lng) * Math.cos((lat * Math.PI) / 180);
      const dist = dLat * dLat + dLng * dLng;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });

    if (best == null) return;
    used.add(best);

    const plot = plots[best];
    const rarity = rarityByTier(LANDMARK_RARITY[landmark.building?.type] || 3);

    plots[best] = {
      ...plot,
      id: landmark.id,
      name: landmark.name,
      region: landmark.region || plot.region,
      owner: landmark.owner || null,
      isClaimed: !!landmark.isClaimed,
      isLandmark: true,
      rarity: rarity.tier,
      rarityKey: rarity.key,
      rarityName: rarity.name,
      price: rarity.price,
      building: landmark.building || null,
      nftState: {
        stage: 'unminted',
        assetId: deedAssetId(landmark.id),
        tokenId: deedAssetId(landmark.id),
        metadataHash: null,
        mintedAt: null,
        txHash: null,
        blockHeight: null,
        confirmations: 0
      }
    };
  });
}
