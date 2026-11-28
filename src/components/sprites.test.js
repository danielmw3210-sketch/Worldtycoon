import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingSprite, itemSprite, resourceSprite, spritePosition } from './sprites.js';

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
});
