/**
 * Learning Plan Service
 *
 * Generates personalized vocabulary learning plans based on student level.
 * Recommends videos and words appropriate for each level.
 */

const dataStore = require('../data-store');
const { getAdjustments } = require('./plan-feedback');
const videoRecommendation = require('./video-recommendation');

// Level configuration
const LEVEL_CONFIG = {
  beginner: {
    rankStart: 1,
    rankEnd: 3000,
    displayName: '初级',
    icon: '🌱',
    dailyNewWords: 10,
    dailyReviewWords: 20,
    description: '核心3000词，日常交流必备'
  },
  intermediate: {
    rankStart: 3001,
    rankEnd: 8000,
    displayName: '中级',
    icon: '🌿',
    dailyNewWords: 8,
    dailyReviewWords: 25,
    description: '进阶5000词，扩展表达能力'
  },
  advanced: {
    rankStart: 8001,
    rankEnd: 999999,
    displayName: '高级',
    icon: '🌳',
    dailyNewWords: 5,
    dailyReviewWords: 30,
    description: '高级词汇，阅读与写作进阶'
  }
};

const LEVEL_ORDER = ['beginner', 'intermediate', 'advanced'];
const GUEST_LEVEL = { level: 'beginner', config: LEVEL_CONFIG.beginner, profile: { interests: [] } };

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function clampInt(value, fallback, min, max) {
  const parsed = toInt(value, fallback);
  return Math.max(min, Math.min(max, parsed));
}

function normalizeLevel(value) {
  const raw = String(value || '').trim().toLowerCase();
  return LEVEL_CONFIG[raw] ? raw : 'beginner';
}

async function getUserLearningProfile(userId) {
  try {
    const result = await dataStore.query(`
      SELECT current_vocabulary_level, vocabulary_level_updated_at, daily_goal, interests
      FROM user_profiles
      WHERE user_id = $1
      LIMIT 1
    `, [userId]);
    const row = result.rows[0] || {};
    const hasExplicitLevel = !!row.vocabulary_level_updated_at;
    return {
      currentLevel: hasExplicitLevel && LEVEL_CONFIG[row.current_vocabulary_level] ? row.current_vocabulary_level : null,
      dailyGoal: clampInt(row.daily_goal, 15, 5, 180),
      interests: Array.isArray(row.interests) ? row.interests.filter(Boolean) : [],
    };
  } catch (err) {
    return {
      currentLevel: null,
      dailyGoal: 15,
      interests: [],
    };
  }
}

function buildDailyTargets(config, dailyGoal) {
  const goalMinutes = clampInt(dailyGoal, 15, 5, 180);
  let scale = 1;
  let intensity = 'standard';

  if (goalMinutes <= 10) {
    scale = 0.38;
    intensity = 'light';
  } else if (goalMinutes <= 20) {
    scale = 0.68;
    intensity = 'steady';
  } else if (goalMinutes <= 40) {
    scale = 1;
    intensity = 'standard';
  } else if (goalMinutes <= 60) {
    scale = 1.25;
    intensity = 'focused';
  } else {
    scale = 1.5;
    intensity = 'intensive';
  }

  return {
    dailyGoal: goalMinutes,
    intensity,
    newWords: Math.max(2, Math.round(config.dailyNewWords * scale)),
    reviewWords: Math.max(5, Math.round(config.dailyReviewWords * scale)),
    videoLimit: goalMinutes <= 10 ? 2 : (goalMinutes >= 45 ? 4 : 3),
    practiceLines: goalMinutes <= 10 ? '3-5' : (goalMinutes <= 30 ? '5-8' : '8-12'),
  };
}

function mapVideoRow(row, fallbackLevel = 'beginner', reason = null) {
  const level = normalizeLevel(row.difficulty_level || fallbackLevel);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    thumbnail: row.thumbnail_path,
    duration: row.duration_sec,
    level,
    levelName: LEVEL_CONFIG[level]?.displayName || LEVEL_CONFIG.beginner.displayName,
    wordCount: row.word_count,
    uniqueWordCount: row.unique_word_count,
    viewCount: row.view_count || 0,
    practiceCount: row.practice_count || 0,
    category: row.category,
    tags: videoRecommendation.collectTags(row),
    recommendationReason: reason || (row.difficulty_level === fallbackLevel ? '匹配你的学习等级' : '适合今天先完成一轮训练')
  };
}

function buildVideoUrl(video) {
  if (!video || !video.id) return './video-reader-desktop.html?from=today';
  return `./video-reader-desktop.html?videoId=${encodeURIComponent(String(video.id))}&from=today`;
}

function buildPracticeUrl(video) {
  const params = new URLSearchParams({ from: 'today', mode: 'shadowing' });
  if (video && video.id) params.set('videoId', String(video.id));
  return `./practice-session-desktop.html?${params.toString()}`;
}

function buildDailyActions({ primaryVideo, newWordsCount, reviewWordsCount, targets }) {
  const practiceLines = targets?.practiceLines || '5-8';
  return [
    {
      key: 'watch',
      title: '看懂一段真实内容',
      description: primaryVideo
        ? `先完成《${primaryVideo.title || '推荐视频'}》的输入理解。`
        : '先从视频训练库选择一段真实内容，建立今天的语境。',
      estimatedMinutes: primaryVideo ? Math.max(5, Math.min(12, Math.round((primaryVideo.duration || 300) / 60))) : 6,
      href: buildVideoUrl(primaryVideo),
      resourceId: primaryVideo?.id || null,
    },
    {
      key: 'shadowing',
      title: '跟读关键句',
      description: `录下 ${practiceLines} 句，听回放并对照原句，重点处理节奏、重音和连读。`,
      estimatedMinutes: targets?.intensity === 'light' ? 4 : 5,
      href: buildPracticeUrl(primaryVideo),
      resourceId: primaryVideo?.id || null,
    },
    {
      key: 'review',
      title: '复习词句',
      description: `优先处理 ${reviewWordsCount || 0} 个到期复习，再补 ${newWordsCount || 0} 个新词。`,
      estimatedMinutes: Math.max(3, Math.min(12, Math.ceil((reviewWordsCount || 0) * 0.35 + (newWordsCount || 0) * 0.8))),
      href: './video-vocabulary-desktop.html?from=today',
      resourceId: null,
    }
  ];
}

/**
 * Get user's vocabulary statistics by level
 */
async function getUserVocabularyStats(userId) {
  const result = await dataStore.query(`
    WITH user_words AS (
      SELECT
        CASE
          WHEN w.frequency_rank <= 3000 THEN 'beginner'
          WHEN w.frequency_rank <= 8000 THEN 'intermediate'
          ELSE 'advanced'
        END as level,
        uv.status
      FROM user_vocabulary uv
      JOIN words w ON uv.word_id = w.id
      WHERE uv.user_id = $1
    )
    SELECT
      level,
      COUNT(*) as total_learned,
        COUNT(*) FILTER (WHERE status IN ('mastered', 'known')) as mastered,
        COUNT(*) FILTER (WHERE status = 'learning') as learning,
        COUNT(*) FILTER (WHERE status IN ('new', 'unknown')) as new_words
    FROM user_words
    GROUP BY level
  `, [userId]);

  // Get total words per level
  const totalsResult = await dataStore.query(`
    SELECT
      CASE
        WHEN frequency_rank <= 3000 THEN 'beginner'
        WHEN frequency_rank <= 8000 THEN 'intermediate'
        ELSE 'advanced'
      END as level,
      COUNT(*) as total_words
    FROM words
    WHERE frequency_rank > 0
    GROUP BY
      CASE
        WHEN frequency_rank <= 3000 THEN 'beginner'
        WHEN frequency_rank <= 8000 THEN 'intermediate'
        ELSE 'advanced'
      END
  `);

  const totals = {};
  totalsResult.rows.forEach(row => {
    totals[row.level] = toInt(row.total_words);
  });

  const stats = {
    beginner: { totalLearned: 0, mastered: 0, learning: 0, new: 0, totalWords: totals.beginner || 0 },
    intermediate: { totalLearned: 0, mastered: 0, learning: 0, new: 0, totalWords: totals.intermediate || 0 },
    advanced: { totalLearned: 0, mastered: 0, learning: 0, new: 0, totalWords: totals.advanced || 0 }
  };

  result.rows.forEach(row => {
    if (stats[row.level]) {
      stats[row.level].totalLearned = toInt(row.total_learned);
      stats[row.level].mastered = toInt(row.mastered);
      stats[row.level].learning = toInt(row.learning);
      stats[row.level].new = toInt(row.new_words);
    }
  });

  // Calculate progress percentage
  for (const level of Object.keys(stats)) {
    const s = stats[level];
    s.progress = s.totalWords > 0 ? Math.round((s.mastered / s.totalWords) * 100) : 0;
  }

  return stats;
}

/**
 * Determine user's current recommended level
 */
async function getUserCurrentLevel(userId) {
  const stats = await getUserVocabularyStats(userId);
  const profile = await getUserLearningProfile(userId);

  if (profile.currentLevel) {
    const config = LEVEL_CONFIG[profile.currentLevel];
    return {
      level: profile.currentLevel,
      config,
      stats,
      profile,
      recommendation: `按你的入门测评，今天从${config.displayName}内容开始完成一轮训练`
    };
  }

  // Logic: Move to next level when 80% of current level is mastered
  const THRESHOLD = 80;

  if (stats.beginner.progress < THRESHOLD) {
    return {
      level: 'beginner',
      config: LEVEL_CONFIG.beginner,
      stats,
      profile,
      recommendation: `继续学习初级词汇，当前掌握 ${stats.beginner.progress}%`
    };
  }

  if (stats.intermediate.progress < THRESHOLD) {
    return {
      level: 'intermediate',
      config: LEVEL_CONFIG.intermediate,
      stats,
      profile,
      recommendation: `已完成初级词汇，开始学习中级词汇，当前掌握 ${stats.intermediate.progress}%`
    };
  }

  return {
    level: 'advanced',
    config: LEVEL_CONFIG.advanced,
    stats,
    profile,
    recommendation: `继续学习高级词汇，当前掌握 ${stats.advanced.progress}%`
  };
}

/**
 * Get words to learn for a specific level
 */
async function getWordsToLearn(userId, level, limit = 20) {
  const config = LEVEL_CONFIG[level];
  if (!config) {
    throw new Error(`Invalid level: ${level}`);
  }

  // Get words not yet in user's vocabulary, ordered by level fit and frequency.
  let result = await dataStore.query(`
    SELECT
      w.id,
      w.word,
      w.phonetic,
      w.definitions,
      w.part_of_speech,
      w.frequency_rank
    FROM words w
    LEFT JOIN user_vocabulary uv ON uv.user_id = $1 AND (
      uv.word_id = w.id OR LOWER(uv.word) = LOWER(w.word)
    )
    WHERE (
        w.frequency_rank BETWEEN $2 AND $3
        OR (w.frequency_rank IS NULL AND w.difficulty_level = $5)
      )
      AND uv.id IS NULL
    ORDER BY
      CASE WHEN w.frequency_rank BETWEEN $2 AND $3 THEN 0 ELSE 1 END,
      w.frequency_rank ASC NULLS LAST,
      w.word ASC
    LIMIT $4
  `, [userId, config.rankStart, config.rankEnd, limit, level]);

  if (result.rows.length === 0) {
    result = await dataStore.query(`
      SELECT
        w.id,
        w.word,
        w.phonetic,
        w.definitions,
        w.part_of_speech,
        w.frequency_rank
      FROM words w
      LEFT JOIN user_vocabulary uv ON uv.user_id = $1 AND (
        uv.word_id = w.id OR LOWER(uv.word) = LOWER(w.word)
      )
      WHERE uv.id IS NULL
      ORDER BY
        CASE WHEN w.frequency_rank IS NULL OR w.frequency_rank <= 0 THEN 1 ELSE 0 END,
        w.frequency_rank ASC NULLS LAST,
        w.word ASC
      LIMIT $2
    `, [userId, limit]);
  }

  return result.rows.map(row => ({
    id: row.id,
    word: row.word,
    phonetic: row.phonetic,
    definitions: row.definitions,
    partOfSpeech: row.part_of_speech,
    frequencyRank: row.frequency_rank,
    level,
    levelName: config.displayName
  }));
}

/**
 * Get words due for review
 */
async function getWordsToReview(userId, limit = 30) {
  const result = await dataStore.query(`
    SELECT
      uv.id,
      uv.word,
      uv.word_id,
      uv.status,
      uv.mastery_level,
      uv.review_count,
      uv.correct_count,
      uv.wrong_count,
      uv.next_review_at,
      w.phonetic,
      w.definitions,
      w.part_of_speech,
      w.frequency_rank,
      CASE
        WHEN w.frequency_rank <= 3000 THEN 'beginner'
        WHEN w.frequency_rank <= 8000 THEN 'intermediate'
        ELSE 'advanced'
      END as level
    FROM user_vocabulary uv
    JOIN words w ON uv.word_id = w.id
    WHERE uv.user_id = $1
      AND uv.status IN ('learning', 'new', 'unknown')
      AND (uv.next_review_at IS NULL OR uv.next_review_at <= NOW())
    ORDER BY
      COALESCE(uv.next_review_at, '1970-01-01') ASC,
      w.frequency_rank ASC
    LIMIT $2
  `, [userId, limit]);

  return result.rows.map(row => ({
    id: row.id,
    wordId: row.word_id,
    word: row.word,
    phonetic: row.phonetic,
    definitions: row.definitions,
    partOfSpeech: row.part_of_speech,
    frequencyRank: row.frequency_rank,
    status: row.status,
    masteryLevel: row.mastery_level,
    reviewCount: row.review_count,
    correctCount: row.correct_count,
    wrongCount: row.wrong_count,
    level: row.level,
    levelName: LEVEL_CONFIG[row.level]?.displayName
  }));
}

/**
 * Get recommended videos for user's level
 * 未看过的优先、按目标标签匹配兴趣、按「太难/太简单」反馈调整难度。
 * userId 为空时按游客处理:默认初级、不做已看过过滤。
 */
async function getRecommendedVideos(userId, limit = 10, options = {}) {
  const userLevel = options.userLevel || (userId ? await getUserCurrentLevel(userId) : GUEST_LEVEL);
  const profile = options.profile || userLevel.profile || { interests: [] };
  const interests = Array.isArray(profile.interests) ? profile.interests.filter(Boolean) : [];

  // generateDailyPlan 传入的 userLevel 已经按反馈调过难度,这里只对直接调用的场景调整
  let level = userLevel.level;
  if (!options.userLevel && userId) {
    const adjustments = await getAdjustments(userId).catch(() => null);
    level = videoRecommendation.shiftLevel(level, adjustments?.difficultyShift || 0);
  }

  const [rows, watchedIds] = await Promise.all([
    videoRecommendation.loadCandidates(userId),
    videoRecommendation.loadWatchedIds(userId),
  ]);
  const ranked = videoRecommendation.rankCandidates(rows, { level, interests, watchedIds, userId }, limit);
  const goalTags = videoRecommendation.goalTagsFor(interests);

  return {
    userLevel: level,
    levelName: LEVEL_CONFIG[level].displayName,
    personalization: {
      interests,
      interestTerms: goalTags,
      matchedVideos: ranked.filter(item => !item.watched && item.reason.startsWith('匹配你的目标')).length,
    },
    videos: ranked.map(({ row, reason, watched }) => ({
      ...mapVideoRow(row, level, reason),
      watched,
      slot: 'today',
    })),
  };
}

/**
 * 看完 afterId 之后的「下一个」推荐:同标签、同难度、未看过优先。
 * afterId 找不到时退回普通推荐。
 */
async function getNextVideo(userId, afterId, limit = 1) {
  const [rows, watchedIds] = await Promise.all([
    videoRecommendation.loadCandidates(userId),
    videoRecommendation.loadWatchedIds(userId),
  ]);
  const anchor = rows.find(row => String(row.id) === String(afterId))
    || await loadVideoAnchor(afterId, userId);

  if (!anchor) {
    const fallback = await getRecommendedVideos(userId, limit);
    return { afterId: afterId || null, videos: fallback.videos.map(video => ({ ...video, slot: 'next' })) };
  }

  const level = userId ? (await getUserCurrentLevel(userId).catch(() => GUEST_LEVEL)).level : GUEST_LEVEL.level;
  const ranked = videoRecommendation.rankNextCandidates(rows, anchor, { level, watchedIds, userId }, limit);
  return {
    afterId: String(anchor.id),
    videos: ranked.map(({ row, reason, watched }) => ({
      ...mapVideoRow(row, level, reason),
      watched,
      slot: 'next',
    })),
  };
}

// 当前视频不在候选池(前 200)里时单独查一次
async function loadVideoAnchor(videoId, userId) {
  if (!videoId) return null;
  const result = await dataStore.query(`
    SELECT
      vr.id, vr.difficulty_level, vr.tags, vr.uploader_id,
      (
        SELECT jsonb_agg(t.name)
        FROM video_tags vt
        JOIN tags t ON t.id = vt.tag_id
        WHERE vt.video_id = vr.id
      ) AS tags_joined
    FROM video_resources vr
    WHERE vr.id::text = $1
      AND (vr.is_public = true OR vr.uploader_id = $2)
    LIMIT 1
  `, [String(videoId), userId]);
  return result.rows[0] || null;
}

/**
 * Generate a daily learning plan for user
 */
async function generateDailyPlan(userId) {
  const [userLevel, adjustments] = await Promise.all([
    getUserCurrentLevel(userId),
    getAdjustments(userId).catch(() => ({
      difficultyShift: 0,
      typePenalty: { watch: 1, shadowing: 1, review: 1 },
      wantDiversity: false,
      hasFeedback: false,
    })),
  ]);
  const config = userLevel.config;
  const profile = userLevel.profile || { dailyGoal: 15, interests: [] };
  const targets = buildDailyTargets(config, profile.dailyGoal);

  let effectiveLevel = userLevel.level;
  if (adjustments.difficultyShift !== 0) {
    const idx = LEVEL_ORDER.indexOf(userLevel.level);
    const shifted = Math.min(LEVEL_ORDER.length - 1, Math.max(0, idx + adjustments.difficultyShift));
    effectiveLevel = LEVEL_ORDER[shifted];
  }

  // Get new words to learn
  const newWords = await getWordsToLearn(userId, effectiveLevel, targets.newWords);

  // Get words to review
  const reviewWords = await getWordsToReview(userId, targets.reviewWords);

  // Get recommended videos
  const videoRecs = await getRecommendedVideos(userId, targets.videoLimit, {
    userLevel: { ...userLevel, level: effectiveLevel },
    profile,
    adjustments,
  });
  const primaryVideo = videoRecs.videos[0] || null;
  const actions = buildDailyActions({
    primaryVideo,
    newWordsCount: newWords.length,
    reviewWordsCount: reviewWords.length,
    targets,
  });

  // Calculate estimated time
  const rawEstimatedMinutes = Math.max(12,
    (newWords.length * 2) +  // 2 minutes per new word
    (reviewWords.length * 0.5) +  // 30 seconds per review
    (videoRecs.videos.length > 0 ? 15 : 0),  // 15 minutes for video practice
  );
  const targetMinutes = targets.dailyGoal;
  const estimatedMinutes = Math.max(10, Math.min(rawEstimatedMinutes, targetMinutes + 5));
  const primaryGoal = profile.interests?.[0] || null;
  const matchedVideos = videoRecs.personalization?.matchedVideos || 0;

  const levelActuallyShifted = effectiveLevel !== userLevel.level;
  const hasOtherFeedback = adjustments.wantDiversity ||
    Object.values(adjustments.typePenalty).some(v => v !== 1);
  const feedbackApplied = adjustments.hasFeedback && (levelActuallyShifted || hasOtherFeedback);
  let feedbackNote = null;
  if (feedbackApplied) {
    if (levelActuallyShifted && adjustments.difficultyShift === -1) {
      feedbackNote = '已根据你的反馈降低难度';
    } else if (levelActuallyShifted && adjustments.difficultyShift === 1) {
      feedbackNote = '已根据你的反馈提升难度';
    } else {
      feedbackNote = '已根据你的反馈调整内容偏好';
    }
  }

  return {
    date: new Date().toISOString().split('T')[0],
    userId,
    currentLevel: {
      level: userLevel.level,
      name: config.displayName,
      icon: config.icon,
      description: config.description
    },
    recommendation: primaryGoal && matchedVideos > 0
      ? `${userLevel.recommendation}。已优先匹配「${primaryGoal}」相关内容`
      : primaryGoal
        ? `${userLevel.recommendation}。目标：${primaryGoal}`
      : userLevel.recommendation,
    stats: userLevel.stats,
    profile: {
      dailyGoal: targetMinutes,
      interests: profile.interests || [],
    },
    targets: {
      intensity: targets.intensity,
      newWords: targets.newWords,
      reviewWords: targets.reviewWords,
      videoLimit: targets.videoLimit,
      practiceLines: targets.practiceLines,
    },
    personalization: {
      interests: videoRecs.personalization?.interests || [],
      matchedVideos,
      effectiveLevel,
      feedbackApplied,
      feedbackNote,
    },

    plan: {
      newWords: {
        count: newWords.length,
        targetCount: targets.newWords,
        words: newWords
      },
      reviewWords: {
        count: reviewWords.length,
        targetCount: targets.reviewWords,
        words: reviewWords
      },
      videos: {
        count: videoRecs.videos.length,
        videos: videoRecs.videos
      }
    },

    actions,
    primaryAction: actions[0],
    estimatedMinutes: Math.round(estimatedMinutes),
    summary: `今日学习计划: ${newWords.length}个新词 + ${reviewWords.length}个复习 + ${videoRecs.videos.length}个视频`
  };
}

async function getTodayProgress(userId) {
  const result = await dataStore.query(`
    WITH today_events AS (
      SELECT event_name, properties
      FROM events
      WHERE user_id = $1
        AND event_time >= date_trunc('day', NOW())
        AND event_time < date_trunc('day', NOW()) + INTERVAL '1 day'
    ),
    video_stats AS (
      SELECT
        COALESCE(SUM((properties->>'seconds')::numeric), 0)::int AS seconds,
        COUNT(*)::int AS events
      FROM today_events
      WHERE event_name = 'video_watch'
        AND properties->>'from' = 'today'
    ),
    vocab_stats AS (
      SELECT
        COALESCE(SUM((properties->>'seconds')::numeric), 0)::int AS seconds,
        COUNT(*)::int AS events
      FROM today_events
      WHERE event_name = 'vocab_study'
        AND properties->>'from' = 'today'
    ),
    practice_stats AS (
      SELECT
        COUNT(*)::int AS completed,
        COALESCE(SUM((properties->>'lines')::numeric), 0)::int AS lines
      FROM today_events
      WHERE event_name = 'today_practice_completed'
        AND COALESCE(properties->>'from', 'today') = 'today'
    )
    SELECT
      vs.seconds AS video_seconds,
      vs.events AS video_events,
      vss.seconds AS vocab_seconds,
      vss.events AS vocab_events,
      ps.completed AS practice_completed,
      ps.lines AS practice_lines
    FROM video_stats vs
    CROSS JOIN vocab_stats vss
    CROSS JOIN practice_stats ps
  `, [userId]);

  const row = result.rows[0] || {};
  const videoSeconds = toInt(row.video_seconds);
  const vocabSeconds = toInt(row.vocab_seconds);
  const practiceCompleted = toInt(row.practice_completed);
  const practiceLines = toInt(row.practice_lines);
  const steps = [
    {
      key: 'watch',
      label: '看一段真实视频',
      done: videoSeconds >= 60,
      value: videoSeconds,
      target: 60,
      unit: 'seconds',
    },
    {
      key: 'shadowing',
      label: '完成跟读练习',
      done: practiceCompleted > 0,
      value: practiceCompleted,
      target: 1,
      unit: 'sessions',
      lines: practiceLines,
    },
    {
      key: 'review',
      label: '复习词汇',
      done: vocabSeconds >= 30,
      value: vocabSeconds,
      target: 30,
      unit: 'seconds',
    },
  ];
  const completed = steps.filter(step => step.done).length;

  return {
    date: new Date().toISOString().slice(0, 10),
    completed,
    total: steps.length,
    percent: Math.round((completed / steps.length) * 100),
    isComplete: completed >= steps.length,
    steps,
    raw: {
      videoSeconds,
      vocabSeconds,
      practiceCompleted,
      practiceLines,
      videoEvents: toInt(row.video_events),
      vocabEvents: toInt(row.vocab_events),
    },
  };
}

function toDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function shiftDateKey(dateKey, offsetDays) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function getTodayStreak(userId) {
  const result = await dataStore.query(`
    WITH activity_days AS (
      SELECT
        event_time::date AS day,
        COUNT(*)::int AS events,
        COUNT(*) FILTER (WHERE event_name = 'video_watch')::int AS video_events,
        COUNT(*) FILTER (WHERE event_name = 'today_practice_completed')::int AS practice_events,
        COUNT(*) FILTER (WHERE event_name = 'vocab_study')::int AS vocab_events
      FROM events
      WHERE user_id = $1
        AND event_time >= date_trunc('day', NOW()) - INTERVAL '180 days'
        AND (
          (event_name = 'video_watch' AND properties->>'from' = 'today')
          OR (event_name = 'vocab_study' AND properties->>'from' = 'today')
          OR (event_name = 'today_practice_completed' AND COALESCE(properties->>'from', 'today') = 'today')
        )
      GROUP BY event_time::date
    )
    SELECT
      (SELECT CURRENT_DATE::text) AS today,
      day::text AS day,
      events,
      video_events,
      practice_events,
      vocab_events
    FROM activity_days
    ORDER BY day DESC
  `, [userId]);

  const rows = result.rows || [];
  const today = toDateKey(rows[0]?.today) || new Date().toISOString().slice(0, 10);
  const days = rows
    .map(row => ({
      date: toDateKey(row.day),
      events: toInt(row.events),
      videoEvents: toInt(row.video_events),
      practiceEvents: toInt(row.practice_events),
      vocabEvents: toInt(row.vocab_events),
    }))
    .filter(day => day.date);
  const activeDates = new Set(days.map(day => day.date));
  const hasTrainedToday = activeDates.has(today);
  const yesterday = shiftDateKey(today, -1);
  const anchor = hasTrainedToday ? today : yesterday;

  let currentStreak = 0;
  let cursor = anchor;
  while (activeDates.has(cursor)) {
    currentStreak += 1;
    cursor = shiftDateKey(cursor, -1);
  }

  let longestStreak = 0;
  let run = 0;
  let previous = null;
  const ascending = days.map(day => day.date).sort();
  ascending.forEach((date) => {
    if (previous && shiftDateKey(previous, 1) === date) {
      run += 1;
    } else {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
    previous = date;
  });

  return {
    today,
    currentStreak,
    longestStreak,
    hasTrainedToday,
    canExtendToday: !hasTrainedToday && currentStreak > 0,
    lastActiveDate: days[0]?.date || null,
    recentDays: days.slice(0, 14),
  };
}

function buildWeeklyRecommendation({ activeDays, practiceSessions, reviewSeconds, totalMinutes }) {
  if (activeDays >= 5 && practiceSessions >= 3) {
    return '本周节奏很好。下一步可以提高跟读强度，把更多句子送进 AI 反馈。';
  }
  if (activeDays >= 3 && practiceSessions === 0) {
    return '本周已有输入习惯，下一步要补输出：优先完成 2 次跟读。';
  }
  if (activeDays >= 3 && reviewSeconds < 90) {
    return '本周训练天数不错，但复习偏少。建议每天加 3 分钟词汇复现。';
  }
  if (totalMinutes >= 30) {
    return '本周已经有训练投入。保持每天一条闭环，比一次学很久更稳定。';
  }
  return '先把目标压到足够轻：连续 3 天完成视频、跟读、复习任意一步。';
}

async function getWeeklyReport(userId) {
  const result = await dataStore.query(`
    WITH days AS (
      SELECT generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day')::date AS day
    ),
    daily AS (
      SELECT
        event_time::date AS day,
        SUM(
          CASE
            WHEN event_name = 'video_watch'
              AND properties->>'from' = 'today'
              AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (properties->>'seconds')::numeric
            ELSE 0
          END
        )::int AS video_seconds,
        SUM(
          CASE
            WHEN event_name = 'vocab_study'
              AND properties->>'from' = 'today'
              AND COALESCE(properties->>'seconds', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (properties->>'seconds')::numeric
            ELSE 0
          END
        )::int AS vocab_seconds,
        COUNT(*) FILTER (
          WHERE event_name = 'today_practice_completed'
            AND COALESCE(properties->>'from', 'today') = 'today'
        )::int AS practice_sessions,
        SUM(
          CASE
            WHEN event_name = 'today_practice_completed'
              AND COALESCE(properties->>'from', 'today') = 'today'
              AND COALESCE(properties->>'lines', '') ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (properties->>'lines')::numeric
            ELSE 0
          END
        )::int AS practice_lines
      FROM events
      WHERE user_id = $1
        AND event_time >= CURRENT_DATE - INTERVAL '6 days'
        AND event_time < CURRENT_DATE + INTERVAL '1 day'
        AND event_name IN ('video_watch', 'vocab_study', 'today_practice_completed')
      GROUP BY event_time::date
    )
    SELECT
      days.day::text AS day,
      COALESCE(daily.video_seconds, 0)::int AS video_seconds,
      COALESCE(daily.vocab_seconds, 0)::int AS vocab_seconds,
      COALESCE(daily.practice_sessions, 0)::int AS practice_sessions,
      COALESCE(daily.practice_lines, 0)::int AS practice_lines
    FROM days
    LEFT JOIN daily ON daily.day = days.day
    ORDER BY days.day ASC
  `, [userId]);

  const days = (result.rows || []).map((row) => {
    const videoSeconds = toInt(row.video_seconds);
    const vocabSeconds = toInt(row.vocab_seconds);
    const practiceSessions = toInt(row.practice_sessions);
    const practiceLines = toInt(row.practice_lines);
    const completedSteps =
      (videoSeconds >= 60 ? 1 : 0) +
      (practiceSessions > 0 ? 1 : 0) +
      (vocabSeconds >= 30 ? 1 : 0);
    const estimatedSeconds = videoSeconds + vocabSeconds + practiceSessions * 300;
    return {
      date: toDateKey(row.day),
      videoSeconds,
      vocabSeconds,
      practiceSessions,
      practiceLines,
      completedSteps,
      active: completedSteps > 0,
      estimatedMinutes: Math.round(estimatedSeconds / 60),
    };
  });

  const totals = days.reduce((acc, day) => {
    acc.videoSeconds += day.videoSeconds;
    acc.vocabSeconds += day.vocabSeconds;
    acc.practiceSessions += day.practiceSessions;
    acc.practiceLines += day.practiceLines;
    acc.completedSteps += day.completedSteps;
    acc.estimatedMinutes += day.estimatedMinutes;
    if (day.active) acc.activeDays += 1;
    return acc;
  }, {
    videoSeconds: 0,
    vocabSeconds: 0,
    practiceSessions: 0,
    practiceLines: 0,
    completedSteps: 0,
    estimatedMinutes: 0,
    activeDays: 0,
  });

  return {
    range: {
      start: days[0]?.date || null,
      end: days[days.length - 1]?.date || null,
      days: days.length,
    },
    totals: {
      ...totals,
      completionRate: days.length ? Math.round((totals.activeDays / days.length) * 100) : 0,
      maxSteps: days.length * 3,
    },
    recommendation: buildWeeklyRecommendation({
      activeDays: totals.activeDays,
      practiceSessions: totals.practiceSessions,
      reviewSeconds: totals.vocabSeconds,
      totalMinutes: totals.estimatedMinutes,
    }),
    days,
  };
}

/**
 * Get learning progress overview for user
 */
async function getLearningProgress(userId) {
  const stats = await getUserVocabularyStats(userId);
  const userLevel = await getUserCurrentLevel(userId);

  // Calculate overall progress
  const totalLearned = stats.beginner.totalLearned + stats.intermediate.totalLearned + stats.advanced.totalLearned;
  const totalMastered = stats.beginner.mastered + stats.intermediate.mastered + stats.advanced.mastered;
  const totalWords = stats.beginner.totalWords + stats.intermediate.totalWords + stats.advanced.totalWords;

  return {
    currentLevel: userLevel.level,
    currentLevelName: LEVEL_CONFIG[userLevel.level].displayName,
    recommendation: userLevel.recommendation,

    overall: {
      totalLearned,
      totalMastered,
      totalWords,
      progress: totalWords > 0 ? Math.round((totalMastered / totalWords) * 100) : 0
    },

    byLevel: {
      beginner: {
        ...stats.beginner,
        name: LEVEL_CONFIG.beginner.displayName,
        icon: LEVEL_CONFIG.beginner.icon
      },
      intermediate: {
        ...stats.intermediate,
        name: LEVEL_CONFIG.intermediate.displayName,
        icon: LEVEL_CONFIG.intermediate.icon
      },
      advanced: {
        ...stats.advanced,
        name: LEVEL_CONFIG.advanced.displayName,
        icon: LEVEL_CONFIG.advanced.icon
      }
    },

    levelConfig: LEVEL_CONFIG
  };
}

/**
 * Get video recommendations by difficulty level
 */
async function getVideosByLevel(level, limit = 20) {
  const config = LEVEL_CONFIG[level];
  if (!config) {
    throw new Error(`Invalid level: ${level}`);
  }

  const result = await dataStore.query(`
    SELECT
      vr.id,
      vr.title,
      vr.description,
      vr.thumbnail_path,
      vr.duration_sec,
      vr.difficulty_level,
      vr.word_count,
      vr.unique_word_count,
      vr.view_count,
      vr.practice_count,
      vr.category,
      vr.tags
    FROM video_resources vr
    WHERE vr.status = 'ready'
      AND vr.is_public = true
    ORDER BY
      CASE
        WHEN vr.difficulty_level = $1 THEN 0
        WHEN vr.difficulty_level IS NULL OR vr.difficulty_level = '' THEN 1
        ELSE 2
      END,
      vr.practice_count DESC NULLS LAST,
      vr.view_count DESC NULLS LAST,
      vr.created_at DESC
    LIMIT $2
  `, [level, limit]);

  return {
    level,
    levelName: config.displayName,
    icon: config.icon,
    description: config.description,
    videos: result.rows.map(row => mapVideoRow(row, level))
  };
}

module.exports = {
  LEVEL_CONFIG,
  getUserVocabularyStats,
  getUserCurrentLevel,
  getWordsToLearn,
  getWordsToReview,
  getRecommendedVideos,
  getNextVideo,
  generateDailyPlan,
  getTodayProgress,
  getTodayStreak,
  getWeeklyReport,
  getLearningProgress,
  getVideosByLevel
};
