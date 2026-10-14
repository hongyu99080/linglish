const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/games/lianliankan.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

const words = (n) => Array.from({ length: n }, (_, i) => ({ lemma: 'w' + i, zh: 'z' + i }));
const seeded = () => { let s = 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
const at = (board, row, col) => board.cells.find((c) => c.row === row && c.col === col);

test('buildBoard emits one english and one chinese card per word', () => {
  const { buildBoard } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  assert.equal(board.cells.length, 12);
  const faces = board.cells.filter((c) => c.lemma === 'w0').map((c) => c.face).sort();
  assert.deepEqual(faces, ['en', 'zh']);
});

test('buildBoard fills every grid position exactly once', () => {
  const { buildBoard } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  const positions = new Set(board.cells.map((c) => c.row + ',' + c.col));
  assert.equal(positions.size, 12);
});

test('buildBoard gives every cell a unique id', () => {
  const { buildBoard } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  assert.equal(new Set(board.cells.map((c) => c.id)).size, 12);
});

test('findPath connects horizontally adjacent cells of the same word', () => {
  const { buildBoard, findPath } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  const a = board.cells[0];
  const b = board.cells.find((c) => c.lemma === a.lemma && c.id !== a.id);
  board.cells.forEach((c) => { if (c.id !== a.id && c.id !== b.id) c.cleared = true; });
  assert.notEqual(findPath(board, a, b), null, 'an otherwise empty board always connects');
});

test('findPath refuses to connect cards of different words', () => {
  const { buildBoard, findPath } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  const a = board.cells.find((c) => c.lemma === 'w0');
  const b = board.cells.find((c) => c.lemma === 'w1');
  assert.equal(findPath(board, a, b), null);
});

test('findPath refuses to connect a card to itself', () => {
  const { buildBoard, findPath } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  const a = board.cells[0];
  assert.equal(findPath(board, a, a), null);
});

test('findPath returns null when the route needs more than two turns', () => {
  const { findPath } = loadModule();
  // A blocked ring: the only route from (1,1) to (1,3) needs 4 turns.
  const cells = [];
  let id = 0;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const isEndpoint = row === 1 && (col === 1 || col === 3);
      cells.push({
        id: 'c' + (id += 1),
        lemma: isEndpoint ? 'target' : 'block',
        face: 'en',
        row,
        col,
        cleared: false,
      });
    }
  }
  const board = { rows: 3, cols: 5, cells };
  const a = cells.find((c) => c.row === 1 && c.col === 1);
  const b = cells.find((c) => c.row === 1 && c.col === 3);
  assert.equal(findPath(board, a, b), null);
});

test('clearPair returns a new board and does not mutate the old one', () => {
  const { buildBoard, clearPair } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  const a = board.cells[0];
  const b = board.cells.find((c) => c.lemma === a.lemma && c.id !== a.id);
  const next = clearPair(board, a.id, b.id);
  assert.equal(next.cells.find((c) => c.id === a.id).cleared, true);
  assert.equal(board.cells.find((c) => c.id === a.id).cleared, false);
});

test('isBoardCleared is true only once every cell is cleared', () => {
  const { buildBoard, isBoardCleared } = loadModule();
  const board = buildBoard(words(6), { rows: 3, cols: 4, rng: seeded() });
  assert.equal(isBoardCleared(board), false);
  const done = { ...board, cells: board.cells.map((c) => ({ ...c, cleared: true })) };
  assert.equal(isBoardCleared(done), true);
});
