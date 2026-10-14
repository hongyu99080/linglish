/**
 * NextVideoSheet - 移动端视频播完后在底部弹出「下一个」推荐卡。
 * 推荐来自 /api/learning/next-video(VideoRecommendationClient),失败则不弹。
 */
(function (root) {
  'use strict';

  var STYLE_ID = 'next-video-sheet-style';
  var CSS = [
    '.next-video-sheet{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:1200;',
    'display:grid;grid-template-columns:1fr auto;gap:10px 12px;align-items:center;padding:14px 14px 14px 16px;',
    'border:1px solid rgba(15,118,110,.28);border-radius:18px;background:var(--surface,#fff);color:var(--text-primary,#0f172a);',
    'box-shadow:0 18px 40px rgba(15,23,42,.18);transform:translateY(0);opacity:1;transition:transform 220ms cubic-bezier(.16,1,.3,1),opacity 220ms ease}',
    '.next-video-sheet[hidden]{display:none}',
    '.next-video-sheet.is-entering{transform:translateY(24px);opacity:0}',
    '.next-video-sheet__label{grid-column:1/-1;display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:700;color:#0f766e}',
    '.next-video-sheet__close{border:0;background:transparent;color:var(--text-muted,#64748b);font-size:18px;line-height:1;padding:0 2px;cursor:pointer}',
    '.next-video-sheet__title{font-size:15px;font-weight:750;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.next-video-sheet__meta{margin-top:2px;font-size:12px;color:var(--text-muted,#64748b)}',
    '.next-video-sheet__go{min-height:40px;padding:0 16px;border:0;border-radius:999px;background:#0f766e;color:#fff;font-weight:750;font-size:14px;cursor:pointer}',
    '.next-video-sheet__go:focus-visible,.next-video-sheet__close:focus-visible{outline:2px solid #0f766e;outline-offset:2px}',
    '@media (prefers-reduced-motion:reduce){.next-video-sheet{transition:none}}'
  ].join('');

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function formatMinutes(sec) {
    var n = Number(sec) || 0;
    if (n <= 0) return '';
    return Math.max(1, Math.round(n / 60)) + ' 分钟';
  }

  function buildEl(doc) {
    var el = doc.createElement('section');
    el.className = 'next-video-sheet';
    el.setAttribute('aria-label', '推荐下一个视频');
    el.hidden = true;
    el.innerHTML =
      '<div class="next-video-sheet__label"><span data-role="reason"></span>' +
      '<button type="button" class="next-video-sheet__close" data-role="close" aria-label="关闭">×</button></div>' +
      '<div><div class="next-video-sheet__title" data-role="title"></div>' +
      '<div class="next-video-sheet__meta" data-role="meta"></div></div>' +
      '<button type="button" class="next-video-sheet__go" data-role="go">下一个 →</button>';
    doc.body.appendChild(el);
    return el;
  }

  /**
   * @param {{ apiBase?: string, getToken: () => (string|null), postEvent: (name: string, props: object) => void,
   *           onOpen: (video: object) => void, client?: object, doc?: Document }} options
   */
  function create(options) {
    var opts = options || {};
    var doc = opts.doc || root.document;
    var client = opts.client || root.VideoRecommendationClient;
    var el = null;
    var current = null;
    var requestSeq = 0;
    var impressions = client ? client.createImpressionTracker(opts.postEvent) : { track: function () {} };

    function hide() {
      requestSeq += 1;
      current = null;
      if (el) el.hidden = true;
    }

    function render(video) {
      if (!el) {
        ensureStyle(doc);
        el = buildEl(doc);
        el.querySelector('[data-role="close"]').addEventListener('click', hide);
        el.querySelector('[data-role="go"]').addEventListener('click', function () {
          if (!current) return;
          var video = current;
          opts.postEvent('reco_click', client.eventProps(video, 'next', 0));
          hide();
          opts.onOpen(video);
        });
      }
      current = video;
      el.querySelector('[data-role="reason"]').textContent = video.recommendationReason || '接着练下一个';
      el.querySelector('[data-role="title"]').textContent = video.title || ('视频 ' + video.id);
      el.querySelector('[data-role="meta"]').textContent = [video.levelName, formatMinutes(video.duration)]
        .filter(Boolean).join(' · ');
      el.classList.add('is-entering');
      el.hidden = false;
      // 下一帧移除,触发入场过渡
      (root.requestAnimationFrame || setTimeout)(function () { el.classList.remove('is-entering'); });
      impressions.track(video, 'next', 0);
    }

    function showAfter(afterId) {
      if (!client || afterId == null) return Promise.resolve(null);
      var seq = ++requestSeq;
      return client.fetchNextVideo({ apiBase: opts.apiBase || '', afterId: afterId, token: opts.getToken() })
        .then(function (video) {
          if (!video || seq !== requestSeq) return null;
          render(video);
          return video;
        });
    }

    return { showAfter: showAfter, hide: hide };
  }

  var api = { create: create, formatMinutes: formatMinutes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NextVideoSheet = api;
})(typeof self !== 'undefined' ? self : this);
