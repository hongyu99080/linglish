const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packPath = path.resolve(__dirname, '../../frontend/js/game/word-packs/pack-max.json');

function loadPack() {
  if (!fs.existsSync(packPath)) return null;
  return JSON.parse(fs.readFileSync(packPath, 'utf8'));
}

test('the pack file exists and parses as json', () => {
  assert.notEqual(loadPack(), null, 'pack-max.json must exist');
});

test('the pack has six chapters', () => {
  assert.equal(loadPack().chapters.length, 6);
});

test('each chapter carries exactly thirty words', () => {
  loadPack().chapters.forEach((chapter) => {
    assert.equal(chapter.words.length, 30, 'chapter ' + chapter.chapter + ' must have 30 words');
  });
});

test('the pack totals 180 words', () => {
  const total = loadPack().chapters.reduce((sum, c) => sum + c.words.length, 0);
  assert.equal(total, 180);
});

test('every word has a lemma, a chinese gloss and an ipa', () => {
  loadPack().chapters.forEach((chapter) => {
    chapter.words.forEach((word) => {
      assert.ok(word.lemma && word.lemma.length > 0, 'missing lemma in chapter ' + chapter.chapter);
      assert.ok(word.zh && word.zh.length > 0, word.lemma + ' missing zh');
      assert.ok(word.ipa && word.ipa.length > 0, word.lemma + ' missing ipa');
    });
  });
});

test('no lemma appears twice across the whole pack', () => {
  const lemmas = loadPack().chapters.flatMap((c) => c.words.map((w) => w.lemma));
  assert.equal(new Set(lemmas).size, lemmas.length);
});

test('every lemma is lowercase ascii letters only', () => {
  loadPack().chapters.flatMap((c) => c.words).forEach((word) => {
    assert.match(word.lemma, /^[a-z]+$/, word.lemma + ' must be lowercase letters only');
  });
});

test('chapters map onto the six unlockable parts in order', () => {
  const rig = require(path.resolve(__dirname, '../../frontend/js/game/character-rig.js'));
  const pack = loadPack();
  pack.chapters.forEach((chapter, index) => {
    assert.equal(chapter.chapter, index + 1);
    assert.equal(chapter.part, rig.PART_ORDER[index]);
  });
});
