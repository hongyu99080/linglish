const dataStore = require('../data-store');

const SUPPORTED_TYPES = ['shadowing', 'dictogloss', '432', 'roleplay'];

function ensureType(type) {
  if (!SUPPORTED_TYPES.includes(type)) {
    throw new Error('UNSUPPORTED_SESSION_TYPE');
  }
}

async function startSession(userId, payload) {
  const { type, media_id = null, segment_id = null } = payload;
  ensureType(type);
  const now = new Date().toISOString();
  const session = await dataStore.createSession({
    user_id: userId,
    type,
    media_id,
    segment_id,
    start_at: now,
    end_at: null,
    duration_sec: null,
    output_blob: null,
  });
  await dataStore.createEvent({
    user_id: userId,
    event_time: now,
    event_name: `${type}_start`,
    properties: { media_id, segment_id },
    source: 'web',
  });
  return session;
}

async function stopSession(userId, sessionId, payload = {}) {
  const session = await dataStore.getSessionById(sessionId);
  if (!session || session.user_id !== userId) {
    throw new Error('SESSION_NOT_FOUND');
  }
  const endAt = payload.end_at || new Date().toISOString();
  let duration = payload.duration_sec;
  if (!duration && session.start_at) {
    duration = Math.max(
      0,
      Math.round((new Date(endAt).getTime() - new Date(session.start_at).getTime()) / 1000),
    );
  }
  const updated = await dataStore.updateSession(sessionId, {
    end_at: endAt,
    duration_sec: duration,
    output_blob: payload.output_blob ?? session.output_blob ?? null,
  });
  await dataStore.createEvent({
    user_id: userId,
    event_time: endAt,
    event_name: `${session.type}_stop`,
    properties: { duration_sec: updated.duration_sec },
    source: 'web',
  });
  return updated;
}

async function listSessions(userId, filters = {}) {
  const sessions = await dataStore.listSessions({
    userId,
    type: filters.type,
    limit: filters.limit || 20,
  });
  return sessions;
}

async function recordEvent(userId, name, properties = {}) {
  const event = await dataStore.createEvent({
    user_id: userId,
    event_time: new Date().toISOString(),
    event_name: name,
    properties,
    source: 'web',
  });
  return event;
}

function calculateStreak(dates) {
  if (!dates || dates.length === 0) return 0;

  // Normalize dates to YYYY-MM-DD strings to avoid timezone issues
  const uniqueDates = [...new Set(dates.map(d => {
    const date = new Date(d);
    return date.toISOString().split('T')[0];
  }))].sort((a, b) => b.localeCompare(a)); // Sort descending

  if (uniqueDates.length === 0) return 0;

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // Streak must start from today or yesterday
  if (uniqueDates[0] !== today && uniqueDates[0] !== yesterday) {
    return 0;
  }

  let streak = 1;
  let currentDate = new Date(uniqueDates[0]);

  for (let i = 1; i < uniqueDates.length; i++) {
    const prevDate = new Date(uniqueDates[i]);
    const diffTime = Math.abs(currentDate - prevDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      streak++;
      currentDate = prevDate;
    } else {
      break;
    }
  }
  return streak;
}

async function getStats(userId) {
  const [sessionStats, vocabStats, videoSeconds, activeDates] = await Promise.all([
    dataStore.getStatsForUser(userId),
    dataStore.getVocabStatsSummary(userId),
    dataStore.getEventSecondsTotal({ userId, name: 'video_watch' }),
    dataStore.getUserActiveDates(userId)
  ]);

  const streak = calculateStreak(activeDates);

  return {
    ...sessionStats,
    words_mastered: vocabStats.mastered || 0,
    video_minutes: Math.round((videoSeconds || 0) / 60),
    streak_days: streak,
    total_learning_minutes: Math.round(sessionStats.effective_minutes + ((videoSeconds || 0) / 60))
  };
}

module.exports = {
  startSession,
  stopSession,
  listSessions,
  recordEvent,
  getStats,
};
