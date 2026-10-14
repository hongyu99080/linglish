const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/character-rig.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

test('the rig defines exactly six unlockable parts', () => {
  const { getPartDefinitions, PART_ORDER } = loadModule();
  assert.equal(PART_ORDER.length, 6);
  assert.equal(getPartDefinitions().length, 6);
});

test('the unlock order starts at the head and ends at the right leg', () => {
  const { PART_ORDER } = loadModule();
  assert.equal(PART_ORDER[0], 'head');
  assert.equal(PART_ORDER[5], 'legR');
});

test('every part definition carries geometry, a home and an explode vector', () => {
  const { getPartDefinitions } = loadModule();
  getPartDefinitions().forEach((part) => {
    assert.equal(part.size.length, 3, part.name + ' needs a size');
    assert.equal(part.home.length, 3, part.name + ' needs a home position');
    assert.equal(part.explode.length, 3, part.name + ' needs an explode vector');
    assert.equal(typeof part.color, 'number', part.name + ' needs a color');
  });
});

test('no two parts share the same home position', () => {
  const { getPartDefinitions } = loadModule();
  const homes = getPartDefinitions().map((p) => p.home.join(','));
  assert.equal(new Set(homes).size, 6);
});

test('every explode vector actually moves the part somewhere', () => {
  const { getPartDefinitions } = loadModule();
  getPartDefinitions().forEach((part) => {
    const magnitude = Math.hypot(part.explode[0], part.explode[1], part.explode[2]);
    assert.ok(magnitude > 0.5, part.name + ' must separate visibly');
  });
});

test('chapter one unlocks the head and chapter six the right leg', () => {
  const { partForChapter } = loadModule();
  assert.equal(partForChapter(1), 'head');
  assert.equal(partForChapter(6), 'legR');
});

test('a chapter outside the range has no part', () => {
  const { partForChapter } = loadModule();
  assert.equal(partForChapter(0), null);
  assert.equal(partForChapter(7), null);
});

test('an unlocked part sits at its home, full size and full color', () => {
  const { getPartDefinitions, computePartTransform } = loadModule();
  const head = getPartDefinitions()[0];
  const transform = computePartTransform(head, true);
  assert.deepEqual(transform.position, head.home);
  assert.equal(transform.scale, 1);
  assert.equal(transform.saturation, 1);
});

test('a locked part sits at its exploded offset, shrunken and desaturated', () => {
  const { getPartDefinitions, computePartTransform } = loadModule();
  const head = getPartDefinitions()[0];
  const transform = computePartTransform(head, false);
  assert.deepEqual(transform.position, [
    head.home[0] + head.explode[0],
    head.home[1] + head.explode[1],
    head.home[2] + head.explode[2],
  ]);
  assert.ok(transform.scale < 1);
  assert.equal(transform.saturation, 0);
});

test('a character is complete only with all six parts unlocked', () => {
  const { isCharacterComplete, PART_ORDER } = loadModule();
  assert.equal(isCharacterComplete(['head', 'body']), false);
  assert.equal(isCharacterComplete(PART_ORDER.slice()), true);
});
