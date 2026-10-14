/**
 * Video Difficulty Analyzer
 *
 * Analyzes video transcripts and calculates difficulty level based on word frequency.
 * Updates video_resources.difficulty_level field.
 *
 * Difficulty Levels:
 * - beginner: Average word rank <= 3000, or >70% words are beginner level
 * - intermediate: Average word rank 3001-8000, or >50% words are intermediate+
 * - advanced: Average word rank > 8000, or >30% words are advanced level
 *
 * Usage: node scripts/analyze-video-difficulty.js [--video-id=123]
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Level thresholds based on vocabulary_level_config
const LEVEL_CONFIG = {
  beginner: { rankStart: 1, rankEnd: 3000 },
  intermediate: { rankStart: 3001, rankEnd: 8000 },
  advanced: { rankStart: 8001, rankEnd: 999999 }
};

/**
 * Extract words from transcript text
 */
function extractWords(text) {
  if (!text) return [];

  // Remove punctuation and split into words
  const words = text
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !/^\d+$/.test(word))
    .map(word => word.replace(/^['-]+|['-]+$/g, '')); // trim quotes/hyphens

  return words;
}

/**
 * Calculate difficulty metrics for a set of words
 */
async function calculateDifficultyMetrics(words) {
  if (words.length === 0) {
    return null;
  }

  // Get unique words
  const uniqueWords = [...new Set(words)];

  // Look up frequency ranks for all words
  const placeholders = uniqueWords.map((_, i) => `$${i + 1}`).join(',');
  const result = await pool.query(
    `SELECT word_lowercase, frequency_rank
     FROM words
     WHERE word_lowercase IN (${placeholders})`,
    uniqueWords
  );

  // Create a map of word -> rank
  const wordRanks = new Map();
  result.rows.forEach(row => {
    wordRanks.set(row.word_lowercase, row.frequency_rank || 15000); // Default rank for unknown
  });

  // Calculate metrics
  let beginnerCount = 0;
  let intermediateCount = 0;
  let advancedCount = 0;
  let unknownCount = 0;
  let totalRank = 0;
  let rankedWordCount = 0;

  for (const word of uniqueWords) {
    const rank = wordRanks.get(word);

    if (rank) {
      totalRank += rank;
      rankedWordCount++;

      if (rank <= LEVEL_CONFIG.beginner.rankEnd) {
        beginnerCount++;
      } else if (rank <= LEVEL_CONFIG.intermediate.rankEnd) {
        intermediateCount++;
      } else {
        advancedCount++;
      }
    } else {
      unknownCount++;
      advancedCount++; // Unknown words are treated as advanced
    }
  }

  const totalWords = uniqueWords.length;
  const avgRank = rankedWordCount > 0 ? Math.round(totalRank / rankedWordCount) : 15000;

  return {
    totalWords,
    uniqueWords: uniqueWords.length,
    beginnerCount,
    intermediateCount,
    advancedCount,
    unknownCount,
    beginnerPercent: Math.round((beginnerCount / totalWords) * 100),
    intermediatePercent: Math.round((intermediateCount / totalWords) * 100),
    advancedPercent: Math.round((advancedCount / totalWords) * 100),
    avgRank,
    rankedWordCount
  };
}

/**
 * Determine difficulty level based on metrics
 */
function determineDifficultyLevel(metrics) {
  if (!metrics) return 'beginner';

  const { avgRank, beginnerPercent, intermediatePercent, advancedPercent } = metrics;

  // Decision rules:
  // 1. If >70% words are beginner level -> beginner
  // 2. If >30% words are advanced level -> advanced
  // 3. If average rank > 6000 -> advanced
  // 4. If average rank > 3500 -> intermediate
  // 5. Otherwise -> beginner

  if (beginnerPercent >= 70) {
    return 'beginner';
  }

  if (advancedPercent >= 30 || avgRank > 6000) {
    return 'advanced';
  }

  if (avgRank > 3500 || intermediatePercent + advancedPercent >= 40) {
    return 'intermediate';
  }

  return 'beginner';
}

/**
 * Analyze a single video
 */
async function analyzeVideo(videoId) {
  const videoResult = await pool.query(
    'SELECT id, title, transcript, transcript_segments, difficulty_level FROM video_resources WHERE id = $1',
    [videoId]
  );

  if (videoResult.rows.length === 0) {
    console.log(`Video ${videoId} not found`);
    return null;
  }

  const video = videoResult.rows[0];

  // Extract text from transcript or segments
  let text = video.transcript || '';

  if (!text && video.transcript_segments) {
    const segments = typeof video.transcript_segments === 'string'
      ? JSON.parse(video.transcript_segments)
      : video.transcript_segments;

    if (Array.isArray(segments)) {
      text = segments.map(s => s.text || s.content || '').join(' ');
    }
  }

  if (!text) {
    console.log(`Video ${videoId} "${video.title}" has no transcript`);
    return null;
  }

  // Extract and analyze words
  const words = extractWords(text);
  const metrics = await calculateDifficultyMetrics(words);

  if (!metrics) {
    return null;
  }

  const newLevel = determineDifficultyLevel(metrics);

  return {
    videoId: video.id,
    title: video.title,
    currentLevel: video.difficulty_level,
    newLevel,
    metrics
  };
}

/**
 * Update video difficulty level
 */
async function updateVideoDifficulty(videoId, level, metrics) {
  await pool.query(
    `UPDATE video_resources
     SET difficulty_level = $1,
         word_count = $2,
         unique_word_count = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [level, metrics.totalWords, metrics.uniqueWords, videoId]
  );
}

/**
 * Main function to analyze all videos or a specific one
 */
async function main() {
  const args = process.argv.slice(2);
  const videoIdArg = args.find(a => a.startsWith('--video-id='));
  const specificVideoId = videoIdArg ? parseInt(videoIdArg.split('=')[1]) : null;
  const dryRun = args.includes('--dry-run');

  console.log('========================================');
  console.log('Video Difficulty Analyzer');
  console.log('========================================\n');

  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  try {
    let videos;

    if (specificVideoId) {
      videos = await pool.query(
        'SELECT id FROM video_resources WHERE id = $1',
        [specificVideoId]
      );
    } else {
      videos = await pool.query(
        'SELECT id FROM video_resources WHERE transcript IS NOT NULL OR transcript_segments IS NOT NULL ORDER BY id'
      );
    }

    console.log(`Found ${videos.rows.length} videos to analyze\n`);

    const results = {
      beginner: [],
      intermediate: [],
      advanced: [],
      skipped: []
    };

    for (const row of videos.rows) {
      const analysis = await analyzeVideo(row.id);

      if (!analysis) {
        results.skipped.push(row.id);
        continue;
      }

      results[analysis.newLevel].push(analysis);

      // Update database
      if (!dryRun) {
        await updateVideoDifficulty(row.id, analysis.newLevel, analysis.metrics);
      }

      // Print result
      const levelEmoji = {
        beginner: '🌱',
        intermediate: '🌿',
        advanced: '🌳'
      };

      console.log(`${levelEmoji[analysis.newLevel]} [${analysis.newLevel.toUpperCase()}] "${analysis.title}"`);
      console.log(`   词汇: ${analysis.metrics.uniqueWords}个 | 平均词频: ${analysis.metrics.avgRank}`);
      console.log(`   分布: 初级${analysis.metrics.beginnerPercent}% | 中级${analysis.metrics.intermediatePercent}% | 高级${analysis.metrics.advancedPercent}%`);

      if (analysis.currentLevel && analysis.currentLevel !== analysis.newLevel) {
        console.log(`   ⚠️  等级变更: ${analysis.currentLevel} → ${analysis.newLevel}`);
      }
      console.log('');
    }

    // Summary
    console.log('========================================');
    console.log('分析结果汇总');
    console.log('========================================');
    console.log(`🌱 初级视频: ${results.beginner.length}`);
    console.log(`🌿 中级视频: ${results.intermediate.length}`);
    console.log(`🌳 高级视频: ${results.advanced.length}`);
    console.log(`⏭️  跳过: ${results.skipped.length}`);
    console.log('========================================');

    if (!dryRun) {
      console.log('\n✓ 所有视频难度等级已更新!');
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();
