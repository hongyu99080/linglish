(function(){
  if (typeof window === 'undefined') return;
  try { console.log('[DictRender] v2025-12-14-BILINGUAL-v3 loaded'); } catch(_) {}
  function esc(s){ return String(s==null?'':s).replace(/[&<>\"']/g, function(m){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]; }); }
  function extractPhon(entry){
    if (!entry) return '';
    let p = entry.phonetic || '';
    if ((!p || !p.trim()) && Array.isArray(entry.phonetics)){
      const x = entry.phonetics.find(function(v){ return v && (v.text||v.phonetic); });
      p = ((x && x.text) || (x && x.phonetic) || '').trim();
    }
    return p || '';
  }
  function buildDefs(entry, langMode, wordLemma){
    // langMode: 'zh' = bilingual (EN + ZH), 'en' = English only, undefined/null = bilingual (default)
    // wordLemma: the word being looked up (needed for translate button)
    let html = '';
    if (!entry || !Array.isArray(entry.meanings)) return html;
    const showEn = true; // Always show English definitions
    const showZh = !langMode || langMode === 'zh'; // Show Chinese only in 'zh' mode or default

    // 收集所有定义
    entry.meanings.slice(0,4).forEach(function(m, mIdx){
      (m.definitions||[]).slice(0,3).forEach(function(d, dIdx){
        // 词性标签
        const pos = m.partOfSpeech ? `<span style="display:inline-block;font-weight:700;color:#2563eb;background:#dbeafe;padding:.15rem .5rem;border-radius:4px;font-size:.85rem;margin-right:.6rem;">${esc(m.partOfSpeech)}</span>` : '';

        // 英文定义
        const defEn = showEn ? `<div style="color:#1e293b;font-size:1rem;line-height:1.7;margin-bottom:.3rem;">${esc(d.definition||'')}</div>` : '';

        // 中文翻译（如果有且包含中文字符，排除占位符）
        const isPlaceholder = d.zh && (d.zh === '翻译中...' || d.zh === '[待翻译]');
        const hasChinese = d.zh && /[\u4e00-\u9fa5]/.test(d.zh) && !isPlaceholder;
        let defZh = '';
        if (showZh) {
          if (hasChinese && d.zh.trim()) {
            // Has valid translation - show it
            defZh = `<div style="color:#64748b;font-size:.95rem;line-height:1.6;padding-left:.5rem;border-left:3px solid #e2e8f0;margin-top:.3rem;">${esc(d.zh)}</div>`;
          } else if (d.definition) {
            // No translation - show translate button
            defZh = `<button class="dict-translate-btn" data-word="${esc(wordLemma||'')}" data-m-idx="${mIdx}" data-d-idx="${dIdx}" data-text="${esc(d.definition)}" data-type="definition" style="margin-top:.3rem;display:inline-flex;align-items:center;gap:.3rem;border:1px solid #cbd5e1;background:#f8fafc;color:#475569;cursor:pointer;font-size:.85rem;padding:.3rem .6rem;border-radius:4px;transition:all .2s;-webkit-tap-highlight-color:transparent;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>翻译</button>`;
          }
        }

        // 定义行：喇叭 + 内容（词性 + 英文定义 + 中文翻译）
        const defLine = `<div style="display:flex;align-items:flex-start;gap:.6rem;margin-bottom:1rem;background:#f8fafc;padding:.8rem;border-radius:8px;"><button class="dict-def-speak" data-text="${esc(d.definition||'')}" style="display:inline-flex;align-items:center;justify-content:center;border:none;background:#fff;cursor:pointer;font-size:1rem;padding:.4rem;opacity:.75;transition:all .2s;flex-shrink:0;width:2rem;height:2rem;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.1);-webkit-tap-highlight-color:transparent;">🔊</button><div style="flex:1;">${pos}${defEn}${defZh}</div></div>`;

        // 例句处理
        let examplesHtml = '';
        if (d.example) {
          const exEn = showEn ? `<div style="color:#475569;font-size:.9rem;line-height:1.6;font-style:italic;margin-bottom:.25rem;">&quot;${esc(d.example)}&quot;</div>` : '';

          // 例句中文翻译（如果有且包含中文字符，排除占位符）
          const isPlaceholderEx = d.exampleZh && (d.exampleZh === '翻译中...' || d.exampleZh === '[待翻译]');
          const hasChineseEx = d.exampleZh && /[\u4e00-\u9fa5]/.test(d.exampleZh) && !isPlaceholderEx;
          let exZh = '';
          if (showZh) {
            if (hasChineseEx && d.exampleZh.trim()) {
              // Has valid translation
              exZh = `<div style="color:#64748b;font-size:.85rem;line-height:1.5;padding-left:.5rem;border-left:3px solid #e2e8f0;margin-top:.3rem;">${esc(d.exampleZh)}</div>`;
            } else {
              // No translation or placeholder - show translate button
              exZh = `<button class="dict-translate-btn" data-word="${esc(wordLemma||'')}" data-m-idx="${mIdx}" data-d-idx="${dIdx}" data-text="${esc(d.example)}" data-type="example" style="margin-top:.3rem;display:inline-flex;align-items:center;gap:.3rem;border:1px solid #cbd5e1;background:#f8fafc;color:#475569;cursor:pointer;font-size:.85rem;padding:.3rem .6rem;border-radius:4px;transition:all .2s;-webkit-tap-highlight-color:transparent;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>翻译</button>`;
            }
          }

          examplesHtml = `<div style="display:flex;align-items:flex-start;gap:.6rem;margin-bottom:1rem;background:#fafbfc;padding:.6rem .8rem;border-radius:6px;border-left:3px solid #e2e8f0;"><button class="dict-def-speak" data-text="${esc(d.example||'')}" style="display:inline-flex;align-items:center;justify-content:center;border:none;background:#fff;cursor:pointer;font-size:.9rem;padding:.3rem;opacity:.7;transition:all .2s;flex-shrink:0;width:1.8rem;height:1.8rem;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.05);-webkit-tap-highlight-color:transparent;">🔊</button><div style="flex:1;">${exEn}${exZh}</div></div>`;
        }

        // 支持多个例句（如果有 examples 数组）
        if (Array.isArray(d.examples) && d.examples.length > 0) {
          d.examples.slice(0, 2).forEach(function(ex, exIdx){
            if (!ex || !ex.trim()) return;
            const exEn = showEn ? `<div style="color:#475569;font-size:.9rem;line-height:1.6;font-style:italic;margin-bottom:.25rem;">&quot;${esc(ex)}&quot;</div>` : '';

            // 获取对应的中文翻译（且包含中文字符）
            const zhTranslation = (Array.isArray(d.examplesZh) && d.examplesZh[exIdx]) ? d.examplesZh[exIdx] : '';
            const hasChineseExArr = zhTranslation && /[\u4e00-\u9fa5]/.test(zhTranslation);
            const exZh = (showZh && hasChineseExArr && zhTranslation.trim()) ? `<div style="color:#64748b;font-size:.85rem;line-height:1.5;padding-left:.5rem;border-left:3px solid #e2e8f0;margin-top:.3rem;">${esc(zhTranslation)}</div>` : '';

            examplesHtml += `<div style="display:flex;align-items:flex-start;gap:.6rem;margin-bottom:1rem;background:#fafbfc;padding:.6rem .8rem;border-radius:6px;border-left:3px solid #e2e8f0;"><button class="dict-def-speak" data-text="${esc(ex)}" style="display:inline-flex;align-items:center;justify-content:center;border:none;background:#fff;cursor:pointer;font-size:.9rem;padding:.3rem;opacity:.7;transition:all .2s;flex-shrink:0;width:1.8rem;height:1.8rem;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.05);-webkit-tap-highlight-color:transparent;">🔊</button><div style="flex:1;">${exEn}${exZh}</div></div>`;
          });
        }

        html += `${defLine}${examplesHtml}`;
      });
    });
    return html || '<div style="color:#94a3b8;text-align:center;padding:1rem;">No definition available</div>';
  }
  function build(lemma, entry, zh, opts){
    const ipa = extractPhon(entry);
    const langMode = (opts && opts.langMode) ? opts.langMode : null;
    const defs = buildDefs(entry, langMode, lemma);
    const speak = !opts || opts.speak !== false;
    const audioUrl = (opts && opts.audioUrl) ? String(opts.audioUrl) : '';
    const statusTxt = (opts && opts.statusText) ? String(opts.statusText) : '';
    const statusClass = (opts && opts.statusClass) ? String(opts.statusClass) : '';
    // 小喇叭按钮（和定义、例句的喇叭一样大小）
    const speakBtn = speak ? `<button class="dict-speak-btn" data-word="${esc(lemma)}" data-audio="${audioUrl}" style="border:none;background:transparent;cursor:pointer;font-size:1rem;padding:.2rem;opacity:.75;transition:all .2s;-webkit-tap-highlight-color:transparent;">🔊</button>` : '';

    // 标题+状态徽标
    const leftGroup = `${speakBtn}<h2 style=\"margin:0;font-size:1.8rem;font-weight:700;color:#0f172a;\">${esc(lemma)}</h2>`;
    const badge = statusTxt ? `<span class=\"dict-status ${esc(statusClass)}\" style=\"margin-left:.5rem;\">${esc(statusTxt)}</span>` : '';
    const titleRow = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem;gap:.6rem;">
        <div style="display:flex;align-items:center;gap:.6rem;">${leftGroup}</div>
        ${badge}
      </div>`;

    // 音标和中文翻译在同一行（EN 模式隐藏中文）
    const showZh = !langMode || langMode === 'zh';
    const metaLine = (ipa || (showZh && zh)) ? `<div style="color:#64748b;font-size:1rem;margin-bottom:1rem;">${ipa ? `<span style="font-style:italic;margin-right:.8rem;">${esc(ipa)}</span>` : ''}${(showZh && zh) ? `<span>${esc(zh)}</span>` : ''}</div>` : '';

    // 无"加入学习"按钮：进入查词即自动加入（由上层逻辑处理）
    return `
      <div class="dict-card" style="background:white;">
        ${titleRow}
        ${metaLine}
        <div class="dict-defs" style="margin-top:.8rem;">${defs}</div>
      </div>`;
  }
  window.DictionaryRender = { build, extractPhon };
})();
