(function initPronunciationCoachUI(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishPronunciationCoachUI = api;
})(typeof window !== 'undefined' ? window : globalThis, function createPronunciationCoachUI() {
  const EVIDENCE_LABELS = {
    provider_phoneme: '音素证据',
    transcript_alignment: '基于词级对齐',
    recording_signal: '基于录音信号',
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function cleanText(value, maxLength = 500) {
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
      : '';
  }

  function normalizeCoaching(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const headline = cleanText(value.headline, 160);
    if (!headline || !Array.isArray(value.issues)) return null;

    const evidenceLevel = Object.prototype.hasOwnProperty.call(EVIDENCE_LABELS, value.evidence_level)
      ? value.evidence_level
      : 'transcript_alignment';
    const strengths = Array.isArray(value.strengths)
      ? value.strengths.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 2)
      : [];
    const issues = value.issues.map((item) => {
      if (!item || typeof item !== 'object') return null;
      const title = cleanText(item.title, 160);
      const reason = cleanText(item.reason, 260);
      const drill = cleanText(item.drill, 260);
      if (!title || (!reason && !drill)) return null;
      return {
        type: cleanText(item.type, 48) || 'focus',
        target: cleanText(item.target, 80),
        title,
        reason,
        drill,
      };
    }).filter(Boolean).slice(0, 3);
    const action = value.next_action && typeof value.next_action === 'object'
      ? {
        type: cleanText(value.next_action.type, 48),
        label: cleanText(value.next_action.label, 120),
        target_text: cleanText(value.next_action.target_text, 180),
      }
      : { type: '', label: '', target_text: '' };

    return {
      version: cleanText(value.version, 32) || 'coach-v1',
      evidence_level: evidenceLevel,
      headline,
      summary: cleanText(value.summary, 300),
      strengths,
      issues,
      next_action: action,
      disclaimer: cleanText(value.disclaimer, 300),
    };
  }

  function buildMarkup(value) {
    const coaching = normalizeCoaching(value);
    if (!coaching) return '';

    const strengthsHtml = coaching.strengths.length
      ? `<div class="pc-strengths" aria-label="已经做好的部分">
          <div class="pc-section-label">已经做好</div>
          <div class="pc-strength-list">${coaching.strengths.map((item) => `<span class="pc-strength">✓ ${escapeHtml(item)}</span>`).join('')}</div>
        </div>`
      : '';

    const issuesHtml = coaching.issues.length
      ? `<div class="pc-issues" aria-label="优先改进建议">
          <div class="pc-section-label">优先改</div>
          ${coaching.issues.map((issue, index) => `
            <article class="pc-issue" data-issue-type="${escapeHtml(issue.type)}">
              <div class="pc-issue-index">${index + 1}</div>
              <div class="pc-issue-body">
                <strong>${escapeHtml(issue.title)}</strong>
                ${issue.reason ? `<p><span>为什么：</span>${escapeHtml(issue.reason)}</p>` : ''}
                ${issue.drill ? `<p class="pc-drill"><span>怎么练：</span>${escapeHtml(issue.drill)}</p>` : ''}
              </div>
            </article>`).join('')}
        </div>`
      : '<div class="pc-clear">✓ 本句没有需要优先修正的词级问题</div>';

    const actionHtml = coaching.next_action.label
      ? `<div class="pc-next-action" data-coach-action="${escapeHtml(coaching.next_action.type)}">
          <span>下一步</span>
          <strong>${escapeHtml(coaching.next_action.label)}</strong>
          ${coaching.next_action.target_text ? `<small>“${escapeHtml(coaching.next_action.target_text)}”</small>` : ''}
        </div>`
      : '';

    return `<section class="pronunciation-coach-card" data-coach-version="${escapeHtml(coaching.version)}" data-evidence-level="${escapeHtml(coaching.evidence_level)}" aria-labelledby="pronunciation-coach-title">
      <header class="pc-header">
        <span class="pc-kicker">✨ AI 教练诊断</span>
        <span class="pc-evidence">${escapeHtml(EVIDENCE_LABELS[coaching.evidence_level])}</span>
      </header>
      <h3 id="pronunciation-coach-title">${escapeHtml(coaching.headline)}</h3>
      ${coaching.summary ? `<p class="pc-summary">${escapeHtml(coaching.summary)}</p>` : ''}
      ${strengthsHtml}
      ${issuesHtml}
      ${actionHtml}
      ${coaching.disclaimer ? `<p class="pc-disclaimer">${escapeHtml(coaching.disclaimer)}</p>` : ''}
    </section>`;
  }

  function buildEventProperties(coaching) {
    return {
      version: coaching.version,
      evidence_level: coaching.evidence_level,
      issue_types: coaching.issues.map((issue) => issue.type),
      issue_count: coaching.issues.length,
      next_action_type: coaching.next_action.type || null,
    };
  }

  function mount(container, value, options = {}) {
    const coaching = normalizeCoaching(value);
    if (!container || !coaching) return false;
    const markup = buildMarkup(coaching);
    if (!markup) return false;

    try {
      const documentObject = container.ownerDocument
        || (typeof document !== 'undefined' ? document : null);
      if (!documentObject || typeof documentObject.createElement !== 'function') return false;

      const existing = typeof container.querySelector === 'function'
        ? container.querySelector('[data-pronunciation-coach-host]')
        : null;
      const host = documentObject.createElement('div');
      host.className = 'pronunciation-coach-host';
      host.setAttribute('data-pronunciation-coach-host', 'true');
      host.innerHTML = markup;

      const beforeNode = options.beforeNode;
      if (beforeNode && beforeNode.parentNode === container && typeof container.insertBefore === 'function') {
        container.insertBefore(host, beforeNode);
      } else if (typeof container.appendChild === 'function') {
        container.appendChild(host);
      } else {
        return false;
      }
      if (existing && existing !== host && typeof existing.remove === 'function') existing.remove();

      const properties = buildEventProperties(coaching);
      const impressionKey = [
        options.impressionId ?? '',
        properties.version,
        properties.evidence_level,
        properties.issue_types.join(','),
        properties.next_action_type || '',
      ].join('|');
      const dataset = container.dataset || (container.dataset = {});
      if (dataset.pronunciationCoachImpression !== impressionKey) {
        dataset.pronunciationCoachImpression = impressionKey;
        if (typeof options.emit === 'function') {
          options.emit('pronunciation_coaching_shown', properties);
        }
        if (typeof options.dispatch === 'function') {
          options.dispatch('linglish:ai-feedback', properties);
        }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function clear(container) {
    if (!container || typeof container.querySelector !== 'function') return false;
    const existing = container.querySelector('[data-pronunciation-coach-host]');
    if (!existing || typeof existing.remove !== 'function') return false;
    existing.remove();
    return true;
  }

  return {
    EVIDENCE_LABELS,
    buildMarkup,
    buildEventProperties,
    clear,
    escapeHtml,
    mount,
    normalizeCoaching,
  };
});
