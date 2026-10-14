/**
 * Mobile Stats Page - Real Data Implementation
 * Integrates with gamification.js and backend API
 */

const API_BASE = '';

// Read stored authentication token
function readStoredToken() {
  return (
    localStorage.getItem('authToken') ||
    localStorage.getItem('linglish_token') ||
    sessionStorage.getItem('authToken') ||
    sessionStorage.getItem('linglish_token')
  );
}

// API fetch helper
async function apiFetch(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  headers['Content-Type'] = 'application/json';

  const token = readStoredToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || 'Request failed');
    error.status = response.status;
    throw error;
  }

  return data;
}

// Get gamification data from localStorage
function getGamificationData() {
  try {
    const stored = localStorage.getItem('linglish_gamification');
    if (stored && stored !== 'undefined' && stored !== 'null') {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to parse gamification data:', e);
  }
  return null;
}

function setText(el, value) {
  if (!el) return;
  const text = String(value);
  if (el.textContent !== text) {
    el.textContent = text;
  }
}

function setStyle(el, key, value) {
  if (!el) return;
  if (el.style[key] !== value) {
    el.style[key] = value;
  }
}

// Get current day of week (0 = Monday, 6 = Sunday)
function getDayOfWeek(date = new Date()) {
  const day = date.getDay();
  return day === 0 ? 6 : day - 1; // Convert Sunday from 0 to 6
}

// Get date string (YYYY-MM-DD)
function getDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Get start of week (Monday)
function getStartOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Calculate weekly learning minutes from events
async function getWeeklyMinutes() {
  try {
    const weekStart = getStartOfWeek();
    const events = await apiFetch('/events?limit=500');

    const weeklyData = [0, 0, 0, 0, 0, 0, 0]; // Mon-Sun

    if (events && events.items) {
      events.items.forEach(event => {
        const eventDate = new Date(event.event_time);
        if (eventDate >= weekStart) {
          const dayIndex = getDayOfWeek(eventDate);

          // Count video_watch and practice time
          if (event.event_name === 'video_watch' && event.properties && event.properties.seconds) {
            weeklyData[dayIndex] += Math.round(event.properties.seconds / 60);
          }
        }
      });
    }

    // Also add training session time
    const sessions = await apiFetch('/training/sessions?limit=500');
    if (sessions && sessions.items) {
      sessions.items.forEach(session => {
        if (session.start_at && session.duration_sec) {
          const sessionDate = new Date(session.start_at);
          if (sessionDate >= weekStart) {
            const dayIndex = getDayOfWeek(sessionDate);
            weeklyData[dayIndex] += Math.round(session.duration_sec / 60);
          }
        }
      });
    }

    return weeklyData;
  } catch (error) {
    console.error('Failed to fetch weekly minutes:', error);
    return [0, 0, 0, 0, 0, 0, 0];
  }
}

// Get recent activity
async function getRecentActivity() {
  try {
    const [events, sessions] = await Promise.all([
      apiFetch('/events?limit=20'),
      apiFetch('/training/sessions?limit=20')
    ]);

    const activities = [];
    const gamData = getGamificationData();

    // Process events
    if (events && events.items) {
      events.items.forEach(event => {
        const date = new Date(event.event_time);

        if (event.event_name === 'video_watch') {
          const minutes = (event.properties && event.properties.seconds) ? Math.round(event.properties.seconds / 60) : 0;
          activities.push({
            type: '📖',
            title: '视频学习',
            description: `观看了 ${minutes} 分钟`,
            timestamp: date
          });
        }
      });
    }

    // Process training sessions
    if (sessions && sessions.items) {
      sessions.items.forEach(session => {
        const date = new Date(session.start_at || session.created_at);
        const minutes = session.duration_sec ? Math.round(session.duration_sec / 60) : 0;

        const typeMap = {
          'shadowing': { icon: '🎤', title: '跟读练习' },
          'dictogloss': { icon: '✍️', title: 'Dictogloss 练习' },
          '432': { icon: '⏱️', title: '4-3-2 练习' },
          'roleplay': { icon: '🎭', title: '角色扮演' }
        };

        const info = typeMap[session.type] || { icon: '📝', title: '练习' };

        activities.push({
          type: info.icon,
          title: info.title,
          description: `完成练习 ${minutes} 分钟`,
          timestamp: date
        });
      });
    }

    // Sort by timestamp
    activities.sort((a, b) => b.timestamp - a.timestamp);

    return activities.slice(0, 10);
  } catch (error) {
    console.error('Failed to fetch recent activity:', error);
    return [];
  }
}

// Format time ago
function formatTimeAgo(date) {
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    if (days === 1) return '昨天';
    if (days === 2) return '2天前';
    return `${days}天前`;
  }
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
}

// Render hero stats cards
function renderHeroStats(gamData, backendStats) {
  const streak = (backendStats && backendStats.streak_days) || (gamData && gamData.currentStreak) || 0;
  const wordsLearned = (backendStats && backendStats.words_mastered) || (gamData && gamData.stats && gamData.stats.wordsLearned) || 0;
  const videosWatched = (backendStats && backendStats.total_sessions) || (gamData && gamData.stats && gamData.stats.videosWatched) || 0;

  requestAnimationFrame(() => {
    // Update streak
    const streakNumber = document.querySelector('.streak-card .stat-number-hero');
    setText(streakNumber, streak);

    // Update words
    const wordsNumber = document.querySelector('.words-card .stat-number-hero');
    setText(wordsNumber, wordsLearned);

    // Update videos (using total sessions as proxy for now, or fetch video count specifically if needed)
    const videosNumber = document.querySelector('.completed-card .stat-number-hero');
    setText(videosNumber, videosWatched);

    // Update descriptions
    const streakDesc = document.querySelector('.streak-card .stat-description');
    if (streakDesc) {
      if (streak === 0) {
        setText(streakDesc, '开始你的学习连击吧！');
      } else if (streak >= 7) {
        setText(streakDesc, '太棒了！继续保持这个节奏！');
      }
    }

    const videosDesc = document.querySelector('.completed-card .stat-description');
    if (videosDesc) {
      if (videosWatched === 0) {
        setText(videosDesc, '开始你的第一个视频学习吧！');
      } else if (videosWatched >= 5) {
        setText(videosDesc, '你正在快速进步！');
      } else if (videosWatched > 0) {
        setText(videosDesc, '保持学习，继续加油！');
      }
    }
  });
}

// Render weekly progress
async function renderWeeklyProgress() {
  const weeklyMinutes = await getWeeklyMinutes();
  const today = getDayOfWeek();
  const maxMinutes = Math.max(...weeklyMinutes, 20); // At least 20 for scale

  requestAnimationFrame(() => {
    const dayItems = document.querySelectorAll('.day-item');

    dayItems.forEach((item, index) => {
      const minutes = weeklyMinutes[index];
      const percentage = (minutes / maxMinutes) * 100;

      const fill = item.querySelector('.day-fill');
      const minutesLabel = item.querySelector('.day-minutes');

      if (fill) setStyle(fill, 'height', `${Math.min(100, percentage)}%`);
      if (minutesLabel) setText(minutesLabel, minutes > 0 ? `${minutes}min` : '0min');

      // Mark today
      if (index === today) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Update weekly summary
    const totalMinutes = weeklyMinutes.reduce((sum, m) => sum + m, 0);
    const summaryElement = document.querySelector('.weekly-summary strong');
    setText(summaryElement, `${totalMinutes} 分钟`);
  });
}

// Render detailed stats
function renderDetailedStats(gamData, backendStats) {
  const stats = [
    { selector: '.stats-grid-detailed .stat-item-detailed:nth-child(1) .stat-value', value: (backendStats && backendStats.total_sessions) || (gamData && gamData.stats && gamData.stats.videosWatched) || 0 },
    { selector: '.stats-grid-detailed .stat-item-detailed:nth-child(2) .stat-value', value: Math.round((backendStats && backendStats.effective_minutes) || 0) },
    { selector: '.stats-grid-detailed .stat-item-detailed:nth-child(3) .stat-value', value: (backendStats && backendStats.words_mastered) || (gamData && gamData.stats && gamData.stats.wordsLearned) || 0 },
    { selector: '.stats-grid-detailed .stat-item-detailed:nth-child(4) .stat-value', value: '—' }, // 平均正确率暂时没有数据
    { selector: '.stats-grid-detailed .stat-item-detailed:nth-child(5) .stat-value', value: (backendStats && backendStats.streak_days) || (gamData && gamData.stats && gamData.stats.daysActive) || 0 },
    { selector: '.stats-grid-detailed .stat-item-detailed:nth-child(6) .stat-value', value: Object.keys((gamData && gamData.achievements) || {}).length }
  ];

  requestAnimationFrame(() => {
    stats.forEach(({ selector, value }) => {
      const element = document.querySelector(selector);
      setText(element, value);
    });
  });
}

// Render recent activity
async function renderRecentActivity() {
  const activities = await getRecentActivity();
  const activityList = document.querySelector('.activity-list');

  if (!activityList) return;

  if (activities.length === 0) {
    activityList.innerHTML = `
      <div class="activity-item-card" style="text-align: center; color: #999;">
        <p>暂无学习活动</p>
        <p style="font-size: 0.875rem; margin-top: 0.5rem;">开始学习后这里会显示你的活动记录</p>
      </div>
    `;
    return;
  }

  activityList.innerHTML = activities.map(activity => `
    <div class="activity-item-card">
      <div class="activity-date">${formatTimeAgo(activity.timestamp)}</div>
      <div class="activity-content-box">
        <span class="activity-type">${activity.type}</span>
        <div class="activity-details">
          <div class="activity-title">${activity.title}</div>
          <div class="activity-desc">${activity.description}</div>
        </div>
      </div>
    </div>
  `).join('');
}

// Render learning goals
function renderLearningGoals(gamData) {
  const dailyGoal = (gamData && gamData.dailyGoal) || { target: 20, completed: 0 };
  const dailyProgress = Math.min(100, Math.round((dailyGoal.completed / dailyGoal.target) * 100));
  const dailyRemaining = Math.max(0, dailyGoal.target - dailyGoal.completed);

  // Daily goal
  const dailyStatusEl = document.querySelector('.goal-card:nth-child(1) .goal-status');
  const dailyFillEl = document.querySelector('.goal-card:nth-child(1) .goal-progress-fill');
  const dailyDescEl = document.querySelector('.goal-card:nth-child(1) .goal-description');

  if (dailyStatusEl) setText(dailyStatusEl, `${dailyGoal.completed}/${dailyGoal.target} 分钟`);
  if (dailyFillEl) setStyle(dailyFillEl, 'width', `${dailyProgress}%`);
  if (dailyDescEl) {
    if (dailyRemaining === 0) {
      setText(dailyDescEl, '🎉 今日目标已完成！');
    } else {
      setText(dailyDescEl, `还需要 ${dailyRemaining} 分钟完成今日目标`);
    }
  }

  // Weekly goal (calculate from weekly minutes)
  const weeklyTarget = 100; // Default weekly target
  getWeeklyMinutes().then(weeklyMinutes => {
    const weeklyCompleted = weeklyMinutes.reduce((sum, m) => sum + m, 0);
    const weeklyProgress = Math.min(100, Math.round((weeklyCompleted / weeklyTarget) * 100));
    const weeklyRemaining = Math.max(0, weeklyTarget - weeklyCompleted);

    const weeklyStatusEl = document.querySelector('.goal-card:nth-child(2) .goal-status');
    const weeklyFillEl = document.querySelector('.goal-card:nth-child(2) .goal-progress-fill');
    const weeklyDescEl = document.querySelector('.goal-card:nth-child(2) .goal-description');

    if (weeklyStatusEl) setText(weeklyStatusEl, `${weeklyCompleted}/${weeklyTarget} 分钟`);
    if (weeklyFillEl) setStyle(weeklyFillEl, 'width', `${weeklyProgress}%`);
    if (weeklyDescEl) {
      if (weeklyRemaining === 0) {
        setText(weeklyDescEl, '🎉 本周目标已完成！');
      } else {
        setText(weeklyDescEl, '继续加油！本周还有时间');
      }
    }
  });
}

// Main initialization
async function initializeStatsPage() {
  try {
    // Get gamification data
    const gamData = getGamificationData();

    // Get backend stats
    const backendStats = await apiFetch('/training/stats');

    // Render all sections
    renderHeroStats(gamData, backendStats);
    await renderWeeklyProgress();
    renderDetailedStats(gamData, backendStats);
    await renderRecentActivity();
    renderLearningGoals(gamData);

    console.log('[Stats] Page initialized with real data');
  } catch (error) {
    console.error('[Stats] Failed to initialize:', error);
    // Keep fallback data if API fails
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeStatsPage);
} else {
  initializeStatsPage();
}
