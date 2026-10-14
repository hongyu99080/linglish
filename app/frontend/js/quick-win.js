/**
 * Quick Win Challenge - 新用户即时成就体验模块
 * 让用户完成10道题的快速测验，获得XP奖励和鼓励动画
 */

class QuickWinChallenge {
    constructor() {
        this.currentQuestionIndex = 0;
        this.correctCount = 0;
        this.totalQuestions = 10;
        this.answeredQuestions = [];
        this.hasCompleted = false;
        this.modalEl = null;

        // 分层得分统计
        this.levelScores = { beginner: 0, intermediate: 0, advanced: 0 };

        // 分层难度题库：初级5题 + 中级5题 + 高级5题
        this.allQuestions = [
            // ========== 初级词汇 (Beginner) ==========
            {
                type: 'listen',
                word: 'Hello',
                level: 'beginner',
                options: ['你好', '再见', '谢谢', '对不起'],
                correct: 0
            },
            {
                type: 'listen',
                word: 'Apple',
                level: 'beginner',
                options: ['香蕉', '橙子', '苹果', '葡萄'],
                correct: 2
            },
            {
                type: 'listen',
                word: 'Water',
                level: 'beginner',
                options: ['牛奶', '水', '果汁', '咖啡'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Book',
                level: 'beginner',
                options: ['笔', '书', '桌子', '椅子'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Happy',
                level: 'beginner',
                options: ['悲伤', '开心', '愤怒', '疲惫'],
                correct: 1
            },

            // ========== 中级词汇 (Intermediate) ==========
            {
                type: 'listen',
                word: 'Opportunity',
                level: 'intermediate',
                options: ['困难', '机会', '挑战', '责任'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Environment',
                level: 'intermediate',
                options: ['经济', '环境', '政治', '文化'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Experience',
                level: 'intermediate',
                options: ['实验', '经验', '专家', '期望'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Relationship',
                level: 'intermediate',
                options: ['亲戚', '关系', '相对', '宗教'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Achievement',
                level: 'intermediate',
                options: ['协议', '成就', '附件', '争论'],
                correct: 1
            },

            // ========== 高级词汇 (Advanced) ==========
            {
                type: 'listen',
                word: 'Entrepreneurship',
                level: 'advanced',
                options: ['娱乐', '企业家精神', '热情', '入口'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Procrastination',
                level: 'advanced',
                options: ['进步', '专业化', '拖延', '保护'],
                correct: 2
            },
            {
                type: 'listen',
                word: 'Sophisticated',
                level: 'advanced',
                options: ['简单的', '复杂精密的', '愚蠢的', '软件的'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Perseverance',
                level: 'advanced',
                options: ['个性', '坚持不懈', '表演', '许可'],
                correct: 1
            },
            {
                type: 'listen',
                word: 'Unprecedented',
                level: 'advanced',
                options: ['预期的', '史无前例的', '不愉快的', '未准备的'],
                correct: 1
            }
        ];

        this.questions = []; // 当前测验的题目
    }

    // 检查是否已经完成过快速挑战
    hasCompletedBefore() {
        try {
            return localStorage.getItem('linglish_quick_win_done') === 'true';
        } catch (e) {
            return false;
        }
    }

    // 标记已完成
    markCompleted() {
        try {
            localStorage.setItem('linglish_quick_win_done', 'true');
            localStorage.setItem('linglish_quick_win_time', new Date().toISOString());
            localStorage.setItem('linglish_quick_win_score', String(this.correctCount));
        } catch (e) { }
        this.hasCompleted = true;
    }

    // 分层选取题目：初级4题 + 中级3题 + 高级3题 = 10题
    selectQuestions() {
        const byLevel = {
            beginner: this.allQuestions.filter(q => q.level === 'beginner'),
            intermediate: this.allQuestions.filter(q => q.level === 'intermediate'),
            advanced: this.allQuestions.filter(q => q.level === 'advanced')
        };

        const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);

        // 选取: 4初级 + 3中级 + 3高级
        const selected = [
            ...shuffle(byLevel.beginner).slice(0, 4),
            ...shuffle(byLevel.intermediate).slice(0, 3),
            ...shuffle(byLevel.advanced).slice(0, 3)
        ];

        // 打乱顺序
        return shuffle(selected);
    }

    // 获取当前题目
    getCurrentQuestion() {
        return this.questions[this.currentQuestionIndex];
    }

    // 播放单词发音
    playWord(word) {
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(word);
            utterance.lang = 'en-US';
            utterance.rate = 0.9;
            window.speechSynthesis.speak(utterance);
        }
    }

    // 创建模态框
    createModal() {
        if (this.modalEl) return this.modalEl;

        const modal = document.createElement('div');
        modal.className = 'quick-win-modal';
        modal.id = 'quickWinModal';
        modal.innerHTML = `
      <div class="quick-win-panel">
        <button class="quick-win-close" onclick="window.quickWin.close()" aria-label="关闭">×</button>
        
        <div class="quick-win-header">
          <div class="quick-win-icon">⚡</div>
          <h2 class="quick-win-title">10题快速测验</h2>
          <p class="quick-win-subtitle">听一听，选出正确的中文意思</p>
        </div>
        
        <div class="quick-win-progress">
          <div class="progress-bar">
            <div class="progress-fill" id="qwProgressFill"></div>
          </div>
          <div class="progress-text" id="qwProgressText">1 / 10</div>
        </div>
        
        <div class="quick-win-content">
          <div class="quick-win-question">
            <button class="play-btn" id="qwPlayBtn" aria-label="播放发音">
              <span class="play-icon">🔊</span>
              <span class="play-text">点击听发音</span>
            </button>
            <div class="word-display" id="qwWord"></div>
          </div>
          
          <div class="quick-win-options" id="qwOptions"></div>
          
          <div class="quick-win-feedback" id="qwFeedback" hidden></div>
        </div>
        
        <div class="quick-win-result" id="qwResult" hidden>
          <div class="result-icon" id="qwResultIcon"></div>
          <div class="result-title" id="qwResultTitle"></div>
          <div class="result-score" id="qwResultScore"></div>
          <div class="result-level" id="qwResultLevel"></div>
          <div class="result-reward" id="qwResultReward"></div>
          <button class="quick-win-continue" id="qwContinue">开始学习之旅 →</button>
        </div>
        
        <div class="quick-win-footer">
          <a href="#" class="quick-win-skip" onclick="window.quickWin.skip(); return false;">跳过测验</a>
        </div>
      </div>
      
      <div class="confetti-container" id="confettiContainer"></div>
    `;

        document.body.appendChild(modal);
        this.modalEl = modal;
        this.bindEvents();
        return modal;
    }

    // 绑定事件
    bindEvents() {
        const playBtn = document.getElementById('qwPlayBtn');
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                const q = this.getCurrentQuestion();
                if (q) {
                    this.playWord(q.word);
                    playBtn.classList.add('playing');
                    setTimeout(() => playBtn.classList.remove('playing'), 1000);
                }
            });
        }

        const continueBtn = document.getElementById('qwContinue');
        if (continueBtn) {
            continueBtn.addEventListener('click', () => {
                this.close();
                window.location.href = './today.html?from=quick_win';
            });
        }
    }

    // 重置测验状态
    reset() {
        this.currentQuestionIndex = 0;
        this.correctCount = 0;
        this.answeredQuestions = [];
        this.questions = this.selectQuestions(this.totalQuestions);
    }

    // 显示挑战
    show() {
        // 允许用户每次点击都能重新开始测验
        this.reset();
        this.createModal();
        this.renderQuestion();
        this.modalEl.classList.add('active');

        // 延迟自动播放发音
        setTimeout(() => {
            const q = this.getCurrentQuestion();
            if (q) this.playWord(q.word);
        }, 500);

        return true;
    }

    // 更新进度条
    updateProgress() {
        const progressFill = document.getElementById('qwProgressFill');
        const progressText = document.getElementById('qwProgressText');
        const percent = ((this.currentQuestionIndex) / this.totalQuestions) * 100;

        if (progressFill) {
            progressFill.style.width = percent + '%';
        }
        if (progressText) {
            progressText.textContent = `${this.currentQuestionIndex + 1} / ${this.totalQuestions}`;
        }
    }

    // 渲染题目
    renderQuestion() {
        const q = this.getCurrentQuestion();
        if (!q) return;

        const wordEl = document.getElementById('qwWord');
        const optionsEl = document.getElementById('qwOptions');
        const feedbackEl = document.getElementById('qwFeedback');
        const resultEl = document.getElementById('qwResult');
        const contentEl = document.querySelector('.quick-win-content');
        const footerEl = document.querySelector('.quick-win-footer');
        const progressEl = document.querySelector('.quick-win-progress');

        // 显示内容区域
        if (contentEl) contentEl.hidden = false;
        if (footerEl) footerEl.hidden = false;
        if (progressEl) progressEl.hidden = false;
        if (resultEl) resultEl.hidden = true;

        // 更新进度
        this.updateProgress();

        // 隐藏单词，让用户听
        if (wordEl) {
            wordEl.textContent = '???';
            wordEl.classList.add('hidden');
        }

        // 渲染选项
        if (optionsEl) {
            optionsEl.innerHTML = q.options.map((opt, i) => `
                <button class="quick-win-option" data-index="${i}">
                    ${opt}
                </button>
            `).join('');

            // 绑定选项点击
            optionsEl.querySelectorAll('.quick-win-option').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    this.checkAnswer(index);
                });
            });
        }

        // 隐藏反馈
        if (feedbackEl) {
            feedbackEl.hidden = true;
        }
    }

    // 检查答案
    checkAnswer(selectedIndex) {
        const q = this.getCurrentQuestion();
        const isCorrect = selectedIndex === q.correct;

        if (isCorrect) {
            this.correctCount++;
            // 记录分层得分
            if (q.level && this.levelScores[q.level] !== undefined) {
                this.levelScores[q.level]++;
            }
        }

        this.answeredQuestions.push({
            question: q,
            selected: selectedIndex,
            correct: isCorrect
        });

        // 禁用所有选项
        const options = document.querySelectorAll('.quick-win-option');
        options.forEach((opt, i) => {
            opt.disabled = true;
            if (i === q.correct) {
                opt.classList.add('correct');
            } else if (i === selectedIndex && !isCorrect) {
                opt.classList.add('wrong');
            }
        });

        // 显示单词
        const wordEl = document.getElementById('qwWord');
        if (wordEl) {
            wordEl.textContent = q.word;
            wordEl.classList.remove('hidden');
        }

        // 显示反馈
        const feedbackEl = document.getElementById('qwFeedback');
        if (feedbackEl) {
            feedbackEl.hidden = false;
            feedbackEl.className = 'quick-win-feedback ' + (isCorrect ? 'correct' : 'wrong');
            feedbackEl.innerHTML = isCorrect
                ? '✓ 正确！'
                : `✗ 正确答案：${q.options[q.correct]}`;
        }

        // 延迟进入下一题或显示结果
        setTimeout(() => {
            this.currentQuestionIndex++;
            if (this.currentQuestionIndex >= this.totalQuestions) {
                this.showFinalResult();
            } else {
                this.renderQuestion();
                // 自动播放下一题
                const nextQ = this.getCurrentQuestion();
                if (nextQ) this.playWord(nextQ.word);
            }
        }, 1200);
    }

    // 根据分层得分智能判断水平
    getLevel() {
        const { beginner, intermediate, advanced } = this.levelScores;

        // 高级：高级题大部分正确 (>=2/3) 且中级题也过半
        if (advanced >= 2 && intermediate >= 2) {
            return { level: 'advanced', name: '高级', icon: '🌳', desc: '你的英语基础非常棒！推荐挑战高难度内容。' };
        }

        // 中级：中级题大部分正确 (>=2/3) 且初级题全对
        if (intermediate >= 2 && beginner >= 3) {
            return { level: 'intermediate', name: '中级', icon: '🌿', desc: '你有不错的英语基础！继续加油。' };
        }

        // 初级：初级题大部分正确 (>=3/4)
        if (beginner >= 3) {
            return { level: 'beginner', name: '初级', icon: '🌱', desc: '继续努力，你在进步中！' };
        }

        // 入门
        return { level: 'beginner', name: '入门', icon: '🌱', desc: '从这里开始，我们一起学习！' };
    }

    // 显示最终结果
    showFinalResult() {
        const resultEl = document.getElementById('qwResult');
        const iconEl = document.getElementById('qwResultIcon');
        const titleEl = document.getElementById('qwResultTitle');
        const scoreEl = document.getElementById('qwResultScore');
        const levelEl = document.getElementById('qwResultLevel');
        const rewardEl = document.getElementById('qwResultReward');
        const contentEl = document.querySelector('.quick-win-content');
        const footerEl = document.querySelector('.quick-win-footer');
        const progressEl = document.querySelector('.quick-win-progress');

        // 隐藏题目区域
        if (contentEl) contentEl.hidden = true;
        if (footerEl) footerEl.hidden = true;
        if (progressEl) progressEl.hidden = true;

        // 显示结果
        if (resultEl) resultEl.hidden = false;

        const levelInfo = this.getLevel();
        const xpReward = this.correctCount * 5 + 10; // 基础10 + 每题5XP

        if (iconEl) iconEl.textContent = '🎉';
        if (titleEl) titleEl.innerHTML = '测验完成！';
        if (scoreEl) scoreEl.innerHTML = `得分：<strong>${this.correctCount} / ${this.totalQuestions}</strong>`;
        if (levelEl) levelEl.innerHTML = `
            <div class="level-badge">${levelInfo.icon} ${levelInfo.name}</div>
            <div class="level-desc">${levelInfo.desc}</div>
        `;
        if (rewardEl) rewardEl.innerHTML = `<span class="xp-reward">+${xpReward} XP</span>`;

        // 触发彩纸动画
        if (this.correctCount >= 5) {
            this.showConfetti();
        }

        // 发放XP奖励
        this.giveReward(xpReward);

        // 保存推荐等级
        try {
            localStorage.setItem('linglish_active_level', levelInfo.level);
        } catch (e) { }

        this.markCompleted();
    }

    // 发放奖励
    giveReward(xp) {
        if (typeof window.gamificationSystem !== 'undefined') {
            window.gamificationSystem.addXP(xp, '');
            window.gamificationSystem.recordActivity('quick_win_completed', {
                correct: this.correctCount,
                total: this.totalQuestions
            });
        }

        // 显示XP飘字动画
        this.showXPFloat(xp);
    }

    // XP飘字动画
    showXPFloat(xp) {
        const float = document.createElement('div');
        float.className = 'xp-float';
        float.textContent = `+${xp} XP`;

        const rewardEl = document.getElementById('qwResultReward');
        if (rewardEl) {
            rewardEl.appendChild(float);
            setTimeout(() => float.classList.add('animate'), 100);
            setTimeout(() => float.remove(), 2000);
        }
    }

    // 彩纸动画
    showConfetti() {
        const container = document.getElementById('confettiContainer');
        if (!container) return;

        const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#ff9ff3', '#54a0ff'];

        for (let i = 0; i < 50; i++) {
            const confetti = document.createElement('div');
            confetti.className = 'confetti';
            confetti.style.left = Math.random() * 100 + '%';
            confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            confetti.style.animationDelay = Math.random() * 0.5 + 's';
            confetti.style.animationDuration = (Math.random() * 1 + 2) + 's';
            container.appendChild(confetti);
        }

        setTimeout(() => container.innerHTML = '', 3000);
    }

    // 关闭模态框
    close() {
        if (this.modalEl) {
            this.modalEl.classList.remove('active');
        }
    }

    // 跳过
    skip() {
        this.close();
    }
}

// 创建全局实例
if (typeof window !== 'undefined') {
    window.quickWin = new QuickWinChallenge();

    window.showQuickWinIfNeeded = function () {
        const done = window.quickWin.hasCompletedBefore();
        if (!done) {
            setTimeout(() => window.quickWin.show(), 1000);
        }
    };
}
