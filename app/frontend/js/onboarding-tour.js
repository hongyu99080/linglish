(function (root, factory) {
  const tour = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      computeTourPosition: tour.computeTourPosition,
      shouldStartTour: tour.shouldStartTour,
    };
  } else {
    root.LinglishTour = tour;
    root.startLinglishTour = tour.startTour;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const STYLE_ID = 'linglish-tour-style';

  function shouldStartTour(search) {
    return new URLSearchParams(search || '').get('focus') !== 'first_lesson';
  }

  function computeTourPosition({ targetRect, tooltipRect, viewport, padding }) {
    const tooltipWidth = Math.min(tooltipRect.width, Math.max(0, viewport.width - padding * 2));
    const tooltipHeight = Math.min(tooltipRect.height, Math.max(0, viewport.height - padding * 2));
    const spaceBelow = viewport.height - targetRect.bottom;
    const placeBelow = spaceBelow > tooltipHeight + padding;
    const candidateTop = placeBelow
      ? targetRect.bottom + padding
      : targetRect.top - tooltipHeight - padding;
    const maxTop = Math.max(padding, viewport.height - tooltipHeight - padding);
    const tooltipTop = Math.min(Math.max(candidateTop, padding), maxTop);
    const maxLeft = Math.max(padding, viewport.width - tooltipWidth - padding);
    const tooltipLeft = Math.min(Math.max(targetRect.left, padding), maxLeft);

    return { tooltipTop, tooltipLeft, tooltipWidth, tooltipHeight };
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .tour-overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.55);
        z-index: 9998;
      }
      .tour-highlight {
        position: fixed;
        border-radius: 16px;
        box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.55);
        border: 2px solid rgba(255, 255, 255, 0.7);
        z-index: 9999;
        pointer-events: none;
        transition: all 0.2s ease;
      }
      .tour-tooltip {
        position: fixed;
        box-sizing: border-box;
        max-width: min(320px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow-y: auto;
        padding: 1rem 1.2rem;
        background: white;
        color: #0f172a;
        border-radius: 16px;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.2);
        z-index: 10000;
        display: grid;
        gap: 0.6rem;
      }
      .tour-title {
        font-weight: 700;
        font-size: 1rem;
      }
      .tour-text {
        font-size: 0.9rem;
        line-height: 1.45;
        color: #475569;
      }
      .tour-actions {
        display: flex;
        justify-content: space-between;
        gap: 0.6rem;
      }
      .tour-btn {
        border: none;
        border-radius: 999px;
        padding: 0.4rem 0.9rem;
        font-size: 0.85rem;
        cursor: pointer;
        transition: transform 0.2s ease;
      }
      .tour-btn.primary {
        background: #1ea88a;
        color: white;
      }
      .tour-btn.ghost {
        background: rgba(15, 23, 42, 0.08);
        color: #1f2937;
      }
      .tour-btn:hover {
        transform: translateY(-1px);
      }
    `;
    document.head.appendChild(style);
  }

  function getUserKey() {
    try {
      return localStorage.getItem('userEmail') ||
        sessionStorage.getItem('userEmail') ||
        localStorage.getItem('userId') ||
        sessionStorage.getItem('userId') ||
        'anon';
    } catch (_) {
      return 'anon';
    }
  }

  function startTour(steps, storageKey) {
    if (!Array.isArray(steps) || steps.length === 0) return;
    try {
      const userKey = getUserKey();
      const globalKey = `linglish_tour_done_${userKey}`;
      if (localStorage.getItem(globalKey) === 'done') return;
      if (localStorage.getItem(storageKey) === 'done') return;
    } catch (_) { }

    injectStyles();
    let current = 0;
    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    const highlight = document.createElement('div');
    highlight.className = 'tour-highlight';
    const tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';

    const title = document.createElement('div');
    title.className = 'tour-title';
    const text = document.createElement('div');
    text.className = 'tour-text';
    const actions = document.createElement('div');
    actions.className = 'tour-actions';

    const backBtn = document.createElement('button');
    backBtn.className = 'tour-btn ghost';
    backBtn.textContent = '上一步';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'tour-btn ghost';
    skipBtn.textContent = '跳过';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'tour-btn primary';
    nextBtn.textContent = '下一步';

    actions.appendChild(backBtn);
    actions.appendChild(skipBtn);
    actions.appendChild(nextBtn);
    tooltip.appendChild(title);
    tooltip.appendChild(text);
    tooltip.appendChild(actions);

    function cleanup() {
      overlay.remove();
      highlight.remove();
      tooltip.remove();
      window.removeEventListener('resize', positionStep);
      window.removeEventListener('scroll', positionStep, true);
    }

    function markDone() {
      try {
        const userKey = getUserKey();
        const globalKey = `linglish_tour_done_${userKey}`;
        localStorage.setItem(storageKey, 'done');
        localStorage.setItem(globalKey, 'done');
      } catch (_) { }
      cleanup();
    }

    function positionStep() {
      const step = steps[current];
      if (!step) return;
      const target = document.querySelector(step.target);
      if (!target) {
        current = Math.min(current + 1, steps.length - 1);
        positionStep();
        return;
      }
      const rect = target.getBoundingClientRect();
      const padding = 8;
      const top = rect.top - padding;
      const left = rect.left - padding;
      const width = rect.width + padding * 2;
      const height = rect.height + padding * 2;

      highlight.style.top = `${Math.max(top, 8)}px`;
      highlight.style.left = `${Math.max(left, 8)}px`;
      highlight.style.width = `${Math.min(width, window.innerWidth - 16)}px`;
      highlight.style.height = `${Math.min(height, window.innerHeight - 16)}px`;

      const tooltipRect = tooltip.getBoundingClientRect();
      const { tooltipTop, tooltipLeft } = computeTourPosition({
        targetRect: rect,
        tooltipRect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        padding: 16,
      });

      tooltip.style.top = `${tooltipTop}px`;
      tooltip.style.left = `${tooltipLeft}px`;
    }

    function renderStep() {
      const step = steps[current];
      if (!step) return;
      const target = document.querySelector(step.target);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      title.textContent = step.title || '';
      text.textContent = step.text || '';
      backBtn.disabled = current === 0;
      nextBtn.textContent = current === steps.length - 1 ? '完成' : '下一步';
      setTimeout(positionStep, 250);
    }

    backBtn.addEventListener('click', () => {
      if (current > 0) {
        current -= 1;
        renderStep();
      }
    });

    nextBtn.addEventListener('click', () => {
      if (current < steps.length - 1) {
        current += 1;
        renderStep();
      } else {
        markDone();
      }
    });

    skipBtn.addEventListener('click', markDone);
    overlay.addEventListener('click', markDone);

    document.body.appendChild(overlay);
    document.body.appendChild(highlight);
    document.body.appendChild(tooltip);
    window.addEventListener('resize', positionStep);
    window.addEventListener('scroll', positionStep, true);
    renderStep();
  }

  return { computeTourPosition, shouldStartTour, startTour };
});
