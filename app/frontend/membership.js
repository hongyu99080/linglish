/**
 * linglish 会员权限系统
 */

class MembershipSystem {
  constructor() {
    this.storageKey = 'linglish_membership';
    this.data = this.loadData();
  }

  // 加载会员数据
  loadData() {
    const stored = localStorage.getItem(this.storageKey);
    if (stored && stored !== 'undefined' && stored !== 'null') {
      try {
        return JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse membership data:', e);
      }
    }

    // 默认免费会员
    return {
      tier: 'free', // free, vip, admin
      joinDate: new Date().toISOString(),
      expiryDate: null,
      features: this.getFeaturesByTier('free')
    };
  }

  // 保存数据
  saveData() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.data));
  }

  // 获取会员等级对应的权限
  getFeaturesByTier(tier) {
    const features = {
      free: {
        name: '免费会员',
        icon: '🆓',
        color: '#94a3b8',
        maxVideos: 3,
        maxVideoSize: 30, // MB
        videoDuration: 7, // 天
        canShare: true,
        canUploadLongVideo: false,
        maxVideoLength: 10, // 分钟
        features: [
          '✅ 上传3个视频',
          '✅ 每个视频最大30MB',
          '✅ 视频保存7天',
          '✅ 基础学习功能',
          '✅ 申请分享优质视频',
          '❌ 无限制上传',
          '❌ 长期保存',
          '❌ 高级统计'
        ]
      },
      svip: {
        name: 'SVIP',
        icon: '👑',
        color: '#0ea5e9',
        maxVideos: 300,
        maxVideoSize: 300, // MB
        videoDuration: 365, // 天
        canShare: true,
        canUploadLongVideo: true,
        maxVideoLength: 180, // 分钟
        features: [
          '✅ 上传300个视频',
          '✅ 每个视频最大300MB',
          '✅ 视频保存365天',
          '✅ 支持批量上传',
          '✅ 所有学习功能',
          '✅ 优先客服支持'
        ]
      },
      family: {
        name: '家庭VIP',
        icon: '👨‍👩‍👧‍👦',
        color: '#22c55e',
        maxVideos: 50,
        maxVideoSize: 500, // MB
        videoDuration: 365, // 天
        canShare: true,
        canUploadLongVideo: true,
        maxVideoLength: 120, // 分钟
        features: [
          '✅ 上传50个视频',
          '✅ 每个视频最大500MB',
          '✅ 视频保存365天',
          '✅ 所有学习功能',
          '✅ 可新增6个家庭成员',
          '✅ 无广告体验',
          '✅ 优先客服支持'
        ]
      },
      vip: {
        name: 'VIP会员',
        icon: '💎',
        color: '#f59e0b',
        maxVideos: 50,
        maxVideoSize: 500, // MB
        videoDuration: 365, // 天
        canShare: true,
        canUploadLongVideo: true,
        maxVideoLength: 120, // 分钟
        features: [
          '✅ 上传50个视频',
          '✅ 每个视频最大500MB',
          '✅ 视频保存365天',
          '✅ 所有学习功能',
          '✅ 优先分享审核',
          '✅ 高级统计分析',
          '✅ 无广告体验',
          '✅ 优先客服支持'
        ]
      },
      // 管理员仅保留在内部使用需要时启用
      // admin: {
      //   name: '管理员',
      //   icon: '👑',
      //   color: '#f97316',
      //   maxVideos: Infinity,
      //   maxVideoSize: Infinity,
      //   videoDuration: Infinity,
      //   canShare: true,
      //   canUploadLongVideo: true,
      //   maxVideoLength: Infinity,
      //   canReview: true,
      //   canFeature: true,
      //   features: [
      //     '✅ 无限制上传',
      //     '✅ 无大小限制',
      //     '✅ 永久保存',
      //     '✅ 所有功能',
      //     '✅ 审核分享视频',
      //     '✅ 加精视频',
      //     '✅ 用户管理',
      //     '✅ 数据分析'
      //   ]
      // }
    };

    return features[tier] || features.free;
  }

  // 获取当前会员等级
  getTier() {
    // 检查是否过期
    if (this.data.expiryDate && new Date(this.data.expiryDate) < new Date()) {
      this.data.tier = 'free';
      this.data.features = this.getFeaturesByTier('free');
      this.saveData();
    }
    return this.data.tier;
  }

  // 获取当前会员信息
  getMembershipInfo() {
    const tier = this.getTier();
    const features = this.data.features;

    return {
      tier,
      ...features,
      joinDate: this.data.joinDate,
      expiryDate: this.data.expiryDate,
      isExpired: this.data.expiryDate && new Date(this.data.expiryDate) < new Date(),
      daysLeft: this.data.expiryDate ? Math.max(0, Math.ceil((new Date(this.data.expiryDate) - new Date()) / (1000 * 60 * 60 * 24))) : null
    };
  }

  // 升级会员
  upgradeTier(newTier, durationDays = 365) {
    void newTier;
    void durationDays;

    this.showNotification('请通过安全支付页面开通会员，支付成功后服务器会自动同步权益。', 'info');

    try {
      setTimeout(() => {
        window.location.href = './pricing.html#plans';
      }, 350);
    } catch (_) {}

    return false;
  }

  // 检查是否可以上传视频
  canUploadVideo(currentVideoCount, videoSize) {
    const info = this.getMembershipInfo();

    // 检查数量限制
    if (currentVideoCount >= info.maxVideos) {
      return {
        allowed: false,
        reason: `${info.name}最多上传${info.maxVideos}个视频`,
        type: 'count'
      };
    }

    // 检查大小限制
    const videoSizeMB = videoSize / (1024 * 1024);
    if (videoSizeMB > info.maxVideoSize) {
      return {
        allowed: false,
        reason: `${info.name}单个视频最大${info.maxVideoSize}MB`,
        type: 'size',
        maxSize: info.maxVideoSize
      };
    }

    return {
      allowed: true,
      expiresIn: info.videoDuration
    };
  }

  // 显示通知
  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `membership-notification ${type}`;
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

  // 显示升级提示
  showUpgradePrompt(reason) {
    const modal = document.createElement('div');
    modal.className = 'membership-modal';
    modal.innerHTML = `
      <div class="membership-modal-content">
        <div class="upgrade-prompt">
          <div class="upgrade-icon">Pro</div>
          <h2>升级会员解锁完整训练闭环</h2>
          <p class="upgrade-reason">${reason}</p>
          <div class="upgrade-benefits">
            <div class="benefit-item">更高频 AI 口语反馈</div>
            <div class="benefit-item">Shadowing / Dictogloss / 4-3-2 全模式</div>
            <div class="benefit-item">真实视频、字幕与 PDF 内容导入</div>
            <div class="benefit-item">错句、生词和表达自动复习</div>
          </div>
          <div class="upgrade-actions">
            <button class="upgrade-btn primary" onclick="window.location.href='./pricing.html#plans';">
              查看会员方案
            </button>
            <button class="upgrade-btn secondary" onclick="this.closest('.membership-modal').remove();">
              稍后再说
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    setTimeout(() => {
      modal.classList.add('show');
    }, 100);
  }
}

// 视频管理系统
class VideoManagementSystem {
  constructor() {
    this.storageKey = 'linglish_video_meta';
    this.videos = this.loadVideos();
  }

  // 加载视频元数据
  loadVideos() {
    const stored = localStorage.getItem(this.storageKey);
    if (stored && stored !== 'undefined' && stored !== 'null') {
      try {
        return JSON.parse(stored);
      } catch (e) {
        console.error('Failed to parse video metadata:', e);
      }
    }
    return {};
  }

  // 保存视频元数据
  saveVideos() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.videos));
  }

  // 添加视频
  addVideo(videoId, metadata) {
    const membershipInfo = membershipSystem.getMembershipInfo();

    this.videos[videoId] = {
      id: videoId,
      title: metadata.title || 'Untitled',
      uploadDate: new Date().toISOString(),
      expiryDate: this.calculateExpiryDate(membershipInfo.videoDuration),
      size: metadata.size || 0,
      duration: metadata.duration || 0,
      language: metadata.language || 'en',
      status: 'active', // active, expired, featured, shared
      isShared: false,
      isFeatured: false,
      shareRequestDate: null,
      featureDate: null,
      views: 0,
      likes: 0
    };

    this.saveVideos();
    return this.videos[videoId];
  }

  // 计算过期日期
  calculateExpiryDate(days) {
    if (days === Infinity) return null;

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    return expiryDate.toISOString();
  }

  // 获取视频信息
  getVideo(videoId) {
    return this.videos[videoId];
  }

  // 获取用户所有视频
  getUserVideos() {
    return Object.values(this.videos).sort((a, b) =>
      new Date(b.uploadDate) - new Date(a.uploadDate)
    );
  }

  // 检查视频是否过期
  isVideoExpired(videoId) {
    const video = this.videos[videoId];
    if (!video || !video.expiryDate) return false;
    if (video.isFeatured) return false; // 加精视频不过期

    return new Date(video.expiryDate) < new Date();
  }

  // 获取即将过期的视频
  getExpiringVideos(days = 3) {
    const now = new Date();
    const threshold = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    return Object.values(this.videos).filter(video => {
      if (!video.expiryDate || video.isFeatured) return false;
      const expiryDate = new Date(video.expiryDate);
      return expiryDate > now && expiryDate <= threshold;
    });
  }

  // 申请分享视频
  async requestShare(videoId) {
    return this.submitReviewRequest(videoId, 'public');
  }

  // 批准分享（管理员）
  approveShare(videoId) {
    void videoId;
    return false;
  }

  // 加精视频（管理员）
  async featureVideo(videoId) {
    return this.submitReviewRequest(videoId, 'featured');
  }

  getAuthToken() {
    const keys = ['linglish_token', 'authToken'];
    for (const key of keys) {
      try {
        const value = localStorage.getItem(key) || sessionStorage.getItem(key);
        if (value && value !== 'null' && value !== 'undefined') return value;
      } catch (_) {}
    }
    return null;
  }

  async submitReviewRequest(videoId, requestType) {
    const token = this.getAuthToken();
    if (!token) {
      membershipSystem.showNotification('请先登录后再提交审核。', 'info');
      return false;
    }
    try {
      const response = await fetch('/api/video-share-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          video_id: videoId,
          request_type: requestType
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.message || '审核请求提交失败');
      const label = requestType === 'featured' ? '精选' : '公开分享';
      membershipSystem.showNotification(data?.request?.already_pending ? `${label}申请已在审核中。` : `${label}申请已提交。`, 'success');
      return data;
    } catch (err) {
      membershipSystem.showNotification(err.message || '审核请求提交失败', 'error');
      return false;
    }
  }

  // 获取剩余天数
  getDaysLeft(videoId) {
    const video = this.videos[videoId];
    if (!video || !video.expiryDate || video.isFeatured) return Infinity;

    const now = new Date();
    const expiry = new Date(video.expiryDate);
    const diffTime = expiry - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return Math.max(0, diffDays);
  }

  // 删除过期视频
  deleteExpiredVideos() {
    const expiredIds = Object.keys(this.videos).filter(id => this.isVideoExpired(id));

    expiredIds.forEach(id => {
      delete this.videos[id];
    });

    if (expiredIds.length > 0) {
      this.saveVideos();
      membershipSystem.showNotification(`🗑️ 已删除${expiredIds.length}个过期视频`, 'info');
    }

    return expiredIds.length;
  }
}

// 创建全局实例
if (typeof window !== 'undefined') {
  window.membershipSystem = new MembershipSystem();
  window.videoManagementSystem = new VideoManagementSystem();
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MembershipSystem, VideoManagementSystem };
}
