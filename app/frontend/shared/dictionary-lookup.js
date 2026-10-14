/**
 * 统一的字典查词模块
 * 用于所有查词场景：视频页面、词汇表、移动端、桌面端
 *
 * 查词逻辑：
 * 1. 调用统一的 /dictionary/:word API 获取英文定义、例句和单词级别的中文翻译
 * 2. API 立即返回（后端不等待定义和例句的翻译完成）
 * 3. 立即渲染，定义和例句的中文翻译通过"翻译"按钮触发
 */

(function() {
  'use strict';

  // API base URL
  const API_BASE = window.API_BASE || '';

  /**
   * 获取请求头（包含auth token）
   */
  function getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };

    // 尝试从多个地方获取token
    let token = null;
    try {
      if (window.DictionaryUtil && typeof window.DictionaryUtil.resolveToken === 'function') {
        token = window.DictionaryUtil.resolveToken();
      } else {
        token = localStorage.getItem('linglish_token') ||
                localStorage.getItem('authToken') ||
                sessionStorage.getItem('linglish_token') ||
                sessionStorage.getItem('authToken') ||
                localStorage.getItem('auth_token') ||
                sessionStorage.getItem('token');
      }
    } catch (_) {}

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  /**
   * 统一的查词函数
   * @param {string} word - 要查询的单词
   * @param {Object} options - 选项
   * @param {Function} options.onLoading - 加载中回调
   * @param {Function} options.onSuccess - 成功回调 (entry, wordTranslation)
   * @param {Function} options.onError - 错误回调
   * @returns {Promise<{entry, wordTranslation}>}
   */
  async function lookupWord(word, options = {}) {
    const {
      onLoading,
      onSuccess,
      onError
    } = options;

    if (!word || typeof word !== 'string') {
      const error = new Error('Invalid word');
      if (onError) onError(error);
      throw error;
    }

    // Normalize: lower-case and trim, and strip leading/trailing punctuation for robustness
    // e.g. "school." -> "school", "\"word\"" -> "word"
    const normalizedWord = word
      .trim()
      .toLowerCase()
      .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');

    try {
      // 触发加载回调
      if (onLoading) {
        onLoading(normalizedWord);
      }

      // 调用统一的 dictionary API（包含 entry 和单词翻译）
      const dictResponse = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(normalizedWord)}`, {
        headers: getHeaders()
      });

      // 解析响应
      let entry = null;
      let wordTranslation = '';

      if (dictResponse.ok) {
        const dictData = await dictResponse.json();
        entry = dictData?.entry || null;
        wordTranslation = dictData?.zh || ''; // 单词翻译从 dictionary API 获取
      } else if (dictResponse.status === 404) {
        // Not found is a valid outcome (typo / rare word). Return empty entry for UI to handle.
        entry = null;
        wordTranslation = '';
      } else {
        throw new Error(`Dictionary lookup failed: ${dictResponse.status}`);
      }

      // 成功回调
      const result = { entry, wordTranslation };
      if (onSuccess) {
        onSuccess(entry, wordTranslation);
      }

      return result;
    } catch (error) {
      console.error('[DictionaryLookup] Lookup failed:', error);
      if (onError) {
        onError(error);
      }
      throw error;
    }
  }

  /**
   * 翻译单个定义或例句
   * @param {string} word - 单词
   * @param {number} meaningIndex - 定义组索引
   * @param {number} definitionIndex - 定义索引
   * @param {string} text - 要翻译的文本
   * @param {string} type - 类型：'definition' 或 'example'
   * @returns {Promise<string>} 翻译结果
   */
  async function translateDefinition(word, meaningIndex, definitionIndex, text, type = 'definition') {
    try {
      const response = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}/translate-definition`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          meaningIndex,
          definitionIndex,
          text,
          type
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Translation failed: ${response.status}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Translation failed');
      }

      return data.translation;
    } catch (error) {
      console.error('[DictionaryLookup] Translate definition failed:', error);
      throw error;
    }
  }

  /**
   * 为容器中的所有"翻译"按钮绑定点击事件
   * @param {HTMLElement} container - 包含翻译按钮的容器
   * @param {string} word - 当前查询的单词
   * @param {Function} stopPolling - 可选，成功翻译后停止轮询的函数
   */
  function attachTranslateButtonHandlers(container, word, stopPolling) {
    if (!container) return;

    const translateButtons = container.querySelectorAll('.dict-translate-btn');

    translateButtons.forEach(btn => {
      // 避免重复绑定
      if (btn.dataset.handlerAttached) return;
      btn.dataset.handlerAttached = 'true';

      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const mIdx = parseInt(btn.dataset.mIdx);
        const dIdx = parseInt(btn.dataset.dIdx);
        const text = btn.dataset.text;
        const type = btn.dataset.type || 'definition';

        if (!text || isNaN(mIdx) || isNaN(dIdx)) {
          console.error('[DictionaryLookup] Invalid translate button data');
          return;
        }

        // 立即停止轮询（避免轮询重新渲染导致按钮引用失效）
        if (typeof stopPolling === 'function') {
          console.log('[DictionaryLookup] Stopping polling before translation');
          stopPolling();
        }

        // 保存原始内容
        const originalHTML = btn.innerHTML;

        // 显示加载状态
        btn.disabled = true;
        btn.innerHTML = '<span style="opacity:0.5;">翻译中...</span>';
        btn.style.cursor = 'wait';

        try {
          // 调用翻译API
          const translation = await translateDefinition(word, mIdx, dIdx, text, type);

          // 替换按钮为翻译结果
          const translationDiv = document.createElement('div');
          translationDiv.style.cssText = 'color:#64748b;font-size:.95rem;line-height:1.6;padding-left:.5rem;border-left:3px solid #e2e8f0;margin-top:.3rem;';
          translationDiv.textContent = translation;

          // 确保按钮仍在 DOM 中再替换
          if (btn.parentNode) {
            btn.parentNode.replaceChild(translationDiv, btn);
          }
        } catch (error) {
          // 显示错误信息
          btn.disabled = false;
          btn.style.cursor = 'pointer';

          const errorMessage = error.message || '翻译失败';
          btn.innerHTML = `<span style="color:#ef4444;">${errorMessage}</span>`;

          // 5秒后恢复原始按钮
          setTimeout(() => {
            if (btn.parentNode) {
              btn.innerHTML = originalHTML;
            }
          }, 5000);
        }
      });
    });
  }

  /**
   * 轮询检查翻译是否完成（用于后台异步翻译场景）
   * @param {string} word - 单词
   * @param {Function} onUpdate - 更新回调 (newEntry) => void
   * @param {Object} options - 选项
   * @param {number} options.maxAttempts - 最大轮询次数（默认10次）
   * @param {number} options.interval - 轮询间隔毫秒（默认2000ms）
   * @returns {Function} 停止轮询的函数
   */
  function pollForTranslations(word, onUpdate, options = {}) {
    const maxAttempts = options.maxAttempts || 10;
    const interval = options.interval || 2000;
    const initialEntry = options.initialEntry || null;
    const initialZh = options.initialZh || '';

    let attempts = 0;
    let timerId = null;
    let stopped = false;
    let lastSignature = null;

    function isRealChineseTranslation(zhText, enText) {
      if (!zhText || zhText === '[待翻译]') return false;
      const zh = String(zhText || '').trim();
      if (!zh) return false;
      // Treat placeholders as not translated
      if (/翻译中/.test(zh)) return false;
      // Must contain Chinese characters
      if (!/[\u4e00-\u9fa5]/.test(zh)) return false;
      // Should not be identical to English text (case-insensitive)
      if (enText && zh.toLowerCase() === String(enText).trim().toLowerCase()) return false;
      return true;
    }

    function computeSignature(entry, zh) {
      if (!entry) return `no-entry|${String(zh || '')}`;
      const parts = [String(zh || '')];
      const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
      for (const meaning of meanings) {
        const defs = Array.isArray(meaning.definitions) ? meaning.definitions : [];
        for (const def of defs) {
          parts.push(String(def.zh || ''));
          parts.push(String(def.exampleZh || ''));
        }
      }
      return parts.join('\u0001');
    }

    // 检查 entry 是否所有定义都有翻译
    function hasAllTranslations(entry) {
      if (!entry || !entry.meanings) return true;

      for (const meaning of entry.meanings) {
        if (!meaning.definitions) continue;
        for (const def of meaning.definitions) {
          // 检查定义翻译
          if (!isRealChineseTranslation(def.zh, def.definition)) {
            return false;
          }
          // 检查例句翻译
          if (def.example && !isRealChineseTranslation(def.exampleZh, def.example)) {
            return false;
          }
        }
      }
      return true;
    }

    async function poll() {
      if (stopped) return;

      attempts++;
      console.log(`[DictionaryLookup] Polling for translations: ${word} (attempt ${attempts}/${maxAttempts})`);

      try {
        const response = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, {
          headers: getHeaders()
        });

        if (!response.ok) {
          console.warn(`[DictionaryLookup] Poll failed with status ${response.status}`);
          scheduleNext();
          return;
        }

        const data = await response.json();
        const entry = data?.entry || null;
        const zh = data?.zh || '';

        if (!entry) {
          console.warn('[DictionaryLookup] Poll returned no entry');
          scheduleNext();
          return;
        }

        const sig = computeSignature(entry, zh);
        if (sig !== lastSignature) {
          lastSignature = sig;
          // 通知更新（仅在内容变化时，避免频繁重渲染导致页面抖动）
          if (onUpdate) onUpdate(entry, zh);
        }

        // 检查是否所有翻译都完成
        if (hasAllTranslations(entry)) {
          console.log(`[DictionaryLookup] All translations completed for: ${word}`);
          stop();
          return;
        }

        scheduleNext();
      } catch (error) {
        console.error('[DictionaryLookup] Poll error:', error);
        scheduleNext();
      }
    }

    function scheduleNext() {
      if (stopped || attempts >= maxAttempts) {
        console.log(`[DictionaryLookup] Polling stopped for: ${word} (attempts: ${attempts})`);
        stop();
        return;
      }

      timerId = setTimeout(poll, interval);
    }

    function stop() {
      stopped = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    }

    // 启动第一次轮询
    lastSignature = computeSignature(initialEntry, initialZh);
    poll();

    // 返回停止函数
    return stop;
  }

  // 导出到全局
  window.DictionaryLookup = {
    lookupWord,
    translateDefinition,
    attachTranslateButtonHandlers,
    pollForTranslations
  };

  console.log('[DictionaryLookup] Module loaded');
})();
