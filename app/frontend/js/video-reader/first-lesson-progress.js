(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishFirstLessonProgress = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const STORAGE_KEY = 'linglish.firstLesson.progress.v2';
  const VERSION = 2;
  const VISITED_KEY = 'linglish.vrp.visited.v1';
  const POSITION_KEY = 'linglish.vrp.position.v1';

  function safeGet(storage, key) {
    try { return storage && storage.getItem(key); } catch (_) { return null; }
  }

  function safeSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (_) { }
  }

  function parseObject(raw, fallback) {
    if (!raw || raw === 'undefined' || raw === 'null') return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function compact(value) {
    return String(value == null ? '' : value).trim();
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeText(value) {
    return compact(value).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = normalizeText(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function segmentTime(segment, names, fallback) {
    for (const name of names) {
      const value = finite(segment && segment[name], NaN);
      if (Number.isFinite(value)) return value;
    }
    return fallback;
  }

  function stableSegmentId(videoId, segment, index) {
    const video = compact(videoId);
    if (!video) throw new Error('FIRST_LESSON_VIDEO_REQUIRED');
    const source = segment || {};
    const explicit = compact(source.segment_id || source.segmentId || source.id);
    const start = segmentTime(source, ['start', 'start_sec', 'startTime'], finite(index, 0));
    const end = segmentTime(source, ['end', 'end_sec', 'endTime'], start);
    const startMs = Math.round(Math.max(0, start) * 1000);
    const endMs = Math.round(Math.max(start, end) * 1000);
    const text = source.text || source.en || source.english || '';
    if (explicit) return `v:${video}:s:${explicit}:t:${startMs}-${endMs}:h:${hashText(text)}`;
    return `v:${video}:t:${startMs}-${endMs}:h:${hashText(text)}`;
  }

  function segmentIdsFor(videoId, segments) {
    const ids = (Array.isArray(segments) ? segments : []).map((segment, index) => (
      stableSegmentId(videoId, segment, index)
    ));
    if (new Set(ids).size !== ids.length) throw new Error('FIRST_LESSON_DUPLICATE_SEGMENT_ID');
    return ids;
  }

  function createInitialState() {
    return { version: VERSION, subjects: {} };
  }

  function normalizeState(raw) {
    const parsed = parseObject(raw, null);
    if (!parsed || parsed.version !== VERSION || !parsed.subjects || typeof parsed.subjects !== 'object') {
      return createInitialState();
    }
    return parsed;
  }

  function decodeTokenSubject(token) {
    const parts = compact(token).split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    try {
      let json;
      if (typeof Buffer !== 'undefined') {
        json = Buffer.from(parts[1], 'base64url').toString('utf8');
      } else {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        json = decodeURIComponent(Array.prototype.map.call(atob(base64), function (character) {
          return `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
        }).join(''));
      }
      const payload = JSON.parse(json);
      return compact(payload.sub || payload.user_id || payload.id) || null;
    } catch (_) {
      return null;
    }
  }

  function resolveSubject(options) {
    const input = options || {};
    const visitorId = compact(input.visitorId);
    if (input.isGuest && visitorId) return `visitor:${visitorId}`;
    const userId = compact(input.userId) || decodeTokenSubject(input.token);
    if (userId) return `user:${userId}`;
    if (visitorId) return `visitor:${visitorId}`;
    return 'visitor:anonymous';
  }

  function createStore(storage, clock) {
    const now = typeof clock === 'function'
      ? clock
      : (clock && typeof clock.now === 'function' ? clock.now.bind(clock) : Date.now);
    let state = normalizeState(safeGet(storage, STORAGE_KEY));

    function persist() {
      safeSet(storage, STORAGE_KEY, JSON.stringify(state));
    }

    function videoRecord(subject, videoId) {
      return state.subjects[subject] && state.subjects[subject].videos
        ? state.subjects[subject].videos[String(videoId)]
        : null;
    }

    function migrateHeard(videoId, segmentIds) {
      const visited = parseObject(safeGet(storage, VISITED_KEY), {});
      const indexes = Array.isArray(visited[String(videoId)]) ? visited[String(videoId)] : [];
      return indexes
        .filter((index) => Number.isInteger(index) && index >= 0 && index < segmentIds.length)
        .map((index) => segmentIds[index]);
    }

    function migrateResume(videoId) {
      let resumeSeconds = 0;
      let resumePercent = 0;
      const positions = parseObject(safeGet(storage, POSITION_KEY), {});
      const position = positions[String(videoId)];
      if (position && typeof position === 'object') {
        resumeSeconds = Math.max(0, finite(position.sec, 0));
      }
      const oldProgress = safeGet(storage, `video_progress_${videoId}`);
      if (oldProgress != null) {
        const parsed = parseObject(oldProgress, null);
        if (parsed && typeof parsed === 'object') {
          resumeSeconds = Math.max(resumeSeconds, finite(parsed.seconds, 0));
          resumePercent = Math.max(0, Math.min(100, finite(parsed.percent, 0)));
        } else {
          resumePercent = Math.max(0, Math.min(100, finite(oldProgress, 0)));
        }
      }
      return { resumeSeconds, resumePercent };
    }

    function ensure(subjectValue, videoValue, segments, create) {
      const subject = compact(subjectValue);
      const videoId = compact(videoValue);
      if (!subject) throw new Error('FIRST_LESSON_SUBJECT_REQUIRED');
      if (!videoId) throw new Error('FIRST_LESSON_VIDEO_REQUIRED');
      let record = videoRecord(subject, videoId);
      if (!record && create) {
        const segmentIds = segmentIdsFor(videoId, segments);
        const resume = migrateResume(videoId);
        if (!state.subjects[subject]) state.subjects[subject] = { videos: {} };
        record = {
          videoId,
          segmentIds,
          heardSegmentIds: migrateHeard(videoId, segmentIds),
          practiced: {},
          resumeSeconds: resume.resumeSeconds,
          resumePercent: resume.resumePercent,
          completedAt: null,
          generalSyncedAt: null,
          createdAt: now(),
          updatedAt: now(),
        };
        state.subjects[subject].videos[videoId] = record;
        persist();
      } else if (record && Array.isArray(segments)) {
        const nextIds = segmentIdsFor(videoId, segments);
        if (nextIds.join('|') !== (record.segmentIds || []).join('|')) {
          const allowed = new Set(nextIds);
          record.segmentIds = nextIds;
          record.heardSegmentIds = (record.heardSegmentIds || []).filter((id) => allowed.has(id));
          record.practiced = Object.fromEntries(
            Object.entries(record.practiced || {}).filter(([id]) => allowed.has(id)),
          );
          record.completedAt = null;
          record.generalSyncedAt = null;
          record.updatedAt = now();
          persist();
        }
      }
      return { subject, videoId, record };
    }

    function buildSnapshot(subject, videoId, record) {
      const ids = Array.isArray(record && record.segmentIds) ? record.segmentIds : [];
      const allowed = new Set(ids);
      const heardIds = Array.from(new Set(record && record.heardSegmentIds || [])).filter((id) => allowed.has(id));
      const practicedIds = ids.filter((id) => record && record.practiced && record.practiced[id]);
      const total = ids.length;
      const practicedCount = practicedIds.length;
      return {
        version: VERSION,
        subject,
        videoId,
        total,
        heardCount: heardIds.length,
        practicedCount,
        percentage: total ? Math.round((practicedCount / total) * 100) : 0,
        complete: total > 0 && practicedCount >= total,
        completedAt: record && record.completedAt || null,
        resumeSeconds: Math.max(0, finite(record && record.resumeSeconds, 0)),
        resumePercent: Math.max(0, Math.min(100, finite(record && record.resumePercent, 0))),
        heardSegmentIds: heardIds,
        practicedSegmentIds: practicedIds,
      };
    }

    function start(subject, videoId, segments) {
      const current = ensure(subject, videoId, segments, true);
      return buildSnapshot(current.subject, current.videoId, current.record);
    }

    function snapshot(subject, videoId) {
      const current = ensure(subject, videoId, null, false);
      return current.record
        ? buildSnapshot(current.subject, current.videoId, current.record)
        : buildSnapshot(current.subject, current.videoId, null);
    }

    function markHeard(subject, videoId, segmentId, evidence) {
      const current = ensure(subject, videoId, null, false);
      const proof = evidence || {};
      const id = compact(segmentId);
      const qualified = current.record
        && current.record.segmentIds.includes(id)
        && proof.source === 'playback'
        && proof.forward === true
        && finite(proof.fraction, 0) >= 0.5;
      if (!qualified) return { changed: false, snapshot: snapshot(subject, videoId) };
      const heard = new Set(current.record.heardSegmentIds || []);
      const changed = !heard.has(id);
      if (changed) {
        heard.add(id);
        current.record.heardSegmentIds = Array.from(heard);
        current.record.updatedAt = now();
        persist();
      }
      return { changed, snapshot: buildSnapshot(current.subject, current.videoId, current.record) };
    }

    function markPracticed(subject, videoId, segmentId, result) {
      const current = ensure(subject, videoId, null, false);
      const input = result || {};
      const evidence = input.evidence || {};
      const id = compact(segmentId);
      const score = typeof input.score === 'number' ? input.score : NaN;
      const evidenceKind = compact(evidence.kind);
      const qualified = current.record
        && current.record.segmentIds.includes(id)
        && input.success === true
        && Number.isFinite(score)
        && score >= 0
        && score <= 100
        && evidence.recording === true
        && compact(evidence.assessmentId)
        && (evidenceKind === 'recording_assessment' || evidenceKind === 'pronunciation_assessment');
      if (!qualified) return { changed: false, snapshot: snapshot(subject, videoId) };
      if (current.record.practiced[id]) {
        return { changed: false, snapshot: buildSnapshot(current.subject, current.videoId, current.record) };
      }
      current.record.practiced[id] = {
        score,
        evidence: evidenceKind,
        assessmentId: compact(evidence.assessmentId).slice(0, 120),
        at: now(),
      };
      const heard = new Set(current.record.heardSegmentIds || []);
      heard.add(id);
      current.record.heardSegmentIds = Array.from(heard);
      current.record.updatedAt = now();
      const next = buildSnapshot(current.subject, current.videoId, current.record);
      if (next.complete && !current.record.completedAt) current.record.completedAt = now();
      persist();
      return { changed: true, snapshot: buildSnapshot(current.subject, current.videoId, current.record) };
    }

    function markResume(subject, videoId, seconds) {
      const current = ensure(subject, videoId, null, false);
      if (!current.record || !Number.isFinite(Number(seconds))) return snapshot(subject, videoId);
      current.record.resumeSeconds = Math.max(0, Number(seconds));
      current.record.updatedAt = now();
      persist();
      return buildSnapshot(current.subject, current.videoId, current.record);
    }

    function syncCompleted(subject, videoId, writer) {
      const current = ensure(subject, videoId, null, false);
      if (!current.record || current.record.generalSyncedAt || typeof writer !== 'function') return false;
      const currentSnapshot = buildSnapshot(current.subject, current.videoId, current.record);
      if (!currentSnapshot.complete) return false;
      writer(currentSnapshot);
      current.record.generalSyncedAt = now();
      current.record.updatedAt = now();
      persist();
      return true;
    }

    return { start, snapshot, markHeard, markPracticed, markResume, syncCompleted };
  }

  return { STORAGE_KEY, VERSION, stableSegmentId, resolveSubject, createStore };
});
