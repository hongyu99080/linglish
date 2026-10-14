/**
 * Speaker Inference Module
 * Handles multi-speaker role assignment and dialogue-aware inference
 */

/**
 * Extract distinct speaker names from segments
 * @param {Array} segments - Video segments
 * @returns {Array} - List of distinct speaker names
 */
export function inferDistinctSpeakersFromSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const names = new Set();
  segments.forEach((seg) => {
    const n = ((seg && seg.speaker) || '').trim();
    if (n) names.add(n);
  });
  return Array.from(names).slice(0, 5);
}

/**
 * Determine the chosen role count based on state
 * @param {Object} state - Application state
 * @returns {number} - Number of roles (2-5)
 */
export function chosenRoleCount(state) {
  const val = state.roleCount;
  if (val === 'auto') {
    const distinct = inferDistinctSpeakersFromSegments(state.currentSegments);
    if (distinct.length >= 2) return Math.min(5, distinct.length);
    // Simple heuristic: longer dialogues prefer 3 people, otherwise 2
    const total = Array.isArray(state.currentSegments) ? state.currentSegments.length : 0;
    return total >= 30 ? 3 : 2;
  }
  const n = parseInt(val, 10);
  return (isFinite(n) && n >= 2 && n <= 5) ? n : 2;
}

/**
 * Build inferred speakers with dialogue-aware role assignment
 * @param {Object} state - Application state
 * @param {Function} getSegmentLookupKeys - Function to get segment lookup keys
 * @param {Function} pushDebug - Debug logging function
 * @param {boolean} debugMode - Whether debug mode is enabled
 */
export function buildInferredSpeakers(state, getSegmentLookupKeys, pushDebug, debugMode) {
  const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
  const k = chosenRoleCount(state);

  // If segments already carry speaker names with >=2 distinct, prefer grouping by names
  const distinct = inferDistinctSpeakersFromSegments(state.currentSegments);
  let speakers = [];

  if (distinct.length >= 2) {
    // Use actual names (limit to k by frequency)
    const freq = new Map();
    segs.forEach(seg => {
      const n = ((seg && seg.speaker) || '').trim();
      if (!n) return;
      freq.set(n, (freq.get(n) || 0) + 1);
    });
    const top = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([n]) => n);
    speakers = top.map(n => ({ speaker: n, lines: [] }));
    const indexOf = (n) => {
      const i = top.indexOf(n);
      return i >= 0 ? i : 0;
    };
    segs.forEach((seg, i) => {
      const idx = (seg && seg.index != null) ? seg.index : i;
      const name = ((seg && seg.speaker) || '').trim();
      if (!name) return;
      const role = speakers[indexOf(name)];
      role.lines.push({
        index: idx,
        segmentIndex: idx,
        start: seg.start,
        end: seg.end,
        text: seg.text,
        speaker: role.speaker
      });
    });
  } else {
    // Content-aware fallback with rotation and turn-taking heuristics
    speakers = Array.from({ length: k }, (_, i) => ({ speaker: `Speaker ${i + 1}`, lines: [] }));
    const offset = Math.abs(state.roleRotation) % k;
    let curRole = offset;
    let lastRole = null;
    let lastText = '';
    let consecCount = 0;

    const shortReplyRe = /^(yes|no|sure|ok|okay|thanks|thank you|right|great|fine|好的|是的|嗯|谢谢)\b/i;
    const interrogativeRe = /(\?|？|\b(who|what|when|where|why|how|can|could|do|did|are|is|will|would|should|可以|是否|能否)\b)/i;
    const nameHintRe = /(sir|madam|mr\.|mrs\.|ms\.|emily|先生|女士|小姐)/i;

    function decideRole(i, text) {
      let needSwitch = false;
      const t = String(text || '');
      const prevQ = interrogativeRe.test(lastText);
      const shortAns = shortReplyRe.test(t);

      if (prevQ && shortAns) needSwitch = true;
      else if (prevQ && t.length < 40) needSwitch = true;
      else if (nameHintRe.test(t) && !nameHintRe.test(lastText)) needSwitch = true;

      // Avoid long monologue: if same role > 3 lines, force switch
      if (!needSwitch && consecCount >= 3) needSwitch = true;

      if (needSwitch) {
        // If 3+ roles, occasionally move to next distinct role
        curRole = (curRole + 1) % k;
      }
      return curRole;
    }

    segs.forEach((seg, i) => {
      const idx = (seg && seg.index != null) ? seg.index : i;
      const text = String((seg && seg.text) || '').trim();
      const roleIdx = decideRole(i, text);
      const role = speakers[roleIdx];
      role.lines.push({
        index: idx,
        segmentIndex: idx,
        start: seg.start,
        end: seg.end,
        text,
        speaker: role.speaker
      });
      if (lastRole === roleIdx) consecCount += 1;
      else consecCount = 1;
      lastRole = roleIdx;
      lastText = text;
    });
  }

  state.speakers = speakers;

  // Rebuild mapping
  state.segmentSpeakerMap = new Map();
  speakers.forEach(sp => {
    sp.lines.forEach(line => {
      const keys = getSegmentLookupKeys(line.index);
      keys.forEach((k) => {
        if (k !== null && k !== undefined) {
          state.segmentSpeakerMap.set(k, sp.speaker);
        }
      });
    });
  });

  if (debugMode) {
    pushDebug('多角色推断完成', {
      k,
      speakers: speakers.map(s => ({ name: s.speaker, count: s.lines.length }))
    });
  }
}
