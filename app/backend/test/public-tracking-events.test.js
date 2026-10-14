const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const dataStore = require('../data-store');
const { registerAuthRoutes } = require('../routes/auth');

const originalCreateEvent = dataStore.createEvent;

function request(payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'user-agent': 'test' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function response() {
  return {
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
    end(payload) { this.payload = JSON.parse(payload); this.writableEnded = true; },
  };
}

test.after(async () => {
  dataStore.createEvent = originalCreateEvent;
  try { await dataStore.pool.end(); } catch (_) { }
});

test('anonymous first-lesson entry and lifecycle events are accepted by the public tracker', async () => {
  const recorded = [];
  dataStore.createEvent = async (event) => { recorded.push(event); };
  const names = [
    'first_lesson_entry_click',
    'first_lesson_guest_ready',
    'first_lesson_entry_ready',
    'first_lesson_entry_error',
    'first_lesson_ready',
    'first_lesson_playback_started',
    'first_lesson_sentence_completed',
    'first_lesson_ai_feedback_seen',
    'first_lesson_completed',
  ];

  for (const eventName of names) {
    const res = response();
    assert.equal(await registerAuthRoutes(
      '/track/event',
      request({
        event_name: eventName,
        visitor_id: 'llv_existingvisitor12',
        properties: { visitor_id: 'llv_existingvisitor12', practiced: 1, total: 21, percentage: 5 },
      }),
      res,
      new URL('http://localhost/track/event'),
    ), true);
    assert.deepEqual(res.payload, { ok: true });
  }

  assert.deepEqual(recorded.map((event) => event.event_name), names);
  assert.equal(recorded.every((event) => event.properties.visitor_id === 'llv_existingvisitor12'), true);
});

test('anonymous recommendation events are accepted by the public tracker', async () => {
  const recorded = [];
  dataStore.createEvent = async (event) => { recorded.push(event); };
  const names = ['reco_impression', 'reco_click', 'reco_feedback'];

  for (const eventName of names) {
    const res = response();
    await registerAuthRoutes(
      '/track/event',
      request({ event_name: eventName, properties: { slot: 'next', video_resource_id: '12', position: 0 } }),
      res,
      new URL('http://localhost/track/event'),
    );
    assert.deepEqual(res.payload, { ok: true });
  }

  assert.deepEqual(recorded.map((event) => event.event_name), names);
});

test('unknown anonymous events remain ignored', async () => {
  let called = false;
  dataStore.createEvent = async () => { called = true; };
  const res = response();

  await registerAuthRoutes(
    '/track/event',
    request({ event_name: 'arbitrary_untrusted_event' }),
    res,
    new URL('http://localhost/track/event'),
  );

  assert.deepEqual(res.payload, { ok: true, ignored: true });
  assert.equal(called, false);
});
