/**
 * Spaced repetition algorithm utilities
 * Handles vocabulary review scheduling and state transitions
 */

function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Compute state transition based on desired state
 */
function computeStateTransition(item, desiredState) {
  const now = new Date();
  const updates = {
    last_seen_at: now,
  };

  switch (desiredState) {
    case 'new':
      updates.state = 'encountered';
      updates.next_review_at = null;
      updates.interval_days = item?.interval_days || 1;
      break;
    case 'learning':
      updates.state = 'learning';
      updates.interval_days = 1;
      updates.next_review_at = addDays(now, 1);
      if (item && item.review_count < 1) {
        updates.review_count = 0;
      }
      break;
    case 'known':
      const reviewCount = Math.max(item?.review_count || 0, 1);
      updates.state = reviewCount >= 5 ? 'mastered' : 'reviewing';
      const interval = Math.max(item?.interval_days || 1, 7);
      updates.interval_days = interval;
      updates.review_count = reviewCount;
      updates.next_review_at = addDays(now, interval);
      break;
    default:
      break;
  }

  return updates;
}

/**
 * Apply review outcome and update spaced repetition parameters
 */
function applyReviewOutcome(item, outcome) {
  const now = new Date();
  let ease = item?.ease_factor || 2.5;
  let interval = item?.interval_days || 1;
  let reviewCount = item?.review_count || 0;
  let state = item?.state || 'learning';
  let lapses = item?.lapses || 0;
  let consecutiveFails = item?.consecutive_fails || 0;

  const normalizedOutcome = String(outcome || '').toLowerCase();

  // Special: force mastered (used by "完全掌握" button)
  if (normalizedOutcome === 'mastered' || normalizedOutcome === 'master' || normalizedOutcome === 'easy') {
    ease = Math.max(1.3, ease + 0.2);
    reviewCount = Math.max(reviewCount + 1, 5);
    state = 'mastered';
    consecutiveFails = 0;
    interval = Math.max(4, interval);
  } else if (outcome === 'pass' || outcome === 'success' || outcome === true) {
    ease = Math.max(1.3, ease + 0.1);
    if (reviewCount === 0) {
      interval = 1;
    } else if (reviewCount === 1) {
      interval = 3;
    } else {
      interval = Math.round(interval * ease);
    }
    reviewCount += 1;
    state = reviewCount >= 5 ? 'mastered' : 'reviewing';
    consecutiveFails = 0; // reset on success
  } else {
    ease = Math.max(1.3, ease - 0.3);
    interval = 0; // bring forward immediately
    reviewCount = Math.max(0, reviewCount - 1);
    consecutiveFails = (consecutiveFails || 0) + 1;
    // Downgrade on consecutive failures: 2+ fails and not already in learning
    if (consecutiveFails >= 2 && (state === 'reviewing' || state === 'mastered')) {
      state = 'learning';
      lapses = (lapses || 0) + 1;
    }
  }

  const nextReviewAt = addDays(now, interval);

  return {
    updates: {
      state,
      ease_factor: ease,
      interval_days: interval,
      review_count: reviewCount,
      lapses,
      consecutive_fails: consecutiveFails,
      next_review_at: nextReviewAt,
      last_review_at: now,
      last_seen_at: now,
    },
    log: {
      outcome: (normalizedOutcome === 'mastered' || normalizedOutcome === 'master' || normalizedOutcome === 'easy' || outcome === 'pass' || outcome === true) ? 'pass' : 'fail',
      easeFactor: ease,
      intervalDays: interval,
    },
  };
}

module.exports = {
  addDays,
  computeStateTransition,
  applyReviewOutcome,
};
