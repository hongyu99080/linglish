/**
 * Page Visit Tracker
 * 统一的页面访问统计脚本，记录用户和游客的页面访问行为
 */
(function() {
  'use strict';

  // 防止重复执行
  if (window.__pageTrackerLoaded) return;
  window.__pageTrackerLoaded = true;

  // 获取当前页面名称
  function getPageName() {
    const path = window.location.pathname;
    const filename = path.split('/').pop() || 'index';
    return filename.replace('.html', '') || 'index';
  }

  function decorateEvent(payload) {
    if (window.LinglishVisitor && typeof window.LinglishVisitor.decorateEvent === 'function') {
      return window.LinglishVisitor.decorateEvent(payload);
    }
    return payload;
  }

  // 记录页面访问
  async function trackPageVisit() {
    try {
      const token = localStorage.getItem('linglish_token') || sessionStorage.getItem('authToken');
      if (!token) {
        // 无token时使用 /track/page-visit 端点（支持游客）
        await fetch('/track/page-visit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(decorateEvent({
            page: getPageName(),
            url: window.location.href,
            referrer: document.referrer || null
          }))
        });
        return;
      }

      // 有token时使用 /events 端点
      const isGuest = localStorage.getItem('is_guest') === 'true';
      await fetch('/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(decorateEvent({
          event_name: isGuest ? 'guest_visit' : 'page_visit',
          properties: {
            page: getPageName(),
            url: window.location.href,
            referrer: document.referrer || null
          },
          source: 'web'
        }))
      });
    } catch (err) {
      // 静默失败，不影响页面正常功能
      console.debug('[PageTracker] Failed to record visit:', err);
    }
  }

  // 页面加载完成后执行追踪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackPageVisit);
  } else {
    // DOM已加载完成，延迟执行避免阻塞
    setTimeout(trackPageVisit, 100);
  }
})();
