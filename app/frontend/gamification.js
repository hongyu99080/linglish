/**
 * linglish 游戏化系统
 * 综合 Duolingo, LingQ, FluentU, Lola Speak 的优点
 */

// 必须与后端 routes/learning-stats.js 的 LEVEL_THRESHOLDS 保持一致
const XP_LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5500, 7500];

class GamificationSystem {
  constructor() {
    this.storageKey = 'linglish_gamification';
    this.data = this.loadData();
    this.syncing = false;
    this.initServerSync();   // 新增:未登录时内部直接返回
  }

  // 加载数据
  loadData() {
    const stored = localStorage.getItem(this.storageKey);
    if (stored && stored !== 'undefined' && stored !== 'null') {
      try {
        return JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse gamification data:', e);
      }
    }

    // 默认数据结构
    return {
      // 经验值系统 (类似 Duolingo)
      xp: 0,
      level: 1,
      xpToNextLevel: 100,
      totalXpEarned: 0,

      // 金币系统
      coins: 0,
      totalCoinsEarned: 0,

      // 连胜系统 (类似 Duolingo)
      currentStreak: 0,
      longestStreak: 0,
      lastActiveDate: null,
      streakFreezeUsed: false,

      // 每日目标
      dailyGoal: {
        target: 20, // 分钟
        completed: 0,
        date: this.getToday()
      },

      // 学习统计
      stats: {
        videosWatched: 0,
        videoMinutes: 0,
        practicesSessions: 0,
        wordsLearned: 0,
        sentencesRecorded: 0,
        perfectScores: 0,
        daysActive: 1
      },

      // 成就系统
      achievements: {},

      // 词汇状态 (类似 LingQ)
      vocabulary: {
        new: 0,
        learning: 0,
        known: 0,
        total: 0
      },

      // 上次更新时间
      lastUpdate: new Date().toISOString()
    };
  }

  getToken() {
    try { return localStorage.getItem('linglish_token') || null; } catch (_) { return null; }
  }

  async apiFetch(path, options = {}) {
    const token = this.getToken();
    if (!token) throw new Error('NO_TOKEN');
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return res.json();
  }

  initServerSync() {
    if (!this.getToken()) return; // 未登录:保持纯本地行为
    // 迁移失败时绝不同步:服务端此刻还没有本地 XP,同步会把本地进度覆盖成 0
    // 并让下次重试只能迁移 0(不可恢复)。失败保持本地数据不动,下次加载重试。
    this.migrateLocalIfNeeded().then((ok) => {
      if (ok) this.syncFromServer();
    });
  }

  async migrateLocalIfNeeded() {
    if (this.data.serverMigrated) return true; // 已迁移:正常同步
    const xp = Math.max(0, Math.floor(this.data.totalXpEarned || this.data.xp || 0));
    try {
      await this.apiFetch('/api/stats/migrate-local', {
        method: 'POST',
        body: JSON.stringify({ xp, stats: this.data.stats || {} }),
      });
      this.data.serverMigrated = true;
      this.saveData();
      return true;
    } catch (_) {
      return false; // 静默:下次加载重试(后端幂等)
    }
  }

  xpToNext(totalXp) {
    for (const t of XP_LEVEL_THRESHOLDS) {
      if (totalXp < t) return t - totalXp;
    }
    return 0; // 满级
  }

  async syncFromServer() {
    // 未完成一次性迁移前绝不回填:服务端还没有本地 XP,同步会把本地进度覆盖成 0
    // 且让后续重试只能迁移 0(不可恢复)。所有调用点共用这一道闸。
    if (!this.data.serverMigrated) return;
    if (this.syncing) return;
    this.syncing = true;
    try {
      const o = await this.apiFetch('/api/stats/overview');
      const oldLevel = this.data.level; // 同步前的等级,用于升级判定
      this.data.xp = o.total_xp;
      this.data.totalXpEarned = o.total_xp;
      this.data.level = o.level;
      this.data.xpToNextLevel = this.xpToNext(o.total_xp);
      this.data.currentStreak = o.streak.current;
      this.data.longestStreak = o.streak.longest;
      this.data.vocabulary.total = o.total_words_learned;
      this.data.serverSyncedAt = new Date().toISOString();
      if (o.level > oldLevel) {
        // 升级判定以服务端为准:复用 levelUp() 的通知动画,不重复其 XP 计算
        this.showNotification(`🎉 升级到 Level ${this.data.level}！`, 'level-up');
      }
      this.saveData(); // saveData 内部触发 notifyListeners → 各页面自动刷新
    } catch (_) { /* 降级:继续用缓存 */ }
    finally { this.syncing = false; }
  }

  // 服务端同步激活后,本地不再权威判定升级(升级由 syncFromServer 的 o.level 驱动)
  // 已登录(token 存在)或数据已被服务端回填(serverSyncedAt)均视为服务端权威
  isServerAuthoritative() {
    return !!(this.getToken() || this.data.serverSyncedAt);
  }

  async fetchServerAchievements() {
    try {
      const r = await this.apiFetch('/api/stats/achievements');
      return r.unlocked || [];
    } catch (_) { return []; }
  }

  // 保存数据
  saveData() {
    this.data.lastUpdate = new Date().toISOString();
    localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    this.notifyListeners();
  }

  // 获取今天日期 (YYYY-MM-DD)
  getToday() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  // 检查是否是新的一天
  isNewDay() {
    return this.data.dailyGoal.date !== this.getToday();
  }

  // 更新每日目标
  updateDailyGoal() {
    if (this.isNewDay()) {
      const yesterday = this.data.dailyGoal.completed;
      const target = this.data.dailyGoal.target;

      // 检查连胜
      if (yesterday >= target) {
        this.incrementStreak();
      } else {
        this.breakStreak();
      }

      // 重置每日目标
      this.data.dailyGoal = {
        target: target,
        completed: 0,
        date: this.getToday()
      };

      this.saveData();
    }
  }

  // 增加经验值
  addXP(amount, reason = '') {
    this.updateDailyGoal();

    this.data.xp += amount;
    this.data.totalXpEarned += amount;

    // 检查升级(仅纯本地模式;服务端权威时升级由 syncFromServer 判定)
    if (!this.isServerAuthoritative()) {
      while (this.data.xp >= this.data.xpToNextLevel) {
        this.levelUp();
      }
    }

    this.saveData();
    this.showNotification(`+${amount} XP ${reason}`, 'xp');
    return amount;
  }

  // 升级
  levelUp() {
    this.data.xp -= this.data.xpToNextLevel;
    this.data.level++;
    this.data.xpToNextLevel = Math.floor(100 * Math.pow(1.5, this.data.level - 1));

    // 升级奖励
    const coinsReward = this.data.level * 10;
    this.addCoins(coinsReward, '');

    this.showNotification(`🎉 升级到 Level ${this.data.level}！获得 ${coinsReward} 金币！`, 'level-up');
  }

  // 添加金币
  addCoins(amount, reason = '') {
    this.data.coins += amount;
    this.data.totalCoinsEarned += amount;
    this.saveData();

    if (reason) {
      this.showNotification(`+${amount} 金币 ${reason}`, 'coins');
    }
    return amount;
  }

  // 增加连胜
  incrementStreak() {
    this.data.currentStreak++;
    if (this.data.currentStreak > this.data.longestStreak) {
      this.data.longestStreak = this.data.currentStreak;
    }
    this.data.lastActiveDate = this.getToday();
    this.data.streakFreezeUsed = false;
    this.saveData();
  }

  // 打断连胜
  breakStreak() {
    if (this.data.streakFreezeUsed) {
      // 如果使用了连胜保护，不打断
      this.showNotification('🛡️ 连胜保护生效！', 'info');
      return;
    }

    if (this.data.currentStreak > 0) {
      this.showNotification(`💔 连胜中断了！之前连续 ${this.data.currentStreak} 天`, 'warning');
    }

    this.data.currentStreak = 0;
    this.saveData();
  }

  // 记录学习活动
  recordActivity(type, data = {}) {
    this.updateDailyGoal();

    switch (type) {
      case 'video_completed':
        this.data.stats.videosWatched++;
        this.addXP(50, '完成视频');
        this.addCoins(10, '完成视频');
        this.checkAchievements();
        break;

      case 'video_watched':
        const minutes = data.minutes || 0;
        this.data.stats.videoMinutes += minutes;
        this.data.dailyGoal.completed += minutes;
        this.addXP(Math.floor(minutes * 2), `观看 ${minutes} 分钟`);
        break;

      case 'practice_completed':
        this.data.stats.practicesSessions++;
        this.addXP(30, '完成练习');
        this.addCoins(5, '完成练习');
        this.checkAchievements();
        break;

      case 'sentence_recorded':
        this.data.stats.sentencesRecorded++;
        this.addXP(10, '录制句子');
        break;

      case 'perfect_score':
        this.data.stats.perfectScores++;
        this.addXP(100, '完美发音！');
        this.addCoins(20, '完美发音！');
        this.checkAchievements();
        break;

      case 'word_learned':
        this.data.stats.wordsLearned++;
        this.addXP(5, '学会新单词');
        break;

      case 'daily_goal_reached':
        this.addXP(50, '达成每日目标！');
        this.addCoins(15, '达成每日目标！');
        break;

      case 'quick_win_completed':
        // XP 已在 quick-win.js 中发放(本地即时反馈)，此处只记录统计和检查成就；
        // 持久化由下方 reportActivity 的 SERVER_LOG_MAP 完成
        if (!this.data.stats.quickWinsCompleted) {
          this.data.stats.quickWinsCompleted = 0;
        }
        this.data.stats.quickWinsCompleted++;
        this.checkAchievements();
        break;

      case 'daily_chest_claimed':
        // XP/金币已在 mobile-treasure.js 中发放(本地即时反馈)，
        // 持久化同样交给 reportActivity
        break;
    }

    this.saveData();
    this.reportActivity(type, data);
  }

  // 上报学习活动到后端
  reportActivity(type, data = {}) {
    const SERVER_LOG_MAP = {
      video_completed: d => ({ type: 'video', duration_minutes: Math.max(1, Math.round(d.minutes || 5)) }),
      video_watched: d => ({ type: 'video', duration_minutes: Math.max(1, Math.round(d.minutes || 1)) }),
      practice_completed: d => ({ type: 'training', duration_minutes: Math.max(1, Math.round(d.minutes || 3)) }),
      sentence_recorded: () => ({ type: 'training', duration_minutes: 1 }),
      perfect_score: () => ({ type: 'training', duration_minutes: 1 }),
      word_learned: () => ({ type: 'vocabulary', duration_minutes: 0, details: { words_learned: 1 } }),
      // 下面两条走同一通道,否则本地发的 XP 会被下一次 syncFromServer 抹掉
      quick_win_completed: d => ({
        type: 'vocabulary',
        duration_minutes: 1,
        details: { words_reviewed: Math.max(0, Math.round(d.correct || 0)) },
      }),
      daily_chest_claimed: () => ({ type: 'other', duration_minutes: 2 }),
    };
    const build = SERVER_LOG_MAP[type];
    if (!build || !this.getToken()) return;
    this.apiFetch('/api/stats/log', { method: 'POST', body: JSON.stringify(build(data)) })
      .then(() => this.syncFromServer())   // 以服务端为准回填
      .catch(() => {});                    // 静默:本地已即时反馈
  }

  // 更新词汇统计
  updateVocabulary(status, delta = 1) {
    if (this.data.vocabulary[status] !== undefined) {
      this.data.vocabulary[status] += delta;
      this.data.vocabulary.total =
        this.data.vocabulary.new +
        this.data.vocabulary.learning +
        this.data.vocabulary.known;
      this.saveData();
    }
  }

  // 获取成就进度
  getProgressForAchievement(id) {
    const stats = this.data.stats;
    const vocab = this.data.vocabulary;
    const streak = this.data.currentStreak;
    const level = this.data.level;

    switch (id) {
      case 'first_video': return { current: stats.videosWatched, target: 1, type: 'count' };
      case 'video_master': return { current: stats.videosWatched, target: 10, type: 'count' };
      case 'first_practice': return { current: stats.practicesSessions, target: 1, type: 'count' };
      case 'practice_master': return { current: stats.sentencesRecorded, target: 100, type: 'count' };
      case 'vocab_50': return { current: vocab.known, target: 50, type: 'count' };
      case 'vocab_500': return { current: vocab.known, target: 500, type: 'count' };
      case 'streak_7': return { current: streak, target: 7, type: 'count' };
      case 'streak_30': return { current: streak, target: 30, type: 'count' };
      case 'perfect_10': return { current: stats.perfectScores, target: 10, type: 'count' };
      case 'level_10': return { current: level, target: 10, type: 'count' };
      default: return { current: 0, target: 100, type: 'unknown' };
    }
  }

  // 获取下一个最近的成就
  getNextAchievement() {
    const all = this.getAllAchievements();
    const locked = all.filter(a => !a.unlocked);

    if (locked.length === 0) return null;

    // Calculate progress for each
    const withProgress = locked.map(a => {
      const prog = this.getProgressForAchievement(a.id);
      const percent = Math.min(100, (prog.current / prog.target) * 100);
      return { ...a, ...prog, percent };
    });

    // Sort by highest percentage
    withProgress.sort((a, b) => b.percent - a.percent);

    return withProgress[0];
  }

  // 检查并解锁成就
  checkAchievements() {
    const achievements = [
      {
        id: 'first_quick_win',
        name: '初次尝试',
        description: '完成首次快速挑战',
        icon: '⚡',
        condition: () => (this.data.stats.quickWinsCompleted || 0) >= 1,
        reward: { xp: 0, coins: 5 } // XP已在挑战中发放
      },
      {
        id: 'first_video',
        name: '视频初体验',
        description: '完成第一个视频',
        icon: '🎬',
        condition: () => this.data.stats.videosWatched >= 1,
        reward: { xp: 50, coins: 20 }
      },
      {
        id: 'video_master',
        name: '视频大师',
        description: '完成10个视频',
        icon: '🎥',
        condition: () => this.data.stats.videosWatched >= 10,
        reward: { xp: 200, coins: 50 }
      },
      {
        id: 'first_practice',
        name: '实战勇士',
        description: '完成第一次角色扮演',
        icon: '🎪',
        condition: () => this.data.stats.practicesSessions >= 1,
        reward: { xp: 50, coins: 20 }
      },
      {
        id: 'practice_master',
        name: '配音大师',
        description: '录制100个句子',
        icon: '🎤',
        condition: () => this.data.stats.sentencesRecorded >= 100,
        reward: { xp: 500, coins: 100 }
      },
      {
        id: 'vocab_50',
        name: '词汇达人',
        description: '掌握50个单词',
        icon: '📚',
        condition: () => this.data.vocabulary.known >= 50,
        reward: { xp: 100, coins: 30 }
      },
      {
        id: 'vocab_500',
        name: '词汇学霸',
        description: '掌握500个单词',
        icon: '📖',
        condition: () => this.data.vocabulary.known >= 500,
        reward: { xp: 1000, coins: 200 }
      },
      {
        id: 'streak_7',
        name: '连胜冠军',
        description: '连续打卡7天',
        icon: '🔥',
        condition: () => this.data.currentStreak >= 7,
        reward: { xp: 200, coins: 50 }
      },
      {
        id: 'streak_30',
        name: '坚持不懈',
        description: '连续打卡30天',
        icon: '💪',
        condition: () => this.data.currentStreak >= 30,
        reward: { xp: 1000, coins: 200 }
      },
      {
        id: 'perfect_10',
        name: '完美发音',
        description: '获得10次完美分数',
        icon: '🎯',
        condition: () => this.data.stats.perfectScores >= 10,
        reward: { xp: 300, coins: 75 }
      },
      {
        id: 'level_10',
        name: '学霸模式',
        description: '达到10级',
        icon: '⭐',
        condition: () => this.data.level >= 10,
        reward: { xp: 0, coins: 500 }
      }
    ];

    achievements.forEach(achievement => {
      if (!this.data.achievements[achievement.id] && achievement.condition()) {
        this.unlockAchievement(achievement);
      }
    });
  }

  // 解锁成就
  unlockAchievement(achievement) {
    this.data.achievements[achievement.id] = {
      unlockedAt: new Date().toISOString(),
      name: achievement.name,
      description: achievement.description,
      icon: achievement.icon
    };

    // 发放奖励
    if (achievement.reward.xp) {
      this.addXP(achievement.reward.xp, '');
    }
    if (achievement.reward.coins) {
      this.addCoins(achievement.reward.coins, '');
    }

    this.saveData();
    this.showAchievementUnlock(achievement);
  }

  // 显示成就解锁动画
  showAchievementUnlock(achievement) {
    const notification = document.createElement('div');
    notification.className = 'achievement-unlock-notification';
    notification.innerHTML = `
      <div class="achievement-icon">${achievement.icon}</div>
      <div class="achievement-info">
        <div class="achievement-title">🎉 成就解锁！</div>
        <div class="achievement-name">${achievement.name}</div>
        <div class="achievement-description">${achievement.description}</div>
        <div class="achievement-reward">
          ${achievement.reward.xp ? `+${achievement.reward.xp} XP` : ''}
          ${achievement.reward.coins ? `+${achievement.reward.coins} 💰` : ''}
        </div>
      </div>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('show');
    }, 100);

    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 5000);
  }

  // 显示通知
  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `gamification-notification ${type}`;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('show');
    }, 100);

    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // 服务端同步后 data.xp 为累计值,读取时按阈值换算为等级内进度
  getLevelProgress() {
    const level = this.data.level;
    const totalXp = this.data.xp;
    const floor = XP_LEVEL_THRESHOLDS[level - 1] || 0;
    const next = XP_LEVEL_THRESHOLDS[level];
    const xpInLevel = Math.max(0, totalXp - floor);
    if (next === undefined) {
      // 满级:进度视为 100%,无剩余
      return { xp: xpInLevel, xpToNextLevel: xpInLevel, xpProgress: '100.0' };
    }
    const bracket = next - floor;
    return {
      xp: xpInLevel,
      xpToNextLevel: bracket,
      xpProgress: Math.min(100, xpInLevel / bracket * 100).toFixed(1),
    };
  }

  // 获取进度数据
  getProgress() {
    // 已被服务端回填时用阈值换算;纯本地路径保留原几何级数语义
    const levelProgress = this.data.serverSyncedAt
      ? this.getLevelProgress()
      : {
          xp: this.data.xp,
          xpToNextLevel: this.data.xpToNextLevel,
          xpProgress: (this.data.xp / this.data.xpToNextLevel * 100).toFixed(1),
        };
    return {
      level: this.data.level,
      xp: levelProgress.xp,
      xpToNextLevel: levelProgress.xpToNextLevel,
      xpProgress: levelProgress.xpProgress,
      coins: this.data.coins,
      streak: this.data.currentStreak,
      longestStreak: this.data.longestStreak,
      dailyGoal: this.data.dailyGoal,
      dailyProgress: (this.data.dailyGoal.completed / this.data.dailyGoal.target * 100).toFixed(1),
      stats: this.data.stats,
      vocabulary: this.data.vocabulary,
      achievements: Object.keys(this.data.achievements).length,
      totalAchievements: 10 // 总成就数
    };
  }

  // 监听器系统
  listeners = [];

  addListener(callback) {
    this.listeners.push(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => callback(this.getProgress()));
  }

  // 获取所有成就
  getAllAchievements() {
    // 返回所有成就（包括未解锁的）
    return [
      {
        id: 'first_quick_win',
        name: '初次尝试',
        description: '完成首次快速挑战',
        icon: '⚡',
        unlocked: !!this.data.achievements['first_quick_win']
      },
      {
        id: 'first_video',
        name: '视频初体验',
        description: '完成第一个视频',
        icon: '🎬',
        unlocked: !!this.data.achievements['first_video']
      },
      {
        id: 'video_master',
        name: '视频大师',
        description: '完成10个视频',
        icon: '🎥',
        unlocked: !!this.data.achievements['video_master']
      },
      {
        id: 'first_practice',
        name: '实战勇士',
        description: '完成第一次角色扮演',
        icon: '🎪',
        unlocked: !!this.data.achievements['first_practice']
      },
      {
        id: 'practice_master',
        name: '配音大师',
        description: '录制100个句子',
        icon: '🎤',
        unlocked: !!this.data.achievements['practice_master']
      },
      {
        id: 'vocab_50',
        name: '词汇达人',
        description: '掌握50个单词',
        icon: '📚',
        unlocked: !!this.data.achievements['vocab_50']
      },
      {
        id: 'vocab_500',
        name: '词汇学霸',
        description: '掌握500个单词',
        icon: '📖',
        unlocked: !!this.data.achievements['vocab_500']
      },
      {
        id: 'streak_7',
        name: '连胜冠军',
        description: '连续打卡7天',
        icon: '🔥',
        unlocked: !!this.data.achievements['streak_7']
      },
      {
        id: 'streak_30',
        name: '坚持不懈',
        description: '连续打卡30天',
        icon: '💪',
        unlocked: !!this.data.achievements['streak_30']
      },
      {
        id: 'perfect_10',
        name: '完美发音',
        description: '获得10次完美分数',
        icon: '🎯',
        unlocked: !!this.data.achievements['perfect_10']
      },
      {
        id: 'level_10',
        name: '学霸模式',
        description: '达到10级',
        icon: '⭐',
        unlocked: !!this.data.achievements['level_10']
      }
    ];
  }
}

// 创建全局实例
if (typeof window !== 'undefined') {
  window.gamificationSystem = new GamificationSystem();
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GamificationSystem;
}
