const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDialogueRecordingPolicy,
} = require('../../frontend/js/dialogue-recording-policy');

test('two-word dialogue can stop shortly after speech instead of recording for six seconds', () => {
  const policy = getDialogueRecordingPolicy({
    text: 'school bus',
    start: 10,
    end: 12,
  });

  assert.deepEqual(policy, {
    minimumMs: 900,
    maximumMs: 4500,
  });
});

test('long dialogue keeps enough maximum time without extending the minimum silence guard', () => {
  const policy = getDialogueRecordingPolicy({
    text: 'Could you please tell me where the nearest train station is?',
    start: 10,
    end: 15,
  });

  assert.deepEqual(policy, {
    minimumMs: 900,
    maximumMs: 7000,
  });
});
