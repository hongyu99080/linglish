/**
 * Vocabulary V2 Routes - 全局唯一词汇系统API
 *
 * 提供两个主要功能:
 * 1. "我的词汇" - 用户从视频导入或手动添加的词汇
 * 2. "完整词汇库" - 所有用户共同贡献的全局词汇
 */

const vocabularyV2 = require('../services/vocabulary-v2');
const smartImport = require('../services/smart-import');
const authService = require('../services/auth');
const { parseBody } = require('../utils/parsers');
const { mapErrorToStatus, sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');

function smartImportErrorStatus(error) {
  if (error?.code === 'SMART_IMPORT_VALIDATION') return 400;
  if (error?.code === 'SMART_IMPORT_SESSION_NOT_FOUND') return 404;
  return 500;
}

/**
 * 注册词汇V2路由
 */
async function registerVocabularyV2Routes(pathname, req, res, url) {
  // ========================================
  // 我的词汇 API
  // ========================================

  // GET /vocabulary/v2/my - 获取"我的词汇"列表
  // 支持 status 和 level 筛选
  if (pathname === '/vocabulary/v2/my' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const status = url.searchParams.get('status');
      const level = url.searchParams.get('level'); // beginner/intermediate/advanced
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const offset = parseInt(url.searchParams.get('offset') || '0');

      let words = await vocabularyV2.getMyVocabulary(user.id, {
        status,
        limit: level ? 10000 : limit, // If filtering by level, get more then filter
        offset: level ? 0 : offset
      });

      // Filter by level if specified
      if (level) {
        words = words.filter(w => {
          const wordLevel = vocabularyV2.getWordLevelByRank(w.frequency_rank);
          return wordLevel === level;
        });
        // Apply pagination after level filter
        words = words.slice(offset, offset + limit);
      }

      // Add computed level to each word
      words = words.map(w => ({
        ...w,
        computed_level: vocabularyV2.getWordLevelByRank(w.frequency_rank)
      }));

      return sendJson(res, 200, {
        success: true,
        words,
        count: words.length
      });
    } catch (err) {
      console.error('[Vocab V2 API] Failed to get my vocabulary:', err);
      return sendError(res, mapErrorToStatus(err, 500), err.message);
    }
  }

  // GET /vocabulary/v2/level-stats - 获取用户级别统计
  if (pathname === '/vocabulary/v2/level-stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const stats = await vocabularyV2.getLevelStats(user.id);

      return sendJson(res, 200, {
        success: true,
        ...stats
      });
    } catch (err) {
      console.error('[Vocab V2 API] Failed to get level stats:', err);
      return sendError(res, 500, err.message);
    }
  }

  // GET /vocabulary/v2/level-words - 获取某级别的推荐学习词汇
  if (pathname === '/vocabulary/v2/level-words' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const level = url.searchParams.get('level') || 'beginner';
      const status = url.searchParams.get('status') || 'not_learned';
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');

      const words = await vocabularyV2.getLevelWords(user.id, {
        level,
        status,
        limit,
        offset
      });

      return sendJson(res, 200, {
        success: true,
        level,
        words,
        count: words.length
      });
    } catch (err) {
      console.error('[Vocab V2 API] Failed to get level words:', err);
      return sendError(res, 500, err.message);
    }
  }

  // PUT /vocabulary/v2/learning-settings - 更新学习设置
  if (pathname === '/vocabulary/v2/learning-settings' && req.method === 'PUT') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { currentLevel, autoProgress } = body;

      const result = await vocabularyV2.updateLearningSettings(user.id, {
        currentLevel,
        autoProgress
      });

      return sendJson(res, 200, {
        success: true,
        message: '学习设置已更新',
        settings: result
      });
    } catch (err) {
      console.error('[Vocab V2 API] Failed to update learning settings:', err);
      return sendError(res, 500, err.message);
    }
  }

  // GET /vocabulary/v2/learning-settings - 获取学习设置
  if (pathname === '/vocabulary/v2/learning-settings' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const stats = await vocabularyV2.getLevelStats(user.id);

      return sendJson(res, 200, {
        success: true,
        settings: {
          currentLevel: stats.currentLevel,
          autoProgress: stats.autoProgress
        }
      });
    } catch (err) {
      console.error('[Vocab V2 API] Failed to get learning settings:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/import-from-video - 从视频批量导入词汇到"我的词汇"
  if (pathname === '/vocabulary/v2/import-from-video' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { videoId, words } = body;

      if (!videoId || !Array.isArray(words) || words.length === 0) {
        return sendError(res, 400, 'videoId and words array are required');
      }

      console.log(`[Vocab V2 API] User ${user.id} importing ${words.length} words from video ${videoId}`);

      const result = await vocabularyV2.batchAddWordsForUser(
        user.id,
        words,
        { videoId }
      );

      let message = `成功添加 ${result.added} 个新词汇到"我的词汇"`;
      if (result.skipped > 0) {
        message += `，跳过 ${result.skipped} 个已有词汇`;
      }
      if (result.newGlobalWords > 0) {
        message += `\n🎉 恭喜！你为全局词库贡献了 ${result.newGlobalWords} 个新词！`;
      }

      return sendJson(res, 200, {
        success: true,
        message,
        ...result
      });
    } catch (err) {
      console.error('[Vocab V2 API] Import from video failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/add - 从完整词库添加单个词汇到"我的词汇"
  if (pathname === '/vocabulary/v2/add' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { word, context } = body;

      if (!word) {
        return sendError(res, 400, 'word is required');
      }

      console.log(`[Vocab V2 API] User ${user.id} adding word "${word}" to their vocabulary`);

      const result = await vocabularyV2.addWordForUser(user.id, word, context || {});

      return sendJson(res, 200, {
        success: true,
        message: `"${word}" 已添加到我的词汇`,
        word: result
      });
    } catch (err) {
      console.error('[Vocab V2 API] Add word failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // PUT /vocabulary/v2/status - 更新词汇状态（unknown/learning/known）
  if (pathname === '/vocabulary/v2/status' && req.method === 'PUT') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { word, status } = body;

      if (!word || !status) {
        return sendError(res, 400, 'word and status are required');
      }

      console.log(`[Vocab V2 API] User ${user.id} updating "${word}" status to "${status}"`);

      const result = await vocabularyV2.updateWordStatus(user.id, word, status);

      return sendJson(res, 200, {
        success: true,
        message: `"${word}" 状态已更新为 "${status}"`,
        word: result
      });
    } catch (err) {
      console.error('[Vocab V2 API] Update status failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // ========================================
  // 完整词汇库 API
  // ========================================

  // GET /vocabulary/v2/full - 获取完整词汇库（所有用户贡献的词汇）
  if (pathname === '/vocabulary/v2/full' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const search = url.searchParams.get('search');
      const minLearners = url.searchParams.get('min_learners');
      const maxLearners = url.searchParams.get('max_learners');
      const pos = url.searchParams.get('part_of_speech');
      const includeLowQuality = (url.searchParams.get('include_low_quality') || '0') === '1';
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const offset = parseInt(url.searchParams.get('offset') || '0');

      const words = await vocabularyV2.getFullVocabulary({
        search,
        minLearners: minLearners ? parseInt(minLearners) : null,
        maxLearners: maxLearners ? parseInt(maxLearners) : null,
        partOfSpeech: pos,
        includeLowQuality,
        limit,
        offset
      });

      // 标记哪些词已在"我的词汇"中，并添加 computed_level
      for (const word of words) {
        word.inMyVocabulary = await vocabularyV2.hasWordInMyVocabulary(user.id, word.id);
        word.computed_level = vocabularyV2.getWordLevelByRank(word.frequency_rank);
      }

      return sendJson(res, 200, {
        success: true,
        words,
        count: words.length
      });
    } catch (err) {
      console.error('[Vocab V2 API] Failed to get full vocabulary:', err);
      return sendError(res, 500, err.message);
    }
  }

  // GET /vocabulary/v2/stats - 获取词汇库统计信息
  if (pathname === '/vocabulary/v2/stats' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const stats = await vocabularyV2.getVocabularyStats(user.id);

      return sendJson(res, 200, {
        success: true,
        stats: {
          totalGlobalWords: stats.totalGlobalWords,
          myWords: stats.myWords,
          canExplore: stats.canExplore,
          mastered: stats.mastered || 0,
          reviewing: stats.reviewing || 0,
          learning: stats.learning || 0,
          unknown: stats.unknown || 0,
          encountered: stats.encountered || 0,
          contributionRate: stats.myWords > 0
            ? ((stats.myWords / stats.totalGlobalWords) * 100).toFixed(1) + '%'
            : '0%'
        }
      });
    } catch (err) {
      console.error('[Vocab V2 API] Failed to get stats:', err);
      return sendError(res, 500, err.message);
    }
  }

  // ========================================
  // 视频难度计算 API
  // ========================================

  // POST /vocabulary/v2/video-difficulty/batch-update - 批量更新视频难度
  // 基于视频字幕中的词汇分布自动计算难度级别
  if (pathname === '/vocabulary/v2/video-difficulty/batch-update' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const forceUpdate = body.forceUpdate === true;

      console.log(`[Vocab V2 API] User ${user.id} triggering batch video difficulty update (force: ${forceUpdate})`);

      const result = await vocabularyV2.batchUpdateVideoDifficulty({ forceUpdate });

      return sendJson(res, 200, {
        success: true,
        message: `已更新 ${result.updated} 个视频的难度级别`,
        ...result
      });
    } catch (err) {
      console.error('[Vocab V2 API] Batch update video difficulty failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/video-difficulty/calculate - 计算单个视频的难度（不保存）
  if (pathname === '/vocabulary/v2/video-difficulty/calculate' && req.method === 'POST') {
    try {
      await authenticate(req);
      const body = await parseBody(req);
      const { transcript } = body;

      if (!transcript) {
        return sendError(res, 400, 'transcript is required');
      }

      const result = await vocabularyV2.calculateVideoDifficulty(transcript);

      return sendJson(res, 200, {
        success: true,
        ...result
      });
    } catch (err) {
      console.error('[Vocab V2 API] Calculate video difficulty failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // ========================================
  // 智能词汇导入 API (Smart Import)
  // ========================================

  // POST /vocabulary/v2/smart-import/start-session - 开始学习会话
  if (pathname === '/vocabulary/v2/smart-import/start-session' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { videoId, lifecycleKey } = body;

      if (!videoId) {
        return sendError(res, 400, 'videoId is required');
      }

      console.log(`[Smart Import API] User ${user.id} starting session for video ${videoId}`);

      const result = await smartImport.startSession(user.id, videoId, lifecycleKey);

      return sendJson(res, 200, {
        success: true,
        ...result
      });
    } catch (err) {
      console.error('[Smart Import API] Start session failed:', err);
      return sendError(res, smartImportErrorStatus(err), err.message);
    }
  }

  // POST /vocabulary/v2/smart-import/record-occurrence - 批量记录词出现
  if (pathname === '/vocabulary/v2/smart-import/record-occurrence' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { sessionId, words } = body;

      if (!sessionId || !Array.isArray(words)) {
        return sendError(res, 400, 'sessionId and words array are required');
      }

      const result = await smartImport.recordWordOccurrences(user.id, sessionId, words);

      return sendJson(res, 200, {
        success: true,
        ...result
      });
    } catch (err) {
      console.error('[Smart Import API] Record occurrence failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/smart-import/record-click - 记录单词点击（查词）
  if (pathname === '/vocabulary/v2/smart-import/record-click' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { sessionId, originalForm, clientLemma, segmentIndex, sentenceText, wordPositionStart, wordPositionEnd, prevSentence, nextSentence } = body;

      if (!sessionId || !originalForm) {
        return sendError(res, 400, 'sessionId and originalForm are required');
      }

      const result = await smartImport.recordWordClick(user.id, sessionId, {
        originalForm,
        clientLemma,
        segmentIndex,
        sentenceText,
        wordPositionStart,
        wordPositionEnd,
        prevSentence,
        nextSentence
      });

      return sendJson(res, 200, {
        success: true,
        ...result
      });
    } catch (err) {
      console.error('[Smart Import API] Record click failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/smart-import/finish - 结束观看，生成推荐
  if (pathname === '/vocabulary/v2/smart-import/finish' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { sessionId, watchedSegments, watchDurationSec, lifecycleKey } = body;

      if (!sessionId) {
        return sendError(res, 400, 'sessionId is required');
      }

      console.log(`[Smart Import API] User ${user.id} finishing session ${sessionId}`);

      const result = await smartImport.finishSession(
        user.id,
        sessionId,
        watchedSegments || [],
        watchDurationSec || 0,
        lifecycleKey
      );

      return sendJson(res, 200, {
        success: true,
        ...result
      });
    } catch (err) {
      console.error('[Smart Import API] Finish session failed:', err);
      return sendError(res, smartImportErrorStatus(err), err.message);
    }
  }

  // GET /vocabulary/v2/smart-import/recommendations - 获取推荐列表
  // 使用 query param: ?sessionId=xxx
  if (pathname === '/vocabulary/v2/smart-import/recommendations' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const sessionId = url.searchParams.get('sessionId');

      if (!sessionId) {
        return sendError(res, 400, 'sessionId query parameter is required');
      }

      const recommendations = await smartImport.getRecommendations(user.id, sessionId);

      return sendJson(res, 200, {
        success: true,
        recommendations,
        count: recommendations.length
      });
    } catch (err) {
      console.error('[Smart Import API] Get recommendations failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/smart-import/confirm - 确认导入
  if (pathname === '/vocabulary/v2/smart-import/confirm' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { sessionId, mode, selectedLemmas } = body;

      if (!sessionId || !mode) {
        return sendError(res, 400, 'sessionId and mode are required');
      }

      const validModes = ['recommended', 'clicked_only', 'custom', 'none'];
      if (!validModes.includes(mode)) {
        return sendError(res, 400, `Invalid mode. Must be one of: ${validModes.join(', ')}`);
      }

      if (mode === 'custom' && !Array.isArray(selectedLemmas)) {
        return sendError(res, 400, 'selectedLemmas array is required for custom mode');
      }

      console.log(`[Smart Import API] User ${user.id} confirming import for session ${sessionId} (mode: ${mode})`);

      const result = await smartImport.confirmImport(
        user.id,
        sessionId,
        mode,
        selectedLemmas || []
      );

      let message = `成功导入 ${result.imported} 个词汇`;
      if (result.skipped > 0) {
        message += `，跳过 ${result.skipped} 个已掌握词汇`;
      }

      return sendJson(res, 200, {
        success: true,
        message,
        ...result
      });
    } catch (err) {
      console.error('[Smart Import API] Confirm import failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // PUT /vocabulary/v2/smart-import/selection - 更新单词选择状态
  if (pathname === '/vocabulary/v2/smart-import/selection' && req.method === 'PUT') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { sessionId, lemma, selected } = body;

      if (!sessionId || !lemma || typeof selected !== 'boolean') {
        return sendError(res, 400, 'sessionId, lemma, and selected (boolean) are required');
      }

      await smartImport.updateWordSelection(user.id, sessionId, lemma, selected);

      return sendJson(res, 200, {
        success: true,
        message: `"${lemma}" ${selected ? '已选中' : '已取消选中'}`
      });
    } catch (err) {
      console.error('[Smart Import API] Update selection failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/smart-import/abandon - 放弃会话
  if (pathname === '/vocabulary/v2/smart-import/abandon' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const { sessionId, videoId, lifecycleKey } = body;

      if (lifecycleKey || videoId) {
        if (!lifecycleKey || !videoId) {
          return sendError(res, 400, 'videoId and lifecycleKey are required together');
        }
        await smartImport.closeSessionLifecycle(user.id, videoId, lifecycleKey);
      } else if (sessionId) {
        await smartImport.abandonSession(user.id, sessionId);
      } else {
        return sendError(res, 400, 'sessionId or videoId and lifecycleKey are required');
      }

      return sendJson(res, 200, {
        success: true,
        message: '会话已放弃'
      });
    } catch (err) {
      console.error('[Smart Import API] Abandon session failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // GET /vocabulary/v2/smart-import/session - 获取会话信息
  if (pathname === '/vocabulary/v2/smart-import/session' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const sessionId = url.searchParams.get('sessionId');

      if (!sessionId) {
        return sendError(res, 400, 'sessionId query parameter is required');
      }

      const session = await smartImport.getSessionForUser(user.id, sessionId);

      if (!session) {
        return sendError(res, 404, 'Session not found');
      }

      return sendJson(res, 200, {
        success: true,
        session
      });
    } catch (err) {
      console.error('[Smart Import API] Get session failed:', err);
      return sendError(res, 500, err.message);
    }
  }

  // POST /vocabulary/v2/smart-import/finish-beacon - Beacon endpoint for beforeunload
  // This endpoint uses token from body since sendBeacon can't set headers
  if (pathname === '/vocabulary/v2/smart-import/finish-beacon' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { sessionId, videoId, lifecycleKey, watchedSegments, watchDurationSec, token } = body;

      if (!token || (!sessionId && !(videoId && lifecycleKey))) {
        // Silent fail for beacon - just return OK
        return sendJson(res, 200, { success: false, reason: 'missing params' });
      }

      let user;
      try {
        user = await authService.requireUser(token);
      } catch (authErr) {
        console.warn('[Smart Import Beacon] Invalid token:', authErr.message);
        return sendJson(res, 200, { success: false, reason: 'invalid token' });
      }

      if (!user?.id) {
        return sendJson(res, 200, { success: false, reason: 'no userId' });
      }

      const userId = user.id;
      console.log(`[Smart Import Beacon] User ${userId} closing SmartImport lifecycle via beacon`);

      // Queue lifecycle closure before responding. A lifecycle key can tombstone a
      // start request whose server response has not reached the browser yet.
      const closure = lifecycleKey && videoId
        ? smartImport.closeSessionLifecycle(userId, videoId, lifecycleKey)
        : smartImport.finishSession(userId, sessionId, watchedSegments || [], watchDurationSec || 0);
      closure
        .then(result => {
          console.log('[Smart Import Beacon] Lifecycle closed:', result?.status || 'finished');
        })
        .catch(err => {
          console.error('[Smart Import Beacon] Failed:', err.message);
        });

      // Return immediately for beacon
      return sendJson(res, 200, { success: true, queued: true });
    } catch (err) {
      console.error('[Smart Import Beacon] Error:', err);
      return sendJson(res, 200, { success: false, error: err.message });
    }
  }

  // Not a vocabulary v2 route
  return false;
}

module.exports = {
  registerVocabularyV2Routes
};
