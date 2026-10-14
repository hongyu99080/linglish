// Lightweight shared feedback utilities: toast, sfx, badges
// Usage: Feedback.showToast('success', '✅ Done'); Feedback.playSfx('success');
//        Feedback.awardBadgeOnce('flow-3', '流畅三连');

(function () {
  if (typeof window === 'undefined') return;
  const Feedback = {};

  // Inject minimal styles once
  function injectStylesOnce() {
    if (document.getElementById('feedback-styles')) return;
    const style = document.createElement('style');
    style.id = 'feedback-styles';
    style.textContent = `
      .toast-container{position:fixed;right:14px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:99999;pointer-events:none}
      .toast{min-width:200px;max-width:320px;padding:10px 12px;border-radius:10px;box-shadow:0 10px 25px rgba(15,23,42,.25);background:#fff;color:#111827;font-size:13px;font-weight:600;border:1px solid rgba(0,0,0,.06);display:flex;align-items:center;gap:8px;transform:translateY(10px);opacity:0;transition:all .2s ease;pointer-events:auto}
      .toast.show{opacity:1;transform:translateY(0)}
      .toast .icon{font-size:16px}
      .toast.success{border-color:rgba(16,185,129,.35)}
      .toast.info{border-color:rgba(59,130,246,.35)}
      .toast.warn{border-color:rgba(245,158,11,.35)}
    `;
    document.head.appendChild(style);
  }

  function ensureContainer() {
    let el = document.getElementById('toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast-container';
      el.className = 'toast-container';
      document.body.appendChild(el);
    }
    return el;
  }

  Feedback.showToast = function showToast(type = 'info', text = '', duration = 1600) {
    try {
      injectStylesOnce();
      const container = ensureContainer();
      const el = document.createElement('div');
      el.className = `toast ${type}`;
      const icon = type === 'success' ? '✅' : (type === 'warn' ? '⚠️' : '💡');
      el.innerHTML = `<span class="icon">${icon}</span><span class="text"></span>`;
      el.querySelector('.text').textContent = String(text);
      container.appendChild(el);
      void el.offsetHeight; // reflow
      el.classList.add('show');
      const t = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 220);
      }, Math.max(800, duration));
      el.addEventListener('click', () => { clearTimeout(t); el.remove(); });
    } catch (_) { /* ignore */ }
  };

  Feedback.playSfx = function playSfx(name = 'success') {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      const now = ctx.currentTime;
      if (name === 'success') {
        o.frequency.setValueAtTime(880, now);
        o.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      } else if (name === 'prompt') {
        o.frequency.setValueAtTime(660, now);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.06, now + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      } else {
        o.frequency.setValueAtTime(520, now);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.05, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
      }
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(now + 0.22);
      o.onended = function() { if (ctx.close) ctx.close(); };
    } catch (_) { /* ignore */ }
  };

  Feedback.awardBadgeOnce = function awardBadgeOnce(key, label) {
    try {
      const storeKey = 'practice_badges';
      const raw = localStorage.getItem(storeKey);
      const bag = (raw && raw !== 'undefined' && raw !== 'null') ? JSON.parse(raw) : {};
      if (bag[key]) return false;
      bag[key] = { at: Date.now() };
      localStorage.setItem(storeKey, JSON.stringify(bag));
      Feedback.showToast('success', `🏅 徽章：${label}`, 2000);
      Feedback.playSfx('success');
      return true;
    } catch (_) {
      Feedback.showToast('success', `🏅 徽章：${label}`, 2000);
      return true;
    }
  };

  window.Feedback = Feedback;
})();

