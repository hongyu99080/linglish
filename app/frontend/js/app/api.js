/**
 * API Client
 * Centralized API communication with error handling and token management
 */

import { API_BASE, state } from './state.js';

/**
 * 内联错误显示（当 GlobalUI 不可用时的降级方案）
 * @param {string} message - 错误消息
 * @param {Function} onConfirm - 确认按钮回调
 */
function showInlineError(message, onConfirm) {
  // 移除已存在的错误提示
  const existing = document.getElementById('inline-error-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'inline-error-modal';
  modal.innerHTML = `
    <div style="
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
    ">
      <div style="
        background: white;
        border-radius: 12px;
        padding: 24px;
        max-width: 320px;
        text-align: center;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      ">
        <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
        <p style="font-size: 15px; color: #333; margin: 0 0 20px 0; line-height: 1.5;">${message}</p>
        <button id="inline-error-btn" style="
          padding: 12px 32px;
          background: linear-gradient(135deg, #0f766e, #f97316);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
        ">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#inline-error-btn').onclick = () => {
    modal.remove();
    if (onConfirm) onConfirm();
  };
}

/**
 * Fetch wrapper with authentication and error handling
 * @param {string} path - API endpoint path
 * @param {Object} options - Fetch options
 * @param {Object} retryConfig - Retry configuration
 * @returns {Promise<any>} Response data
 * @throws {Error} If request fails
 */
export async function apiFetch(path, options = {}, retryConfig = {}) {
  const { showModalOnError = true, maxRetries = 0, currentRetry = 0 } = retryConfig;
  const headers = options.headers ? { ...options.headers } : {};
  headers['Content-Type'] = 'application/json';
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (networkError) {
    // 网络错误处理
    if (typeof GlobalUI !== 'undefined' && showModalOnError) {
      return new Promise((resolve, reject) => {
        GlobalUI.handleNetworkError(() => {
          // 重试
          apiFetch(path, options, { ...retryConfig, currentRetry: currentRetry + 1 })
            .then(resolve)
            .catch(reject);
        });
      });
    }
    throw networkError;
  }

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Friendly auth handling with modal
    if (response.status === 401) {
      const msg = (typeof i18n !== 'undefined') ? i18n.t('upload.login_expired') : '登录已过期，请重新登录';

      if (showModalOnError) {
        // 确保 GlobalUI 可用，否则创建简单的错误显示
        if (typeof GlobalUI !== 'undefined') {
          GlobalUI.handleAuthError(msg);
        } else {
          // 创建简单的内联错误提示（不使用 alert）
          showInlineError(msg, () => {
            try {
              localStorage.removeItem('linglish_token');
              sessionStorage.removeItem('linglish_token');
            } catch(_) {}
            window.location.href = './index.html';
          });
        }
        const error = new Error(msg);
        error.status = 401;
        error.handled = true;
        throw error;
      }
      const error = new Error(msg);
      error.status = 401;
      throw error;
    }

    if (response.status === 403) {
      const banned = String((data && data.message) || '').toUpperCase() === 'BANNED';
      const zh = banned ? '账户已封禁，请联系管理员' : '无权限访问';
      const en = banned ? 'Your account has been banned. Please contact support' : 'Forbidden';
      const msg = (typeof i18n !== 'undefined') ? (banned ? i18n.t('auth.banned') : 'Forbidden') : (navigator.language||'').toLowerCase().startsWith('en') ? en : zh;

      if (banned && showModalOnError) {
        if (typeof GlobalUI !== 'undefined') {
          GlobalUI.showErrorModal({
            icon: '🚫',
            title: '账户已封禁',
            message: msg,
            actionText: '确定',
            showCancel: false,
            onAction: () => {
              try {
                localStorage.removeItem('linglish_token');
                sessionStorage.removeItem('linglish_token');
              } catch(_) {}
              window.location.href = './index.html';
            }
          });
        } else {
          showInlineError(msg, () => {
            try {
              localStorage.removeItem('linglish_token');
              sessionStorage.removeItem('linglish_token');
            } catch(_) {}
            window.location.href = './index.html';
          });
        }
        const error = new Error(msg);
        error.status = 403;
        error.handled = true;
        throw error;
      }
      const error = new Error(msg);
      error.status = 403;
      throw error;
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 30;
      const zh = retryAfterSeconds
        ? `请求过于频繁，请 ${retryAfterSeconds} 秒后再试`
        : '请求过于频繁，请稍后再试';
      const en = retryAfterSeconds
        ? `Too many attempts. Please try again in ${retryAfterSeconds} seconds.`
        : 'Too many attempts. Please try again shortly.';
      const msg = data.message || ((navigator.language||'').toLowerCase().startsWith('en') ? en : zh);

      if (typeof GlobalUI !== 'undefined' && showModalOnError) {
        return new Promise((resolve, reject) => {
          GlobalUI.handleRateLimitError(retryAfterSeconds, () => {
            // 重试
            apiFetch(path, options, { ...retryConfig, currentRetry: currentRetry + 1 })
              .then(resolve)
              .catch(reject);
          });
        });
      }

      const error = new Error(msg);
      error.status = 429;
      if (!Number.isNaN(retryAfterSeconds)) {
        error.retryAfter = retryAfterSeconds;
      }
      throw error;
    }

    const error = new Error(data.message || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * Record an analytics event
 * @param {string} name - Event name
 * @param {Object} properties - Event properties
 */
export async function recordEvent(name, properties = {}) {
  if (!state.token) return;
  try {
    await apiFetch('/events', {
      method: 'POST',
      body: JSON.stringify({ event_name: name, properties }),
    });
  } catch (err) {
    console.warn('Failed to record event', err);
  }
}
