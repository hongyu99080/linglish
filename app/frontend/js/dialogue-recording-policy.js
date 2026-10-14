(function attachDialogueRecordingPolicy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.DialogueRecordingPolicy = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPolicy() {
  function getDialogueRecordingPolicy(sentence = {}) {
    const text = String(sentence.text || sentence.content || '').trim();
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const start = Number(sentence.start);
    const end = Number(sentence.end);
    const subtitleMs = Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, (end - start) * 1000)
      : 0;
    const speechEstimateMs = wordCount * 500 + 1500;
    const maximumMs = Math.min(
      12000,
      Math.max(4500, subtitleMs + 2000, speechEstimateMs),
    );

    return {
      minimumMs: 900,
      maximumMs: Math.round(maximumMs),
    };
  }

  return { getDialogueRecordingPolicy };
}));
