const test = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('fs/promises');

const { removeFileSafe } = require('../utils/file-utils');

test('removeFileSafe keeps default warning behavior and suppresses warnings when silent is enabled', async () => {
  const originalUnlink = fsPromises.unlink;
  const originalWarn = console.warn;
  const warnings = [];
  fsPromises.unlink = async () => {
    const err = new Error('permission denied');
    err.code = 'EPERM';
    throw err;
  };
  console.warn = (...args) => warnings.push(args);

  try {
    await removeFileSafe('/tmp/loud-temp.wav');
    await removeFileSafe('/tmp/quiet-temp.wav', { silent: true });
  } finally {
    fsPromises.unlink = originalUnlink;
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Failed to remove file:');
  assert.equal(warnings[0][1], '/tmp/loud-temp.wav');
  assert.equal(warnings[0][2], 'permission denied');
});
