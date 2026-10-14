const test = require('node:test');
const assert = require('node:assert/strict');

const { createOriginalAudioReplayController } = require('../../frontend/js/practice/original-audio-replay');

function createHarness({ delayedSeek = false } = {}) {
  let time = 0;
  let muted = true;
  let plays = 0;
  let pauses = 0;
  let rafId = 0;
  const rafs = new Map();
  let timerId = 0;
  const timers = new Map();
  let requestedTime = null;
  let clock = 0;

  const controller = createOriginalAudioReplayController({
    getTime: () => time,
    setTime: (value) => { requestedTime = value; if (!delayedSeek) time = value; },
    play: async () => { plays += 1; return true; },
    pause: () => { pauses += 1; },
    unmute: () => { muted = false; },
    setVolume: () => {},
    requestFrame: (fn) => { rafs.set(++rafId, fn); return rafId; },
    cancelFrame: (id) => { rafs.delete(id); },
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: clock + ms }); return timerId; },
    clearTimer: (id) => { timers.delete(id); },
    now: () => clock,
  });

  return {
    controller,
    setTime(value) { time = value; },
    completeSeek() { time = requestedTime; },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) { timers.delete(id); timer.fn(); }
      }
    },
    flushFrames() {
      const callbacks = [...rafs.values()];
      rafs.clear();
      callbacks.forEach((fn) => fn());
    },
    snapshot: () => ({ time, muted, plays, pauses, rafs: rafs.size, timers: timers.size }),
  };
}

test('the same original segment can be replayed repeatedly from the beginning', async () => {
  const h = createHarness();
  await h.controller.replay({ start: 10, end: 12 });
  assert.equal(h.snapshot().time, 9.85);
  assert.equal(h.snapshot().plays, 1);
  assert.equal(h.snapshot().muted, false);

  await h.controller.replay({ start: 10, end: 12 });
  assert.equal(h.snapshot().time, 9.85);
  assert.equal(h.snapshot().plays, 2);
  assert.equal(h.snapshot().rafs, 1, 'a new replay replaces the old monitor');
  assert.equal(h.snapshot().timers, 1, 'a new replay replaces the old fallback timer');
});

test('a stale monitor cannot stop a newer replay', async () => {
  const h = createHarness();
  await h.controller.replay({ start: 2, end: 3 });
  const oldStopCount = h.snapshot().pauses;
  await h.controller.replay({ start: 8, end: 10 });

  h.setTime(3.5);
  h.flushFrames();
  assert.equal(h.snapshot().pauses, oldStopCount + 1, 'only replacement cleanup pauses once');
  assert.equal(h.controller.isPlaying(), true);

  h.setTime(8);
  h.flushFrames();
  h.setTime(10.5);
  h.flushFrames();
  assert.equal(h.controller.isPlaying(), false);
});

test('a delayed seek cannot finish a one-second replay using the previous playback time', async () => {
  const h = createHarness({ delayedSeek: true });
  h.setTime(48);
  await h.controller.replay({ start: 26, end: 27 });
  h.flushFrames();
  h.advance(2000);
  h.flushFrames();
  assert.equal(h.controller.isPlaying(), true);
  assert.equal(h.snapshot().pauses, 0);
  h.completeSeek();
  h.flushFrames();
  h.setTime(26.9);
  h.flushFrames();
  assert.equal(h.controller.isPlaying(), true);
  h.setTime(27.3);
  h.flushFrames();
  assert.equal(h.controller.isPlaying(), false);
  assert.equal(h.snapshot().pauses, 1);
});

test('slow or briefly buffering playback is stopped by media time instead of a one-times-speed wall clock', async () => {
  const h = createHarness();
  await h.controller.replay({ start: 10, end: 15 });
  h.flushFrames();
  for (const time of [10.2, 11, 12, 13, 14]) {
    h.setTime(time);
    h.advance(2000);
    h.flushFrames();
    assert.equal(h.controller.isPlaying(), true);
  }
  h.setTime(15.7);
  h.flushFrames();
  assert.equal(h.controller.isPlaying(), false);
});

test('a replay that never reaches the requested position eventually releases its controls', async () => {
  const h = createHarness({ delayedSeek: true });
  h.setTime(48);
  await h.controller.replay({ start: 26, end: 27 });
  h.advance(8000);
  assert.equal(h.controller.isPlaying(), false);
  assert.equal(h.snapshot().rafs, 0);
  assert.equal(h.snapshot().timers, 0);
});
