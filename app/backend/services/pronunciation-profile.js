const {
  deriveSkillObservations,
  computeNextSkillState,
  buildPronunciationProfile,
} = require('./pronunciation-skill-model');

function mergePersistedAssessment(savedAssessment, assessed) {
  const saved = savedAssessment && typeof savedAssessment === 'object' ? savedAssessment : {};
  const live = assessed && typeof assessed === 'object' ? assessed : {};
  return {
    ...saved,
    ...live,
    id: saved.id ?? live.id ?? null,
    video_resource_id: saved.video_resource_id ?? live.video_resource_id ?? null,
  };
}

function summarizeSkillState(state) {
  return {
    type: state.skill_type,
    evidence: state.evidence_level,
    status: state.status,
    display_target: state.display_target,
  };
}

async function loadPronunciationProfile(store, userId, { limit = 3, now = new Date() } = {}) {
  const [assessments, skills] = await Promise.all([
    store.listPronunciationAssessments(userId, { limit: 20 }),
    store.listPronunciationSkills(userId, { limit: 20, includeStable: true }),
  ]);
  return buildPronunciationProfile({ assessments, skills, limit, now });
}

async function updateProfileAfterAssessment(store, userId, savedAssessment, assessed, now = new Date()) {
  const assessment = mergePersistedAssessment(savedAssessment, assessed);
  const states = await store.withPronunciationSkillTransaction(userId, async (transaction) => {
    const existingSkills = await transaction.listPronunciationSkillsForUpdate();
    const observations = deriveSkillObservations(assessment, existingSkills);
    const updated = [];
    for (const item of observations) {
      const previous = existingSkills.find((skill) => skill.skill_type === item.skill_type
        && skill.target_key === item.target_key) || null;
      const state = computeNextSkillState(previous, item, now);
      await transaction.upsertPronunciationSkill(userId, state);
      updated.push({ observation: item, state });
    }
    return updated;
  }) || [];

  const profile = await loadPronunciationProfile(store, userId, { now });
  return {
    improved: states
      .filter(({ observation }) => observation.outcome === 'success')
      .map(({ state }) => summarizeSkillState(state)),
    needs_focus: states
      .filter(({ observation }) => observation.outcome === 'issue')
      .map(({ state }) => summarizeSkillState(state)),
    sample_count: profile.sample_count,
  };
}

module.exports = {
  updateProfileAfterAssessment,
  loadPronunciationProfile,
};
