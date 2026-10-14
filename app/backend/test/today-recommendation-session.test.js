const test = require('node:test');
const assert = require('node:assert/strict');

let TodayRecommendationSession = {};
try {
  TodayRecommendationSession = require('../../frontend/js/video-reader/today-recommendation-session');
} catch (_) {
  // RED 阶段：模块尚未实现时，让行为断言明确失败。
}

test('starting the recommended video dismisses the card for the current page session', () => {
  assert.equal(typeof TodayRecommendationSession.create, 'function');

  const session = TodayRecommendationSession.create();
  const card = { hidden: false, style: { display: 'grid' } };
  const candidate = { id: 42, title: 'Job interview' };
  let selectedVideo = null;

  const started = session.start(candidate, {
    card,
    selectVideo(video) {
      selectedVideo = video;
    }
  });

  assert.equal(started, true);
  assert.equal(card.hidden, true);
  assert.equal(card.style.display, 'none');
  assert.equal(selectedVideo, candidate);
  assert.equal(session.shouldShow(candidate), false);
});

test('a dismissed recommendation stays hidden during later list refreshes', () => {
  assert.equal(typeof TodayRecommendationSession.create, 'function');

  const session = TodayRecommendationSession.create();
  session.dismiss();

  assert.equal(session.shouldShow({ id: 1 }), false);
  assert.equal(session.shouldShow({ id: 2 }), false);
});

test('without a candidate, start does nothing and keeps the session available', () => {
  assert.equal(typeof TodayRecommendationSession.create, 'function');

  const session = TodayRecommendationSession.create();
  const card = { hidden: false };
  let selectCount = 0;

  const started = session.start(null, {
    card,
    selectVideo() {
      selectCount += 1;
    }
  });

  assert.equal(started, false);
  assert.equal(card.hidden, false);
  assert.equal(selectCount, 0);
  assert.equal(session.shouldShow({ id: 1 }), true);
});
