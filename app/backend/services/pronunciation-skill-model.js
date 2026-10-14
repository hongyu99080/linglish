const MAX_TARGET_LENGTH = 80;
const MAX_SAMPLE_LENGTH = 240;

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function wordKey(value) {
  const token = cleanText(value, MAX_TARGET_LENGTH)
    .match(/[a-z0-9]+(?:'[a-z0-9]+)*/i);
  return token ? token[0].toLowerCase().slice(0, MAX_TARGET_LENGTH) : '';
}

function phonemeKey(value) {
  return cleanText(value, MAX_TARGET_LENGTH);
}

function assessmentContext(assessment) {
  return {
    sample_text: cleanText(assessment?.text, MAX_SAMPLE_LENGTH),
    assessment_id: assessment?.id ?? null,
    video_resource_id: assessment?.video_resource_id ?? null,
  };
}

function observation(context, skillType, targetKey, displayTarget, evidenceLevel, outcome) {
  return {
    skill_type: skillType,
    target_key: targetKey,
    display_target: cleanText(displayTarget, MAX_TARGET_LENGTH),
    evidence_level: evidenceLevel,
    outcome,
    observed_score: outcome === 'success' ? 100 : 20,
    ...context,
  };
}

function hasIssue(issues, type) {
  return issues.some((issue) => issue?.type === type);
}

function deriveSkillObservations(assessment = {}, activeSkills = []) {
  const coaching = assessment.coaching && typeof assessment.coaching === 'object'
    ? assessment.coaching
    : {};
  const issues = Array.isArray(coaching.issues) ? coaching.issues : [];
  const context = assessmentContext(assessment);
  const assessmentPace = finiteNumber(assessment.speech_rate_wpm);
  const observations = [];
  const seen = new Set();
  const add = (item) => {
    const key = `${item.skill_type}:${item.target_key}`;
    if (item.target_key && !seen.has(key)) {
      seen.add(key);
      observations.push(item);
    }
  };

  for (const issue of issues) {
    const evidence = issue?.evidence;
    if (issue?.type === 'missing_word' && coaching.evidence_level === 'transcript_alignment'
      && evidence === 'transcript_alignment') {
      const target = wordKey(issue.target);
      add(observation(context, 'missing_word', target, target, evidence, 'issue'));
    }
    if (issue?.type === 'extra_word' && coaching.evidence_level === 'transcript_alignment'
      && evidence === 'transcript_alignment') {
      add(observation(context, 'extra_word', 'flow_control', '减少额外词或重复', evidence, 'issue'));
    }
    if (issue?.type === 'pace' && assessmentPace !== null) {
      add(observation(context, 'pace', 'pace', '短语节奏', 'recording_signal', 'issue'));
    }
    if (issue?.type === 'phoneme' && coaching.evidence_level === 'provider_phoneme'
      && evidence === 'provider_phoneme') {
      const target = phonemeKey(issue.target);
      add(observation(context, 'phoneme', target, target, evidence, 'issue'));
    }
  }

  const active = Array.isArray(activeSkills) ? activeSkills : [];
  const correctWords = new Set((Array.isArray(assessment.words) ? assessment.words : [])
    .filter((word) => word?.type === 'correct')
    .map((word) => wordKey(word.word))
    .filter(Boolean));
  const hasExtraIssue = hasIssue(issues, 'extra_word');
  const accuracy = Number(assessment.accuracy);
  const pace = assessmentPace;
  const phonemes = Array.isArray(assessment.phonemes) ? assessment.phonemes : [];

  for (const activeSkill of active) {
    const skillType = activeSkill?.skill_type;
    const targetKey = cleanText(activeSkill?.target_key, MAX_TARGET_LENGTH);
    if (skillType === 'missing_word' && correctWords.has(targetKey)) {
      add(observation(context, skillType, targetKey, activeSkill.display_target || targetKey,
        'transcript_alignment', 'success'));
    }
    if (skillType === 'extra_word' && !hasExtraIssue && Number.isFinite(accuracy) && accuracy >= 80
      && coaching.evidence_level !== 'recording_signal') {
      add(observation(context, skillType, 'flow_control', activeSkill.display_target || '减少额外词或重复',
        'transcript_alignment', 'success'));
    }
    if (skillType === 'pace' && Number.isFinite(pace) && pace >= 70 && pace <= 190) {
      add(observation(context, skillType, 'pace', activeSkill.display_target || '短语节奏',
        'recording_signal', 'success'));
    }
    if (skillType === 'phoneme' && coaching.evidence_level === 'provider_phoneme') {
      const matched = phonemes.find((phoneme) => phonemeKey(phoneme?.symbol || phoneme?.phoneme) === targetKey);
      if (matched && matched.error !== true && Number.isFinite(Number(matched.accuracy))
        && Number(matched.accuracy) >= 80) {
        add(observation(context, skillType, targetKey, activeSkill.display_target || targetKey,
          'provider_phoneme', 'success'));
      }
    }
  }

  return observations;
}

function evidenceWeight(level) {
  return ({ provider_phoneme: 1, transcript_alignment: 0.9, recording_signal: 0.75 })[level] || 0;
}

function plusDays(now, days) {
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function computeNextSkillState(previous, observation, now = new Date()) {
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError('now must be a valid date');
  const prior = previous && typeof previous === 'object' ? previous : {};
  const isSuccess = observation?.outcome === 'success';
  const attemptCount = Number(prior.attempt_count || 0) + 1;
  const successStreak = isSuccess ? Number(prior.success_streak || 0) + 1 : 0;
  const observedScore = isSuccess ? 100 : 20;
  const priorScore = Number(prior.ema_score);
  const emaScore = Number.isFinite(priorScore)
    ? Number((priorScore * 0.7 + observedScore * 0.3).toFixed(6))
    : observedScore;
  const intervalDays = isSuccess ? (successStreak >= 3 ? 8 : successStreak === 2 ? 4 : 2) : 1;
  const weight = Math.max(evidenceWeight(prior.evidence_level), evidenceWeight(observation?.evidence_level));
  const hasVideoContext = observation?.video_resource_id !== null
    && observation?.video_resource_id !== undefined
    && observation?.video_resource_id !== '';
  const preservePriorContext = !hasVideoContext && (prior.video_resource_id !== null
    && prior.video_resource_id !== undefined
    && prior.video_resource_id !== '');

  return {
    skill_type: observation.skill_type,
    target_key: observation.target_key,
    display_target: cleanText(observation.display_target, MAX_TARGET_LENGTH),
    evidence_level: evidenceWeight(observation?.evidence_level) >= evidenceWeight(prior.evidence_level)
      ? observation.evidence_level
      : prior.evidence_level,
    attempt_count: attemptCount,
    issue_count: Number(prior.issue_count || 0) + (isSuccess ? 0 : 1),
    success_count: Number(prior.success_count || 0) + (isSuccess ? 1 : 0),
    success_streak: successStreak,
    ema_score: emaScore,
    confidence: Math.min(1, attemptCount / 5) * weight,
    status: isSuccess && successStreak >= 3 && emaScore >= 80 ? 'stable' : isSuccess ? 'improving' : 'focus',
    next_review_at: plusDays(timestamp, intervalDays),
    last_assessment_id: preservePriorContext ? prior.last_assessment_id ?? null : observation.assessment_id ?? null,
    video_resource_id: preservePriorContext ? prior.video_resource_id : observation.video_resource_id ?? null,
    sample_text: preservePriorContext
      ? cleanText(prior.sample_text, MAX_SAMPLE_LENGTH)
      : cleanText(observation.sample_text, MAX_SAMPLE_LENGTH),
    last_issue_at: isSuccess ? prior.last_issue_at || null : timestamp.toISOString(),
    last_success_at: isSuccess ? timestamp.toISOString() : prior.last_success_at || null,
    created_at: prior.created_at || timestamp.toISOString(),
    updated_at: timestamp.toISOString(),
  };
}

function credibleAssessments(assessments) {
  return (Array.isArray(assessments) ? assessments : []).filter((assessment) => {
    const evidence = assessment?.coaching?.evidence_level;
    return evidence === 'transcript_alignment' || evidence === 'provider_phoneme';
  }).slice(0, 20);
}

function recencyWeightedScore(assessments, field) {
  let weightTotal = 0;
  let scoreTotal = 0;
  assessments.forEach((assessment, index) => {
    const score = Number(assessment?.[field]);
    if (!Number.isFinite(score)) return;
    const weight = 0.8 ** index;
    scoreTotal += Math.min(100, Math.max(0, score)) * weight;
    weightTotal += weight;
  });
  return weightTotal ? Math.round(scoreTotal / weightTotal) : null;
}

function dimension(key, label, score, confidence, evidence) {
  return { key, label, score, confidence, evidence };
}

function buildTrend(assessments) {
  const windowSize = Math.min(5, Math.floor(assessments.length / 2));
  const recent = assessments.slice(0, windowSize);
  const previous = assessments.slice(windowSize, windowSize * 2);
  if (recent.length < 2 || previous.length < 2) return { direction: 'collecting', delta: null };
  const average = (items) => items.reduce((total, assessment) => {
    const values = [assessment.accuracy, assessment.completeness]
      .map(Number)
      .filter(Number.isFinite);
    return total + (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  }, 0) / items.length;
  const delta = Math.round(average(recent) - average(previous));
  return { direction: delta > 5 ? 'up' : delta < -5 ? 'down' : 'flat', delta };
}

function buildFocusItems(skills, now, limit) {
  const currentTime = now.getTime();
  const prioritized = (Array.isArray(skills) ? skills : []).filter((skill) => skill && skill.skill_type && skill.target_key)
    .map((skill) => {
      const dueAt = new Date(skill.next_review_at).getTime();
      const due = Number.isFinite(dueAt) && dueAt <= currentTime;
      const attempts = Number(skill.attempt_count) || 0;
      const issueRate = (Number(skill.issue_count) || 0) / Math.max(1, attempts);
      return { skill, due, issueRate };
    })
    .sort((left, right) => Number(right.due) - Number(left.due)
      || Number(left.skill.status === 'stable') - Number(right.skill.status === 'stable')
      || right.issueRate - left.issueRate
      || Number(right.skill.confidence || 0) - Number(left.skill.confidence || 0));
  const typeCounts = new Map();
  const items = [];
  for (const { skill } of prioritized) {
    const typeCount = typeCounts.get(skill.skill_type) || 0;
    if (typeCount >= 2 || items.length >= limit) continue;
    typeCounts.set(skill.skill_type, typeCount + 1);
    items.push({
      skill_type: skill.skill_type,
      target_key: skill.target_key,
      display_target: cleanText(skill.display_target || skill.target_key, MAX_TARGET_LENGTH),
      evidence_level: skill.evidence_level || null,
      status: skill.status || 'focus',
      next_review_at: skill.next_review_at || null,
      video_resource_id: skill.video_resource_id ?? null,
      assessment_id: skill.last_assessment_id ?? null,
      sample_text: cleanText(skill.sample_text, MAX_SAMPLE_LENGTH),
    });
  }
  return items;
}

function buildPronunciationProfile({ assessments = [], skills = [], now = new Date(), limit = 3 } = {}) {
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError('now must be a valid date');
  const credible = credibleAssessments(assessments);
  const sampleCount = credible.length;
  const ready = sampleCount >= 3;
  const confidence = Math.min(1, sampleCount / 5) * 0.9;
  const hasPaceEvidence = credible.some((assessment) => finiteNumber(assessment.speech_rate_wpm) !== null);
  const phonemeSkills = (Array.isArray(skills) ? skills : []).filter((skill) => skill?.skill_type === 'phoneme'
    && skill.evidence_level === 'provider_phoneme' && Number.isFinite(Number(skill.ema_score)));
  const phonemeScore = phonemeSkills.length
    ? Math.round(phonemeSkills.reduce((total, skill) => total + Number(skill.ema_score), 0) / phonemeSkills.length)
    : null;
  const safeLimit = Math.min(5, Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 3));

  return {
    status: ready ? 'ready' : 'collecting',
    sample_count: sampleCount,
    dimensions: [
      dimension('clarity', '词级清晰', ready ? recencyWeightedScore(credible, 'accuracy') : null, ready ? confidence : 0, 'transcript_alignment'),
      dimension('completeness', '完整表达', ready ? recencyWeightedScore(credible, 'completeness') : null, ready ? confidence : 0, 'transcript_alignment'),
      dimension('pace', '短语节奏', ready && hasPaceEvidence ? recencyWeightedScore(credible.map((assessment) => {
        const pace = finiteNumber(assessment.speech_rate_wpm);
        return { speech_rate_wpm: pace === null ? null : pace >= 70 && pace <= 190 ? 100 : 20 };
      }), 'speech_rate_wpm') : null, hasPaceEvidence ? 0.75 : 0, 'recording_signal'),
      dimension('phoneme', '音素证据', ready ? phonemeScore : null, phonemeSkills.length ? Math.max(...phonemeSkills.map((skill) => Number(skill.confidence) || 0)) : 0, 'provider_phoneme'),
    ],
    focus_items: buildFocusItems(skills, timestamp, safeLimit),
    trend: buildTrend(credible),
    next_action: null,
    disclaimer: '画像仅基于可信的词级对齐、音素证据和语速信号，会随后续表现更新。',
  };
}

module.exports = {
  deriveSkillObservations,
  computeNextSkillState,
  buildPronunciationProfile,
};
