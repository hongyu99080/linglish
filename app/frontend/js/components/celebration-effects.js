/**
 * Celebration Effects Library
 * 庆祝动画效果库
 *
 * 效果类型：
 * 1. ConfettiEffect - 彩色纸屑飘落
 * 2. FireworksEffect - 烟花绽放
 * 3. StarBurstEffect - 星星爆发
 * 4. GlowPulseEffect - 光晕脉冲
 * 5. ParticleRainEffect - 粒子雨
 */

class CelebrationEffects {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.animationId = null;
    this.isRunning = false;
  }

  /**
   * 初始化画布
   */
  initCanvas() {
    if (this.canvas) return;

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'celebration-canvas';
    this.canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 99998;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.resizeCanvas();

    window.addEventListener('resize', () => this.resizeCanvas());
  }

  /**
   * 调整画布大小
   */
  resizeCanvas() {
    if (!this.canvas) return;
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /**
   * 清理画布
   */
  clearCanvas() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * 停止所有动画
   */
  stop() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.particles = [];
    this.clearCanvas();
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
      this.ctx = null;
    }
  }

  // ============================================================================
  // 纸屑效果
  // ============================================================================

  /**
   * 创建纸屑粒子
   */
  createConfettiParticle(x, y) {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DFE6E9', '#6C5CE7', '#FD79A8'];
    return {
      x: x || Math.random() * this.canvas.width,
      y: y || -10,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
      velocityX: (Math.random() - 0.5) * 3,
      velocityY: Math.random() * 3 + 2,
      gravity: 0.1,
      opacity: 1,
      shape: Math.random() > 0.5 ? 'square' : 'circle'
    };
  }

  /**
   * 更新纸屑粒子
   */
  updateConfettiParticle(particle) {
    particle.x += particle.velocityX;
    particle.velocityY += particle.gravity;
    particle.y += particle.velocityY;
    particle.rotation += particle.rotationSpeed;
    particle.velocityX *= 0.99;

    // 淡出效果
    if (particle.y > this.canvas.height - 100) {
      particle.opacity -= 0.02;
    }

    return particle.y < this.canvas.height + 50 && particle.opacity > 0;
  }

  /**
   * 绘制纸屑粒子
   */
  drawConfettiParticle(particle) {
    this.ctx.save();
    this.ctx.translate(particle.x, particle.y);
    this.ctx.rotate(particle.rotation * Math.PI / 180);
    this.ctx.globalAlpha = particle.opacity;
    this.ctx.fillStyle = particle.color;

    if (particle.shape === 'square') {
      this.ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size);
    } else {
      this.ctx.beginPath();
      this.ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  /**
   * 播放纸屑效果
   * @param {number} duration - 持续时间（毫秒）
   * @param {number} intensity - 强度（1-5）
   */
  playConfetti(duration = 3000, intensity = 3) {
    this.initCanvas();
    this.isRunning = true;

    const startTime = Date.now();
    const particlesPerFrame = intensity * 2;

    const animate = () => {
      if (!this.isRunning) return;

      this.clearCanvas();

      // 添加新粒子
      const elapsed = Date.now() - startTime;
      if (elapsed < duration) {
        for (let i = 0; i < particlesPerFrame; i++) {
          this.particles.push(this.createConfettiParticle());
        }
      }

      // 更新和绘制粒子
      this.particles = this.particles.filter(particle => {
        if (this.updateConfettiParticle(particle)) {
          this.drawConfettiParticle(particle);
          return true;
        }
        return false;
      });

      // 继续动画或结束
      if (this.particles.length > 0 || elapsed < duration) {
        this.animationId = requestAnimationFrame(animate);
      } else {
        this.stop();
      }
    };

    animate();
  }

  // ============================================================================
  // 烟花效果
  // ============================================================================

  /**
   * 创建烟花粒子
   */
  createFireworkParticle(x, y, color) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 5 + 2;
    return {
      x,
      y,
      velocityX: Math.cos(angle) * speed,
      velocityY: Math.sin(angle) * speed,
      color,
      size: Math.random() * 3 + 1,
      opacity: 1,
      gravity: 0.05,
      friction: 0.98,
      trail: [],
      maxTrailLength: 5
    };
  }

  /**
   * 创建烟花爆炸
   */
  createFireworkExplosion(x, y) {
    const colors = ['#FF6B6B', '#FFE66D', '#4ECDC4', '#95E1D3', '#F38181', '#AA96DA'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const particleCount = 50 + Math.floor(Math.random() * 30);

    for (let i = 0; i < particleCount; i++) {
      this.particles.push(this.createFireworkParticle(x, y, color));
    }
  }

  /**
   * 更新烟花粒子
   */
  updateFireworkParticle(particle) {
    // 保存轨迹
    particle.trail.push({ x: particle.x, y: particle.y });
    if (particle.trail.length > particle.maxTrailLength) {
      particle.trail.shift();
    }

    particle.velocityY += particle.gravity;
    particle.velocityX *= particle.friction;
    particle.velocityY *= particle.friction;
    particle.x += particle.velocityX;
    particle.y += particle.velocityY;
    particle.opacity -= 0.015;

    return particle.opacity > 0;
  }

  /**
   * 绘制烟花粒子
   */
  drawFireworkParticle(particle) {
    // 绘制轨迹
    particle.trail.forEach((pos, index) => {
      const alpha = (index / particle.trail.length) * particle.opacity * 0.5;
      this.ctx.beginPath();
      this.ctx.arc(pos.x, pos.y, particle.size * 0.5, 0, Math.PI * 2);
      this.ctx.fillStyle = particle.color;
      this.ctx.globalAlpha = alpha;
      this.ctx.fill();
    });

    // 绘制粒子
    this.ctx.beginPath();
    this.ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    this.ctx.fillStyle = particle.color;
    this.ctx.globalAlpha = particle.opacity;
    this.ctx.fill();

    // 添加发光效果
    this.ctx.shadowBlur = 10;
    this.ctx.shadowColor = particle.color;
  }

  /**
   * 播放烟花效果
   * @param {number} count - 烟花数量
   */
  playFireworks(count = 5) {
    this.initCanvas();
    this.isRunning = true;

    let explosionsCreated = 0;
    let lastExplosion = 0;
    const explosionInterval = 500;

    const animate = () => {
      if (!this.isRunning) return;

      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      // 创建新烟花
      const now = Date.now();
      if (explosionsCreated < count && now - lastExplosion > explosionInterval) {
        const x = Math.random() * this.canvas.width * 0.8 + this.canvas.width * 0.1;
        const y = Math.random() * this.canvas.height * 0.5 + this.canvas.height * 0.1;
        this.createFireworkExplosion(x, y);
        explosionsCreated++;
        lastExplosion = now;
      }

      // 更新和绘制粒子
      this.ctx.shadowBlur = 0;
      this.particles = this.particles.filter(particle => {
        if (this.updateFireworkParticle(particle)) {
          this.drawFireworkParticle(particle);
          return true;
        }
        return false;
      });

      if (this.particles.length > 0 || explosionsCreated < count) {
        this.animationId = requestAnimationFrame(animate);
      } else {
        setTimeout(() => this.stop(), 500);
      }
    };

    animate();
  }

  // ============================================================================
  // 星星爆发效果
  // ============================================================================

  /**
   * 创建星星粒子
   */
  createStarParticle(x, y) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 8 + 4;
    return {
      x,
      y,
      velocityX: Math.cos(angle) * speed,
      velocityY: Math.sin(angle) * speed,
      size: Math.random() * 15 + 10,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 15,
      opacity: 1,
      color: Math.random() > 0.5 ? '#FFD700' : '#FFA500',
      points: 5
    };
  }

  /**
   * 绘制星星
   */
  drawStar(x, y, size, points, color, opacity, rotation) {
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(rotation * Math.PI / 180);
    this.ctx.globalAlpha = opacity;
    this.ctx.fillStyle = color;

    this.ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? size : size / 2;
      const angle = (i * Math.PI) / points - Math.PI / 2;
      if (i === 0) {
        this.ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      } else {
        this.ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
    }
    this.ctx.closePath();
    this.ctx.fill();

    // 发光效果
    this.ctx.shadowBlur = 15;
    this.ctx.shadowColor = color;
    this.ctx.fill();

    this.ctx.restore();
  }

  /**
   * 播放星星爆发效果
   */
  playStarBurst(x = null, y = null, count = 20) {
    this.initCanvas();
    this.isRunning = true;

    const centerX = x || this.canvas.width / 2;
    const centerY = y || this.canvas.height / 2;

    for (let i = 0; i < count; i++) {
      this.particles.push(this.createStarParticle(centerX, centerY));
    }

    const animate = () => {
      if (!this.isRunning) return;

      this.clearCanvas();

      this.particles = this.particles.filter(particle => {
        particle.x += particle.velocityX;
        particle.y += particle.velocityY;
        particle.velocityX *= 0.95;
        particle.velocityY *= 0.95;
        particle.rotation += particle.rotationSpeed;
        particle.opacity -= 0.02;
        particle.size *= 0.98;

        if (particle.opacity > 0) {
          this.drawStar(
            particle.x,
            particle.y,
            particle.size,
            particle.points,
            particle.color,
            particle.opacity,
            particle.rotation
          );
          return true;
        }
        return false;
      });

      if (this.particles.length > 0) {
        this.animationId = requestAnimationFrame(animate);
      } else {
        this.stop();
      }
    };

    animate();
  }

  // ============================================================================
  // 光晕脉冲效果
  // ============================================================================

  /**
   * 播放光晕脉冲效果
   */
  playGlowPulse(color = '#0f766e', duration = 1500) {
    const overlay = document.createElement('div');
    overlay.className = 'glow-pulse-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 99997;
      background: radial-gradient(circle at center, ${color}40 0%, transparent 70%);
      opacity: 0;
      animation: glowPulse ${duration}ms ease-out forwards;
    `;

    // 添加动画样式
    if (!document.getElementById('glow-pulse-style')) {
      const style = document.createElement('style');
      style.id = 'glow-pulse-style';
      style.textContent = `
        @keyframes glowPulse {
          0% { opacity: 0; transform: scale(0.8); }
          30% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(1.5); }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);

    setTimeout(() => overlay.remove(), duration);
  }

  // ============================================================================
  // 粒子雨效果
  // ============================================================================

  /**
   * 创建粒子雨粒子
   */
  createRainParticle() {
    const symbols = ['✨', '⭐', '🌟', '💫', '🎉'];
    return {
      x: Math.random() * this.canvas.width,
      y: -30,
      velocityY: Math.random() * 3 + 2,
      velocityX: (Math.random() - 0.5) * 2,
      size: Math.random() * 20 + 15,
      symbol: symbols[Math.floor(Math.random() * symbols.length)],
      opacity: 1,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 5
    };
  }

  /**
   * 播放粒子雨效果
   */
  playParticleRain(duration = 3000) {
    this.initCanvas();
    this.isRunning = true;

    const startTime = Date.now();

    const animate = () => {
      if (!this.isRunning) return;

      this.clearCanvas();

      const elapsed = Date.now() - startTime;

      // 添加新粒子
      if (elapsed < duration && Math.random() > 0.7) {
        this.particles.push(this.createRainParticle());
      }

      // 更新和绘制粒子
      this.particles = this.particles.filter(particle => {
        particle.y += particle.velocityY;
        particle.x += particle.velocityX;
        particle.rotation += particle.rotationSpeed;

        if (particle.y > this.canvas.height - 100) {
          particle.opacity -= 0.05;
        }

        if (particle.opacity > 0 && particle.y < this.canvas.height + 50) {
          this.ctx.save();
          this.ctx.translate(particle.x, particle.y);
          this.ctx.rotate(particle.rotation * Math.PI / 180);
          this.ctx.globalAlpha = particle.opacity;
          this.ctx.font = `${particle.size}px Arial`;
          this.ctx.textAlign = 'center';
          this.ctx.textBaseline = 'middle';
          this.ctx.fillText(particle.symbol, 0, 0);
          this.ctx.restore();
          return true;
        }
        return false;
      });

      if (this.particles.length > 0 || elapsed < duration) {
        this.animationId = requestAnimationFrame(animate);
      } else {
        this.stop();
      }
    };

    animate();
  }

  // ============================================================================
  // 组合效果
  // ============================================================================

  /**
   * 播放任务完成效果（小型）
   */
  playTaskComplete() {
    this.playStarBurst(null, null, 10);
    this.playGlowPulse('#10B981', 800);
  }

  /**
   * 播放每日目标完成效果（全屏）
   */
  playDailyGoalComplete() {
    this.playConfetti(3000, 4);
    this.playFireworks(3);
    setTimeout(() => this.playGlowPulse('#F59E0B', 1000), 500);
  }

  /**
   * 播放里程碑达成效果
   * @param {string} type - 'standard' | 'epic' | 'legendary'
   */
  playMilestoneEffect(type = 'standard') {
    switch (type) {
      case 'legendary':
        this.playFireworks(8);
        setTimeout(() => this.playConfetti(5000, 5), 1000);
        setTimeout(() => this.playParticleRain(4000), 2000);
        break;
      case 'epic':
        this.playFireworks(5);
        setTimeout(() => this.playConfetti(3000, 4), 500);
        break;
      default:
        this.playStarBurst(null, null, 30);
        this.playConfetti(2000, 2);
    }
  }

  /**
   * 播放升级效果
   */
  playLevelUp() {
    this.playGlowPulse('#8B5CF6', 1200);
    setTimeout(() => this.playStarBurst(null, null, 25), 300);
    setTimeout(() => this.playConfetti(2500, 3), 600);
  }

  /**
   * 播放联赛晋级效果
   */
  playLeaguePromotion() {
    this.playFireworks(6);
    setTimeout(() => this.playConfetti(4000, 4), 800);
    setTimeout(() => this.playGlowPulse('#10B981', 1500), 1500);
  }
}

// 创建全局实例
if (typeof window !== 'undefined') {
  window.celebrationEffects = new CelebrationEffects();
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CelebrationEffects;
}
