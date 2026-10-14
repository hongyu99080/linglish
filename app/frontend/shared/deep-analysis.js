/**
 * DeepAnalysis – shared module for AI deep word analysis
 * Used by: video-reader.html, mobile-power.html, and any future pages
 *
 * Exposes: window.DeepAnalysis.load(word, apiBase, getHeaders)  → Promise<data>
 *          window.DeepAnalysis.render(word, data)               → HTML string
 *          window.DeepAnalysis.renderLoading()                  → HTML string
 */
(function () {
  'use strict';

  // In-memory cache: word → parsed data
  const _cache = new Map();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function rootColor(lang) {
    const l = (lang || '').toLowerCase();
    if (l.includes('latin'))   return '#7c3aed';
    if (l.includes('greek'))   return '#2563eb';
    if (l.includes('french'))  return '#db2777';
    if (l.includes('germani') || l.includes('old english') || l.includes('proto')) return '#059669';
    if (l.includes('arabic'))  return '#d97706';
    return '#475569';
  }

  function renderLoading() {
    return `
      <div class="da-loading">
        <div class="da-shimmer" style="width:55%;height:26px;border-radius:10px;margin-bottom:.9rem;"></div>
        <div class="da-shimmer" style="width:90%;"></div>
        <div class="da-shimmer" style="width:75%;"></div>
        <div class="da-shimmer" style="width:85%;margin-bottom:.8rem;"></div>
        <div class="da-shimmer" style="width:100%;height:54px;border-radius:12px;margin-bottom:.8rem;"></div>
        <div class="da-shimmer" style="width:90%;"></div>
        <div class="da-shimmer" style="width:70%;"></div>
        <div class="da-loading-hint">✦ Ling宝正在解剖这个词...</div>
      </div>`;
  }

  function renderPaywall(paywall) {
    var data = paywall || {};
    var title = data.title || '今日额度已用完';
    var message = data.message || '升级会员可获得更高频训练额度。';
    var action = data.action_label || '查看会员方案';
    var href = data.upgrade_url || '/pricing.html?from=quota#plans';
    var hint = data.reset_hint || '';
    return `
      <div style="padding:1.5rem;text-align:center;border:1px solid rgba(15,118,110,.2);border-radius:14px;background:#f0fdfa;">
        <div style="font-weight:850;color:#0f766e;font-size:1rem;margin-bottom:.45rem;">${esc(title)}</div>
        <p style="color:#0f172a;font-size:.86rem;line-height:1.55;margin:0 0 .9rem;">${esc(message)}</p>
        ${hint ? `<div style="color:#64748b;font-size:.78rem;margin-bottom:1rem;">${esc(hint)}</div>` : ''}
        <a href="${esc(href)}" style="display:inline-flex;align-items:center;justify-content:center;padding:.55rem 1.1rem;border-radius:999px;background:#0f766e;color:#fff;font-size:.82rem;font-weight:800;text-decoration:none;">${esc(action)}</a>
      </div>`;
  }

  function normalizeMermaidCode(raw) {
    var code = String(raw || '');
    if (!code.trim()) return '';

    // Fix single-dash arrows -> to double-dash --> (AI sometimes generates invalid ->)
    code = code.replace(/(?<!-)->/g, '-->');
    // Strip diacritics so special chars (ō, é, ü …) don't break mermaid node IDs
    code = code.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Normalize ['...'] single-quoted labels -> ["..."] double-quoted
    code = code.replace(/\['([^']*(?:[\r\n][^']*)*?)'\]/g, function (_, inner) {
      return '["' + inner.replace(/"/g, '') + '"]';
    });
    // Flatten label newlines: literal \n and actual newlines -> · (middle dot)
    // <br/> is also normalized to · for full compatibility across mermaid versions
    code = code.replace(/\["([^"]*)"\]/g, function (_, inner) {
      var normalized = inner
        .replace(/\\n/g, '·')
        .replace(/\r?\n/g, '·')
        .replace(/<br\s*\/?>/gi, '·')
        .replace(/"/g, '');
      return '["' + normalized + '"]';
    });
    // Fix standalone 'label' bare node IDs -> n0["label"]
    var nodeMap = {}, nodeCount = 0;
    code = code.replace(/'([^']*)'/g, function (_, inner) {
      var key = inner
        .replace(/\\n/g, '·')
        .replace(/\r?\n/g, '·')
        .replace(/<br\s*\/?>/gi, '·')
        .replace(/"/g, '');
      if (!key.trim()) return "''";
      if (!nodeMap[key]) nodeMap[key] = 'n' + (nodeCount++);
      return nodeMap[key] + '["' + key + '"]';
    });
    // Keep only if it looks like a graph with arrows
    return /-->|->|==>|-\.->/.test(code) ? code : '';
  }

  // ── GPT-4 Dictionary (gpt4dict source) renderer — epub book style ──────────

  // Section icon mapping
  var _SECT_ICONS = [
    { k: ['例句', '例子'], v: '💬' },
    { k: ['词义', '词意', '分析词义', '词的意思'], v: '📖' },
    { k: ['词根'], v: '🌱' },
    { k: ['词缀'], v: '🔤' },
    { k: ['历史', '背景', '文化'], v: '📜' },
    { k: ['变形', '单词变形', '形式'], v: '🔄' },
    { k: ['记忆', '辅助'], v: '💡' },
    { k: ['故事'], v: '✨' },
  ];
  function _gdIcon(title) {
    for (var i = 0; i < _SECT_ICONS.length; i++) {
      var e = _SECT_ICONS[i];
      for (var j = 0; j < e.k.length; j++) {
        if (title.indexOf(e.k[j]) >= 0) return e.v;
      }
    }
    return '·';
  }
  function _gdIsEg(title) { return title.indexOf('例') >= 0; }

  // Parse "1. English sentence. （Chinese translation）" into parts
  function _gdParseEg(line) {
    var m = line.match(/^(\d+)\.\s+(.+)$/);
    if (!m) return null;
    var num = m[1], rest = m[2];
    var pm = rest.match(/^(.*?)\s*[（(]([^）)]+)[）)]\s*$/);
    if (pm) return { num: num, en: pm[1].replace(/\.\s*$/, '').trim(), zh: pm[2].trim() };
    var zi = rest.search(/[\u4e00-\u9fa5]/);
    if (zi > 2) return { num: num, en: rest.slice(0, zi).replace(/[（(]$/, '').trim(), zh: rest.slice(zi).replace(/[）)]$/, '').trim() };
    return { num: num, en: rest, zh: '' };
  }

  // Convert one section's markdown body → book-style HTML
  // isEg: true for example-sentence sections → render as cards with EN/ZH split
  function _gdBodyToHtml(text, isEg) {
    return text.split('\n').map(function (line) {
      line = line.trim();
      if (!line) return '';
      var escaped = esc(line);
      escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      if (/^\d+\.\s/.test(line)) {
        if (isEg) {
          var p = _gdParseEg(line);
          if (p) {
            var n = p.num.length < 2 ? '0' + p.num : p.num;
            return '<div class="da-bk-eg">' +
              '<span class="da-bk-eg-num">' + n + '</span>' +
              '<div class="da-bk-eg-en">' + esc(p.en) + '</div>' +
              (p.zh ? '<div class="da-bk-eg-zh">' + esc(p.zh) + '</div>' : '') +
              '</div>';
          }
        }
        return '<div class="da-bk-item">' + escaped + '</div>';
      }
      if (/^[-*]\s/.test(line))  return '<div class="da-bk-item">' + escaped.substring(2) + '</div>';
      return '<div class="da-bk-para">' + escaped + '</div>';
    }).filter(Boolean).join('');
  }

  // Parse ## / ### sections from markdown content
  function _gdParseSections(content) {
    var sections = [];
    var lines = content.split('\n');
    var curTitle = null, curLines = [];
    for (var li = 0; li < lines.length; li++) {
      var ln = lines[li];
      var hm = ln.match(/^#{2,3}\s+(.+)/);
      if (hm) {
        if (curTitle !== null && curLines.join('').trim()) {
          sections.push({ title: curTitle, body: curLines.join('\n').trim() });
        }
        curTitle = hm[1].trim();
        curLines = [];
      } else if (curTitle !== null) {
        curLines.push(ln);
      }
    }
    if (curTitle !== null && curLines.join('').trim()) {
      sections.push({ title: curTitle, body: curLines.join('\n').trim() });
    }
    return sections;
  }

  function renderGpt4Dict(word, d) {
    var content = d.content_md || '';

    if (!content) {
      return '<div class="da-bk-wrap">' +
        '<div class="da-bk-title">' + esc(word) + '</div>' +
        '<div class="da-bk-para" style="color:rgba(255,255,255,.4);">暂无内容</div>' +
        '</div>';
    }

    var sections = _gdParseSections(content);

    // If no section headers found, render whole content as one block
    if (!sections.length) {
      return '<div class="da-bk-wrap">' +
        '<div class="da-bk-title">' + esc(word) + '</div>' +
        '<div class="da-bk-body">' + _gdBodyToHtml(content) + '</div>' +
        '</div>';
    }

    var sectionsHTML = sections.map(function (s) {
      var icon = _gdIcon(s.title);
      var isEg = _gdIsEg(s.title);
      return '<div class="da-bk-section">' +
        '<div class="da-bk-section-title"><span class="da-bk-section-icon">' + icon + '</span>' + esc(s.title) + '</div>' +
        '<div class="da-bk-body">' + _gdBodyToHtml(s.body, isEg) + '</div>' +
        '</div>';
    }).join('');

    return '<div class="da-bk-wrap">' +
      '<div class="da-bk-header">' +
        '<div class="da-bk-title">' + esc(word) + '</div>' +
        '<div class="da-bk-badge">GPT 词典</div>' +
      '</div>' +
      '<div class="da-bk-content">' + sectionsHTML + '</div>' +
      '</div>';
  }

  // ─────────────────────────────────────────────────────────────────────────

  function render(word, d) {
    // Route to GPT-4 dict renderer when data comes from DictionaryByGPT4.
    // Check both source field AND content_md as fallback (in case source is lost in transit).
    if (d && (d.source === 'gpt4dict' || d.content_md)) return renderGpt4Dict(word, d);

    const etym    = d.etymology   || {};
    const roots   = Array.isArray(etym.roots)    ? etym.roots    : [];
    const cogs    = Array.isArray(etym.cognates) ? etym.cognates : [];
    const coreImg = d.core_image  || {};
    const comps   = Array.isArray(d.comparisons) ? d.comparisons : [];
    const mermaidCode = d.mermaid || '';
    const parts   = (d.philosophy || '').split('\n');
    const philoEN = parts[0] || '';
    const philoZH = parts[1] || '';

    // DNA formula chips
    const dnaHTML = roots.length ? `
      <div class="da-dna">
        ${roots.map(function (r, i) {
          return (i > 0 ? '<span class="da-plus">+</span>' : '') +
            `<div class="da-chip" style="background:${rootColor(r.lang)};" title="${esc(r.meaning || '')}">
               ${esc(r.root || '')}
               <small>${esc(r.lang || '')}</small>
             </div>`;
        }).join('')}
        ${roots.length ? `<span class="da-arrow">→</span><span class="da-result">${esc(word)}</span>` : ''}
      </div>` : '';

    // Cognate pills
    const cogHTML = cogs.length
      ? `<div class="da-cognates">${cogs.map(function (c) { return `<span class="da-cognate">${esc(c)}</span>`; }).join('')}</div>`
      : '';

    // Confusable cards
    const cfHTML = comps.map(function (c) {
      return `
        <div class="da-cf-card">
          <div class="da-cf-head">
            <span class="da-cf-word">${esc(c.word || '')}</span>
            <span class="da-cf-vs">vs ${esc(word)}</span>
          </div>
          <div class="da-cf-body">
            <div class="da-cf-col">
              <div class="da-cf-label da-cf-sim">✓ 相同</div>
              ${esc(c.similarity || '')}
            </div>
            <div class="da-cf-col">
              <div class="da-cf-label da-cf-diff">✕ 区别</div>
              ${esc(c.difference || '')}
            </div>
          </div>
        </div>`;
    }).join('');

    // Mermaid section (render async via global mermaid if available)
    const mermaidSection = mermaidCode ? `
      <div class="da-section">
        <div class="da-section-label"><span>🌳</span> 词根扩散图</div>
        <div class="da-mermaid-wrap"><div class="da-mermaid-src">${esc(mermaidCode)}</div></div>
      </div>` : `
      <div class="da-section">
        <div class="da-section-label"><span>🌳</span> 词根扩散图</div>
        <div style="font-size:.78rem;color:#94a3b8;padding:.3rem 0;">该词暂无词根扩散图</div>
      </div>`;

    return `
      <div class="da-card">
        <!-- Hero -->
        <div class="da-hero">
          <div class="da-hero-word">${esc(word)}</div>
          <div class="da-hero-badge">✦ AI 深度解析</div>
        </div>

        <!-- 词源 DNA -->
        <div class="da-section">
          <div class="da-section-label"><span>🧬</span> 词源 DNA</div>
          ${dnaHTML}
          ${cogs.length ? `<div class="da-cog-label">同根词族</div>${cogHTML}` : ''}
          ${etym.evolution ? `<div class="da-evolution">${esc(etym.evolution)}</div>` : ''}
        </div>

        <!-- 记忆锚点 -->
        ${(coreImg.formula || coreImg.metaphor) ? `
        <div class="da-section">
          <div class="da-section-label"><span>💡</span> 记忆锚点</div>
          <div class="da-anchor">
            ${coreImg.formula  ? `<div class="da-anchor-formula">${esc(coreImg.formula)}</div>`  : ''}
            ${coreImg.metaphor ? `<div class="da-anchor-meta">${esc(coreImg.metaphor)}</div>` : ''}
          </div>
        </div>` : ''}

        <!-- 易混词 -->
        ${comps.length ? `
        <div class="da-section">
          <div class="da-section-label"><span>⚖️</span> 易混词对比</div>
          <div class="da-cf-list">${cfHTML}</div>
        </div>` : ''}

        <!-- 词根扩散图 -->
        ${mermaidSection}

        <!-- 哲学金句 -->
        ${philoEN ? `
        <div class="da-section">
          <div class="da-section-label"><span>🔮</span> 哲学金句</div>
          <div class="da-quote">
            <div class="da-quote-en">${esc(philoEN)}</div>
            ${philoZH ? `<div class="da-quote-zh">${esc(philoZH)}</div>` : ''}
          </div>
        </div>` : ''}
      </div>`;
  }

  async function load(word, apiBase, getHeaders, opts) {
    const key = (word || '').toLowerCase().trim();
    const refresh = !!(opts && opts.refresh);
    if (refresh) _cache.delete(key); // clear stale JS cache on force refresh
    if (!refresh && _cache.has(key)) return _cache.get(key);

    const base = apiBase || window.API_BASE || '';
    const hdrs = (typeof getHeaders === 'function') ? getHeaders() : { 'Content-Type': 'application/json' };
    const qs = refresh ? '?refresh=1' : '';

    const res = await fetch(`${base}/api/word/deep/${encodeURIComponent(key)}${qs}`, { headers: hdrs });
    if (!res.ok) {
      const errorData = await res.json().catch(async function () {
        const txt = await res.text().catch(function () { return String(res.status); });
        return { message: txt };
      });
      if (res.status === 402 && errorData.code === 'WORD_DEEP_DAILY_LIMIT_REACHED') {
        const quota = errorData.quota || {};
        const tier = String(quota.tier || 'free').toLowerCase();
        const paywall = errorData.paywall || null;
        const message = paywall?.message || (tier === 'free'
          ? `今日免费深度解析 ${quota.limit || 0} 次已用完，升级会员可继续生成。`
          : '今日深度解析生成额度已用完，明天会自动恢复。');
        const err = new Error(message);
        err.code = errorData.code;
        err.quota = quota;
        err.paywall = paywall;
        throw err;
      }
      throw new Error(errorData.message || String(res.status));
    }
    const json = await res.json();
    const data = json.data || json;
    _cache.set(key, data);
    return data;
  }

  // Try to render mermaid inside a container after content is shown.
  // Uses rAF + 80ms delay so the container is fully painted before mermaid queries the DOM.
  function tryRenderMermaid(container) {
    if (!container) return;
    requestAnimationFrame(function () {
      setTimeout(function () {
        var srcEl = container.querySelector('.da-mermaid-src');
        if (!srcEl) return;
        var code = normalizeMermaidCode(srcEl.textContent || '');
        // If code is not a real graph, show fallback text instead of hiding the section
        if (!code) {
          var fallbackWrap = srcEl.closest('.da-mermaid-wrap') || srcEl;
          fallbackWrap.innerHTML = '<div style="font-size:.78rem;color:#94a3b8;padding:.3rem 0;">词根扩散图数据异常，暂无法渲染</div>';
          return;
        }
        try {
          if (typeof mermaid === 'undefined') return;
          if (!window._dasMermaidInited) {
            mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
            window._dasMermaidInited = true;
          }
          var id = 'da-mermaid-' + Date.now();
          mermaid.render(id, code).then(function (result) {
            var wrap = srcEl.closest('.da-mermaid-wrap') || srcEl;
            // Insert SVG then strip any surviving single-quotes from text nodes
            var tmp = document.createElement('div');
            tmp.innerHTML = result.svg;
            tmp.querySelectorAll('text, tspan').forEach(function (el) {
              if (!el.children.length) {
                el.textContent = el.textContent
                  .replace(/^'+|'+$/g, '')
                  .replace(/\\n/g, ' ');
              }
            });
            wrap.innerHTML = tmp.innerHTML;
          }).catch(function () {
            // Rendering failed — hide raw mermaid, show placeholder
            var section = srcEl.closest('.da-section');
            if (section) section.querySelector('.da-mermaid-wrap').innerHTML =
              '<div style="font-size:.78rem;color:#94a3b8;padding:.3rem 0;">词根扩散图加载失败</div>';
          });
        } catch (_) {}
      }, 80);
    });
  }

  window.DeepAnalysis = {
    load: load,
    render: render,
    renderLoading: renderLoading,
    renderPaywall: renderPaywall,
    tryRenderMermaid: tryRenderMermaid,
  };
  console.log('[DeepAnalysis] module loaded');
})();
