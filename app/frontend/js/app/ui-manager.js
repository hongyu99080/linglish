/**
 * UI Manager Module
 * Handles DOM manipulation, UI updates, and user interface interactions
 */

import { state } from './state.js';
import { apiFetch } from './api.js';

/**
 * Display a toast notification
 * @param {string} message - Message to display
 * @param {string} type - Toast type: 'info', 'success', 'warning', 'error'
 */
export function showToast(message, type = 'info') {
  // 优先使用 GlobalUI 的增强版 toast
  if (typeof GlobalUI !== 'undefined' && GlobalUI.showToast) {
    GlobalUI.showToast(message, type);
    return;
  }

  // 降级到原来的 toast
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

/**
 * Toggle visibility of authentication and app shells
 * @param {boolean} isAuthenticated - Whether user is authenticated
 */
export function toggleAppShell(isAuthenticated) {
  const authSection = document.getElementById('auth-section');
  const appSection = document.getElementById('app-section');
  const userInfo = document.getElementById('user-info');
  const guestActions = document.getElementById('guest-actions');
  const userEmailDisplay = document.getElementById('user-email');

  if (authSection) {
    authSection.hidden = isAuthenticated;
    if (isAuthenticated) {
      authSection.style.display = 'none';
    } else {
      authSection.style.removeProperty('display');
    }
    authSection.setAttribute('aria-hidden', isAuthenticated ? 'true' : 'false');
  }

  if (appSection) {
    appSection.hidden = !isAuthenticated;
    if (isAuthenticated) {
      appSection.style.removeProperty('display');
    } else {
      appSection.style.display = 'none';
    }
    appSection.setAttribute('aria-hidden', !isAuthenticated ? 'true' : 'false');
  }

  if (guestActions) {
    guestActions.hidden = isAuthenticated;
    if (isAuthenticated) {
      guestActions.style.display = 'none';
    } else {
      guestActions.style.removeProperty('display');
    }
    guestActions.setAttribute('aria-hidden', isAuthenticated ? 'true' : 'false');
  }

  if (userInfo) {
    userInfo.hidden = !isAuthenticated;
    if (isAuthenticated) {
      userInfo.style.removeProperty('display');
    } else {
      userInfo.style.display = 'none';
    }
    userInfo.setAttribute('aria-hidden', !isAuthenticated ? 'true' : 'false');
  }

  if (!isAuthenticated) {
    // Clear both old email display and new display name
    if (userEmailDisplay) {
      userEmailDisplay.textContent = '';
    }
    const userDisplayNameEl = document.getElementById('user-display-name');
    if (userDisplayNameEl) {
      userDisplayNameEl.textContent = '';
    }
  }

  // 切换可见性后重新应用翻译，避免某些节点在初次隐藏状态下未被正确更新
  try {
    if (typeof i18n !== 'undefined' && i18n && typeof i18n.updatePage === 'function') {
      i18n.updatePage();
    }
  } catch (_) {}
}

/**
 * Load and display recent content
 */
export async function loadRecentContent() {
  try {
    const videosResponse = await apiFetch('/video-resources?lite=1&limit=12').catch(() => ({ items: [] }));
    const videos = (videosResponse && videosResponse.items) || [];
    const allContent = videos.map(v => ({ ...v, type: 'video', icon: '🎬' })).slice(0, 12);

    const contentGrid = document.getElementById('recent-content');

    if (!contentGrid) {
      return;
    }

    if (allContent.length === 0) {
      contentGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 4rem; margin-bottom: 1rem;">📚</div>
          <p style="font-size: 1.3rem; color: var(--text-primary); margin: 0 0 0.5rem 0; font-weight: 600;">还没有学习内容</p>
          <p style="color: var(--text-secondary); margin: 0 0 2rem 0;">上传你的第一个视频，开启沉浸式学习之旅</p>
          <a href="./video-upload.html" style="display: inline-block; padding: 1rem 2rem; background: linear-gradient(135deg, var(--brand), var(--accent)); color: white; text-decoration: none; border-radius: 10px; font-weight: 600; box-shadow: 0 5px 20px rgba(99, 102, 241, 0.3); transition: all 0.3s ease;">📤 上传视频</a>
        </div>
      `;
      return;
    }

    const getVideoProgress = (videoId) => {
      try {
        const raw = localStorage.getItem(`video_progress_${videoId}`);
        const val = Number(raw);
        if (Number.isFinite(val) && val >= 0) {
          return Math.min(100, Math.max(0, Math.round(val)));
        }
      } catch (_) {}
      return 0;
    };

    const currentUserId = state.user && state.user.id;

    contentGrid.innerHTML = allContent.map(item => {
      const url = (item.type === 'video' && item.id)
        ? `./video-reader.html?videoId=${encodeURIComponent(String(item.id))}`
        : './video-reader.html';
      const prog = getVideoProgress(item.id);
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;

      // Only show edit/delete actions if user is the owner
      // Use loose equality to handle number/string type differences
      const isOwner = currentUserId && item.uploader_id && String(item.uploader_id) === String(currentUserId);
      const actionsMarkup = item.type === 'video' && item.id && isOwner
        ? `
          <div class="content-card-actions">
            <button
              type="button"
              class="content-card-action-btn icon"
              data-action="rename"
              aria-label="${t('video.rename')}"
              title="${t('video.rename')}"
            >✏️</button>
            <button
              type="button"
              class="content-card-action-btn icon danger"
              data-action="delete"
              aria-label="${t('video.delete')}"
              title="${t('video.delete')}"
            >🗑️</button>
          </div>
        `
        : '';

      return `
        <div
          class="content-card"
          data-type="${item.type}"
          data-id="${item.id || ''}"
          data-url="${url}"
          role="link"
          tabindex="0"
          aria-label="${escapeHtml(item.title)}"
        >
          <div class="content-card-top">
            <div class="content-card-type">${item.icon}</div>
            ${actionsMarkup}
          </div>
          <h3 class="content-card-title">${escapeHtml(item.title)}</h3>
          <div class="video-progress-row">
            <div class="progress-bar-mini"><div class="progress-fill-mini" style="width: ${prog}%"></div></div>
            <span class="progress-text">${prog}%</span>
          </div>
        </div>
      `;
    }).join('');

    wireRecentContentGrid(contentGrid);
  } catch (err) {
    console.error('Failed to load recent content:', err);
    const fallbackGrid = document.getElementById('recent-content');
    if (fallbackGrid) {
      fallbackGrid.innerHTML = '<p style="color: #999; text-align: center; padding: 2rem;">Failed to load content</p>';
    }
  }
}

/**
 * Add interactivity to recent content grid
 * @param {HTMLElement} container - Grid container
 */
export function wireRecentContentGrid(container) {
  if (!container || container.dataset.interactive === 'true') {
    return;
  }

  container.addEventListener('click', async (event) => {
    const actionBtn = event.target.closest('.content-card-action-btn');
    if (actionBtn) {
      event.preventDefault();
      event.stopPropagation();
      if (actionBtn.disabled) {
        return;
      }
      const card = actionBtn.closest('.content-card');
      if (!card) {
        return;
      }
      actionBtn.disabled = true;
      try {
        if (actionBtn.dataset.action === 'rename') {
          await handleVideoRename(card);
        } else if (actionBtn.dataset.action === 'delete') {
          await handleVideoDelete(card);
        }
      } finally {
        actionBtn.disabled = false;
      }
      return;
    }

    const card = event.target.closest('.content-card');
    if (!card) {
      return;
    }
    if (event.target.closest('.content-card-actions')) {
      return;
    }
    const url = card.dataset.url;
    if (url) {
      window.location.href = url;
    }
  });

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const isActionTarget = event.target.closest('.content-card-action-btn');
    if (isActionTarget) {
      return;
    }
    const card = event.target.closest('.content-card');
    if (!card) {
      return;
    }
    if (event.target.closest('.content-card-actions')) {
      return;
    }
    const url = card.dataset.url;
    if (url) {
      event.preventDefault();
      window.location.href = url;
    }
  });

  container.dataset.interactive = 'true';
}

/**
 * Render video library list
 * @param {Array} videos - Video array
 */
export function renderVideoLibraryList(videos = []) {
  const listContainer = document.getElementById('video-library-list');
  if (!listContainer) return;

  if (!Array.isArray(videos) || videos.length === 0) {
    listContainer.innerHTML = `
      <p class="library-video-placeholder">
        暂无视频，先去 <a href="./video-upload.html" style="color: inherit; text-decoration: underline;">上传一个</a> 吧
      </p>
    `;
    return;
  }

  const formatMeta = (video) => {
    const parts = [];
    if (video.status && typeof video.status === 'string') {
      const statusMap = { ready: '已就绪', processing: '处理中', failed: '导入失败' };
      parts.push(statusMap[video.status] || video.status);
    }
    if (Number.isFinite(video.duration_sec) && video.duration_sec > 0) {
      const minutes = Math.floor(video.duration_sec / 60);
      const seconds = Math.round(video.duration_sec % 60)
        .toString()
        .padStart(2, '0');
      parts.push(`${minutes}:${seconds}`);
    }
    return parts.join(' · ');
  };

  const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
  const currentUserId = state.user && state.user.id;

  listContainer.innerHTML = videos
    .map((video) => {
      const title = video.title && video.title.trim() ? video.title : '未命名视频';
      const meta = formatMeta(video);
      const url = `./video-reader.html?videoId=${encodeURIComponent(String(video.id))}`;
      // Use loose equality to handle number/string type differences
      const isOwner = currentUserId && video.uploader_id && String(video.uploader_id) === String(currentUserId);

      // Only show edit/delete buttons if user is the owner
      const actionButtons = isOwner ? `
            <button type="button" class="content-card-action-btn icon" data-action="rename" aria-label="${t('video.rename')}" title="${t('video.rename')}">✏️</button>
            <button type="button" class="content-card-action-btn icon danger" data-action="delete" aria-label="${t('video.delete')}" title="${t('video.delete')}">🗑️</button>
      ` : '';

      return `
        <div
          class="library-video-entry"
          data-id="${video.id}"
          data-url="${url}"
          tabindex="0"
          role="link"
          aria-label="${escapeHtml(title)}"
        >
          <div style="flex: 1; min-width: 0;">
            <p class="content-card-title">${escapeHtml(title)}</p>
            <p class="content-card-meta">${meta ? escapeHtml(meta) : ''}</p>
          </div>
          <div class="content-card-actions">
            ${actionButtons}
          </div>
        </div>
      `;
    })
    .join('');

  wireVideoLibraryList(listContainer);
}

/**
 * Add interactivity to video library list
 * @param {HTMLElement} container - List container
 */
export function wireVideoLibraryList(container) {
  if (!container || container.dataset.interactive === 'true') {
    return;
  }

  container.addEventListener('click', async (event) => {
    const actionBtn = event.target.closest('.content-card-action-btn');
    if (actionBtn) {
      event.preventDefault();
      event.stopPropagation();
      if (actionBtn.disabled) {
        return;
      }
      const entry = actionBtn.closest('.library-video-entry');
      if (!entry) {
        return;
      }
      actionBtn.disabled = true;
      try {
        if (actionBtn.dataset.action === 'rename') {
          await handleVideoRename(entry);
        } else if (actionBtn.dataset.action === 'delete') {
          await handleVideoDelete(entry);
        }
      } finally {
        actionBtn.disabled = false;
      }
      return;
    }

    const entry = event.target.closest('.library-video-entry');
    if (!entry) return;
    const url = entry.dataset.url;
    if (url) {
      window.location.href = url;
    }
  });

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const entry = event.target.closest('.library-video-entry');
    if (!entry) {
      return;
    }
    if (event.target.closest('.content-card-action-btn')) {
      return;
    }
    const url = entry.dataset.url;
    if (url) {
      event.preventDefault();
      window.location.href = url;
    }
  });

  container.dataset.interactive = 'true';
}

/**
 * Handle video rename action
 * @param {HTMLElement} card - Video card or entry element
 */
async function handleVideoRename(card) {
  const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
  const videoId = Number(card.dataset.id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    showToast(t('video.invalid_id'));
    return;
  }

  const titleEl = card.querySelector('.content-card-title');
  const currentTitle = titleEl ? titleEl.textContent.trim() : '';
  const nextTitle = window.prompt(t('video.rename_prompt'), currentTitle);

  if (nextTitle === null) {
    return;
  }

  const trimmedTitle = nextTitle.trim();
  if (!trimmedTitle.length) {
    showToast(t('video.title_empty'));
    return;
  }

  if (trimmedTitle === currentTitle) {
    return;
  }

  try {
    const response = await apiFetch(`/video-resources/${videoId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: trimmedTitle })
    });
    const updatedTitle = response && response.video && response.video.title
      ? response.video.title
      : trimmedTitle;
    if (titleEl) {
      titleEl.textContent = updatedTitle;
    }
    showToast(t('video.rename_success'));
    // Refresh library list pane
    try {
      const videosRes = await apiFetch('/video-resources?lite=1').catch(() => ({ items: [] }));
      renderVideoLibraryList((videosRes && videosRes.items) || []);
    } catch (_) {}
  } catch (err) {
    console.error('Failed to rename video:', err);
    showToast(err.message || t('video.rename_error'));
  }
}

/**
 * Handle video delete action
 * @param {HTMLElement} card - Video card or entry element
 */
async function handleVideoDelete(card) {
  const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
  const videoId = Number(card.dataset.id);
  if (!Number.isFinite(videoId) || videoId <= 0) {
    showToast(t('video.invalid_id'));
    return;
  }

  const confirmed = window.confirm(t('video.delete_confirm'));
  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/video-resources/${videoId}`, {
      method: 'DELETE'
    });
    showToast(t('video.delete_success'));

    // Import here to avoid circular dependency
    const { loadRecentContent: loadRecentContentFn } = await import('./ui-manager.js');
    const { loadLibraryCounts } = await import('./vocabulary.js');

    await loadRecentContentFn();
    try {
      await loadLibraryCounts();
    } catch (countErr) {
      console.warn('Failed to refresh library counts after deletion:', countErr);
    }
    try {
      const videosRes = await apiFetch('/video-resources?lite=1').catch(() => ({ items: [] }));
      renderVideoLibraryList((videosRes && videosRes.items) || []);
    } catch (_) {}
  } catch (err) {
    console.error('Failed to delete video:', err);
    showToast(err.message || t('video.delete_error'));
  }
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML
 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format seconds to MM:SS format
 * @param {number} totalSeconds - Total seconds
 * @returns {string} Formatted time string
 */
export function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}
