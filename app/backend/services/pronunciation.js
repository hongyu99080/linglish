const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const baiduAsr = require('./baidu-asr');
const aiConfig = require('../config/ai-config');
const vtService = require('./video-transcription');
const { buildCoaching, VERSION: COACHING_VERSION } = require('./pronunciation-coach');

/**
 * Get audio duration in seconds using ffprobe
 */
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const duration = metadata?.format?.duration;
        if (duration && Number.isFinite(Number(duration))) {
          resolve(Number(duration));
        } else {
          reject(new Error('No valid duration found in metadata'));
        }
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function tokenizeSentence(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function computeWordSimilarity(reference, hypothesis) {
  const refTokens = tokenizeSentence(reference);
  const hypTokens = tokenizeSentence(hypothesis);
  if (!refTokens.length && !hypTokens.length) return 1;
  if (!refTokens.length || !hypTokens.length) return 0;
  const m = refTokens.length;
  const n = hypTokens.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = refTokens[i - 1] === hypTokens[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const distance = dp[m][n];
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : Math.max(0, 1 - distance / maxLen);
}

function shouldRunContextReview(referenceText, hypothesis, assessment) {
  const refTokens = tokenizeSentence(referenceText);
  const hypTokens = tokenizeSentence(hypothesis);
  if (!refTokens.length || !hypTokens.length) return false;
  if (referenceText.length > 120 || assessment.accuracy >= 80) return false;
  return true;
}

function diffWords(reference, hypothesis) {
  const ref = tokenizeSentence(reference);
  const hyp = tokenizeSentence(hypothesis);
  const m = ref.length;
  const n = hyp.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = ref[i - 1] === hyp[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // backtrack for operations
  const ops = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (ref[i - 1] === hyp[j - 1]) {
      ops.unshift({ type: 'correct', word: ref[i - 1] });
      i -= 1; j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.unshift({ type: 'missing', word: ref[i - 1] });
      i -= 1;
    } else {
      ops.unshift({ type: 'extra', word: hyp[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) { ops.unshift({ type: 'missing', word: ref[i - 1] }); i -= 1; }
  while (j > 0) { ops.unshift({ type: 'extra', word: hyp[j - 1] }); j -= 1; }
  return ops;
}

async function assessWithAsr(buffer, referenceText, asrOptions = {}) {
  let asr;
  try {
    // Practice recordings should honor STT_PRACTICE_PROVIDER / FALLBACK (default: gemini → custom)
    const tmp = path.join(os.tmpdir(), `pron-input-${Date.now()}-${randomBytes(4).toString('hex')}.wav`);
    await fs.writeFile(tmp, buffer);
    try {
      // 检查音频时长
      let duration;
      try {
        duration = await getAudioDuration(tmp);
        console.log(`[Pronunciation] Audio duration: ${duration.toFixed(2)}s`);

        if (duration < 1.5) {
          console.warn(`[Pronunciation] ⚠️  Audio is too short (${duration.toFixed(2)}s < 1.5s). Recognition may be incomplete.`);
          console.warn('[Pronunciation] Whisper/STT models need at least 1.5-2 seconds for reliable recognition.');
        }
      } catch (durationErr) {
        console.warn('[Pronunciation] Failed to get audio duration:', durationErr.message);
      }

      // Use scenario-aware transcription (practice-recording) to respect env config
      const result = await vtService.transcribeVideoFile(tmp, {
        scenario: 'practice-recording',
        language: asrOptions.language || 'en',
        languageParam: 'language'
      });
      asr = { text: result.text || '' };
    } finally {
      fs.unlink(tmp).catch(() => {});
    }
  } catch (err) {
    // Final safety: if custom failed, try Baidu once
    try {
      asr = await baiduAsr.transcribe(buffer, asrOptions);
    } catch (e2) {
      throw err;
    }
  }
  return buildAssessment(asr.text || '', referenceText, 'baidu-asr', asrOptions);
}

function buildAssessment(asrText, referenceText, provider, options = {}) {
  let hypText = asrText || '';
  // 添加诊断日志
  console.log('[Pronunciation] ASR result:', {
    referenceText,
    hypText,
    isEmpty: !hypText,
    textLength: hypText.length
  });

  // 语言验证：检测是否识别成了非英语内容
  // 如果包含大量非 ASCII 字符（如中文、日文等），则视为识别错误
  let nonEnglishWarning = null;
  if (hypText) {
    const nonAsciiCount = (hypText.match(/[^\x00-\x7F]/g) || []).length;
    const totalChars = hypText.length;
    const nonAsciiRatio = totalChars > 0 ? nonAsciiCount / totalChars : 0;

    if (nonAsciiRatio > 0.3) {
      console.warn(`[Pronunciation] Non-English content detected (${Math.round(nonAsciiRatio * 100)}% non-ASCII). Treating as empty.`);
      console.warn('[Pronunciation] Original ASR output:', hypText.substring(0, 100));
      nonEnglishWarning = 'NON_ENGLISH_DETECTED';
      hypText = ''; // 清空识别结果，后续会返回低分
    }
  }

  // 如果转录结果为空，给出警告
  if (!hypText || hypText.trim().length === 0) {
    console.warn('[Pronunciation] Empty transcription! Possible causes:');
    console.warn('  - Audio too short or quiet');
    console.warn('  - Background noise');
    console.warn('  - Microphone issues');
    console.warn('  - Recording not captured');
  }

  const sim = computeWordSimilarity(referenceText, hypText);
  const overall = Math.round(sim * 100);
  // crude splits
  const accuracy = overall;
  const fluency = Math.max(0, Math.min(100, overall - 5));
  const completeness = Math.max(0, Math.min(100, overall - 3));
  const words = diffWords(referenceText, hypText);
  const durationNumber = Number(options.durationSeconds);
  const durationSeconds = Number.isFinite(durationNumber) && durationNumber >= 0.2 && durationNumber <= 120
    ? durationNumber
    : null;
  const phonemes = [];
  const coaching = buildCoaching({
    referenceText,
    hypothesis: hypText,
    words,
    phonemes,
    accuracy,
    durationSeconds,
  });
  return {
    hypothesis: hypText,
    overall, accuracy, fluency, completeness,
    words,
    phonemes,
    provider,
    warning: nonEnglishWarning, // 'NON_ENGLISH_DETECTED' if non-English content was detected
    coaching,
    analysis_version: COACHING_VERSION,
    duration_seconds: durationSeconds,
    speech_rate_wpm: coaching.speech_rate_wpm,
  };
}

async function assessFileWithAsr(wavPath, referenceText, asrOptions = {}) {
  const customEndpoint = asrOptions.endpoint || aiConfig.speechToText?.custom?.endpoint;
  if (!customEndpoint) {
    return assessWithAsr(await fs.readFile(wavPath), referenceText, asrOptions);
  }

  try {
    const result = await vtService.transcribePracticeWav(wavPath, {
      ...asrOptions,
      endpoint: customEndpoint,
      language: asrOptions.language || 'en',
    });
    const firstAssessment = buildAssessment(result.text || '', referenceText, 'custom', asrOptions);

    // Whisper tends to normalize quiet, uncommon short words into common words or
    // cross-language spellings (for example "singsing" -> "cien cien"). Keep the
    // first pass unbiased, then context-review non-empty low-score short phrases.
    // The reviewed result is accepted only when it actually improves the score.
    if (shouldRunContextReview(referenceText, result.text || '', firstAssessment)) {
      try {
        const reviewed = await vtService.transcribePracticeWav(wavPath, {
          ...asrOptions,
          endpoint: customEndpoint,
          language: asrOptions.language || 'en',
          initialPrompt: referenceText,
        });
        const reviewedAssessment = buildAssessment(
          reviewed.text || '',
          referenceText,
          'custom-context-review',
          asrOptions,
        );
        if (reviewedAssessment.accuracy > firstAssessment.accuracy) {
          console.log('[Pronunciation] Context review improved accuracy:', {
            first: firstAssessment.accuracy,
            reviewed: reviewedAssessment.accuracy,
          });
          return reviewedAssessment;
        }
      } catch (reviewErr) {
        console.warn('[Pronunciation] Context review failed, keeping first result:', reviewErr?.message || reviewErr);
      }
    }

    return firstAssessment;
  } catch (err) {
    try {
      const buffer = await fs.readFile(wavPath);
      const fallback = await baiduAsr.transcribe(buffer, asrOptions);
      return buildAssessment(fallback.text || '', referenceText, 'baidu-asr', asrOptions);
    } catch (_) {
      throw err;
    }
  }
}

module.exports = {
  assessWithAsr,
  assessFileWithAsr,
  buildAssessment,
};
