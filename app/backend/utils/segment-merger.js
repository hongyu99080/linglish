/**
 * 智能断句合并工具
 * 用于将按固定时间间隔切分的字幕段落合并为完整的自然句子
 *
 * 业界最佳实践：
 * 1. 基于语法完整性检测（句末标点、句末词汇）
 * 2. 基于词性模式检测（形容词后应跟名词等）
 * 3. 基于停顿时间检测（说话者的自然停顿）
 * 4. 基于说话人变化检测（对话场景）
 */

/**
 * 检测文本是否以不完整结构结尾
 * 这些模式表明句子可能在中间被截断
 */
function endsWithIncompleteStructure(text) {
  const trimmed = text.trim();

  // 常见的不完整结尾模式
  const incompletePatterns = [
    // 冠词（a, an, the）后面应该有名词
    /\b(a|an|the)\s*$/i,
    // 形容词后面通常应该有名词
    /\b(my|your|his|her|its|our|their|this|that|these|those)\s*$/i,
    // 介词后面应该有宾语
    /\b(of|to|for|with|in|on|at|by|from|about|into|through|during|before|after|above|below|between|under|over|against|among)\s*$/i,
    // 连词后面应该有从句
    /\b(and|or|but|so|because|although|while|when|if|unless|until|as|since|that|which|who|whom|whose|where)\s*$/i,
    // 动词不定式 to 后面应该有动词
    /\bto\s*$/i,
    // 常见的未完成短语
    /\b(have another|another episode|episode of|of my|my fabulous|a lot|kind of|sort of|type of|one of|some of|all of|most of|none of)\s*$/i,
    // 数字后面可能有单位或名词
    /\b\d+\s*$/,
    // 所有格后面应该有名词
    /['']s?\s*$/,
    // be动词后面应该有表语
    /\b(is|are|was|were|am|be|been|being)\s*$/i,
    // 情态动词后面应该有动词
    /\b(can|could|will|would|shall|should|may|might|must)\s*$/i,
    // 常见形容词（可能后面还有名词）
    /\b(fabulous|great|amazing|wonderful|beautiful|interesting|important|different|special|common|popular|famous|favourite|favorite|british|english|american)\s*$/i,
  ];

  return incompletePatterns.some(pattern => pattern.test(trimmed));
}

/**
 * 检测文本是否以完整句子结构结尾
 */
function isCompleteSentence(text) {
  const trimmed = text.trim();

  // 句子结束标点（支持中英文）
  if (/[.!?。！？]$/.test(trimmed)) {
    return true;
  }

  // 常见的句子结束词（英文口语中常见的句尾）
  // 移除基于单词的判定，防止误判（如 "right now" 被切分为 "right" + "now"）
  // 业界标准倾向于依赖明确的标点符号或较长的停顿（由调用方的 gap 判断）
  /*
  const sentenceEndWords = /\b(right|okay|ok|yes|no|yeah|nope|anyway|however|therefore|thus|finally|lastly|bye|goodbye|hello|hi|thanks|please)\s*[,.]?\s*$/i;
  if (sentenceEndWords.test(trimmed)) {
    return true;
  }
  */

  return false;
}

/**
 * 检测是否是新句子的开始
 * 注意：数字开头不一定是新句子（可能是前一句的延续，如 "my fabulous" + "5 Common British Expressions"）
 */
function isNewSentenceStart(text, prevText) {
  const trimmed = text.trim();
  const prevTrimmed = (prevText || '').trim();

  // 如果前一句以不完整结构结尾，即使当前句以大写开头也不应该分开
  if (endsWithIncompleteStructure(prevTrimmed)) {
    return false;
  }

  // 如果以数字开头，检查是否可能是标题/标签（通常较短且独立）
  if (/^\d/.test(trimmed)) {
    // 短文本（少于5个词）且前一句完整，可能是标题
    const wordCount = (trimmed.match(/\b[\w']+\b/g) || []).length;
    if (wordCount <= 5 && isCompleteSentence(prevTrimmed)) {
      return true;
    }
    // 否则，数字开头不一定是新句子
    return false;
  }

  // 以大写字母开头
  if (/^[A-Z]/.test(trimmed)) {
    // 检查是否是专有名词的延续（前一句以专有名词结尾）
    if (/[A-Z][a-z]+$/.test(prevTrimmed)) {
      return false;
    }
    // 检查前一句是否完整
    if (isCompleteSentence(prevTrimmed)) {
      return true;
    }
    // 前一句不完整，不应该分开
    return false;
  }

  // 以小写字母开头，通常不是新句子
  return false;
}

/**
 * 智能合并不完整的句子segments
 * @param {Array} segments - 原始segments数组，每个segment包含 {text, start, end, speaker?, index?}
 * @param {Object} options - 配置选项
 * @param {number} options.maxMergeGap - 最大合并时间间隔（秒），默认5秒
 * @param {number} options.maxSegmentDuration - 单个segment最大时长（秒），默认30秒
 * @param {number} options.minSegmentDuration - 单个segment最小时长（秒），过短的会被合并，默认1秒
 * @returns {Array} 合并后的segments数组
 */
function mergeIncompleteSegments(segments, options = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return segments;
  }

  const {
    maxMergeGap = 5,          // 最大合并间隔5秒
    maxSegmentDuration = 30,   // 单个segment最大30秒
    minSegmentDuration = 0.5,  // 过短的segment（<0.5秒）强制合并
  } = options;

  const merged = [];
  let current = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = (seg.text || '').trim();

    if (!text) continue;

    if (current === null) {
      current = {
        index: merged.length,
        start: seg.start,
        end: seg.end,
        text: text,
        speaker: seg.speaker || null,
        // 保留词级别时间戳（如果有的话）
        words: Array.isArray(seg.words) ? [...seg.words] : undefined,
      };
      continue;
    }

    // 计算时间间隔和合并后时长
    const gap = seg.start - current.end;
    const potentialDuration = seg.end - current.start;
    const currentDuration = current.end - current.start;
    const nextDuration = seg.end - seg.start;

    // Speaker 检测
    const currentHasSpeaker = current.speaker !== null && current.speaker !== undefined && current.speaker !== '';
    const nextHasSpeaker = seg.speaker !== null && seg.speaker !== undefined && seg.speaker !== '';
    const sameSpeaker = currentHasSpeaker && nextHasSpeaker && current.speaker === seg.speaker;
    const bothUnknownSpeaker = !currentHasSpeaker && !nextHasSpeaker;

    // 数字连续（如 3 + 000 = 3000）
    const numericContinuation = /[\d,]$/.test(current.text) && /^\d/.test(text);

    // Speaker 限制：普通文本要求 speaker 相同或都未知
    const speakerOk = numericContinuation ? true : (sameSpeaker || bothUnknownSpeaker);

    // 动态时间间隔限制
    let effectiveMaxGap = Math.min(maxMergeGap, 1.2);
    if (sameSpeaker) effectiveMaxGap = maxMergeGap;
    else if (currentHasSpeaker !== nextHasSpeaker) effectiveMaxGap = Math.min(maxMergeGap, 0.8);
    if (numericContinuation) effectiveMaxGap = Math.max(effectiveMaxGap, maxMergeGap);

    // 判断是否应该合并
    let shouldMerge = false;

    // 强制合并条件
    if (numericContinuation && gap <= effectiveMaxGap && potentialDuration <= maxSegmentDuration) {
      // 数字连续，强制合并
      shouldMerge = true;
    } else if (nextDuration < minSegmentDuration && gap <= effectiveMaxGap && potentialDuration <= maxSegmentDuration && speakerOk) {
      // 下一段太短，合并
      shouldMerge = true;
    } else if (currentDuration < minSegmentDuration && gap <= effectiveMaxGap && potentialDuration <= maxSegmentDuration && speakerOk) {
      // 当前段太短，合并
      shouldMerge = true;
    } else {
      // 基于语法完整性判断
      const currentComplete = isCompleteSentence(current.text);
      const nextIsNewSentence = isNewSentenceStart(text, current.text);
      const currentIncomplete = endsWithIncompleteStructure(current.text);

      // 策略 1: 强制合并逻辑
      // 如果当前句子没有结束标点，且 gap 很小，倾向于合并 (防止 audio cutoff)
      const isShortGap = gap < 0.4; // 400ms 内的间隔通常是连贯的
      const currentEndsWithPunctuation = /[.!?。！？]$/.test(current.text.trim());

      // 策略 2: 长度偏好
      // 如果当前片段太短（少于 15 个字符）且没有明确结束标点，尝试合并
      const isTooShort = current.text.length < 15;

      if (speakerOk) {
        if (currentIncomplete) {
          shouldMerge = true; // 语法不完整，必须合并
        } else if (numericContinuation) {
          shouldMerge = true; // 数字连续
        } else if (!currentEndsWithPunctuation && isShortGap) {
          shouldMerge = true; // 没有标点且间隔短，合并 (Fixes "half sentence read")
        } else if (!currentEndsWithPunctuation && !nextIsNewSentence) {
          shouldMerge = true; // 没有标点且下句不像新句首，合并
        } else if (isTooShort && !currentEndsWithPunctuation && gap <= effectiveMaxGap) {
          shouldMerge = true; // 句子太短且无标点，合并
        } else if (!currentComplete && !nextIsNewSentence && gap <= effectiveMaxGap) {
          shouldMerge = true; // 原有逻辑保底
        }
      }

      // 最后的保护：如果合并后太长，则强制不合并 (除非是 numericContinuation)
      if (shouldMerge && !numericContinuation) {
        if (potentialDuration > maxSegmentDuration || (current.text.length + text.length > 200)) {
          shouldMerge = false;
        }
      }
    }

    if (shouldMerge) {
      // 合并
      const joiner = numericContinuation ? '' : ' ';
      current.text = current.text + joiner + text;
      current.end = seg.end;
      // 合并词级别时间戳
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        if (!current.words) current.words = [];
        current.words.push(...seg.words);
      }
    } else {
      // 不合并，保存当前并开始新的
      merged.push(current);
      current = {
        index: merged.length,
        start: seg.start,
        end: seg.end,
        text: text,
        speaker: seg.speaker || null,
        // 保留词级别时间戳
        words: Array.isArray(seg.words) ? [...seg.words] : undefined,
      };
    }
  }

  // 保存最后一个segment
  if (current !== null) {
    merged.push(current);
  }

  // 重新编号index
  merged.forEach((seg, idx) => {
    seg.index = idx;
  });

  console.log(`[SegmentMerger] Merged ${segments.length} segments into ${merged.length} segments`);

  return merged;
}

/**
 * 规范化segment时间戳
 * 确保end时间合理，修复重叠问题
 */
function normalizeSegmentsTiming(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const sorted = segments
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      ...s,
      start: Number(s.start ?? 0),
      end: Number(s.end),
    }))
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const start = Number.isFinite(seg.start) ? seg.start : 0;
    const next = sorted[i + 1];
    const nextStart = next && Number.isFinite(next.start) ? next.start : null;

    let end = Number.isFinite(seg.end) ? seg.end : null;
    if (end === null || end <= start) {
      if (nextStart !== null && nextStart > start) {
        end = nextStart;
      } else {
        end = start + 2.5;
      }
    }
    if (nextStart !== null && end > nextStart) {
      end = nextStart;
    }

    seg.start = start;
    seg.end = end;
  }

  return sorted;
}

module.exports = {
  mergeIncompleteSegments,
  normalizeSegmentsTiming,
  isCompleteSentence,
  endsWithIncompleteStructure,
  isNewSentenceStart,
};
