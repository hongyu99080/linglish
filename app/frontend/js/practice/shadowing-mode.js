/**
 * Shadowing Mode Manager
 * 跟读模式管理器
 */

class ShadowingMode {
  constructor(options = {}) {
    this.videoPlayer = options.videoPlayer || null;
    this.youtubePlayer = options.youtubePlayer || null;
    this.isYouTubeVideo = options.isYouTubeVideo || false;
    this.state = options.state || {};
    this.getSegmentationMode = options.getSegmentationMode || (() => 'caption');
    this.escapeHtml = options.escapeHtml || ((s) => s);
    this.formatTime = options.formatTime || ((s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

    // Shadowing state
    this.sentences = [];
    this.currentIndex = 0;
    this.autoMode = false;
    this.targetEndTime = null;
    this.stopIndex = null;
    this.sentenceEnded = false;
    this.lastStopIndex = null;
    this.lastStopTime = null;

    // Timers
    this.progressTimer = null;
    this.waitingTimeout = null;
    this.waitingInterval = null;
    this.autoPauseListener = null;

    // DOM references
    this.currentLineEl = null;
    this.statusEl = null;
    this.listEl = null;

    // Callbacks
    this.onStatusChange = options.onStatusChange || null;
    this.onDisplayUpdate = options.onDisplayUpdate || null;
  }

  /**
   * 设置 DOM 元素引用
   */
  setElements(elements) {
    this.currentLineEl = elements.currentLine || null;
    this.statusEl = elements.status || null;
    this.listEl = elements.list || null;
  }

  /**
   * 设置播放器引用
   */
  setPlayer(videoPlayer, youtubePlayer = null, isYouTube = false) {
    this.videoPlayer = videoPlayer;
    this.youtubePlayer = youtubePlayer;
    this.isYouTubeVideo = isYouTube;
  }

  /**
   * 初始化跟读模式
   */
  init(segments) {
    if (Array.isArray(segments) && segments.length) {
      this.sentences = segments.map((seg, i) => {
        const start = Number(seg?.start) || 0;
        const end = Number(seg?.end != null ? seg.end : start) || start;
        return {
          index: i,
          segmentIndex: seg?.index != null ? seg.index : i,
          text: typeof seg?.text === 'string' ? seg.text : '',
          startTime: start,
          endTime: end,
        };
      });
    } else {
      this.sentences = [];
    }

    this.currentIndex = 0;
    this.autoMode = false;
    this.targetEndTime = null;
    this.stopIndex = null;
    this.sentenceEnded = false;

    this.updateDisplay();
    this.updateStatus('准备开始', '⏸️');

    return this.sentences.length;
  }

  /**
   * 计算句子结束时间（带缓冲）
   */
  computeTargetEndTime(sentenceIndex) {
    const sentence = this.sentences[sentenceIndex];
    if (!sentence) return 0;

    const segMode = this.getSegmentationMode();
    const baseEndTime = Number(sentence.endTime);
    const startTime = Number(sentence.startTime);
    const text = sentence.text || '';
    const wordCount = (text.match(/\b[\w']+\b/g) || []).length;

    const nextSentence = this.sentences[sentenceIndex + 1];
    const nextStartTime = nextSentence ? Number(nextSentence.startTime ?? Infinity) : Infinity;
    const hasNext = Number.isFinite(nextStartTime);

    if (segMode === 'caption') {
      // Caption 模式：加一个小缓冲，确保音频完整播放
      // 当句子结束时间等于或接近下一句开始时间时，不要提前停止
      const CAPTION_BUFFER = 0.4; // 400ms 缓冲
      const gapToNext = hasNext ? (nextStartTime - baseEndTime) : Infinity;

      // 如果下一句紧接着开始（间隔小于 0.1 秒），允许播放到句子原始结束时间
      // 这样可以确保最后一个词完整播放
      if (gapToNext <= 0.1) {
        // 紧接句子：播放到原始结束时间，最多延伸一点点到下一句开始
        return Math.min(baseEndTime + 0.15, nextStartTime + 0.05);
      }

      // 有间隔的句子：正常缓冲但不超过下一句开始
      const maxEnd = hasNext ? nextStartTime - 0.05 : baseEndTime + 2;
      return Math.min(baseEndTime + CAPTION_BUFFER, maxEnd);
    }

    const safetyGap = 0.05;
    const OVERLAP_TAIL_SEC = 0.22;
    const gapToNext = hasNext ? (nextStartTime - baseEndTime) : Infinity;
    const maxPossibleEnd = (hasNext && gapToNext <= safetyGap)
      ? (nextStartTime + OVERLAP_TAIL_SEC)
      : (nextStartTime - safetyGap);

    const baseTail = 0.8;
    const extraTail = wordCount > 10 ? 0.3 : (wordCount > 6 ? 0.15 : 0);
    const desiredTarget = baseEndTime + baseTail + extraTail;

    const finalTarget = Math.min(desiredTarget, maxPossibleEnd);
    return Math.max(baseEndTime, finalTarget);
  }

  /**
   * 计算跳转时间
   */
  computeSeekTime(sentenceIndex) {
    const sentence = this.sentences[sentenceIndex];
    if (!sentence) return 0;
    return Number(sentence.startTime ?? 0);
  }

  /**
   * 更新状态显示
   */
  updateStatus(text, icon) {
    if (this.statusEl) {
      const iconEl = this.statusEl.querySelector('.status-icon');
      const textEl = this.statusEl.querySelector('.status-text');
      if (iconEl) iconEl.textContent = icon;
      if (textEl) textEl.textContent = text;
    }
    if (this.onStatusChange) {
      this.onStatusChange(text, icon);
    }
  }

  /**
   * 更新显示
   */
  updateDisplay() {
    const currentSentence = this.sentences[this.currentIndex];
    if (!currentSentence) return;

    if (this.currentLineEl) {
      this.currentLineEl.hidden = false;
      this.currentLineEl.className = 'practice-current-line';
      this.currentLineEl.innerHTML = `
        <div class="practice-current-meta">Line ${this.currentIndex + 1} of ${this.sentences.length}</div>
        <div class="practice-current-text">${this.escapeHtml(currentSentence.text || '')}</div>
        <div class="practice-current-time">${this.formatTime(currentSentence.startTime)} – ${this.formatTime(currentSentence.endTime)}</div>
      `;
    }

    if (this.listEl && getComputedStyle(this.listEl).display !== 'none') {
      const allItems = this.listEl.querySelectorAll('.line-item');
      allItems.forEach((item, index) => {
        item.classList.toggle('current', index === this.currentIndex);
      });
    }

    if (this.onDisplayUpdate) {
      this.onDisplayUpdate(currentSentence, this.currentIndex);
    }
  }

  /**
   * 获取当前时间
   */
  getCurrentTime() {
    if (this.isYouTubeVideo && this.youtubePlayer?.getCurrentTime) {
      return this.youtubePlayer.getCurrentTime();
    }
    return this.videoPlayer?.currentTime || 0;
  }

  /**
   * 暂停视频
   */
  pauseVideo() {
    if (this.isYouTubeVideo && this.youtubePlayer?.pauseVideo) {
      this.youtubePlayer.pauseVideo();
    } else if (this.videoPlayer) {
      this.videoPlayer.pause();
    }
  }

  /**
   * 播放视频
   */
  async playVideo() {
    if (this.isYouTubeVideo && this.youtubePlayer?.playVideo) {
      this.youtubePlayer.playVideo();
    } else if (this.videoPlayer) {
      await this.videoPlayer.play();
    }
  }

  /**
   * 跳转到指定时间
   */
  seekTo(time) {
    if (this.isYouTubeVideo && this.youtubePlayer?.seekTo) {
      this.youtubePlayer.seekTo(time, true);
    } else if (this.videoPlayer) {
      this.videoPlayer.currentTime = time;
    }
  }

  /**
   * 清理定时器
   */
  clearTimers() {
    if (this.waitingTimeout) {
      clearTimeout(this.waitingTimeout);
      this.waitingTimeout = null;
    }
    if (this.waitingInterval) {
      clearInterval(this.waitingInterval);
      this.waitingInterval = null;
    }
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.autoPauseListener && this.videoPlayer) {
      this.videoPlayer.removeEventListener('timeupdate', this.autoPauseListener);
      this.autoPauseListener = null;
    }
  }

  /**
   * 句子结束处理
   */
  onSentenceEnded() {
    if (this.sentenceEnded) return;
    this.sentenceEnded = true;

    const t = this.getCurrentTime();
    if (Number.isFinite(t)) {
      this.lastStopIndex = this.currentIndex;
      this.lastStopTime = t;
    }

    this.clearTimers();
    this.pauseVideo();

    if (this.state) {
      this.state.segmentPlaybackEnd = null;
      this.state.segmentPlaybackCallback = null;
    }

    this.updateStatus('请跟读... (读完后点击"下一句")', '🎙️');
  }

  /**
   * 设置自动暂停监听
   */
  setupAutoPause(targetEndTime) {
    this.clearTimers();
    this.sentenceEnded = false;

    this.progressTimer = setInterval(() => {
      const currentTime = this.getCurrentTime();
      if (currentTime >= targetEndTime && !this.sentenceEnded) {
        this.pauseVideo();
        this.onSentenceEnded();
      }
    }, 30);
  }

  /**
   * 播放当前句子
   */
  async playCurrentSentence() {
    const sentence = this.sentences[this.currentIndex];
    if (!sentence) return;

    this.updateStatus('正在播放...', '▶️');
    this.clearTimers();
    this.sentenceEnded = false;

    const seekTime = this.computeSeekTime(this.currentIndex);
    this.seekTo(seekTime);

    try {
      await this.playVideo();
    } catch (err) {
      console.warn('[Shadowing] Play failed:', err);
      return;
    }

    this.targetEndTime = this.computeTargetEndTime(this.currentIndex);
    this.stopIndex = this.currentIndex;
    this.setupAutoPause(this.targetEndTime);
    this.updateDisplay();
  }

  /**
   * 开始自动跟读
   */
  async start() {
    this.autoMode = true;
    if (this.state) this.state.autoMode = true;

    document.body.classList.add('immersive-active');
    await this.playCurrentSentence();
  }

  /**
   * 暂停跟读
   */
  pause() {
    this.autoMode = false;
    if (this.state) this.state.autoMode = false;

    document.body.classList.remove('immersive-active');
    this.clearTimers();
    this.pauseVideo();
    this.updateStatus('已暂停', '⏸️');
  }

  /**
   * 重播当前句子
   */
  async replay() {
    this.sentenceEnded = true;
    this.clearTimers();
    await this.playCurrentSentence();
  }

  /**
   * 下一句
   */
  async next() {
    this.sentenceEnded = true;
    this.clearTimers();

    if (this.currentIndex < this.sentences.length - 1) {
      this.currentIndex++;
      this.updateDisplay();
      await this.playCurrentSentence();
    } else {
      this.updateStatus('已经是最后一句了', '🏁');
    }
  }

  /**
   * 上一句
   */
  async previous() {
    this.sentenceEnded = true;
    this.clearTimers();

    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.updateDisplay();
      await this.playCurrentSentence();
    }
  }

  /**
   * 跳转到指定句子
   */
  async jumpTo(index) {
    if (index < 0 || index >= this.sentences.length) return;
    this.sentenceEnded = true;
    this.clearTimers();
    this.currentIndex = index;
    this.updateDisplay();
    await this.playCurrentSentence();
  }

  /**
   * 获取当前状态
   */
  getState() {
    return {
      currentIndex: this.currentIndex,
      totalSentences: this.sentences.length,
      autoMode: this.autoMode,
      currentSentence: this.sentences[this.currentIndex] || null,
    };
  }

  /**
   * 销毁
   */
  destroy() {
    this.clearTimers();
    this.sentences = [];
    this.currentIndex = 0;
    this.autoMode = false;
  }
}

// 导出
window.ShadowingMode = ShadowingMode;
