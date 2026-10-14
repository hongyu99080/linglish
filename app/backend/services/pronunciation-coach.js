const VERSION = 'coach-v1';
const DISCLAIMER = '建议基于本次语音识别与词级对齐；有音素证据时才显示音素诊断。';
const MAX_TEXT_LENGTH = 500;
const MAX_TOKEN_LENGTH = 80;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeToken(value) {
  return normalizeText(value, MAX_TOKEN_LENGTH)
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, '')
    .toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function computeSpeechRateWpm(referenceText, durationSeconds) {
  const tokens = tokenize(referenceText);
  const duration = Number(durationSeconds);
  if (tokens.length < 4 || !Number.isFinite(duration) || duration < 0.5 || duration > 120) {
    return null;
  }
  return Math.round((tokens.length / duration) * 60);
}

function phraseAround(referenceText, target) {
  const tokens = tokenize(referenceText);
  if (!tokens.length) return normalizeText(referenceText, 120);
  const normalizedTarget = normalizeToken(target);
  const index = tokens.indexOf(normalizedTarget);
  if (index < 0) return tokens.slice(0, 5).join(' ');
  return tokens.slice(Math.max(0, index - 1), Math.min(tokens.length, index + 3)).join(' ');
}

function normalizeWordOps(words) {
  if (!Array.isArray(words)) return [];
  return words.slice(0, 80).map((item) => {
    const type = ['correct', 'missing', 'extra'].includes(item?.type) ? item.type : 'neutral';
    return { type, word: normalizeToken(item?.word) };
  }).filter((item) => item.word);
}

function normalizePhonemeErrors(phonemes) {
  if (!Array.isArray(phonemes)) return [];
  return phonemes.slice(0, 80).map((item) => {
    const symbol = normalizeText(item?.symbol || item?.phoneme, 24);
    const accuracy = Number(item?.accuracy);
    const hasLowAccuracy = Number.isFinite(accuracy) && accuracy < 60;
    if (!symbol || (item?.error !== true && !hasLowAccuracy)) return null;
    return {
      symbol,
      accuracy: Number.isFinite(accuracy) ? clamp(accuracy, 0, 100) : null,
    };
  }).filter(Boolean);
}

function phonemeDrill(symbol) {
  const drills = {
    'θ': '舌尖轻触上下齿间，先送气读 /θ/，再回到原句。',
    'ð': '舌尖轻触上下齿间并保持声带振动，先读 /ð/ 再读原句。',
    'r': '先单独听辨 /r/，再从目标词慢速连回短语。',
    'l': '舌尖轻触上齿龈，先读目标词，再按原声节奏连读。',
    'v': '上齿轻触下唇并保持振动，先读 /v/ 再回到目标词。',
    'w': '双唇先收圆再快速展开，先读 /w/ 再连入目标词。',
  };
  return drills[String(symbol).toLowerCase()]
    || `先听原声中的 /${symbol}/，单独模仿 2 次，再读完整短语。`;
}

function buildRecordingSignal(referenceText, accuracy) {
  return {
    version: VERSION,
    evidence_level: 'recording_signal',
    accuracy,
    speech_rate_wpm: null,
    headline: '先让系统听清完整一句',
    summary: '本次没有获得稳定的英语识别结果，先排除录音过短、音量过低或环境噪声。',
    strengths: [],
    issues: [{
      type: 'recording_signal',
      target: '',
      title: '没有听到完整句子',
      reason: '识别结果为空，暂时无法判断具体单词的发音。',
      drill: '靠近麦克风，等录音开始后完整读完一句，再停止录音。',
      evidence: 'recording_signal',
    }],
    next_action: {
      type: 'retry_recording',
      label: '重新录一遍完整句子',
      target_text: normalizeText(referenceText, 160),
    },
    disclaimer: DISCLAIMER,
  };
}

function buildCoaching(input = {}) {
  const referenceText = normalizeText(input.referenceText);
  const hypothesis = normalizeText(input.hypothesis);
  const accuracy = Math.round(clamp(input.accuracy, 0, 100));
  const words = normalizeWordOps(input.words);
  const phonemeErrors = normalizePhonemeErrors(input.phonemes);
  const speechRateWpm = computeSpeechRateWpm(referenceText, input.durationSeconds);

  if (!hypothesis) return buildRecordingSignal(referenceText, accuracy);

  const issues = [];
  const correctWords = unique(words.filter((item) => item.type === 'correct').map((item) => item.word));
  const missingWords = unique(words.filter((item) => item.type === 'missing').map((item) => item.word));
  const extraWords = unique(words.filter((item) => item.type === 'extra').map((item) => item.word));
  const evidenceLevel = phonemeErrors.length ? 'provider_phoneme' : 'transcript_alignment';

  phonemeErrors.slice(0, 2).forEach((item) => {
    const scoreText = item.accuracy == null ? '' : `，本次音素得分 ${Math.round(item.accuracy)}%`;
    issues.push({
      type: 'phoneme',
      target: item.symbol,
      title: `先稳定 /${item.symbol}/`,
      reason: `语音评测服务标记了 /${item.symbol}/ 的发音${scoreText}。`,
      drill: phonemeDrill(item.symbol),
      evidence: 'provider_phoneme',
    });
  });

  missingWords.forEach((word) => {
    if (issues.length >= 3) return;
    const phrase = phraseAround(referenceText, word);
    issues.push({
      type: 'missing_word',
      target: word,
      title: `把 ${word} 说得更清楚`,
      reason: `识别结果中没有稳定捕捉到 ${word}。`,
      drill: `先慢读 ${word} 2 次，再连读 “${phrase}”。`,
      evidence: 'transcript_alignment',
    });
  });

  if (extraWords.length && issues.length < 3) {
    const extra = extraWords.slice(0, 2).join('、');
    issues.push({
      type: 'extra_word',
      target: extra,
      title: '减少额外词或重复',
      reason: `识别结果中多出了 ${extra}，可能来自重复、停顿后重启或环境声音。`,
      drill: '先听一遍原声的停顿位置，再不回头地完整读一次。',
      evidence: 'transcript_alignment',
    });
  }

  if (speechRateWpm != null && (speechRateWpm < 70 || speechRateWpm > 190) && issues.length < 3) {
    const tooSlow = speechRateWpm < 70;
    issues.push({
      type: 'pace',
      target: `${speechRateWpm} WPM`,
      title: tooSlow ? '让短语衔接更连贯' : '稍微放慢，保留清晰度',
      reason: `本句语速约 ${speechRateWpm} WPM，${tooSlow ? '停顿可能偏多' : '可能压缩了部分单词'}。`,
      drill: '按原声停顿把句子切成 2–3 个短语，跟着节奏重读一次。',
      evidence: 'recording_signal',
    });
  }

  const strengths = issues.length === 0
    ? ['整句词序与内容都已清晰识别']
    : correctWords.slice(0, 2).map((word) => `${word} 已经说清楚`);

  let headline = '这句已经说清楚了';
  let summary = '识别结果与参考句一致，可以保持现在的清晰度和节奏继续练习。';
  let nextAction = {
    type: 'continue',
    label: '保持节奏，继续下一句',
    target_text: referenceText.slice(0, 160),
  };

  const firstIssue = issues[0];
  if (firstIssue?.type === 'phoneme') {
    headline = `先稳定 /${firstIssue.target}/`;
    summary = '先处理评测服务明确标记的音素，再回到完整句子。';
    nextAction = {
      type: 'retry_focus',
      label: `重点重读 /${firstIssue.target}/`,
      target_text: referenceText.slice(0, 160),
    };
  } else if (firstIssue?.type === 'missing_word') {
    headline = `先把 ${firstIssue.target} 说清楚`;
    summary = `系统没有稳定识别到 ${firstIssue.target}，下一遍只专注这个词。`;
    nextAction = {
      type: 'retry_focus',
      label: `重点重读 ${firstIssue.target}`,
      target_text: phraseAround(referenceText, firstIssue.target).slice(0, 160),
    };
  } else if (firstIssue?.type === 'extra_word') {
    headline = '减少额外词，再完整说一遍';
    summary = '保持句子向前推进，避免停顿后重复或补词。';
    nextAction = {
      type: 'retry_focus',
      label: '不回头地重读一次',
      target_text: referenceText.slice(0, 160),
    };
  } else if (firstIssue?.type === 'pace') {
    headline = '按短语节奏再读一遍';
    summary = '这一遍先对齐原声停顿和短语衔接。';
    nextAction = {
      type: 'retry_pace',
      label: '跟着原声节奏重读',
      target_text: referenceText.slice(0, 160),
    };
  }

  return {
    version: VERSION,
    evidence_level: evidenceLevel,
    accuracy,
    speech_rate_wpm: speechRateWpm,
    headline,
    summary,
    strengths: strengths.slice(0, 2),
    issues: issues.slice(0, 3),
    next_action: nextAction,
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  VERSION,
  buildCoaching,
  computeSpeechRateWpm,
};
