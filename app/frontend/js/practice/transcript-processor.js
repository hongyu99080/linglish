/**
 * Transcript Processor Module
 * 字幕处理模块 - 从 practice-session-desktop.html 提取
 *
 * 提供字幕段落的合并、拆分、标准化等功能
 */

// ===== 共享常量 =====
const DANGLING_WORDS = new Set([
  'a', 'an', 'the',
  'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'about', 'into', 'through',
  'and', 'or', 'but', 'so', 'because', 'although', 'while', 'when', 'if',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
]);

const NEEDS_FOLLOWING_WORD = new Set([
  // 形容词
  'fabulous', 'wonderful', 'amazing', 'beautiful', 'great', 'good', 'bad',
  'new', 'old', 'big', 'small', 'long', 'short', 'first', 'last', 'next',
  'common', 'popular', 'important', 'interesting', 'different', 'special',
  'best', 'worst', 'favorite', 'favourite', 'main', 'real', 'true', 'false',
  'more', 'less', 'most', 'least', 'very', 'really', 'quite', 'rather',
  // 物主代词
  'my', 'your', 'his', 'her', 'our', 'their', 'its',
  // 冠词和限定词
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'some', 'any', 'no', 'every', 'each', 'all', 'both', 'few', 'many', 'much',
  // 介词
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  // 数词
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  // 其他
  'another', 'other', 'such', 'same', 'own',
  'and', 'or', 'but', 'than', 'as',
  // 动词助词
  'be', 'been', 'being', 'is', 'are', 'was', 'were', 'am',
  'have', 'has', 'had', 'having',
  'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
]);

const SENTENCE_STARTERS = new Set([
  'i', 'we', 'you', 'he', 'she', 'it', 'they', 'there', 'here',
  'what', 'when', 'where', 'why', 'how', 'who', 'which',
  'now', 'so', 'and', 'but', 'well', 'ok', 'okay', 'yes', 'no',
  'hello', 'hi', 'hey', 'bye', 'goodbye',
  'today', 'tomorrow', 'yesterday', 'first', 'finally', 'next',
]);

// ===== 基础工具函数 =====

function normalizeSegTime(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function segStart(seg) {
  return normalizeSegTime(seg?.start ?? seg?.start_sec ?? seg?.startTime ?? seg?.start_time);
}

function segEnd(seg) {
  return normalizeSegTime(seg?.end ?? seg?.end_sec ?? seg?.endTime ?? seg?.end_time);
}

function getSegText(seg) {
  return String(seg?.text ?? seg?.transcript ?? seg?.line ?? '').trim();
}

function stripPromptMarkers(text) {
  return String(text || '').replace(/^\s*>>\s*/g, '').trim();
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWords(s) {
  return (String(s || '').match(/\b[\w']+\b/g) || []).length;
}

function firstWordAscii(text) {
  const t = String(text || '').trim();
  const cleaned = t.replace(/^[\s"'""''()\[\]{}<>]+/g, '');
  const m = cleaned.match(/^([A-Za-z][A-Za-z']*)\b/);
  return m ? m[1] : '';
}

function lastWordAscii(text) {
  const t = String(text || '').trim();
  const cleaned = t.replace(/[\s"'""''()\[\]{}<>.,!?。！？，,;；:：]+$/g, '');
  const m = cleaned.match(/\b([A-Za-z][A-Za-z']*)$/);
  return m ? m[1] : '';
}

// ===== 句子判断函数 =====

function endsWithSentencePunctuation(text) {
  return /[.!?。！？]['""\u201d\u2019\u300d）】\]]*\s*$/.test(String(text || '').trim());
}

function endsIncomplete(text) {
  const t = String(text || '').trim();
  if (endsWithSentencePunctuation(t)) return false;
  const words = t.split(/\s+/);
  const lastWord = (words[words.length - 1] || '').toLowerCase().replace(/[^a-z']/g, '');
  return NEEDS_FOLLOWING_WORD.has(lastWord);
}

function startsAsContinuation(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^[0-9]/.test(t)) return true;
  const firstChar = t[0];
  if (firstChar && firstChar === firstChar.toLowerCase() && /[a-z]/.test(firstChar)) return true;
  const firstWord = t.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (SENTENCE_STARTERS.has(firstWord)) return false;
  return true;
}

// ===== 文本拆分函数 =====

function splitTextForTimeline(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];

  let parts = t
    .split(/\n+/g)
    .flatMap(s => s.split(/(?<=[.!?。！？])\s+/g))
    .map(s => s.trim())
    .filter(Boolean);

  function splitOnSoftPunct(str) {
    const s = String(str || '');
    const parts = [];
    let buf = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const isSep = ch === ',' || ch === '，' || ch === ';' || ch === '；';
      if (!isSep) {
        buf += ch;
        continue;
      }
      const prev = s[i - 1] || '';
      const next = s[i + 1] || '';
      if (/\d/.test(prev) && /\d/.test(next)) {
        buf += ch;
        continue;
      }
      const trimmed = buf.trim();
      if (trimmed) parts.push(trimmed);
      buf = '';
    }
    const last = buf.trim();
    if (last) parts.push(last);
    return parts;
  }

  const out = [];
  for (const p of parts) {
    const wordCount = countWords(p);
    if (p.length > 80 || wordCount > 14) {
      const sub = splitOnSoftPunct(p);
      if (sub.length > 1) out.push(...sub);
      else out.push(p);
    } else {
      out.push(p);
    }
  }

  // 合并过小的片段
  const merged = [];
  for (const p of out) {
    const wc = countWords(p);
    if (merged.length && (p.length < 8 || wc <= 1)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${p}`.trim();
    } else {
      merged.push(p);
    }
  }
  return merged;
}

function splitIntoCompleteSentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const sentences = t
    .split(/(?<=[.!?。！？])\s+/g)
    .map(s => s.trim())
    .filter(Boolean);
  return sentences.length <= 1 ? [t] : sentences;
}

function splitLongSentence(text, maxWords = 20) {
  const t = String(text || '').trim();
  const wordCount = countWords(t);
  if (wordCount <= maxWords) return [t];

  const parts = t.split(/(?<=[,;，；])\s*/g).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [t];

  const merged = [];
  let current = '';
  for (const part of parts) {
    const partWords = countWords(part);
    const currentWords = countWords(current);
    if (current && currentWords + partWords <= maxWords) {
      current = current + ' ' + part;
    } else if (current) {
      merged.push(current.trim());
      current = part;
    } else {
      current = part;
    }
  }
  if (current) merged.push(current.trim());
  return merged.length > 0 ? merged : [t];
}

function coalesceToMaxCount(chunks, maxCount) {
  const arr = Array.isArray(chunks) ? chunks.filter(Boolean) : [];
  if (maxCount <= 0 || arr.length <= maxCount) return arr;
  const groupSize = Math.ceil(arr.length / maxCount);
  const out = [];
  for (let i = 0; i < arr.length; i += groupSize) {
    out.push(arr.slice(i, i + groupSize).join(', ').trim());
  }
  return out.filter(Boolean);
}

// ===== 段落合并函数 =====

function mergeIncompleteSentences(segments) {
  if (!Array.isArray(segments) || segments.length <= 1) return segments;

  const merged = [];
  let i = 0;
  while (i < segments.length) {
    const current = { ...segments[i] };
    current.text = getSegText(current);
    const currentStart = segStart(current);
    let currentEnd = segEnd(current);
    let currentText = current.text;

    while (i + 1 < segments.length && endsIncomplete(currentText)) {
      const next = segments[i + 1];
      const nextText = getSegText(next);
      const nextStart = segStart(next);
      const nextEnd = segEnd(next);

      if (!startsAsContinuation(nextText)) break;
      if (nextStart != null && currentEnd != null && (nextStart - currentEnd) > 2) break;

      currentText = `${currentText} ${nextText}`.replace(/\s+/g, ' ').trim();
      currentEnd = nextEnd != null ? nextEnd : currentEnd;
      i++;
    }

    current.text = currentText;
    current.end = currentEnd;
    current.end_sec = currentEnd;
    merged.push(current);
    i++;
  }

  console.log(`[TranscriptProcessor] mergeIncompleteSentences: ${segments.length} → ${merged.length}`);
  return merged;
}

// ===== 段落精炼函数 =====

function refineTranscriptSegments(rawSegments) {
  const segs = Array.isArray(rawSegments) ? rawSegments : [];
  if (segs.length === 0) return [];

  const starts = segs.map(segStart).filter(v => Number.isFinite(v));
  const ends = segs.map(segEnd).filter(v => Number.isFinite(v));
  const span = (starts.length && ends.length) ? (Math.max(...ends) - Math.min(...starts)) : null;
  const segsPerMinute = (span && span > 0) ? (segs.length / (span / 60)) : null;
  const avgDur = (span && span > 0) ? (span / segs.length) : null;

  let maxDur = 0;
  for (const s of segs) {
    const a = segStart(s);
    const b = segEnd(s);
    if (a != null && b != null) {
      const d = b - a;
      if (Number.isFinite(d) && d > maxDur) maxDur = d;
    }
  }

  const allowRefine =
    segs.length <= 12 ||
    (segsPerMinute != null && segsPerMinute < 2) ||
    (avgDur != null && avgDur > 9) ||
    (maxDur > 18) ||
    segs.length <= 5;

  if (!allowRefine) {
    console.log('[TranscriptProcessor] refine skipped:', { count: segs.length, avgDur, maxDur });
    return segs;
  }

  const refined = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] || {};
    const start = segStart(seg);
    const end = segEnd(seg);
    const text = getSegText(seg);

    if (start == null || end == null || !Number.isFinite(end - start) || (end - start) <= 0.2 || !text) {
      refined.push(seg);
      continue;
    }

    const duration = end - start;
    const wordCount = countWords(text);
    const hasSplitHints = /[，,;；.!?。！？]/.test(text);
    const shouldSplit = (duration >= 5 && hasSplitHints) || (duration >= 8 && wordCount >= 8);

    if (!shouldSplit) {
      refined.push(seg);
      continue;
    }

    let chunks = splitTextForTimeline(text);
    const maxCount = Math.max(2, Math.floor(duration / 1.2));
    chunks = coalesceToMaxCount(chunks, maxCount);
    if (chunks.length <= 1) {
      refined.push(seg);
      continue;
    }

    const weights = chunks.map(c => Math.max(1, String(c).replace(/\s+/g, '').length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    let cursor = start;
    for (let j = 0; j < chunks.length; j++) {
      const w = weights[j] / total;
      const isLast = j === chunks.length - 1;
      const nextEnd = isLast ? end : (cursor + duration * w);
      refined.push({
        ...seg,
        index: refined.length,
        text: chunks[j],
        start: cursor,
        end: nextEnd,
        start_sec: cursor,
        end_sec: nextEnd,
      });
      cursor = nextEnd;
    }
  }

  console.log(`[TranscriptProcessor] refineTranscriptSegments: ${segs.length} → ${refined.length}`);
  return refined;
}

// ===== 段落标准化函数 =====

function makeCaptionSegmentsNonOverlapping(raw) {
  const segs = Array.isArray(raw) ? raw.slice() : [];
  if (segs.length <= 1) return segs;

  segs.sort((a, b) => (Number(segStart(a) ?? 0) - Number(segStart(b) ?? 0)) || 0);

  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = { ...segs[i] };
    const start = Number(segStart(seg) ?? 0);
    let end = Number(segEnd(seg) ?? start);
    const next = segs[i + 1];
    const nextStart = next ? Number(segStart(next) ?? Infinity) : Infinity;

    if (Number.isFinite(nextStart) && nextStart > start + 0.05) {
      end = Math.min(end, nextStart);
    }
    if (!Number.isFinite(end) || end < start + 0.05) end = start + 0.05;

    seg.start = start;
    seg.end = end;
    seg.start_sec = start;
    seg.end_sec = end;
    seg.text = stripPromptMarkers(getSegText(seg));
    out.push(seg);
  }

  out.forEach((s, idx) => { s.index = idx; });
  return out;
}

function normalizeAndDedupSegments(raw, options = {}) {
  const { dedupBoundaryWords = true } = options;
  const segs = Array.isArray(raw) ? raw.slice() : [];
  if (segs.length <= 1) return segs;

  segs.sort((a, b) => (Number(segStart(a) ?? 0) - Number(segStart(b) ?? 0)) || 0);

  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = { ...segs[i] };
    seg.text = getSegText(seg);
    let start = segStart(seg);
    let end = segEnd(seg);
    if (start == null) start = 0;
    if (end == null) end = start + 0.05;
    seg.start = start;
    seg.end = end;
    seg.start_sec = start;
    seg.end_sec = end;
    if (seg.text) out.push(seg);
  }

  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const prevStart = Number(prev.start) || 0;
    const prevEnd = Number(prev.end) || prevStart;
    let curStart = Number(cur.start);
    let curEnd = Number(cur.end);
    if (!Number.isFinite(curStart)) curStart = prevEnd;
    if (!Number.isFinite(curEnd)) curEnd = curStart + 0.05;

    if (curStart <= prevStart + 0.001 || curStart < prevEnd - 0.03) {
      curStart = prevEnd;
    }
    if (curEnd < curStart + 0.05) curEnd = curStart + 0.05;

    if (dedupBoundaryWords) {
      const last = lastWordAscii(prev.text);
      const first = firstWordAscii(cur.text);
      if (last && first && last.length >= 3 && first.length >= 3 && last.toLowerCase() === first.toLowerCase()) {
        const re = new RegExp(`^\\s*${escapeRegExp(first)}\\b[\\s,]*`, 'i');
        const nextText = String(cur.text).replace(re, '').trim();
        if (nextText) {
          cur.text = nextText;
          const PAD_SEC = 0.18;
          const split = Math.min(curEnd - 0.05, curStart + PAD_SEC);
          if (Number.isFinite(split) && split > curStart + 0.03) {
            prev.end = split;
            prev.end_sec = split;
            curStart = split;
          }
        }
      }
    }

    cur.start = curStart;
    cur.end = curEnd;
    cur.start_sec = curStart;
    cur.end_sec = curEnd;
  }

  return out.filter(s => String(s.text || '').trim().length > 0);
}

// ===== 检测函数 =====

function detectRollingWindowTranscript(raw) {
  const segs = Array.isArray(raw) ? raw : [];
  if (segs.length < 6) return false;

  const sorted = segs
    .map((s) => ({
      start: Number(segStart(s) ?? 0),
      end: Number(segEnd(s) ?? (Number(segStart(s) ?? 0))),
      text: String(getSegText(s) || ''),
    }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
    .sort((a, b) => (a.start - b.start) || 0);

  if (sorted.length < 6) return false;

  let overlapCount = 0;
  let maxDur = 0;
  let totalWords = 0;
  let maxWords = 0;

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const dur = s.end - s.start;
    if (Number.isFinite(dur) && dur > maxDur) maxDur = dur;
    const wc = countWords(s.text);
    totalWords += wc;
    if (wc > maxWords) maxWords = wc;
    if (i > 0) {
      const prev = sorted[i - 1];
      if (s.start < prev.end - 0.2) overlapCount++;
    }
  }

  const overlapRatio = overlapCount / Math.max(1, sorted.length - 1);
  const avgWords = totalWords / Math.max(1, sorted.length);

  return overlapRatio >= 0.25 && (avgWords >= 12 || maxWords >= 22 || maxDur >= 10);
}

function getSegmentationMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const v = String(params.get('segMode') || '').trim().toLowerCase();
    if (v === 'caption' || v === 'smart') return v;
    const stored = String(localStorage.getItem('linglish.segMode') || '').trim().toLowerCase();
    if (stored === 'caption' || stored === 'smart') return stored;
  } catch (e) { }
  return 'caption';
}

// ===== 导出 (全局变量方式，兼容非模块环境) =====
window.TranscriptProcessor = {
  // 常量
  DANGLING_WORDS,
  NEEDS_FOLLOWING_WORD,
  SENTENCE_STARTERS,

  // 基础工具
  normalizeSegTime,
  segStart,
  segEnd,
  getSegText,
  stripPromptMarkers,
  escapeRegExp,
  countWords,
  firstWordAscii,
  lastWordAscii,

  // 句子判断
  endsWithSentencePunctuation,
  endsIncomplete,
  startsAsContinuation,

  // 文本拆分
  splitTextForTimeline,
  splitIntoCompleteSentences,
  splitLongSentence,
  coalesceToMaxCount,

  // 段落处理
  mergeIncompleteSentences,
  refineTranscriptSegments,
  makeCaptionSegmentsNonOverlapping,
  normalizeAndDedupSegments,

  // 检测
  detectRollingWindowTranscript,
  getSegmentationMode,
};

console.log('[TranscriptProcessor] Module loaded');
