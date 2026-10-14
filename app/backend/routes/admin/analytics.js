const path = require('path');
const fsp = require('fs/promises');
const dataStore = require('../../data-store');
const { sendJson, sendError, mapErrorToStatus } = require('../../middleware/error-handler');
const { authenticate } = require('../../middleware/auth');
const { requireAiVocabToken } = require('../../middleware/ai-auth');
const { parseBody } = require('../../utils/parsers');

const STATIC_DIR = path.join(__dirname, '../../public');

/**
 * Check if user is admin and throw error if not
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {Promise<Object>} Admin user object
 */
async function requireAdmin(req) {
  const u = await authenticate(req);
  if (!u?.is_admin) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
  return u;
}

/**
 * Check if request has admin auth OR valid AI token (for MCP access)
 * @param {http.IncomingMessage} req - HTTP request object
 * @returns {Promise<Object>} Auth context
 */
async function requireAdminOrAiToken(req) {
  // Try admin auth first
  try {
    const u = await authenticate(req);
    if (u?.is_admin) {
      return { type: 'admin', user: u };
    }
  } catch (_) {
    // Admin auth failed, try AI token
  }

  // Try AI token
  try {
    const aiAuth = requireAiVocabToken(req);
    return { type: 'ai', ...aiAuth };
  } catch (_) {
    // AI token also failed
  }

  const err = new Error('UNAUTHORIZED');
  err.status = 401;
  throw err;
}

/**
 * Helper function to serialize video resource data
 * @param {Object} video - Video resource object
 * @returns {Object} Serialized video data
 */
function serializeVideoResource(video) {
  // Check if transcript_segments has bilingual subtitles (any segment with translation)
  let hasBilingual = false;
  if (video.transcript_segments) {
    try {
      const segments = typeof video.transcript_segments === 'string'
        ? JSON.parse(video.transcript_segments)
        : video.transcript_segments;
      if (Array.isArray(segments) && segments.length > 0) {
        hasBilingual = segments.some(seg => seg && seg.translation && seg.translation.trim());
      }
    } catch (_) {
      hasBilingual = false;
    }
  }

  // Normalize tags to string[]
  let tags = [];
  if (Array.isArray(video.tags)) {
    tags = video.tags.map(String);
  } else if (video.tags && typeof video.tags === 'string') {
    try {
      const parsed = JSON.parse(video.tags);
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch (_) {
      tags = [];
    }
  }

  return {
    id: video.id,
    uploader_id: video.uploader_id ?? null,
    title: video.title,
    description: video.description,
    video_path: video.video_path,
    youtube_video_id: video.youtube_video_id || null,
    thumbnail_path: (typeof video.thumbnail_path === 'string' && video.thumbnail_path.includes('${')) ? null : video.thumbnail_path,
    original_filename: video.original_filename,
    duration_sec: video.duration_sec,
    status: video.status,
    failure_reason: video.failure_reason,
    // metadata
    file_size: video.file_size,
    mime_type: video.mime_type,
    file_hash: video.file_hash,
    view_count: video.view_count || 0,
    is_vip_only: !!video.is_vip_only,
    difficulty_level: video.difficulty_level || null,
    category: video.category || null,
    // tag + secondary tag
    tags,
    collection_name: video.collection_name || null,
    // timestamps
    created_at: video.created_at,
    updated_at: video.updated_at,
    // computed
    has_bilingual: hasBilingual,
  };
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(numerator, denominator) {
  const n = numeric(numerator);
  const d = numeric(denominator);
  if (d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10;
}

function stepByKey(stats, key) {
  return (stats?.steps || []).find(step => step.key === key) || {};
}

function lastDailyValue(rows, field) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  return numeric(rows[rows.length - 1]?.[field]);
}

function addRecommendation(recommendations, condition, item) {
  if (condition) recommendations.push(item);
}

function buildGrowthOverview({
  days,
  firstDayActivation,
  onboarding,
  today,
  retention,
  pricing,
  reportGrowth,
  teamLeads,
}) {
  const firstDaySummary = firstDayActivation?.summary || {};
  const firstDayRegistered = numeric(firstDaySummary.registered_users);
  const firstDayTodayEntered = numeric(firstDaySummary.today_entered_users);
  const firstDayTrainingStarted = numeric(firstDaySummary.training_started_users);
  const firstDayPracticeCompleted = numeric(firstDaySummary.practice_completed_users);
  const firstDayUpgradeIntent = numeric(firstDaySummary.upgrade_intent_users);
  const firstDayTrainingRate = numeric(firstDaySummary.training_start_rate);
  const firstDayPracticeRate = numeric(firstDaySummary.practice_completion_rate);

  const onboardingStarted = numeric(stepByKey(onboarding, 'started').events);
  const onboardingCompleted = numeric(stepByKey(onboarding, 'completed').events);
  const onboardingTodayEntered = numeric(stepByKey(onboarding, 'today_entered').events);
  const profileSynced = numeric(stepByKey(onboarding, 'profile_synced').events);
  const onboardingCompletionRate = percentage(onboardingCompleted, onboardingStarted);
  const onboardingTodayRate = percentage(onboardingTodayEntered, onboardingCompleted);

  const todayViews = numeric(stepByKey(today, 'workspace_view').events);
  const todayActionClicks = numeric(stepByKey(today, 'next_action_click').events);
  const todayVideoUsers = numeric(stepByKey(today, 'video_watch').users);
  const todayPracticeUsers = numeric(stepByKey(today, 'practice_completed').users);
  const todayCommitments = numeric(stepByKey(today, 'next_session_commitment').events);
  const todayActivationRate = percentage(todayActionClicks, todayViews);

  const retentionSummary = retention?.summary || {};
  const d1RetentionRate = numeric(retentionSummary.d1_retention_rate);
  const fullLoopRate = numeric(retentionSummary.full_loop_rate);
  const returningRate = numeric(retentionSummary.returning_rate);

  const pricingViews = numeric(stepByKey(pricing, 'page_view').events);
  const upgradeClicks = numeric(stepByKey(pricing, 'upgrade_click').events);
  const checkoutStarted = numeric(stepByKey(pricing, 'checkout_started').events);
  const paidConfirmed = numeric(stepByKey(pricing, 'entitlement_active').events);
  const pricingUpgradeRate = percentage(upgradeClicks, pricingViews);
  const checkoutStartRate = percentage(checkoutStarted, pricingViews);
  const paidConversionRate = percentage(paidConfirmed, pricingViews);

  const reportViews = numeric(stepByKey(reportGrowth, 'report_view').events);
  const reportShares = numeric(stepByKey(reportGrowth, 'share_action').events);
  const reportCommitments = numeric(stepByKey(reportGrowth, 'next_commitment').events);
  const reportShareRate = percentage(reportShares, reportViews);

  const leadSummary = teamLeads?.summary || {};
  const totalLeads = numeric(leadSummary.total_leads);
  const qualifiedLeads = numeric(leadSummary.qualified_leads) + numeric(leadSummary.won_leads);
  const contactedLeads = numeric(leadSummary.contacted_leads);
  const wonLeads = numeric(leadSummary.won_leads);
  const leadQualificationRate = percentage(qualifiedLeads, totalLeads);

  const stages = [
    {
      key: 'first_day_activation',
      label: '首日激活',
      primary: firstDayTrainingRate,
      primary_label: '首日训练率',
      volume: firstDayRegistered,
      volume_label: '新注册用户',
      detail: `进入 Today ${firstDayTodayEntered}，完成跟读 ${firstDayPracticeCompleted}，升级意向 ${firstDayUpgradeIntent}`,
      status: firstDayRegistered === 0
        ? 'watch'
        : (firstDayTrainingRate >= 45 ? 'good' : (firstDayTrainingRate >= 25 ? 'watch' : 'risk')),
    },
    {
      key: 'onboarding',
      label: '测评引导',
      primary: onboardingCompletionRate,
      primary_label: '完成率',
      volume: onboardingStarted,
      volume_label: '开始测评',
      detail: `完成 ${onboardingCompleted}，进入 Today ${onboardingTodayEntered}，登录同步画像 ${profileSynced}`,
      status: onboardingCompletionRate >= 70 ? 'good' : (onboardingCompletionRate >= 45 ? 'watch' : 'risk'),
    },
    {
      key: 'activation',
      label: 'Today 激活',
      primary: todayActivationRate,
      primary_label: '行动点击率',
      volume: todayViews,
      volume_label: '工作台访问',
      detail: `视频用户 ${todayVideoUsers}，跟读用户 ${todayPracticeUsers}，下次训练承诺 ${todayCommitments}`,
      status: todayActivationRate >= 45 ? 'good' : (todayActivationRate >= 25 ? 'watch' : 'risk'),
    },
    {
      key: 'retention',
      label: '训练留存',
      primary: d1RetentionRate,
      primary_label: 'D1 留存',
      volume: numeric(retentionSummary.training_users),
      volume_label: '训练用户',
      detail: `回访率 ${returningRate}%，完整闭环率 ${fullLoopRate}%，当前连续训练用户 ${numeric(retentionSummary.current_streak_users)}`,
      status: d1RetentionRate >= 25 ? 'good' : (d1RetentionRate >= 12 ? 'watch' : 'risk'),
    },
    {
      key: 'revenue',
      label: '付费转化',
      primary: paidConversionRate,
      primary_label: '定价页付费率',
      volume: pricingViews,
      volume_label: '定价页访问',
      detail: `升级点击 ${upgradeClicks}，Checkout ${checkoutStarted}，权益生效 ${paidConfirmed}`,
      status: paidConversionRate >= 3 ? 'good' : (checkoutStartRate >= 4 ? 'watch' : 'risk'),
    },
    {
      key: 'referral',
      label: '周报传播',
      primary: reportShareRate,
      primary_label: '分享率',
      volume: reportViews,
      volume_label: '周报查看',
      detail: `分享/复制 ${reportShares}，下次训练承诺 ${reportCommitments}`,
      status: reportShareRate >= 20 ? 'good' : (reportShareRate >= 8 ? 'watch' : 'risk'),
    },
    {
      key: 'b2b',
      label: '团队线索',
      primary: leadQualificationRate,
      primary_label: '合格率',
      volume: totalLeads,
      volume_label: '线索数',
      detail: `已联系 ${contactedLeads}，合格 ${qualifiedLeads}，成交 ${wonLeads}`,
      status: totalLeads === 0 ? 'watch' : (leadQualificationRate >= 25 ? 'good' : 'risk'),
    },
  ];

  const dailyByDate = new Map();
  function mergeDaily(rows, mapper) {
    (rows || []).forEach((row) => {
      const date = String(row.date || '').slice(0, 10);
      if (!date) return;
      const current = dailyByDate.get(date) || { date };
      Object.assign(current, mapper(row));
      dailyByDate.set(date, current);
    });
  }

  mergeDaily(today?.daily, row => ({
    today_views: numeric(row.workspace_views),
    today_actions: numeric(row.next_action_clicks),
    today_practice: numeric(row.practice_completed),
  }));
  mergeDaily(firstDayActivation?.daily, row => ({
    first_day_registered: numeric(row.registered_users),
    first_day_today_entered: numeric(row.today_entered_users),
    first_day_training_started: numeric(row.training_started_users),
    first_day_practice_completed: numeric(row.practice_completed_users),
  }));
  mergeDaily(retention?.daily, row => ({
    active_training_users: numeric(row.active_users),
    full_loop_users: numeric(row.full_loop_users),
    retained_next_day_users: numeric(row.retained_next_day_users),
  }));
  mergeDaily(pricing?.daily, row => ({
    pricing_views: numeric(row.page_views),
    checkout_started: numeric(row.checkout_started),
    paid_confirmed: numeric(row.entitlement_active),
  }));
  mergeDaily(reportGrowth?.daily, row => ({
    report_views: numeric(row.report_views),
    report_shares: numeric(row.share_actions),
  }));
  mergeDaily(teamLeads?.daily, row => ({
    team_leads: numeric(row.leads),
    qualified_team_leads: numeric(row.qualified_or_won),
  }));

  const daily = Array.from(dailyByDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({
      today_views: 0,
      today_actions: 0,
      today_practice: 0,
      first_day_registered: 0,
      first_day_today_entered: 0,
      first_day_training_started: 0,
      first_day_practice_completed: 0,
      active_training_users: 0,
      full_loop_users: 0,
      retained_next_day_users: 0,
      pricing_views: 0,
      checkout_started: 0,
      paid_confirmed: 0,
      report_views: 0,
      report_shares: 0,
      team_leads: 0,
      qualified_team_leads: 0,
      ...row,
    }));

  const recommendations = [];
  addRecommendation(recommendations, firstDayRegistered >= 5 && firstDayTrainingRate < 25, {
    priority: 'high',
    area: '首日激活',
    title: '把注册后第一步改成可立即完成的训练',
    detail: '新注册用户首日训练率低于 25%，优先检查注册回跳、Today 首屏主按钮和第一条素材加载速度。',
  });
  addRecommendation(recommendations, firstDayRegistered >= 5 && firstDayPracticeRate < 12, {
    priority: 'medium',
    area: '首日激活',
    title: '降低首次跟读完成门槛',
    detail: '首日完成跟读偏低，建议提供 1 句试玩、默认短素材和完成后即时正反馈。',
  });
  addRecommendation(recommendations, onboardingStarted > 0 && onboardingCompletionRate < 55, {
    priority: 'high',
    area: '测评引导',
    title: '降低首次测评摩擦',
    detail: '完成率低于 55%，优先检查题目长度、跳过入口和生成 Today 的等待反馈。',
  });
  addRecommendation(recommendations, todayViews > 0 && todayActivationRate < 30, {
    priority: 'high',
    area: 'Today 激活',
    title: '把首个训练动作放得更明确',
    detail: 'Today 访问后行动点击不足，优先强化第一张推荐素材和主按钮文案。',
  });
  addRecommendation(recommendations, numeric(retentionSummary.training_users) > 5 && d1RetentionRate < 15, {
    priority: 'high',
    area: '训练留存',
    title: '补强次日回访触发',
    detail: 'D1 留存偏低，优先测试下次训练承诺、周报提醒和复习任务提醒。',
  });
  addRecommendation(recommendations, pricingViews > 0 && pricingUpgradeRate < 8, {
    priority: 'medium',
    area: '付费转化',
    title: '重写定价页主价值证明',
    detail: '定价页升级点击偏低，应突出 AI 反馈频率、学习结果和退款/试用承诺。',
  });
  addRecommendation(recommendations, checkoutStarted > 0 && paidConfirmed === 0, {
    priority: 'high',
    area: '付费转化',
    title: '排查支付回访与权益同步',
    detail: '已有 checkout 但没有权益生效事件，优先检查支付回调、状态轮询和 token 透传。',
  });
  addRecommendation(recommendations, reportViews > 0 && reportShareRate < 10, {
    priority: 'medium',
    area: '周报传播',
    title: '让周报更像可分享战绩',
    detail: '分享率偏低，优先优化摘要文案、邀请链接收益和移动端复制体验。',
  });
  addRecommendation(recommendations, totalLeads > 0 && contactedLeads === 0, {
    priority: 'high',
    area: '团队线索',
    title: '尽快建立销售跟进 SLA',
    detail: '已有团队线索但尚未标记联系，建议 24 小时内完成首次触达。',
  });
  if (!recommendations.length) {
    recommendations.push({
      priority: 'normal',
      area: '增长节奏',
      title: '继续扩大有效流量样本',
      detail: '核心链路暂无明显红灯，下一步关注样本量、渠道质量和训练完成后的转介绍。',
    });
  }

  return {
    days,
    summary: {
      first_day_registered_users: firstDayRegistered,
      first_day_today_entered_users: firstDayTodayEntered,
      first_day_training_started_users: firstDayTrainingStarted,
      first_day_practice_completed_users: firstDayPracticeCompleted,
      first_day_upgrade_intent_users: firstDayUpgradeIntent,
      first_day_training_rate: firstDayTrainingRate,
      first_day_practice_rate: firstDayPracticeRate,
      onboarding_started: onboardingStarted,
      onboarding_completed: onboardingCompleted,
      onboarding_completion_rate: onboardingCompletionRate,
      onboarding_today_rate: onboardingTodayRate,
      today_views: todayViews,
      today_action_clicks: todayActionClicks,
      today_activation_rate: todayActivationRate,
      today_commitments: todayCommitments,
      training_users: numeric(retentionSummary.training_users),
      active_user_days: numeric(retentionSummary.active_user_days),
      d1_retention_rate: d1RetentionRate,
      returning_rate: returningRate,
      full_loop_rate: fullLoopRate,
      pricing_views: pricingViews,
      pricing_upgrade_rate: pricingUpgradeRate,
      checkout_started: checkoutStarted,
      checkout_start_rate: checkoutStartRate,
      paid_confirmed: paidConfirmed,
      paid_conversion_rate: paidConversionRate,
      report_views: reportViews,
      report_shares: reportShares,
      report_share_rate: reportShareRate,
      team_leads: totalLeads,
      qualified_team_leads: qualifiedLeads,
      lead_qualification_rate: leadQualificationRate,
      today_active_training_users: lastDailyValue(retention?.daily, 'active_users'),
    },
    stages,
    daily,
    recommendations,
    source: {
      first_day_activation: firstDayActivation,
      onboarding,
      today,
      retention,
      pricing,
      report_growth: reportGrowth,
      team_leads: teamLeads,
    },
  };
}

/**
 * Register and handle admin analytics and usage routes
 * @param {string} pathname - URL pathname
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {http.ServerResponse} res - HTTP response object
 * @param {URL} url - URL object for query parameters
 * @returns {Promise<boolean>} True if route was handled, false otherwise
 */
async function registerAdminAnalyticsRoutes(pathname, req, res, url) {
  // GET /admin/usage/summary
  if (pathname === '/admin/usage/summary' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const usage = await dataStore.getUsageSummaryAllUsers();
      const categories = await dataStore.getGlobalCategoryUsage();
      const topVideos = await dataStore.getVideoUsageTop({ limit: 20 });
      return sendJson(res, 200, { sessions: usage, categories, top_videos: topVideos });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/usage/ai
  if (pathname === '/admin/usage/ai' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 7;
      const summary = await dataStore.getAiUsageSummary({ days });
      return sendJson(res, 200, summary);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/videos
  if (pathname === '/admin/videos' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const videos = await dataStore.listVideoResourcesWithUserInfo();

      // Enhance each video with file size information
      const videosWithSize = await Promise.all(videos.map(async (video) => {
        let fileSize = null;
        let fileSizeFormatted = null;

        // Skip file size check for YouTube/external URLs
        const isExternalUrl = video.video_path && (
          video.video_path.startsWith('http://') ||
          video.video_path.startsWith('https://')
        );

        if (video.video_path && !isExternalUrl) {
          try {
            const videoFullPath = path.join(STATIC_DIR, video.video_path);
            const stats = await fsp.stat(videoFullPath);
            fileSize = stats.size;

            // Format file size
            if (fileSize >= 1024 * 1024 * 1024) {
              fileSizeFormatted = (fileSize / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
            } else if (fileSize >= 1024 * 1024) {
              fileSizeFormatted = (fileSize / (1024 * 1024)).toFixed(2) + ' MB';
            } else if (fileSize >= 1024) {
              fileSizeFormatted = (fileSize / 1024).toFixed(2) + ' KB';
            } else {
              fileSizeFormatted = fileSize + ' B';
            }
          } catch (err) {
            console.warn(`Failed to get file size for video ${video.id}:`, err.message);
          }
        }

        return {
          ...serializeVideoResource({ ...video, tags: video.tags_joined ?? video.tags }),
          username: video.username,
          email: video.email,
          display_name: video.display_name,
          file_size: fileSize,
          file_size_formatted: fileSizeFormatted,
        };
      }));

      return sendJson(res, 200, { items: videosWithSize });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      console.error('[Admin] Failed to list videos:', err);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/usage/pronunciation
  if (pathname === '/admin/usage/pronunciation' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 14;
      const summary = await dataStore.getPronunciationSummaryAll();
      const top = await dataStore.getTopPhonemesAll(10);
      const daily = await dataStore.getPronunciationDailyAverages(days);
      return sendJson(res, 200, { summary, top_phonemes: top, daily });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/feedback
  if (pathname === '/admin/feedback' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const statusFilter = url.searchParams.get('status') || null;
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 100;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      const items = await dataStore.adminListFeedback({ status: statusFilter, limit, offset });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/feedback/:id/status, POST /admin/feedback/:id/reply, DELETE /admin/feedback/:id
  if (pathname.startsWith('/admin/feedback/') && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      const adminUser = await requireAdmin(req);
      const match = pathname.match(/^\/admin\/feedback\/(\d+)(?:\/(status|reply))?$/);
      if (!match) return sendError(res, 404, 'Not Found');
      const feedbackId = Number(match[1]);
      const action = match[2] || '';
      if (!Number.isFinite(feedbackId)) return sendError(res, 400, 'Invalid feedback id');

      if (req.method === 'DELETE' && !action) {
        const deleted = await dataStore.deleteFeedback(feedbackId);
        return sendJson(res, 200, { item: deleted });
      }

      if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
      const body = await parseBody(req);

      if (action === 'status') {
        const status = String(body.status || '').toLowerCase();
        if (!status) return sendError(res, 400, 'status is required');
        const updated = await dataStore.updateFeedbackStatus(feedbackId, status);
        return sendJson(res, 200, { item: updated });
      }

      if (action === 'reply') {
        const message = String(body.message || '').trim();
        if (!message) return sendError(res, 400, 'message is required');
        const reply = await dataStore.addFeedbackReply(adminUser.id, feedbackId, message);
        return sendJson(res, 200, { item: reply });
      }

      return sendError(res, 404, 'Not Found');
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/visits - Get page visits with pagination
  if (pathname === '/admin/visits' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 100;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      const eventName = url.searchParams.get('event_name') || null;
      const userType = url.searchParams.get('user_type') || null;
      const result = await dataStore.getPageVisits({ limit, offset, eventName, userType });
      return sendJson(res, 200, result);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/visits/stats - Get visit statistics
  if (pathname === '/admin/visits/stats' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const stats = await dataStore.getVisitStats({ days });
      return sendJson(res, 200, stats);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/visits/daily - Get daily visit breakdown
  if (pathname === '/admin/visits/daily' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const dailyStats = await dataStore.getVisitsByDate({ days });
      return sendJson(res, 200, { items: dailyStats });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // DELETE /admin/visits/by-ip/:ip - Delete visits by IP
  const deleteByIpMatch = pathname.match(/^\/admin\/visits\/by-ip\/(.+)$/);
  if (deleteByIpMatch && req.method === 'DELETE') {
    try {
      await requireAdmin(req);
      const ip = decodeURIComponent(deleteByIpMatch[1]);
      const result = await dataStore.deleteVisitsByIP(ip);
      return sendJson(res, 200, { message: `已删除 ${result.deleted} 条访问记录`, deleted: result.deleted });
    } catch (err) {
      console.error('[DELETE visits by IP] Error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // DELETE /admin/visits/batch - Batch delete visits by IDs
  if (pathname === '/admin/visits/batch' && req.method === 'DELETE') {
    try {
      await requireAdmin(req);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (!body.ids || !Array.isArray(body.ids)) {
        return sendError(res, 400, '需要提供ids数组');
      }

      const result = await dataStore.deleteVisitsByIds(body.ids);
      return sendJson(res, 200, { message: `已删除 ${result.deleted} 条访问记录`, deleted: result.deleted });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/visits/batch-delete - Batch delete visits by IDs (POST version for frontend)
  if (pathname === '/admin/visits/batch-delete' && req.method === 'POST') {
    try {
      await requireAdmin(req);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (!body.ids || !Array.isArray(body.ids)) {
        return sendError(res, 400, '需要提供ids数组');
      }

      const result = await dataStore.deleteVisitsByIds(body.ids);
      return sendJson(res, 200, { success: true, message: `已删除 ${result.deleted} 条访问记录`, deleted: result.deleted });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/visits/delete-by-ip - Delete visits by IP (POST version for frontend)
  if (pathname === '/admin/visits/delete-by-ip' && req.method === 'POST') {
    try {
      await requireAdmin(req);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (!body.ip) {
        return sendError(res, 400, '需要提供ip参数');
      }

      const result = await dataStore.deleteVisitsByIP(body.ip);
      return sendJson(res, 200, { success: true, message: `已删除 ${result.deleted} 条访问记录`, deleted: result.deleted });
    } catch (err) {
      console.error('[POST delete visits by IP] Error:', err);
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/videos - Get video viewing statistics
  if (pathname === '/admin/analytics/videos' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 10;
      const videos = await dataStore.getVideoViewsWithDetails({ limit });
      return sendJson(res, 200, { items: videos });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/active-users - Get top active users
  if (pathname === '/admin/analytics/active-users' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 10;
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const users = await dataStore.getTopActiveUsers({ limit, days });
      return sendJson(res, 200, { items: users });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/user-growth - Get user growth trend
  if (pathname === '/admin/analytics/user-growth' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const trend = await dataStore.getUserGrowthTrend({ days });
      return sendJson(res, 200, { items: trend });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/user-distribution - Get user type distribution
  if (pathname === '/admin/analytics/user-distribution' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const distribution = await dataStore.getUserTypeDistribution();
      return sendJson(res, 200, distribution);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/feedback-distribution - Get feedback status distribution
  if (pathname === '/admin/analytics/feedback-distribution' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const distribution = await dataStore.getFeedbackStatusDistribution();
      return sendJson(res, 200, { items: distribution });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/click-heatmap - CTA click heatmap
  if (pathname === '/admin/analytics/click-heatmap' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 12;
      const page = url.searchParams.get('page') || null;
      const items = await dataStore.getClickHeatmap({ days, limit, page });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/growth-overview - Executive growth dashboard
  if (pathname === '/admin/analytics/growth-overview' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const [
        firstDayActivation,
        onboarding,
        today,
        retention,
        pricing,
        reportGrowth,
        teamLeads,
      ] = await Promise.all([
        dataStore.getFirstDayActivationStats({ days }),
        dataStore.getOnboardingFunnelStats({ days }),
        dataStore.getTodayActivationFunnel({ days }),
        dataStore.getTodayRetentionSummary({ days }),
        dataStore.getPricingFunnelStats({ days }),
        dataStore.getLearningReportGrowthStats({ days }),
        dataStore.getTeamLeadStats({ days }),
      ]);
      return sendJson(res, 200, buildGrowthOverview({
        days,
        firstDayActivation,
        onboarding,
        today,
        retention,
        pricing,
        reportGrowth,
        teamLeads,
      }));
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/first-day-activation - New-user first-day activation cohort
  if (pathname === '/admin/analytics/first-day-activation' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const stats = await dataStore.getFirstDayActivationStats({ days });
      return sendJson(res, 200, stats);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/guest-funnel - Guest conversion funnel
  if (pathname === '/admin/analytics/guest-funnel' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const items = await dataStore.getGuestFunnelStats({ days });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/onboarding-funnel - First-run onboarding conversion funnel
  if (pathname === '/admin/analytics/onboarding-funnel' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const funnel = await dataStore.getOnboardingFunnelStats({ days });
      return sendJson(res, 200, funnel);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/today-funnel - Today workspace activation funnel
  if (pathname === '/admin/analytics/today-funnel' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const funnel = await dataStore.getTodayActivationFunnel({ days });
      return sendJson(res, 200, funnel);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/game-funnel - Vocabulary game engagement funnel
  if (pathname === '/admin/analytics/game-funnel' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const funnel = await dataStore.getGameFunnelStats({ days });
      return sendJson(res, 200, funnel);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/pricing-funnel - Pricing checkout conversion funnel
  if (pathname === '/admin/analytics/pricing-funnel' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const funnel = await dataStore.getPricingFunnelStats({ days });
      return sendJson(res, 200, funnel);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/team-leads - Team plan lead capture health
  if (pathname === '/admin/analytics/team-leads' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const stats = await dataStore.getTeamLeadStats({ days });
      return sendJson(res, 200, stats);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/today-retention - Today workspace retention summary
  if (pathname === '/admin/analytics/today-retention' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const summary = await dataStore.getTodayRetentionSummary({ days });
      return sendJson(res, 200, summary);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/report-growth - Learning report sharing and reactivation funnel
  if (pathname === '/admin/analytics/report-growth' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const growth = await dataStore.getLearningReportGrowthStats({ days });
      return sendJson(res, 200, growth);
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/analytics/ab-test - A/B test exposure summary
  if (pathname === '/admin/analytics/ab-test' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;
      const testKey = url.searchParams.get('test') || '';
      const items = await dataStore.getABTestSummary({ days, testKey });
      return sendJson(res, 200, { items });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // ==================== 视频管理端点 (MCP支持) ====================

  // GET /admin/videos/:id - Get single video detail
  const videoDetailMatch = pathname.match(/^\/admin\/videos\/(\d+)$/);
  if (videoDetailMatch && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const videoId = Number(videoDetailMatch[1]);
      const video = await dataStore.getVideoResourceById(videoId);
      if (!video) {
        return sendError(res, 404, 'Video not found');
      }
      return sendJson(res, 200, serializeVideoResource(video));
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/videos/stats - Get video statistics
  if (pathname === '/admin/videos/stats' && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const videos = await dataStore.listVideoResourcesWithUserInfo();

      // Calculate statistics
      const totalVideos = videos.length;
      let hasTagsCount = 0;
      let hasDifficultyCount = 0;
      let hasCategoryCount = 0;
      const tagDistribution = {};
      const difficultyDistribution = {};
      const categoryDistribution = {};

      for (const video of videos) {
        // Count tagged videos
        const tags = video.tags_joined || video.tags;
        if (tags && Array.isArray(tags) && tags.length > 0) {
          hasTagsCount++;
          for (const tag of tags) {
            tagDistribution[tag] = (tagDistribution[tag] || 0) + 1;
          }
        }

        // Count difficulty
        if (video.difficulty_level) {
          hasDifficultyCount++;
          difficultyDistribution[video.difficulty_level] = (difficultyDistribution[video.difficulty_level] || 0) + 1;
        }

        // Count category
        if (video.category) {
          hasCategoryCount++;
          categoryDistribution[video.category] = (categoryDistribution[video.category] || 0) + 1;
        }
      }

      return sendJson(res, 200, {
        total_videos: totalVideos,
        has_tags: hasTagsCount,
        has_difficulty: hasDifficultyCount,
        has_category: hasCategoryCount,
        missing_tags: totalVideos - hasTagsCount,
        missing_difficulty: totalVideos - hasDifficultyCount,
        missing_category: totalVideos - hasCategoryCount,
        tag_distribution: tagDistribution,
        difficulty_distribution: difficultyDistribution,
        category_distribution: categoryDistribution
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/videos/needing-tags - Get videos needing tags
  if (pathname === '/admin/videos/needing-tags' && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      const missing = url.searchParams.get('missing') || 'tags'; // tags, difficulty, category

      const videos = await dataStore.listVideoResourcesWithUserInfo();

      // Filter videos based on what's missing
      let filtered = videos;
      if (missing === 'tags') {
        filtered = videos.filter(v => {
          const tags = v.tags_joined || v.tags;
          return !tags || !Array.isArray(tags) || tags.length === 0;
        });
      } else if (missing === 'difficulty') {
        filtered = videos.filter(v => !v.difficulty_level);
      } else if (missing === 'category') {
        filtered = videos.filter(v => !v.category);
      }

      // Apply pagination
      const paginated = filtered.slice(offset, offset + limit);

      return sendJson(res, 200, {
        items: paginated.map(v => serializeVideoResource({ ...v, tags: v.tags_joined ?? v.tags })),
        total: filtered.length,
        limit,
        offset
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // POST /admin/videos/batch-update - Batch update videos
  if (pathname === '/admin/videos/batch-update' && req.method === 'POST') {
    try {
      await requireAdminOrAiToken(req);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      const { operations = [], dry_run = true } = body;

      if (!Array.isArray(operations) || operations.length === 0) {
        return sendError(res, 400, 'operations array is required');
      }

      const results = [];
      for (const op of operations) {
        const { id, tags, difficulty_level, category } = op;
        if (!id) {
          results.push({ id: null, error: 'Missing video id' });
          continue;
        }

        const updateFields = {};
        if (tags !== undefined) updateFields.tags = JSON.stringify(tags);
        if (difficulty_level !== undefined) updateFields.difficulty_level = difficulty_level;
        if (category !== undefined) updateFields.category = category;

        if (Object.keys(updateFields).length === 0) {
          results.push({ id, error: 'No fields to update' });
          continue;
        }

        if (dry_run) {
          results.push({ id, action: 'would_update', fields: updateFields });
        } else {
          try {
            await dataStore.updateVideoResource(id, updateFields);
            results.push({ id, action: 'updated', fields: updateFields });
          } catch (updateErr) {
            results.push({ id, error: updateErr.message });
          }
        }
      }

      return sendJson(res, 200, {
        dry_run,
        total: operations.length,
        results
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // ==================== 用户分析端点 (MCP支持) ====================

  // GET /admin/users/learning-data - Get user learning data
  if (pathname === '/admin/users/learning-data' && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const userId = url.searchParams.get('user_id') ? Number(url.searchParams.get('user_id')) : null;
      const email = url.searchParams.get('email');

      if (!userId && !email) {
        return sendError(res, 400, 'user_id or email is required');
      }

      // Find user
      let user;
      if (userId) {
        user = await dataStore.findUserById(userId);
      } else if (email) {
        user = await dataStore.findUserByEmail(email);
      }

      if (!user) {
        return sendError(res, 404, 'User not found');
      }

      // Get learning stats
      const vocabStats = await dataStore.getVocabStatsSummary(user.id);

      return sendJson(res, 200, {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          created_at: user.created_at,
          last_login_at: user.last_login_at
        },
        vocab: vocabStats || {
          total: 0,
          mastered: 0,
          learning: 0,
          new: 0
        }
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/stats/daily - Get daily statistics
  if (pathname === '/admin/stats/daily' && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const days = url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30;

      // Get daily visit stats
      const visitStats = await dataStore.getVisitsByDate({ days });

      // Get user growth trend
      const userGrowth = await dataStore.getUserGrowthTrend({ days });

      return sendJson(res, 200, {
        daily_visits: visitStats,
        user_growth: userGrowth
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // GET /admin/users/leaderboard - Get learning leaderboard
  if (pathname === '/admin/users/leaderboard' && req.method === 'GET') {
    try {
      await requireAdminOrAiToken(req);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 20;
      const metric = url.searchParams.get('metric') || 'total_reviews';

      // Get top active users
      const users = await dataStore.getTopActiveUsers({ limit, days: 30 });

      return sendJson(res, 200, {
        metric,
        items: users
      });
    } catch (err) {
      const status = err.status || mapErrorToStatus(err, 400);
      return sendError(res, status, err.message);
    }
  }

  // Route not handled
  return false;
}

module.exports = { registerAdminAnalyticsRoutes };
