(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameLianliankan = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const GAME_TYPE = 'lianliankan';
  const MAX_TURNS = 2;
  const DIRECTIONS = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  function shuffle(items, rng) {
    const next = items.slice();
    for (let i = next.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const swap = next[i];
      next[i] = next[j];
      next[j] = swap;
    }
    return next;
  }

  function buildBoard(words, options) {
    const settings = options || {};
    const rows = Number(settings.rows) || 4;
    const cols = Number(settings.cols) || 6;
    const rng = typeof settings.rng === 'function' ? settings.rng : Math.random;

    const capacity = rows * cols;
    const usable = words.slice(0, Math.floor(capacity / 2));
    const faces = [];
    usable.forEach(function (word) {
      faces.push({ lemma: word.lemma, face: 'en', label: word.lemma });
      faces.push({ lemma: word.lemma, face: 'zh', label: word.zh });
    });

    const positions = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) positions.push({ row, col });
    }

    const placed = shuffle(faces, rng);
    const cells = placed.map(function (entry, index) {
      return {
        id: 'cell-' + index,
        lemma: entry.lemma,
        face: entry.face,
        label: entry.label,
        row: positions[index].row,
        col: positions[index].col,
        cleared: false,
      };
    });

    return { rows, cols, cells };
  }

  function buildOccupancy(board) {
    const grid = new Map();
    board.cells.forEach(function (cell) {
      if (!cell.cleared) grid.set(cell.row + ',' + cell.col, cell);
    });
    return grid;
  }

  function isWalkable(grid, board, row, col, target) {
    if (row < -1 || col < -1 || row > board.rows || col > board.cols) return false;
    if (row === target.row && col === target.col) return true;
    return !grid.has(row + ',' + col);
  }

  function findPath(board, cellA, cellB) {
    if (!cellA || !cellB) return null;
    if (cellA.id === cellB.id) return null;
    if (cellA.lemma !== cellB.lemma) return null;
    if (cellA.face === cellB.face) return null;
    if (cellA.cleared || cellB.cleared) return null;

    const grid = buildOccupancy(board);
    const start = { row: cellA.row, col: cellA.col };
    const target = { row: cellB.row, col: cellB.col };

    const best = new Map();
    const queue = [{ row: start.row, col: start.col, dir: -1, turns: 0, path: [start] }];

    while (queue.length > 0) {
      const node = queue.shift();
      if (node.row === target.row && node.col === target.col) return node.path;

      for (let d = 0; d < DIRECTIONS.length; d += 1) {
        const turns = node.dir === -1 || node.dir === d ? node.turns : node.turns + 1;
        if (turns > MAX_TURNS) continue;

        const row = node.row + DIRECTIONS[d][0];
        const col = node.col + DIRECTIONS[d][1];
        if (!isWalkable(grid, board, row, col, target)) continue;

        const key = row + ',' + col + ',' + d;
        if (best.has(key) && best.get(key) <= turns) continue;
        best.set(key, turns);

        queue.push({ row, col, dir: d, turns, path: node.path.concat({ row, col }) });
      }
    }

    return null;
  }

  function clearPair(board, idA, idB) {
    return {
      ...board,
      cells: board.cells.map(function (cell) {
        return cell.id === idA || cell.id === idB ? { ...cell, cleared: true } : cell;
      }),
    };
  }

  function isBoardCleared(board) {
    return board.cells.every(function (cell) { return cell.cleared; });
  }

  return { buildBoard, findPath, clearPair, isBoardCleared, GAME_TYPE, MAX_TURNS };
});
