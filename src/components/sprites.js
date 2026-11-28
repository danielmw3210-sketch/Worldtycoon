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
  silver_coin: [2, 3],
  gold_coin: [3, 3],
  metal_bar: [4, 3]
};

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
  knight: [3, 2]
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
  return position ? { sheet: 'building', position } : null;
}

export function resourceSprite(resource) {
  return buildingSprite({ type: resource === 'wood' ? 'woodcutter' : `${resource}_mine` });
}

export function itemSprite(type) {
  const position = equipment[type];
  return position ? { sheet: 'equipment', position } : null;
}

export function spritePosition(sprite) {
  const [col, row] = sprite.position;
  return `${col * (sprite.sheet === 'building' ? 25 : 100 / 3)}% ${row * (100 / 3)}%`;
}
