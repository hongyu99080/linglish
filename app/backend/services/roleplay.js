const dataStore = require('../data-store');

function clamp(value, min, max) {
  if (Number.isNaN(value) || value == null) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toBigrams(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }
  if (normalized.length === 1) {
    return [normalized];
  }
  const results = [];
  for (let i = 0; i < normalized.length - 1; i += 1) {
    results.push(normalized.slice(i, i + 2));
  }
  return results;
}

function diceCoefficient(a, b) {
  const bigramsA = toBigrams(a);
  const bigramsB = toBigrams(b);
  if (!bigramsA.length || !bigramsB.length) {
    return 0;
  }
  const map = new Map();
  bigramsA.forEach((gram) => {
    map.set(gram, (map.get(gram) || 0) + 1);
  });

  let intersection = 0;
  bigramsB.forEach((gram) => {
    const count = map.get(gram) || 0;
    if (count > 0) {
      intersection += 1;
      map.set(gram, count - 1);
    }
  });

  return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

function deriveGrade(score) {
  if (score >= 95) return 'S';
  if (score >= 85) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

function defaultLineMerge(scriptLines) {
  if (!Array.isArray(scriptLines)) {
    return '';
  }
  return scriptLines
    .map((line) => {
      if (!line) return '';
      if (typeof line === 'string') {
        return line;
      }
      return line.text || '';
    })
    .join(' ')
    .trim();
}

function serializeQuest(row) {
  if (!row) return null;
  return {
    id: row.id,
    video_resource_id: row.video_resource_id,
    title: row.title,
    description: row.description,
    character_name: row.character_name,
    start_sec: Number(row.start_sec),
    end_sec: Number(row.end_sec),
    script_lines: Array.isArray(row.script_lines) ? row.script_lines : [],
    difficulty: row.difficulty || 'normal',
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeRun(row) {
  if (!row) return null;
  let metrics = row.metrics;
  if (metrics && typeof metrics === 'string') {
    try {
      metrics = JSON.parse(metrics);
    } catch (err) {
      metrics = {};
    }
  }
  return {
    id: row.id,
    quest_id: row.quest_id,
    session_id: row.session_id,
    user_id: row.user_id,
    attempt_number: row.attempt_number,
    transcript: row.transcript,
    metrics: metrics || {},
    score: Number(row.score),
    grade: row.grade,
    reward_id: row.reward_id,
    recorded_at: row.recorded_at,
  };
}

function serializeReward(row) {
  if (!row) return null;
  let metadata = row.metadata;
  if (metadata && typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch (err) {
      metadata = null;
    }
  }
  return {
    id: row.id,
    user_id: row.user_id,
    quest_id: row.quest_id,
    reward_type: row.reward_type,
    amount: Number(row.amount),
    metadata,
    earned_at: row.earned_at,
  };
}

async function ensureVideoExists(videoId) {
  const video = await dataStore.getVideoResourceById(videoId);
  if (!video) {
    const error = new Error('VIDEO_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  return video;
}

async function createQuest(userId, videoId, payload) {
  await ensureVideoExists(videoId);
  const {
    title,
    description = null,
    character_name,
    start_sec,
    end_sec,
    script_lines = [],
    difficulty = 'normal',
  } = payload;

  if (!character_name) {
    throw new Error('CHARACTER_REQUIRED');
  }
  if (!Number.isFinite(start_sec) || !Number.isFinite(end_sec) || end_sec <= start_sec) {
    throw new Error('INVALID_TIME_RANGE');
  }

  const cleanedLines = Array.isArray(script_lines)
    ? script_lines
        .filter(Boolean)
        .map((line, index) => {
          if (typeof line === 'string') {
            return { index, text: line };
          }
          return {
            index: typeof line.index === 'number' ? line.index : index,
            text: line.text || '',
            start_sec:
              Number.isFinite(line.start_sec) ? Number(line.start_sec) : undefined,
            end_sec:
              Number.isFinite(line.end_sec) ? Number(line.end_sec) : undefined,
          };
        })
    : [];

  const quest = await dataStore.createVideoSceneQuest({
    video_resource_id: videoId,
    title: title || `${character_name} ${start_sec.toFixed(1)}-${end_sec.toFixed(1)}`,
    description,
    character_name,
    start_sec,
    end_sec,
    script_lines: cleanedLines,
    difficulty,
    created_by: userId,
  });

  return serializeQuest(quest);
}

async function listQuests(videoId) {
  await ensureVideoExists(videoId);
  const rows = await dataStore.listVideoSceneQuestsByVideoId(videoId);
  return rows.map(serializeQuest);
}

function computeExpressiveness({ energyScore, emotionTag }) {
  if (Number.isFinite(energyScore)) {
    return clamp(energyScore, 0, 1);
  }
  if (!emotionTag) {
    return 0.55;
  }
  const tag = String(emotionTag).toLowerCase();
  const base =
    tag.includes('excited') || tag.includes('angry')
      ? 0.75
      : tag.includes('calm') || tag.includes('serious')
        ? 0.6
        : 0.55;
  return base;
}

function buildMetrics(referenceLines, attemptTranscript, timingConfidence, energyScore, emotionTag) {
  const referenceText = defaultLineMerge(referenceLines);
  const similarity = referenceText ? diceCoefficient(referenceText, attemptTranscript) : 0;
  const timingScore = clamp(timingConfidence, 0, 1);
  const expressiveness = computeExpressiveness({ energyScore, emotionTag });

  return {
    line_match: Number(similarity.toFixed(2)),
    timing: Number(timingScore.toFixed(2)),
    expressiveness: Number(expressiveness.toFixed(2)),
  };
}

async function evaluateRun(userId, questId, payload) {
  const questRow = await dataStore.getVideoSceneQuestById(questId);
  if (!questRow) {
    const error = new Error('QUEST_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  const quest = serializeQuest(questRow);

  const { session_id: sessionId = null } = payload;
  let session = null;
  if (sessionId != null) {
    session = await dataStore.getSessionById(sessionId);
    if (!session || session.user_id !== userId) {
      throw new Error('SESSION_NOT_FOUND');
    }
    if (session.type !== 'roleplay') {
      throw new Error('SESSION_TYPE_MISMATCH');
    }
  }

  const attemptTranscriptRaw = (payload.transcript || '').toString().trim();
  const transcriptNormalized = normalizeText(attemptTranscriptRaw);
  const metrics = buildMetrics(
    quest.script_lines,
    transcriptNormalized,
    Number(payload.timing_confidence),
    Number(payload.energy_score),
    payload.emotion_tag,
  );

  const score = Math.round(
    metrics.line_match * 60 + metrics.timing * 25 + metrics.expressiveness * 15,
  );
  const grade = deriveGrade(score);

  const previousBest = await dataStore.getBestRoleplayRun(userId, questId);
  const isPersonalBest = !previousBest || score > Number(previousBest.score || 0);

  let reward = null;
  if (isPersonalBest && score >= 70) {
    const rewardType = score >= 90 ? 'scene_badge' : 'scene_coin';
    const amount = score >= 90 ? 120 : 60;
    reward = await dataStore.createUserReward({
      user_id: userId,
      quest_id: questId,
      reward_type: rewardType,
      amount,
      metadata: {
        grade,
        score,
        quest_title: quest.title,
      },
    });
  }

  const run = await dataStore.createRoleplayRun({
    quest_id: questId,
    session_id: session ? session.id : null,
    user_id: userId,
    transcript: attemptTranscriptRaw,
    metrics,
    score,
    grade,
    reward_id: reward ? reward.id : null,
  });

  if (session) {
    const summary = {
      quest_id: quest.id,
      score,
      grade,
      metrics,
    };
    await dataStore.updateSession(session.id, {
      output_blob: JSON.stringify(summary),
    });
  }

  await dataStore.createEvent({
    user_id: userId,
    event_time: new Date().toISOString(),
    event_name: 'roleplay_run_scored',
    properties: {
      quest_id: questId,
      score,
      grade,
      is_personal_best: isPersonalBest,
    },
    source: 'web',
  });

  return {
    quest,
    run: serializeRun(run),
    reward: reward ? serializeReward(reward) : null,
    metrics,
    is_personal_best: isPersonalBest,
    grade,
    score,
  };
}

async function listRuns(userId, questId, limit = 20) {
  const questRow = await dataStore.getVideoSceneQuestById(questId);
  if (!questRow) {
    const error = new Error('QUEST_NOT_FOUND');
    error.status = 404;
    throw error;
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const rows = await dataStore.listRoleplayRuns({ userId, questId, limit: safeLimit });
  return rows.map(serializeRun);
}

async function listRewards(userId, limit = 50) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const rows = await dataStore.listRewardsForUser(userId, safeLimit);
  return rows.map(serializeReward);
}

module.exports = {
  createQuest,
  listQuests,
  evaluateRun,
  listRuns,
  listRewards,
};
