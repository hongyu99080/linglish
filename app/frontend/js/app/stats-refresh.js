/**
 * Stats and Sessions Refresh Module
 * Separated to avoid circular dependencies
 */

import { apiFetch } from './api.js';

/**
 * Refresh training statistics
 */
export async function refreshStats() {
  try {
    const stats = await apiFetch('/training/stats');

    // Check if stats is valid
    if (!stats || typeof stats !== 'object') {
      console.warn('Invalid stats data received');
      return;
    }

    // Old stats (if elements exist)
    const oldMinutes = document.getElementById('stat-effective-minutes');
    const oldOutputs = document.getElementById('stat-effective-outputs');
    const oldSessions = document.getElementById('stat-total-sessions');

    if (oldMinutes && typeof stats.effective_minutes === 'number') {
      oldMinutes.textContent = stats.effective_minutes.toFixed(2);
    }
    if (oldOutputs && stats.effective_outputs !== undefined) {
      oldOutputs.textContent = stats.effective_outputs;
    }
    if (oldSessions && stats.total_sessions !== undefined) {
      oldSessions.textContent = stats.total_sessions;
    }

    // New stats cards
    const totalTime = document.getElementById('total-time');
    const totalWords = document.getElementById('total-words');

    if (totalTime && typeof stats.effective_minutes === 'number') {
      const hours = Math.floor(stats.effective_minutes / 60);
      const mins = Math.floor(stats.effective_minutes % 60);
      totalTime.textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    if (totalWords) {
      totalWords.textContent = stats.words_learned || 0;
    }

    // Update progress ring
    const dailyMinutes = stats.effective_minutes || 0;
    const targetMinutes = 20;
    const percent = Math.min(100, Math.round((dailyMinutes / targetMinutes) * 100));

    const progressPercent = document.getElementById('progress-percent');
    const progressRing = document.getElementById('progress-ring');

    if (progressPercent) {
      progressPercent.textContent = percent;
    }

    if (progressRing) {
      const circumference = 2 * Math.PI * 52;
      const offset = circumference - (percent / 100) * circumference;
      progressRing.style.strokeDashoffset = offset;
    }
  } catch (err) {
    console.error('Failed to refresh stats:', err);
  }

  // 同步到顶部导航徽标（显示百分比或分钟）
  try {
    const badge = document.querySelector('.nav-badge.progress');
    if (badge) {
      const stats = await apiFetch('/training/stats');
      const minutes = Math.round(stats.effective_minutes || 0);
      const todayLabel = (typeof i18n !== 'undefined') ? i18n.t('stats.today') : '今日';
      const minAbbr = (typeof i18n !== 'undefined') ? i18n.t('stats.min_abbr') : '分';
      const label = minutes > 0 ? `${todayLabel} ${minutes}${minAbbr}` : ((typeof i18n !== 'undefined') ? i18n.t('nav.badge_progress') : '进度');
      badge.textContent = label;
    }
  } catch (_) { }
}

/**
 * Refresh recent training sessions
 */
export async function refreshSessions() {
  try {
    const response = await apiFetch('/training/sessions?limit=5');

    // Validate response
    if (!response || !Array.isArray(response.items)) {
      console.warn('Invalid sessions response');
      return;
    }

    // Old list (keep for backward compatibility)
    const list = document.getElementById('recent-sessions');
    if (list) {
      list.innerHTML = '';
      response.items.forEach((session) => {
        const li = document.createElement('li');
        const date = new Date(session.created_at);
        const dateStr = date.toLocaleDateString();
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        li.textContent = `${session.type} - ${dateStr} ${timeStr} (${session.duration}s)`;
        list.appendChild(li);
      });
    }

    // New activity feed
    const activityList = document.getElementById('activity-list');
    if (activityList) {
      activityList.innerHTML = '';
      const maxShow = 3;
      response.items.slice(0, maxShow).forEach((session) => {
        const item = document.createElement('div');
        item.className = 'activity-item';

        const icon = document.createElement('div');
        icon.className = 'activity-icon';
        const iconMap = { shadowing: '🎤', dictogloss: '📝', '432': '⏱️' };
        icon.textContent = iconMap[session.type] || '✅';

        const info = document.createElement('div');
        info.className = 'activity-info';

        const desc = document.createElement('div');
        desc.className = 'activity-desc';
        const typeLabel = { shadowing: '跟读练习', dictogloss: '听写练习', '432': '4-3-2计时' }[session.type] || session.type;
        desc.textContent = typeLabel;

        const time = document.createElement('div');
        time.className = 'activity-time';
        const date = new Date(session.created_at);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 60) {
          time.textContent = `${diffMins}分钟前`;
        } else if (diffMins < 1440) {
          time.textContent = `${Math.floor(diffMins / 60)}小时前`;
        } else {
          time.textContent = date.toLocaleDateString();
        }

        info.appendChild(desc);
        info.appendChild(time);
        item.appendChild(icon);
        item.appendChild(info);
        activityList.appendChild(item);
      });
    }
  } catch (err) {
    console.error('Failed to refresh sessions:', err);
  }
}
