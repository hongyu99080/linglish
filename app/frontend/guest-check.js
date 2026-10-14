/**
 * 游客权限检查工具
 * 用于限制游客用户的某些操作
 */
(function() {
  if (typeof window === 'undefined') return;

  /**
   * 检查当前用户是否为游客
   * @returns {boolean} 是否为游客
   */
  function isGuest() {
    try {
      const isGuestFlag = localStorage.getItem('is_guest');
      return isGuestFlag === 'true';
    } catch (e) {
      return false;
    }
  }

  /**
   * 获取游客ID
   * @returns {string|null} 游客ID
   */
  function getGuestId() {
    try {
      if (!isGuest()) return null;
      return localStorage.getItem('guest_id') || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 显示游客限制提示
   * @param {string} feature - 功能名称
   */
  function showGuestRestriction(feature) {
    const message = `游客模式下无法使用【${feature}】功能\n\n请注册正式账号以使用完整功能`;
    alert(message);
  }

  /**
   * 检查并阻止游客操作
   * @param {string} feature - 功能名称
   * @returns {boolean} 是否应该阻止操作（true=阻止，false=允许）
   */
  function checkGuestRestriction(feature) {
    if (isGuest()) {
      showGuestRestriction(feature);
      return true; // 阻止操作
    }
    return false; // 允许操作
  }

  /**
   * 为元素添加游客限制
   * @param {string} selector - CSS选择器
   * @param {string} feature - 功能名称
   */
  function restrictForGuest(selector, feature) {
    if (!isGuest()) return;

    const elements = document.querySelectorAll(selector);
    elements.forEach(element => {
      element.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showGuestRestriction(feature);
      }, true);

      // 添加视觉提示
      element.style.opacity = '0.6';
      element.style.cursor = 'not-allowed';
      element.title = `游客模式下无法使用此功能`;
    });
  }

  /**
   * 在页面上显示游客提示横幅
   */
  function showGuestBanner() {
    if (!isGuest()) return;

    const guestId = getGuestId();
    // Determine the correct registration page based on current page type
    const path = String(location.pathname || '').toLowerCase();

    // 判断是否为移动端页面
    // 1. 路径包含 'mobile-' (如 mobile-auth.html, mobile-explore.html)
    // 2. 是 video-reader.html (移动端视频页面)
    const isMobilePage = path.includes('mobile-') ||
                         (path.includes('video-reader.html') && !path.includes('desktop'));

    // 添加 mode=register 参数，让页面默认显示注册标签页
    const registerLink = isMobilePage ? './mobile-auth.html?mode=register' : './index-desktop.html?mode=register';

    const banner = document.createElement('div');
    banner.id = 'guest-banner';
    banner.innerHTML = `
      <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 8px 20px; text-align: center; font-size: 13px; position: sticky; top: 0; z-index: 9999; box-shadow: 0 2px 8px rgba(0,0,0,0.2);">
        <span style="margin-right: 8px;">🎭</span>
        <strong>游客模式</strong> (ID: ${guestId || '未知'})
        <span style="margin: 0 10px;">|</span>
        <button id="guest-register-btn" style="background: transparent; border: none; color: white; text-decoration: underline; font-weight: bold; cursor: pointer; font-size: 13px; padding: 0;">注册账号</button>
      </div>
    `;

    const bannerElement = banner.firstElementChild;
    document.body.insertBefore(bannerElement, document.body.firstChild);
    console.log('[Guest] Banner created for guest:', guestId);

    // 添加注册按钮点击事件
    const registerBtn = document.getElementById('guest-register-btn');
    console.log('[Guest] Register button element:', registerBtn ? 'found' : 'NOT FOUND');
    if (registerBtn) {
      registerBtn.addEventListener('click', function(e) {
        e.preventDefault();
        console.log('[Guest] Register button clicked, starting logout process...');

        // 清除所有游客登录信息（同步操作）
        try {
          // localStorage - 清除所有相关项
          localStorage.removeItem('linglish_token');
          localStorage.removeItem('authToken');
          localStorage.removeItem('is_guest');
          localStorage.removeItem('isGuest');  // 驼峰式
          localStorage.removeItem('guest_id');

          // sessionStorage - 清除所有相关项
          sessionStorage.removeItem('linglish_token');
          sessionStorage.removeItem('authToken');
          sessionStorage.removeItem('is_guest');
          sessionStorage.removeItem('isGuest');  // 驼峰式
          sessionStorage.removeItem('guest_id');

          console.log('[Guest] Cleared all guest session data');
        } catch (err) {
          console.error('[Guest] Failed to clear session:', err);
        }

        // 使用 setTimeout 确保清除操作完成
        setTimeout(() => {
          // 使用 replace 避免保留历史记录，并添加时间戳和强制注册标记避免缓存
          const url = registerLink + (registerLink.includes('?') ? '&' : '?') + 'from_guest=1&_t=' + Date.now();
          console.log('[Guest] Redirecting to:', url);
          window.location.replace(url);
        }, 100);
      });
    }
  }

  // 导出到全局
  window.GuestCheck = {
    isGuest,
    getGuestId,
    showGuestRestriction,
    checkGuestRestriction,
    restrictForGuest,
    showGuestBanner
  };
})();
