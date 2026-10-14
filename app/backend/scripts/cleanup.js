#!/usr/bin/env node

/**
 * Data Cleanup Cron Job
 * 数据清理定时任务
 *
 * 功能：
 * - 删除过期的训练事件数据
 * - 删除过期的AI聊天记录
 * - 删除过期的学习报告
 * - 删除过期的分享记录
 * - 删除过期的用户录音文件
 * - 统计清理结果并记录日志
 *
 * 使用方法:
 * node scripts/cleanup.js
 *
 * Crontab配置:
 * # 每天凌晨4点运行
 * 0 4 * * * cd /root/linglish/app/backend && node scripts/cleanup.js >> logs/cron.log 2>&1
 *
 * 清理策略:
 * - training_events: 保留6个月 (182天)
 * - ai_chat_history: 保留6个月 (182天)
 * - learning_reports: 保留1年 (365天)
 * - share_records: 保留3个月 (90天)
 * - 用户录音文件: 保留30天
 * - AI角色对话逐轮原文: 保留30天，之后仅保留非文本聚合信息
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;

const dataStore = require('../data-store');

// 清理策略配置（天数）
const RETENTION_POLICY = {
  TRAINING_EVENTS: 182,      // 6个月
  AI_CHAT_HISTORY: 182,      // 6个月
  AI_ROLEPLAY_TURNS: 30,     // 30天
  LEARNING_REPORTS: 365,     // 1年
  SHARE_RECORDS: 90,         // 3个月
  RECORDING_FILES: 30        // 30天
};

/**
 * 清理训练事件
 */
async function cleanupTrainingEvents() {
  console.log('Cleaning up training events...');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.TRAINING_EVENTS);

  try {
    const result = await dataStore.query(
      `DELETE FROM training_events
       WHERE created_at < $1`,
      [cutoffDate]
    );

    const deletedCount = result.rowCount || 0;
    console.log(`✓ Deleted ${deletedCount} training events older than ${RETENTION_POLICY.TRAINING_EVENTS} days`);
    return deletedCount;
  } catch (error) {
    console.error('Error cleaning training events:', error.message);
    return 0;
  }
}

/**
 * 清理AI聊天记录
 */
async function cleanupAIChatHistory() {
  console.log('Cleaning up AI chat history...');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.AI_CHAT_HISTORY);

  try {
    const result = await dataStore.query(
      `DELETE FROM ai_chat_history
       WHERE created_at < $1`,
      [cutoffDate]
    );

    const deletedCount = result.rowCount || 0;
    console.log(`✓ Deleted ${deletedCount} AI chat messages older than ${RETENTION_POLICY.AI_CHAT_HISTORY} days`);
    return deletedCount;
  } catch (error) {
    console.error('Error cleaning AI chat history:', error.message);
    return 0;
  }
}

/**
 * 清理学习报告
 */
async function cleanupLearningReports() {
  console.log('Cleaning up learning reports...');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.LEARNING_REPORTS);

  try {
    const result = await dataStore.query(
      `DELETE FROM learning_reports
       WHERE created_at < $1`,
      [cutoffDate]
    );

    const deletedCount = result.rowCount || 0;
    console.log(`✓ Deleted ${deletedCount} learning reports older than ${RETENTION_POLICY.LEARNING_REPORTS} days`);
    return deletedCount;
  } catch (error) {
    console.error('Error cleaning learning reports:', error.message);
    return 0;
  }
}

/**
 * 清理分享记录
 */
async function cleanupShareRecords() {
  console.log('Cleaning up share records...');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_POLICY.SHARE_RECORDS);

  try {
    const result = await dataStore.query(
      `DELETE FROM share_records
       WHERE created_at < $1`,
      [cutoffDate]
    );

    const deletedCount = result.rowCount || 0;
    console.log(`✓ Deleted ${deletedCount} share records older than ${RETENTION_POLICY.SHARE_RECORDS} days`);
    return deletedCount;
  } catch (error) {
    console.error('Error cleaning share records:', error.message);
    return 0;
  }
}

/**
 * 清理过期录音文件
 */
async function cleanupRecordingFiles() {
  console.log('Cleaning up recording files...');

  const recordingsPath = path.join(__dirname, '../public/recordings');
  const cutoffTime = Date.now() - (RETENTION_POLICY.RECORDING_FILES * 24 * 60 * 60 * 1000);

  let deletedCount = 0;
  let totalSize = 0;

  try {
    // 检查目录是否存在
    try {
      await fs.access(recordingsPath);
    } catch {
      console.log('✓ Recordings directory does not exist, skipping...');
      return 0;
    }

    const files = await fs.readdir(recordingsPath);

    for (const file of files) {
      const filePath = path.join(recordingsPath, file);

      try {
        const stats = await fs.stat(filePath);

        // 只删除文件，不删除目录
        if (stats.isFile() && stats.mtimeMs < cutoffTime) {
          totalSize += stats.size;
          await fs.unlink(filePath);
          deletedCount++;
        }
      } catch (error) {
        console.error(`Error processing file ${file}:`, error.message);
      }
    }

    const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
    console.log(`✓ Deleted ${deletedCount} recording files (${sizeMB} MB) older than ${RETENTION_POLICY.RECORDING_FILES} days`);
    return deletedCount;
  } catch (error) {
    console.error('Error cleaning recording files:', error.message);
    return 0;
  }
}

/**
 * 清理过期的刷新令牌
 */
async function cleanupExpiredTokens() {
  console.log('Cleaning up expired refresh tokens...');

  try {
    const result = await dataStore.query(
      `DELETE FROM refresh_tokens
       WHERE expires_at < NOW()`
    );

    const deletedCount = result.rowCount || 0;
    console.log(`✓ Deleted ${deletedCount} expired refresh tokens`);
    return deletedCount;
  } catch (error) {
    console.error('Error cleaning expired tokens:', error.message);
    return 0;
  }
}

function sqlStringList(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

function safeJsonBoolean(expression) {
  return `CASE WHEN jsonb_typeof(${expression}) = 'boolean' THEN ${expression} END`;
}

function safeJsonNumber(expression) {
  return `CASE WHEN jsonb_typeof(${expression}) = 'number' THEN ${expression} END`;
}

function safeJsonIdentifier(expression) {
  return `CASE
    WHEN jsonb_typeof(${expression}) = 'string'
      AND (${expression} #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    THEN ${expression}
  END`;
}

function safeJsonAssessmentId(expression) {
  return `CASE
    WHEN jsonb_typeof(${expression}) = 'string'
      AND (${expression} #>> '{}') ~ '^[1-9][0-9]*$'
    THEN ${expression}
  END`;
}

function safeJsonEnum(expression, values) {
  return `CASE
    WHEN jsonb_typeof(${expression}) = 'string'
      AND (${expression} #>> '{}') IN (${sqlStringList(values)})
    THEN ${expression}
  END`;
}

function sanitizedMetricObject(expression, allowedKeys) {
  return `CASE
    WHEN jsonb_typeof(${expression}) = 'object' THEN COALESCE((
      SELECT jsonb_object_agg(metric.key, metric.value ORDER BY metric.key)
      FROM jsonb_each(${expression}) AS metric(key, value)
      WHERE metric.key IN (${sqlStringList(allowedKeys)})
        AND jsonb_typeof(metric.value) IN ('number', 'boolean', 'null')
    ), '{}'::jsonb)
  END`;
}

function sanitizedPronunciation(expression) {
  return `CASE
    WHEN jsonb_typeof(${expression}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
      'trusted', ${safeJsonBoolean(`${expression} -> 'trusted'`)},
      'owned_by_user', ${safeJsonBoolean(`${expression} -> 'owned_by_user'`)},
      'credible', ${safeJsonBoolean(`${expression} -> 'credible'`)},
      'assessment_id', ${safeJsonAssessmentId(`${expression} -> 'assessment_id'`)},
      'overall', ${safeJsonNumber(`${expression} -> 'overall'`)},
      'accuracy', ${safeJsonNumber(`${expression} -> 'accuracy'`)},
      'fluency', ${safeJsonNumber(`${expression} -> 'fluency'`)},
      'completeness', ${safeJsonNumber(`${expression} -> 'completeness'`)},
      'confidence', ${safeJsonNumber(`${expression} -> 'confidence'`)}
    ))
  END`;
}

function sanitizedGoalArray(expression, includeReviewFields = false) {
  const fields = [
    `'goal_id', ${safeJsonIdentifier(`goal -> 'goal_id'`)}`,
    `'status', ${safeJsonEnum(`goal -> 'status'`, ['pending', 'completed', 'partial', 'met', 'unmet'])}`,
  ];
  if (includeReviewFields) {
    fields.push(`'completed', ${safeJsonBoolean(`goal -> 'completed'`)}`);
    fields.push(`'required', ${safeJsonBoolean(`goal -> 'required'`)}`);
  }

  return `CASE
    WHEN jsonb_typeof(${expression}) = 'array' THEN COALESCE((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(${fields.join(', ')}))
        ORDER BY ordinal
      )
      FROM jsonb_array_elements(${expression}) WITH ORDINALITY AS goals(goal, ordinal)
      WHERE jsonb_typeof(goal) = 'object'
        AND ${safeJsonIdentifier(`goal -> 'goal_id'`)} IS NOT NULL
    ), '[]'::jsonb)
    ELSE '[]'::jsonb
  END`;
}

function sanitizedEvaluation(expression) {
  return `CASE
    WHEN jsonb_typeof(${expression}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
      'understood', ${safeJsonBoolean(`${expression} -> 'understood'`)},
      'goal_updates', ${sanitizedGoalArray(`${expression} -> 'goal_updates'`)},
      'correction', NULL,
      'suggested_phrase', NULL
    ))
    ELSE jsonb_build_object('goal_updates', '[]'::jsonb)
  END`;
}

function sanitizedControls(expression) {
  return `CASE
    WHEN jsonb_typeof(${expression}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
      'should_end', ${safeJsonBoolean(`${expression} -> 'should_end'`)},
      'needs_clarification', ${safeJsonBoolean(`${expression} -> 'needs_clarification'`)},
      'difficulty_adjustment', ${safeJsonEnum(`${expression} -> 'difficulty_adjustment'`, ['easier', 'same', 'harder'])}
    ))
  END`;
}

function sanitizedReviewSummary(expression) {
  return `CASE
    WHEN ${expression} IS NULL THEN NULL
    WHEN jsonb_typeof(${expression}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
      'goals', ${sanitizedGoalArray(`${expression} -> 'goals'`, true)},
      'goal_completion', ${sanitizedMetricObject(`${expression} -> 'goal_completion'`, ['completed', 'total', 'required_completed', 'required_total', 'remaining', 'completion_rate'])},
      'task_completion', ${sanitizedMetricObject(`${expression} -> 'task_completion'`, ['completed', 'total', 'required_completed', 'required_total', 'remaining', 'completion_rate'])},
      'status', ${safeJsonEnum(`${expression} -> 'status'`, ['active', 'completed', 'partial', 'failed', 'abandoned', 'not_assessed'])},
      'task_status', ${safeJsonEnum(`${expression} -> 'task_status'`, ['active', 'completed', 'partial', 'failed', 'abandoned', 'not_assessed'])},
      'score', ${safeJsonNumber(`${expression} -> 'score'`)},
      'overall_score', ${safeJsonNumber(`${expression} -> 'overall_score'`)},
      'score_components', ${sanitizedMetricObject(`${expression} -> 'score_components'`, ['task', 'task_completion', 'understandability', 'communication', 'vocabulary_grammar', 'language_control', 'pronunciation', 'total', 'overall'])},
      'pronunciation', ${sanitizedPronunciation(`${expression} -> 'pronunciation'`)},
      'best_turn', NULL,
      'correction', NULL,
      'suggested_phrase', NULL
    ))
    ELSE '{}'::jsonb
  END`;
}

const redactedEvaluationSql = sanitizedEvaluation('t.evaluation');
const redactedPronunciationSql = sanitizedPronunciation('t.pronunciation_summary');
const redactedTurnResultSql = `CASE
  WHEN t.turn_result IS NULL THEN NULL
  WHEN jsonb_typeof(t.turn_result) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
    'version', ${safeJsonNumber(`t.turn_result -> 'version'`)},
    'evaluation', ${redactedEvaluationSql},
    'controls', ${sanitizedControls(`t.turn_result -> 'controls'`)}
  ))
  ELSE '{}'::jsonb
END`;

const AI_ROLEPLAY_PRIVACY_SQL = `
  WITH session_candidates AS (
    SELECT s.id,
           ${sanitizedReviewSummary('s.review_summary')} AS redacted_review_summary
    FROM ai_roleplay_sessions AS s
    WHERE s.status = 'completed'
      AND s.completed_at < NOW() - INTERVAL '${RETENTION_POLICY.AI_ROLEPLAY_TURNS} days'
  ),
  expired_sessions AS (
    UPDATE ai_roleplay_sessions AS s
    SET review_summary = candidate.redacted_review_summary,
        updated_at = NOW()
    FROM session_candidates AS candidate
    WHERE s.id = candidate.id
      AND s.review_summary IS DISTINCT FROM candidate.redacted_review_summary
    RETURNING s.id
  ),
  turn_candidates AS (
    SELECT t.id,
           ${redactedEvaluationSql} AS redacted_evaluation,
           ${redactedTurnResultSql} AS redacted_turn_result,
           ${redactedPronunciationSql} AS redacted_pronunciation_summary
    FROM ai_roleplay_turns AS t
    JOIN ai_roleplay_sessions AS s ON s.id = t.session_id
    WHERE s.status = 'completed'
      AND t.status = 'completed'
      AND t.created_at < NOW() - INTERVAL '${RETENTION_POLICY.AI_ROLEPLAY_TURNS} days'
  ),
  expired_turns AS (
    UPDATE ai_roleplay_turns AS t
    SET learner_text = '',
        assistant_text = NULL,
        assistant_translation_zh = NULL,
        evaluation = candidate.redacted_evaluation,
        turn_result = candidate.redacted_turn_result,
        pronunciation_summary = candidate.redacted_pronunciation_summary,
        updated_at = NOW()
    FROM turn_candidates AS candidate
    WHERE t.id = candidate.id
      AND (
        t.learner_text <> ''
        OR t.assistant_text IS NOT NULL
        OR t.assistant_translation_zh IS NOT NULL
        OR t.evaluation IS DISTINCT FROM candidate.redacted_evaluation
        OR t.turn_result IS DISTINCT FROM candidate.redacted_turn_result
        OR t.pronunciation_summary IS DISTINCT FROM candidate.redacted_pronunciation_summary
      )
    RETURNING t.id
  )
  SELECT (SELECT COUNT(*)::integer FROM expired_sessions) AS sessions_redacted,
         (SELECT COUNT(*)::integer FROM expired_turns) AS turns_redacted
`;

async function cleanupAIRoleplayTurns({
  query = dataStore.query,
  log = console.log,
  error = console.error
} = {}) {
  try {
    const result = await query(AI_ROLEPLAY_PRIVACY_SQL);
    const counts = result.rows?.[0] || {};
    const redactedCount = (Number(counts.sessions_redacted) || 0) + (Number(counts.turns_redacted) || 0);
    log(`AI roleplay records redacted: ${redactedCount}`);
    return redactedCount;
  } catch (_) {
    error('AI roleplay privacy cleanup failed');
    const safeError = new Error('AI_ROLEPLAY_CLEANUP_FAILED');
    safeError.code = 'AI_ROLEPLAY_CLEANUP_FAILED';
    throw safeError;
  }
}

/**
 * 优化数据库（可选）
 */
async function vacuumDatabase() {
  console.log('Vacuuming database tables...');

  const tables = [
    'training_events',
    'ai_chat_history',
    'learning_reports',
    'share_records',
    'refresh_tokens'
  ];

  for (const table of tables) {
    try {
      await dataStore.query(`VACUUM ANALYZE ${table}`);
      console.log(`✓ Vacuumed table: ${table}`);
    } catch (error) {
      console.error(`Error vacuuming ${table}:`, error.message);
    }
  }
}

/**
 * 主函数
 */
async function main() {
  // 直接执行 cron 时保持原有 backend 工作目录语义；模块导入不影响宿主进程。
  process.chdir(path.join(__dirname, '..'));

  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting data cleanup...`);
  console.log('='.repeat(60));

  const stats = {
    trainingEvents: 0,
    aiChatHistory: 0,
    aiRoleplayRecords: 0,
    learningReports: 0,
    shareRecords: 0,
    recordingFiles: 0,
    expiredTokens: 0
  };

  try {
    // 初始化数据库连接
    await dataStore.init();
    console.log('Database connected');
    console.log('='.repeat(60));

    // 执行各项清理任务
    stats.trainingEvents = await cleanupTrainingEvents();
    stats.aiChatHistory = await cleanupAIChatHistory();
    stats.aiRoleplayRecords = await cleanupAIRoleplayTurns();
    stats.learningReports = await cleanupLearningReports();
    stats.shareRecords = await cleanupShareRecords();
    stats.recordingFiles = await cleanupRecordingFiles();
    stats.expiredTokens = await cleanupExpiredTokens();

    console.log('='.repeat(60));

    // 优化数据库（可选，注释掉以提高执行速度）
    // await vacuumDatabase();

    // 统计总结
    const duration = Date.now() - startTime;
    const totalDeleted = Object.values(stats).reduce((sum, count) => sum + count, 0);

    console.log('\n📊 Cleanup Summary:');
    console.log(`   Training Events:    ${stats.trainingEvents.toLocaleString()} records`);
    console.log(`   AI Chat History:    ${stats.aiChatHistory.toLocaleString()} messages`);
    console.log(`   AI Roleplay Records: ${stats.aiRoleplayRecords.toLocaleString()} redacted`);
    console.log(`   Learning Reports:   ${stats.learningReports.toLocaleString()} reports`);
    console.log(`   Share Records:      ${stats.shareRecords.toLocaleString()} records`);
    console.log(`   Recording Files:    ${stats.recordingFiles.toLocaleString()} files`);
    console.log(`   Expired Tokens:     ${stats.expiredTokens.toLocaleString()} tokens`);
    console.log(`   ────────────────────────────────`);
    console.log(`   Total Deleted:      ${totalDeleted.toLocaleString()} items`);
    console.log(`   Duration:           ${(duration / 1000).toFixed(2)}s`);
    console.log('='.repeat(60));

    console.log(`[${new Date().toISOString()}] ✓ Cleanup completed successfully`);
    process.exit(0);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ✗ Error during cleanup:`, error);
    process.exit(1);
  }
}

module.exports = {
  cleanupAIRoleplayTurns,
  main
};

// 仅在作为定时任务脚本直接执行时启动，便于测试清理函数而不触发 cron。
if (require.main === module) {
  main();
}
