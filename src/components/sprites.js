const buildings = {
  cottage: [0, 0],
  terraced_row: [1, 0],
  townhouse: [2, 0],
  manor: [3, 0],
  villa: [4, 0],
  estate: [0, 1],
  palace: [1, 1],
  peasant_lodge: [2, 1],
  settlement_lodge: [2, 1],
  town_hall: [3, 1],
  motte_and_bailey: [3, 1],
  castle_keep: [4, 1],
  woodcutter: [0, 2],
  iron_mine: [1, 2],
  tin_mine: [2, 2],
  copper_mine: [3, 2],
  silver_mine: [4, 2],
  gold_mine: [0, 3],
  forge: [1, 3],
  resource_mint: [3, 3],
  silver_coin: [2, 3],
  gold_coin: [3, 3],
  metal_bar: [4, 3],
  gold_mint: [3, 3],
  silver_mint: [2, 3]
};

export const SPRITE_SHEETS = {
  building: { file: 'building-atlas.png', cols: 5, rows: 4 },
  equipment: { file: 'soldier-atlas.png', cols: 4, rows: 4 },
  town: { file: 'town-atlas.png', cols: 4, rows: 4 },
  castle: { file: 'castle-atlas.png', cols: 4, rows: 4 },
  treasure: { file: 'treasure-atlas.png', cols: 4, rows: 4 },
  resource: { file: 'resource-atlas.png', cols: 4, rows: 4 }
};

const resources = {
  wood: [0, 0],
  iron: [1, 0],
  tin: [2, 0],
  copper: [3, 0],
  silver: [0, 1],
  gold: [1, 1],
  silver_coin: [2, 1],
  gold_coin: [3, 1],
  silver_bar: [0, 2],
  gold_bar: [1, 2],
  silver_coins: [2, 2],
  gold_coins: [3, 2],
  anvil: [0, 3],
  mint_press: [1, 3],
  vault: [2, 3],
  mine_cart: [3, 3]
};

export function resourceIcon(key) {
  const position = resources[key];
  return position ? { sheet: 'resource', position } : null;
}

/** Icon for a minted metal asset, e.g. ('gold', 'bar') -> gold ingot. */
export function metalAssetSprite(metal, form) {
  return resourceIcon(`${metal}_${form === 'bar' ? 'bar' : 'coin'}`);
}

const treasure = {
  crown: [0, 0],
  coronet: [1, 0],
  signet_ring: [2, 0],
  banner: [3, 0],
  deed_scroll: [0, 1],
  key: [1, 1],
  coin_purse: [2, 1],
  treasure_chest: [3, 1],
  stock_certificate: [0, 2],
  scales: [1, 2],
  timber: [2, 2],
  grain: [3, 2],
  tools: [0, 3],
  trebuchet: [1, 3],
  war_drum: [2, 3],
  mining_rig: [3, 3]
};

export function treasureSprite(type) {
  const position = treasure[type];
  return position ? { sheet: 'treasure', position } : null;
}

/** Picks one of the 16 grand castle designs, stable for a given plot id. */
export function grandCastleSprite(seed) {
  let hash = 0;
  for (const char of String(seed ?? '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const index = hash % 16;
  return { sheet: 'castle', position: [index % 4, Math.floor(index / 4)] };
}

const equipment = {
  bronze_sword: [0, 0],
  iron_sword: [1, 0],
  bow: [2, 0],
  bronze_mail: [3, 0],
  iron_mail: [0, 1],
  bronze_helmet: [1, 1],
  iron_helmet: [2, 1],
  levy: [3, 1],
  archer: [0, 2],
  cavalry: [1, 2],
  man_at_arms: [2, 2],
  knight: [3, 2],
  shield: [0, 3],
  spear: [1, 3],
  iron_bar: [2, 3],
  crown_coin: [3, 3]
};

const town = {
  bank: [0, 0],
  market: [1, 0],
  auction_house: [2, 0],
  stock_exchange: [3, 0],
  stock_broker: [3, 0],
  open_lot: [3, 3],
  tavern: [0, 1],
  church: [1, 1],
  windmill: [2, 1],
  farm: [3, 1],
  barracks: [0, 2],
  stable: [1, 2],
  watchtower: [2, 2],
  harbour: [3, 2],
  armoury: [0, 3],
  throne_hall: [1, 3],
  library: [2, 3],
  well: [3, 3]
};

export function buildingSprite(building) {
  if (!building) return null;
  let type = building.type;
  if (type === 'peasant_lodge') {
    const level = Number(building.level || 1);
    if (level >= 10 || building.settlementForm === 'castle') type = 'castle_keep';
    else if (level >= 5 || building.settlementForm === 'motte_and_bailey') type = 'motte_and_bailey';
  }
  const position = buildings[type];
  if (position) return { sheet: 'building', position };
  return townSprite(type);
}

export function resourceSprite(resource) {
  return buildingSprite({ type: resource === 'wood' ? 'woodcutter' : `${resource}_mine` });
}

export function itemSprite(type) {
  const position = equipment[type];
  return position ? { sheet: 'equipment', position } : null;
}

export function townSprite(type) {
  const position = town[type];
  return position ? { sheet: 'town', position } : null;
}

/** Serializable atlas reference stored in minted asset metadata. */
export function spriteReference(sprite) {
  if (!sprite) return null;
  const sheet = SPRITE_SHEETS[sprite.sheet];
  return {
    atlas: `/assets/${sheet.file}`,
    col: sprite.position[0],
    row: sprite.position[1],
    cols: sheet.cols,
    rows: sheet.rows
  };
}

export function spritePosition(sprite) {
  const [col, row] = sprite.position;
  return `${col * (sprite.sheet === 'building' ? 25 : 100 / 3)}% ${row * (100 / 3)}%`;
}
