import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingSprite, itemSprite, resourceSprite, spritePosition, townSprite, treasureSprite, grandCastleSprite, resourceIcon, metalAssetSprite } from './sprites.js';

test('settlement artwork follows the level 5 and level 10 milestones', () => {
  assert.deepEqual(buildingSprite({ type: 'peasant_lodge', level: 4 }).position, [2, 1]);
  assert.deepEqual(buildingSprite({ type: 'peasant_lodge', level: 5 }).position, [3, 1]);
  assert.deepEqual(buildingSprite({ type: 'peasant_lodge', level: 10 }).position, [4, 1]);
});

test('resources, equipment, and metal outputs use their matching atlas cells', () => {
  for (const resource of ['wood', 'iron', 'tin', 'copper', 'silver', 'gold']) {
    assert.ok(resourceSprite(resource), resource);
  }
  for (const item of ['levy', 'archer', 'cavalry', 'bronze_sword', 'iron_sword', 'bow', 'bronze_mail', 'iron_mail', 'bronze_helmet', 'iron_helmet']) {
    assert.ok(itemSprite(item), item);
  }
  assert.equal(spritePosition(buildingSprite({ type: 'silver_coin' })), '50% 100%');
  assert.equal(spritePosition(buildingSprite({ type: 'gold_coin' })), '75% 100%');
  assert.equal(spritePosition(itemSprite('cavalry')), `${100 / 3}% ${200 / 3}%`);
  assert.equal(buildingSprite({ type: 'unknown' }), null);
  assert.equal(spritePosition(townSprite('well')), '100% 100%');
  assert.equal(spritePosition(itemSprite('crown_coin')), '100% 100%');
  assert.equal(townSprite('unknown'), null);
});

test('grand castle and treasure sprites', () => {
  assert.deepEqual(grandCastleSprite('plot-1'), grandCastleSprite('plot-1'));
  assert.equal(grandCastleSprite('x').sheet, 'castle');
  assert.equal(spritePosition(treasureSprite('mining_rig')), '100% 100%');
  assert.equal(treasureSprite('nope'), null);
});

test('resource atlas icons and metal asset sprites', () => {
  assert.equal(spritePosition(resourceIcon('mine_cart')), '100% 100%');
  assert.deepEqual(metalAssetSprite('gold', 'bar'), resourceIcon('gold_bar'));
  assert.deepEqual(metalAssetSprite('silver', 'coin'), resourceIcon('silver_coin'));
});
