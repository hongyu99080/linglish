/**
 * Feedback Modal Module
 * Displays detailed pronunciation feedback with word-level highlighting
 */

let currentModal = null;
let resolveCallback = null;

/**
 * Build highlighted text HTML from word evaluation results
 * @param {string} referenceText - Original reference text
 * @param {Array} words - Word-level evaluation results [{type, word}, ...]
 * @returns {string} - HTML string with highlighted words
 */
function buildHighlightedText(referenceText, words) {
  if (!words || words.length === 0) {
    return `<span class="word-neutral">${escapeHtml(referenceText)}</span>`;
  }

  const parts = [];
  for (const w of words) {
    const escapedWord = escapeHtml(w.word);
    switch (w.type) {
      case 'correct':
        parts.push(`<span class="word-correct">${escapedWord}</span>`);
        break;
      case 'missing':
        parts.push(`<span class="word-missing">${escapedWord}</span>`);
        break;
      case 'extra':
        parts.push(`<span class="word-extra">${escapedWord}</span>`);
        break;
      default:
        parts.push(`<span class="word-neutral">${escapedWord}</span>`);
    }
  }
  return parts.join(' ');
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Get score level class and label
 * @param {number} score - Score (0-1)
 * @returns {Object} - {className, label}
 */
function getScoreLevel(score) {
  const percent = Math.round(score * 100);
  if (score >= 0.9) {
    return { className: 'excellent', label: 'A', percent };
  } else if (score >= 0.8) {
    return { className: 'good', label: 'B', percent };
  } else if (score >= 0.6) {
    return { className: 'fair', label: 'C', percent };
  } else {
    return { className: 'poor', label: 'D', percent };
  }
}

/**
 * Show pronunciation feedback modal
 * @param {Object} options - Modal options
 * @param {number} options.score - Pronunciation score (0-1)
 * @param {string} options.referenceText - Reference text
 * @param {Array} options.words - Word-level evaluation results
 * @param {string} options.hypothesis - ASR transcription result
 * @param {Object} options.feedback - Feedback object from generateFeedback()
 * @returns {Promise<string>} - 'retry' or 'next'
 */
export function showFeedbackModal({ score, referenceText, words, hypothesis, feedback }) {
  return new Promise((resolve) => {
    resolveCallback = resolve;

    // Remove existing modal if any
    if (currentModal) {
      currentModal.remove();
      currentModal = null;
    }

    const scoreLevel = getScoreLevel(score);
    const highlightedText = buildHighlightedText(referenceText, words);

    // Create modal HTML
    const modalHtml = `
      <div class="pronunciation-feedback-overlay" id="pronunciationFeedbackOverlay">
        <div class="pronunciation-feedback-card">
          <div class="feedback-header">
            <span class="feedback-emoji">${feedback.emoji}</span>
            <span class="feedback-title">${feedback.text}</span>
          </div>

          <div class="feedback-score-section">
            <div class="score-circle ${scoreLevel.className}">
              <span class="score-label">${scoreLevel.label}</span>
              <span class="score-percent">${scoreLevel.percent}%</span>
            </div>
          </div>

          <div class="feedback-text-section">
            <div class="text-label">发音对比</div>
            <div class="highlighted-text">${highlightedText}</div>
            ${hypothesis ? `<div class="hypothesis-text">你说的: "${escapeHtml(hypothesis)}"</div>` : ''}
          </div>

          ${feedback.details ? `
          <div class="feedback-tip">
            <span class="tip-icon">💡</span>
            <span class="tip-text">${escapeHtml(feedback.details)}</span>
          </div>
          ` : ''}

          <div class="feedback-legend">
            <span class="legend-item"><span class="word-correct">单词</span> 正确</span>
            <span class="legend-item"><span class="word-missing">单词</span> 缺失</span>
            <span class="legend-item"><span class="word-extra">单词</span> 多余</span>
          </div>

          <div class="feedback-actions">
            <button class="feedback-btn retry-btn" id="feedbackRetryBtn">
              <span class="btn-icon">🔄</span>
              <span class="btn-text">再试一次</span>
            </button>
            <button class="feedback-btn next-btn" id="feedbackNextBtn">
              <span class="btn-icon">▶️</span>
              <span class="btn-text">继续下一句</span>
            </button>
          </div>
        </div>
      </div>
    `;

    // Insert modal into DOM
    const container = document.createElement('div');
    container.innerHTML = modalHtml;
    currentModal = container.firstElementChild;
    document.body.appendChild(currentModal);

    // Add event listeners
    const retryBtn = document.getElementById('feedbackRetryBtn');
    const nextBtn = document.getElementById('feedbackNextBtn');
    const overlay = document.getElementById('pronunciationFeedbackOverlay');

    retryBtn.addEventListener('click', () => {
      closeFeedbackModal('retry');
    });

    nextBtn.addEventListener('click', () => {
      closeFeedbackModal('next');
    });

    // Close on overlay click (outside card)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeFeedbackModal('next');
      }
    });

    // Animate in
    requestAnimationFrame(() => {
      currentModal.classList.add('visible');
    });
  });
}

/**
 * Close the feedback modal
 * @param {string} action - 'retry' or 'next'
 */
export function closeFeedbackModal(action = 'next') {
  if (currentModal) {
    currentModal.classList.remove('visible');
    currentModal.classList.add('closing');

    setTimeout(() => {
      if (currentModal) {
        currentModal.remove();
        currentModal = null;
      }
    }, 250);
  }

  if (resolveCallback) {
    resolveCallback(action);
    resolveCallback = null;
  }
}

/**
 * Check if feedback modal is currently visible
 * @returns {boolean}
 */
export function isFeedbackModalVisible() {
  return currentModal !== null;
}
