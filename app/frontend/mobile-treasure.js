/**
 * Mobile Treasure Page Logic
 * Aggregates data from GamificationSystem (local) and Backend API
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

    try {
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers,
        });

        if (response.status === 204) return null;
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        return await response.json();
    } catch (err) {
        console.warn(`[Treasure] API fetch failed for ${path}:`, err);
        return null;
    }
}

// Get local gamification data
function getGamificationData() {
    if (window.gamificationSystem) {
        return window.gamificationSystem.getProgress();
    }
    // Fallback if system not initialized
    try {
        const stored = localStorage.getItem('linglish_gamification');
        return stored ? JSON.parse(stored) : null;
    } catch (e) {
        return null;
    }
}

// Main initialization function
async function initializeTreasurePage() {
    console.log('[Treasure] Initializing...');

    // 1. Get Local Data (Gamification)
    const gamData = getGamificationData();
    const localStats = gamData?.stats || {};

    // 2. Get Backend Data (Training Stats)
    const backendStats = await apiFetch('/training/stats') || {};

    // 3. Aggregate Data
    // Merge gamification data (XP, Coins, Level) with backend stats
    const data = {
        streak: backendStats.streak_days || gamData?.streak || 0,
        wordsMastered: backendStats.words_mastered || localStats.wordsLearned || 0,
        videoMinutes: backendStats.video_minutes || Math.round(localStats.videoMinutes || 0),
        practiceMinutes: Math.round(backendStats.effective_minutes || 0),
        practiceOutputs: backendStats.effective_outputs || 0,
        totalSessions: backendStats.total_sessions || ((localStats.videosWatched || 0) + (backendStats.total_sessions || 0)),

        // Gamification Properties from gamification.js
        level: gamData?.level || 1,
        xp: gamData?.xp || 0,
        xpToNextLevel: gamData?.xpToNextLevel || 100,
        coins: gamData?.coins || 0,

        totalMinutes: backendStats.total_learning_minutes || (Math.round(localStats.videoMinutes || 0) + Math.round(backendStats.effective_minutes || 0)),
        todayMinutes: backendStats.today_minutes || 0
    };

    // 4. Render UI
    renderUserProfile(data);
    renderLearningStats(data);

    // 5. Check for Rewards
    checkRewardAction();

    // 6. Render Next Achievement
    if (window.gamificationSystem) {
        renderNextAchievement(window.gamificationSystem);
    }
    initAchievementSheet();

    console.log('[Treasure] Initialization complete', data);
}

// Reward System Logic
function checkRewardAction() {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('action');

    if (action === 'claim_daily') {
        const modal = document.getElementById('reward-modal');
        const chestContainer = document.getElementById('chest-container');
        const chestImg = document.querySelector('.chest-img');
        const rewardContent = document.getElementById('reward-content');
        const claimBtn = document.getElementById('claim-btn');

        if (modal && chestContainer) {
            modal.classList.add('active');

            // Click chest to open
            chestContainer.addEventListener('click', () => {
                if (chestImg.classList.contains('open')) return;

                chestImg.classList.remove('shake');
                chestImg.classList.add('open');

                // Call Gamification System to add persistent rewards
                if (window.gamificationSystem) {
                    window.gamificationSystem.addXP(20, 'Daily Chest');
                    window.gamificationSystem.addCoins(50, 'Daily Chest');
                    // 上报服务端,否则下一次 syncFromServer 会把这笔 XP 抹掉
                    window.gamificationSystem.recordActivity('daily_chest_claimed');

                    const newData = window.gamificationSystem.getProgress();
                    // Refetch elements to update UI immediately
                    const levelBadge = document.getElementById('level-badge');
                    if (levelBadge) levelBadge.textContent = `Lv. ${newData.level}`;

                    const xpFill = document.getElementById('xp-bar-fill');
                    if (xpFill) xpFill.style.width = `${Math.min(100, (newData.xp / newData.xpToNextLevel) * 100)}%`;

                    const xpCurrent = document.getElementById('xp-current');
                    if (xpCurrent) xpCurrent.textContent = newData.xp;

                    const statCoins = document.getElementById('stat-coins');
                    if (statCoins) statCoins.textContent = newData.coins;
                }

                // Show rewards after short delay
                setTimeout(() => {
                    rewardContent.classList.add('show');
                }, 600);
            });

            // Close modal
            claimBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // prevent triggering chest click again
                modal.classList.remove('active');

                // Clean URL
                const url = new URL(window.location);
                url.searchParams.delete('action');
                window.history.replaceState({}, '', url);
            });
        }
    }
}

// Render User Profile Section
function renderUserProfile(data) {
    // Update Level Badge
    const levelBadge = document.getElementById('level-badge');
    if (levelBadge) levelBadge.textContent = `Lv. ${data.level || 1}`;

    // Update XP Bar
    const xpFill = document.getElementById('xp-bar-fill');
    const xpCurrent = document.getElementById('xp-current');
    const xpNext = document.getElementById('xp-next');
    const xpPercent = document.getElementById('xp-percent');
    const xpRemaining = document.getElementById('xp-remaining');

    if (xpFill && xpCurrent && xpNext) {
        const current = data.xp || 0;
        const target = data.xpToNextLevel || 100;
        const pct = Math.min(100, Math.max(0, (current / target) * 100));

        xpFill.style.width = `${pct}%`;
        xpCurrent.textContent = current;
        xpNext.textContent = target;
        if (xpPercent) xpPercent.textContent = `${Math.round(pct)}%`;
        if (xpRemaining) xpRemaining.textContent = Math.max(0, target - current);
    }

    // Update Coins
    const statCoins = document.getElementById('stat-coins');
    if (statCoins) statCoins.textContent = data.coins || 0;

    // Update Mini Stats
    const statMinutes = document.getElementById('stat-minutes');
    if (statMinutes) statMinutes.textContent = data.totalMinutes || 0;
}

// Render Main Stats Grid
function renderLearningStats(data) {
    // We need to map our data to the DOM elements. 
    // Since we are redesigning the HTML, we will target specific IDs that we will add to the HTML.

    updateElement('stat-total-time', `${data.totalMinutes} 分钟`);
    updateElement('stat-streak', `${data.streak} 天`);
    updateElement('stat-words', `${data.wordsMastered} 个`);
    updateElement('stat-video-time', `${data.videoMinutes} 分钟`);
    updateElement('stat-practice-time', `${data.practiceMinutes} 分钟`);

    // Update Daily Goal
    updateDailyGoal(data.todayMinutes || 0);
}

function updateDailyGoal(minutes) {
    const GOAL = 15;
    const circle = document.querySelector('.progress-ring-value');
    const text = document.getElementById('daily-goal-text');
    const meta = document.getElementById('daily-goal-meta');

    if (!circle || !text) return;

    const radius = circle.r.baseVal.value;
    const circumference = radius * 2 * Math.PI;

    // Set initial stroke-dasharray
    circle.style.strokeDasharray = `${circumference} ${circumference}`;

    const progress = Math.min(minutes / GOAL, 1);
    const offset = circumference - progress * circumference;

    circle.style.strokeDashoffset = offset;

    if (minutes >= GOAL) {
        text.textContent = `🎉 目标达成！已学 ${minutes} 分钟`;
        text.style.color = '#115e59';
        text.style.fontWeight = 'bold';
        if (meta) meta.textContent = '奖励已准备，记得来领取～';
    } else {
        const remaining = GOAL - minutes;
        text.textContent = `加油！还差 ${remaining} 分钟`;
        if (meta) meta.textContent = `今日已学 ${minutes} 分钟 · 继续学习解锁奖励`;
    }
}

function updateElement(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function renderNextAchievement(gamSystem) {
    const nextAch = gamSystem.getNextAchievement();
    const nameEl = document.getElementById('next-achievement-name');
    const descEl = document.getElementById('next-achievement-desc');
    const ringEl = document.getElementById('next-achievement-ring');
    const iconEl = document.getElementById('next-achievement-icon');
    const sheetTitle = document.getElementById('achievement-sheet-title');
    const sheetDesc = document.getElementById('achievement-sheet-desc');
    const sheetProgress = document.getElementById('achievement-sheet-progress');
    const sheetBar = document.getElementById('achievement-sheet-bar');
    const sheetAction = document.getElementById('achievement-sheet-action');

    if (!nameEl) return;

    if (nextAch) {
        nameEl.textContent = nextAch.name;
        descEl.textContent = `进度: ${nextAch.current} / ${nextAch.target} (${Math.round(nextAch.percent)}%) - ${nextAch.description}`;
        iconEl.textContent = nextAch.icon;
        if (sheetTitle) sheetTitle.textContent = `${nextAch.icon} ${nextAch.name}`;
        if (sheetDesc) sheetDesc.textContent = nextAch.description;
        if (sheetProgress) {
            sheetProgress.textContent = `进度 ${nextAch.current} / ${nextAch.target}（${Math.round(nextAch.percent)}%）`;
        }
        if (sheetBar) sheetBar.style.width = `${Math.min(100, Math.max(0, nextAch.percent))}%`;
        if (sheetAction) sheetAction.href = getAchievementActionLink(nextAch.id);

        // Update Ring
        if (ringEl) {
            const radius = 26;
            const circumference = radius * 2 * Math.PI;
            const offset = circumference - (nextAch.percent / 100) * circumference;
            // ringEl.style.strokeDasharray = `${circumference} ${circumference}`; // already set in CSS/SVG
            ringEl.style.strokeDashoffset = offset;
        }
    } else {
        nameEl.textContent = "所有成就已解锁！";
        descEl.textContent = "你是真正的语言大师！";
        if (ringEl) ringEl.style.strokeDashoffset = 0; // Full circle
        if (sheetTitle) sheetTitle.textContent = '🏆 成就已全部解锁';
        if (sheetDesc) sheetDesc.textContent = '继续学习，解锁更多进阶内容。';
        if (sheetProgress) sheetProgress.textContent = '进度 100%';
        if (sheetBar) sheetBar.style.width = '100%';
        if (sheetAction) sheetAction.href = 'mobile-today.html';
    }
}

function getAchievementActionLink(id) {
    const map = {
        first_video: 'mobile-explore.html',
        video_master: 'mobile-explore.html',
        first_practice: 'mobile-arena.html',
        practice_master: 'mobile-arena.html',
        vocab_50: 'mobile-vocabulary.html',
        vocab_500: 'mobile-vocabulary.html',
        streak_7: 'mobile-today.html',
        streak_30: 'mobile-today.html',
        perfect_10: 'mobile-arena.html',
        level_10: 'mobile-today.html'
    };
    return map[id] || 'mobile-today.html';
}

function initAchievementSheet() {
    const card = document.getElementById('next-achievement-card');
    const sheet = document.getElementById('achievement-sheet');
    const closeBtn = document.getElementById('achievement-sheet-close');
    if (!card || !sheet) return;

    const openSheet = () => {
        sheet.classList.add('active');
        sheet.setAttribute('aria-hidden', 'false');
    };
    const closeSheet = () => {
        sheet.classList.remove('active');
        sheet.setAttribute('aria-hidden', 'true');
    };

    card.addEventListener('click', openSheet);
    if (closeBtn) closeBtn.addEventListener('click', closeSheet);
    sheet.addEventListener('click', (event) => {
        if (event.target === sheet) closeSheet();
    });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeTreasurePage);
} else {
    initializeTreasurePage();
}
