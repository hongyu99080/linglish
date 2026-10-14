const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldBypassExpensiveRateLimit,
} = require('../middleware/ai-auth');

function requestWithToken(token) {
  return {
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
  };
}

test('valid operations token bypasses the expensive limiter only for AI vocab routes', () => {
  process.env.AI_VOCAB_TOKEN = 'operations-token';

  assert.equal(
    shouldBypassExpensiveRateLimit(
      requestWithToken('operations-token'),
      '/ai/vocab/candidates',
    ),
    true,
  );
  assert.equal(
    shouldBypassExpensiveRateLimit(
      requestWithToken('operations-token'),
      '/ai/chat',
    ),
    false,
  );
});

test('missing or invalid operations token never bypasses the expensive limiter', () => {
  process.env.AI_VOCAB_TOKEN = 'operations-token';

  assert.equal(
    shouldBypassExpensiveRateLimit(
      requestWithToken(),
      '/ai/vocab/candidates',
    ),
    false,
  );
  assert.equal(
    shouldBypassExpensiveRateLimit(
      requestWithToken('wrong-token'),
      '/ai/vocab/batch-apply',
    ),
    false,
  );
});
