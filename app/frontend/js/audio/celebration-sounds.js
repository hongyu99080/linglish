/**
 * Celebration Sounds Manager
 * 庆祝音效管理器
 *
 * 功能：
 * 1. 预加载音效
 * 2. 播放各类庆祝音效
 * 3. 音量控制
 * 4. 静音支持
 */

class CelebrationSounds {
  constructor() {
    this.sounds = {};
    this.volume = 0.5;
    this.muted = false;
    this.loaded = false;
    this.audioContext = null;

    // 音效配置（使用Web Audio API生成简单音效）
    this.soundConfigs = {
      task_complete: {
        frequency: 880,
        duration: 0.15,
        type: 'sine',
        fadeOut: true
      },
      all_tasks_done: {
        frequencies: [523.25, 659.25, 783.99, 1046.50],
        duration: 0.2,
        type: 'sine',
        arpeggio: true
      },
      achievement_unlock: {
        frequencies: [392, 523.25, 659.25, 783.99],
        duration: 0.25,
        type: 'triangle',
        arpeggio: true
      },
      level_up: {
        frequencies: [261.63, 329.63, 392, 523.25, 659.25],
        duration: 0.15,
        type: 'sine',
        arpeggio: true
      },
      streak_milestone: {
        frequencies: [440, 554.37, 659.25, 880],
        duration: 0.3,
        type: 'sine',
        arpeggio: true
      },
      league_promote: {
        frequencies: [392, 493.88, 587.33, 783.99, 987.77],
        duration: 0.2,
        type: 'sine',
        arpeggio: true
      },
      coin_collect: {
        frequency: 1200,
        duration: 0.08,
        type: 'sine'
      },
      xp_gain: {
        frequency: 600,
        duration: 0.1,
        type: 'sine'
      },
      click: {
        frequency: 800,
        duration: 0.05,
        type: 'sine'
      },
      error: {
        frequency: 200,
        duration: 0.3,
        type: 'sawtooth'
      }
    };

    this.loadSettings();
  }

  /**
   * 初始化 AudioContext
   */
  initAudioContext() {
    if (this.audioContext) return;

    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.loaded = true;
    } catch (e) {
      console.warn('Web Audio API not supported:', e);
    }
  }

  /**
   * 加载设置
   */
  loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem('linglish_sound_settings') || '{}');
      this.volume = settings.volume ?? 0.5;
      this.muted = settings.muted ?? false;
    } catch (e) {
      console.warn('Failed to load sound settings:', e);
    }
  }

  /**
   * 保存设置
   */
  saveSettings() {
    try {
      localStorage.setItem('linglish_sound_settings', JSON.stringify({
        volume: this.volume,
        muted: this.muted
      }));
    } catch (e) {
      console.warn('Failed to save sound settings:', e);
    }
  }

  /**
   * 设置音量
   * @param {number} value - 0-1
   */
  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    this.saveSettings();
  }

  /**
   * 设置静音
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = muted;
    this.saveSettings();
  }

  /**
   * 切换静音
   */
  toggleMute() {
    this.muted = !this.muted;
    this.saveSettings();
    return this.muted;
  }

  /**
   * 播放音效
   * @param {string} soundName - 音效名称
   */
  play(soundName) {
    if (this.muted) return;

    // 确保 AudioContext 已初始化
    this.initAudioContext();
    if (!this.audioContext) return;

    // Resume context if suspended (mobile browsers)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const config = this.soundConfigs[soundName];
    if (!config) {
      console.warn(`Sound not found: ${soundName}`);
      return;
    }

    try {
      if (config.arpeggio && config.frequencies) {
        this.playArpeggio(config);
      } else {
        this.playTone(config);
      }
    } catch (e) {
      console.warn('Failed to play sound:', e);
    }
  }

  /**
   * 播放单音
   */
  playTone(config) {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.type = config.type || 'sine';
    oscillator.frequency.value = config.frequency;

    const now = this.audioContext.currentTime;
    const duration = config.duration || 0.1;

    gainNode.gain.setValueAtTime(this.volume * 0.5, now);

    if (config.fadeOut) {
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);
    } else {
      gainNode.gain.setValueAtTime(this.volume * 0.5, now + duration * 0.8);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);
    }

    oscillator.start(now);
    oscillator.stop(now + duration + 0.1);
  }

  /**
   * 播放琶音
   */
  playArpeggio(config) {
    const frequencies = config.frequencies;
    const noteDuration = config.duration || 0.15;
    const now = this.audioContext.currentTime;

    frequencies.forEach((freq, index) => {
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      oscillator.type = config.type || 'sine';
      oscillator.frequency.value = freq;

      const startTime = now + (index * noteDuration * 0.7);
      const endTime = startTime + noteDuration;

      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(this.volume * 0.4, startTime + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.001, endTime);

      oscillator.start(startTime);
      oscillator.stop(endTime + 0.1);
    });
  }

  /**
   * 播放任务完成音效
   */
  playTaskComplete() {
    this.play('task_complete');
  }

  /**
   * 播放全部任务完成音效
   */
  playAllTasksDone() {
    this.play('all_tasks_done');
  }

  /**
   * 播放成就解锁音效
   */
  playAchievementUnlock() {
    this.play('achievement_unlock');
  }

  /**
   * 播放升级音效
   */
  playLevelUp() {
    this.play('level_up');
  }

  /**
   * 播放里程碑音效
   */
  playStreakMilestone() {
    this.play('streak_milestone');
  }

  /**
   * 播放联赛晋级音效
   */
  playLeaguePromotion() {
    this.play('league_promote');
  }

  /**
   * 播放金币收集音效
   */
  playCoinCollect() {
    this.play('coin_collect');
  }

  /**
   * 播放XP获得音效
   */
  playXPGain() {
    this.play('xp_gain');
  }

  /**
   * 播放点击音效
   */
  playClick() {
    this.play('click');
  }

  /**
   * 播放错误音效
   */
  playError() {
    this.play('error');
  }

  /**
   * 预热 AudioContext（用户交互后调用）
   */
  warmUp() {
    this.initAudioContext();
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }
}

// 创建全局实例
if (typeof window !== 'undefined') {
  window.celebrationSounds = new CelebrationSounds();

  // 在用户首次交互时预热 AudioContext
  const warmUpHandler = () => {
    window.celebrationSounds.warmUp();
    document.removeEventListener('click', warmUpHandler);
    document.removeEventListener('touchstart', warmUpHandler);
  };

  document.addEventListener('click', warmUpHandler, { once: true });
  document.addEventListener('touchstart', warmUpHandler, { once: true });
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CelebrationSounds;
}
