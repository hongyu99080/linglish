'use strict';

/**
 * LemonSqueezy service — handles subscription checkout, webhooks, billing portal, and cancellation.
 *
 * Environment variables required:
 *   LEMONSQUEEZY_API_KEY         — API key from LemonSqueezy dashboard
 *   LEMONSQUEEZY_WEBHOOK_SECRET  — Webhook signing secret
 *   LEMONSQUEEZY_CHECKOUT_URL_MONTHLY — Monthly checkout URL
 *   LEMONSQUEEZY_CHECKOUT_URL_YEARLY  — Yearly checkout URL
 *   LEMONSQUEEZY_SUCCESS_URL     — Redirect URL after successful checkout
 *   LEMONSQUEEZY_CANCEL_URL      — Redirect URL after cancelled checkout
 */

const crypto = require('crypto');
const https = require('https');
const dataStore = require('../data-store');
const {
  ACTIVE_SUBSCRIPTION_STATUSES,
  BLOCKED_SUBSCRIPTION_STATUSES,
  getEntitlement,
  normalizeSubscriptionStatus,
} = require('./entitlements');

const API_BASE = 'https://api.lemonsqueezy.com/v1';
const HARD_INACTIVE_SUBSCRIPTION_STATUSES = BLOCKED_SUBSCRIPTION_STATUSES;

function normalizeMetricDays(days, fallback = 30, max = 365) {
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseCentsEnv(name) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

// ── HTTP helper (JSON:API) ───────────────────────────────────────────────────

/**
 * Make an HTTPS request to the LemonSqueezy API.
 *
 * @param {string} method   — HTTP method
 * @param {string} path     — API path (e.g. '/subscriptions/123')
 * @param {object} [body]   — request body (will be JSON-stringified)
 * @returns {Promise<object>}
 */
function apiRequest(method, path, body) {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY;
  if (!apiKey) throw new Error('LEMONSQUEEZY_NOT_CONFIGURED');

  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`);
  const payload = body ? JSON.stringify(body) : null;

  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method,
    headers: {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${apiKey}`,
    },
  };

  if (payload) {
    options.headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch (e) {
            resolve({});
          }
        } else {
          const err = new Error(`LemonSqueezy API ${res.statusCode}: ${raw}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a checkout session — returns the LemonSqueezy checkout URL
 * with user email and custom user_id pre-filled.
 *
 * @param {{ id: number, email: string }} user
 * @param {'monthly'|'yearly'} plan
 * @returns {{ url: string }}
 */
function createCheckoutSession(user, plan) {
  const normalizedPlan = plan === 'yearly' ? 'yearly' : 'monthly';
  const checkoutUrl = getCheckoutUrlForPlan(normalizedPlan);

  const successUrl = process.env.LEMONSQUEEZY_SUCCESS_URL || 'http://localhost:4000/pricing.html?success=1&from=checkout';
  const cancelUrl  = process.env.LEMONSQUEEZY_CANCEL_URL  || 'http://localhost:4000/pricing.html?cancelled=1&from=checkout';

  // Build the checkout URL with query params
  const url = new URL(checkoutUrl);
  url.searchParams.set('checkout[email]', user.email);
  url.searchParams.set('checkout[custom][user_id]', String(user.id));
  url.searchParams.set('checkout[custom][plan]', normalizedPlan);
  url.searchParams.set('checkout[success_url]', successUrl);
  url.searchParams.set('checkout[cancel_url]', cancelUrl);

  return { url: url.toString(), plan: normalizedPlan };
}

function getCheckoutUrlForPlan(plan) {
  const monthlyUrl = process.env.LEMONSQUEEZY_CHECKOUT_URL_MONTHLY || process.env.LEMONSQUEEZY_CHECKOUT_URL;
  const yearlyUrl = process.env.LEMONSQUEEZY_CHECKOUT_URL_YEARLY;

  if (plan === 'monthly') {
    if (!monthlyUrl) throw new Error('LEMONSQUEEZY_MONTHLY_CHECKOUT_URL_NOT_CONFIGURED');
    return monthlyUrl;
  }

  if (!yearlyUrl) throw new Error('LEMONSQUEEZY_YEARLY_CHECKOUT_URL_NOT_CONFIGURED');
  return yearlyUrl;
}

/**
 * Get the subscription status for a user from the database.
 *
 * @param {{ id: number }} user
 * @returns {Promise<object>}
 */
async function getSubscriptionStatus(user) {
  const row = await dataStore.findUserById(user.id);
  if (!row) throw new Error('USER_NOT_FOUND');
  const lastEvent = await getLatestSubscriptionEventForUser(user.id);
  const entitlement = getEntitlement(row);

  return {
    membership_type:       row.membership_type || 'free',
    subscription_status:   entitlement.subscriptionStatus,
    subscription_end_date: row.subscription_end_date || null,
    membership_expires_at: row.membership_expires_at || null,
    has_active_vip: entitlement.isPremiumActive,
    has_billing_portal: Boolean(row.ls_subscription_id),
    billing_provider: row.ls_subscription_id ? 'lemonsqueezy' : null,
    entitlement: {
      tier: entitlement.tier,
      effective_tier: entitlement.effectiveTier,
      reason: entitlement.reason,
      daily_pronunciation_assessments: entitlement.dailyPronunciationAssessments,
      daily_ai_scores: entitlement.dailyAiScores,
      daily_deep_word_generations: entitlement.dailyDeepWordGenerations,
    },
    last_event: lastEvent,
  };
}

/**
 * Request a fresh signed LemonSqueezy Customer Portal URL.
 * Signed URLs are fetched on click because they expire.
 *
 * @param {{ id: number }} user
 * @returns {Promise<{ url: string, update_payment_method_url: string|null, signed: boolean }>}
 */
async function createCustomerPortalSession(user) {
  const row = await dataStore.findUserById(user.id);
  if (!row || !row.ls_subscription_id) {
    throw new Error('NO_SUBSCRIPTION');
  }

  const fallbackUrl = String(process.env.LEMONSQUEEZY_CUSTOMER_PORTAL_URL || '').trim();
  if (!process.env.LEMONSQUEEZY_API_KEY && fallbackUrl) {
    return {
      url: fallbackUrl,
      update_payment_method_url: null,
      signed: false,
    };
  }

  let response;
  try {
    response = await apiRequest('GET', `/subscriptions/${row.ls_subscription_id}`);
  } catch (err) {
    if (fallbackUrl) {
      console.warn('[LemonSqueezy] customer portal signed URL failed, using unsigned fallback:', err?.message || err);
      return {
        url: fallbackUrl,
        update_payment_method_url: null,
        signed: false,
      };
    }
    throw err;
  }
  const urls = response?.data?.attributes?.urls || {};
  const portalUrl = urls.customer_portal;

  if (!portalUrl) {
    if (fallbackUrl) {
      return {
        url: fallbackUrl,
        update_payment_method_url: urls.update_payment_method || null,
        signed: false,
      };
    }
    throw new Error('CUSTOMER_PORTAL_UNAVAILABLE');
  }

  return {
    url: portalUrl,
    update_payment_method_url: urls.update_payment_method || null,
    signed: true,
  };
}

/**
 * Verify the LemonSqueezy webhook signature (HMAC-SHA256).
 *
 * @param {Buffer|string} rawBody    — raw request body
 * @param {string}        signature  — value of the 'x-signature' header
 * @param {string}        secret     — webhook signing secret
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)));
  const digest = hmac.digest('hex');

  // Constant-time comparison
  try {
    const left = Buffer.from(digest, 'hex');
    const right = Buffer.from(String(signature), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Handle a verified LemonSqueezy webhook event.
 * Updates subscription status and membership level in the database.
 *
 * LemonSqueezy webhook payload structure:
 *   { meta: { event_name, custom_data: { user_id } }, data: { id, attributes: { ... } } }
 *
 * @param {object} payload — parsed JSON body from webhook
 */
async function handleWebhookEvent(payload) {
  const eventName  = payload.meta && payload.meta.event_name;
  const customData = (payload.meta && payload.meta.custom_data) || {};
  const attributes = (payload.data && payload.data.attributes) || {};
  const dataType = payload.data && payload.data.type;
  const lsSubscriptionId = dataType === 'subscriptions'
    ? payload.data && payload.data.id
    : attributes.subscription_id;

  // Try to find user by custom_data.user_id first, then by ls_customer_id
  let userId = customData.user_id ? Number(customData.user_id) : null;

  if (!userId && lsSubscriptionId) {
    // Try to find user by their stored subscription ID
    const userRow = await findUserByLsSubscription(lsSubscriptionId);
    if (userRow) userId = userRow.id;
  }

  if (!userId && attributes.user_email) {
    // Fallback: find by email
    const userRow = await findUserByEmail(attributes.user_email);
    if (userRow) userId = userRow.id;
  }

  if (!userId) {
    await recordSubscriptionEvent(payload, { processedStatus: 'ignored', errorMessage: 'USER_NOT_IDENTIFIED' });
    console.warn(`[LemonSqueezy] webhook ${eventName}: could not identify user`);
    return;
  }

  const eventRow = await recordSubscriptionEvent(payload, { userId, processedStatus: 'processing' });

  try {
    let handled = true;

    switch (eventName) {

      // ── Subscription lifecycle — sync entitlement ─────────────────────────
      case 'subscription_created':
      case 'subscription_updated':
      case 'subscription_resumed':
      case 'subscription_unpaused':
      case 'subscription_paused': {
        await syncSubscriptionFromAttributes(userId, String(lsSubscriptionId), attributes);
        console.log(`[LemonSqueezy] User ${userId} subscription ${eventName}: status=${attributes.status}`);
        break;
      }

      // ── Subscription cancelled ─────────────────────────────────────────────
      case 'subscription_cancelled': {
        const endsAt = parseDate(attributes.ends_at || attributes.renews_at) || new Date();
        await syncCancelledSubscription(userId, String(lsSubscriptionId), attributes, endsAt);
        console.log(`[LemonSqueezy] User ${userId} subscription cancelled, ends at ${endsAt.toISOString()}`);
        break;
      }

      // ── Subscription expired — remove paid entitlement ─────────────────────
      case 'subscription_expired': {
        const endedAt = parseDate(attributes.ends_at || attributes.renews_at) || new Date();
        await expireSubscription(userId, String(lsSubscriptionId), attributes.status || 'expired', endedAt);
        console.log(`[LemonSqueezy] User ${userId} subscription expired: ${lsSubscriptionId}`);
        break;
      }

      // ── Payment success — record payment and refresh active status ─────────
      case 'subscription_payment_success': {
        const amountStr = attributes.subtotal_formatted || attributes.total_formatted || '';
        const amount    = attributes.subtotal || attributes.total || 0;
        const currency  = attributes.currency || 'USD';
        const paymentId = payload.data && payload.data.id ? String(payload.data.id) : null;

        if (paymentId) {
          await recordPayment(
            userId,
            paymentId,
            amount,
            currency.toLowerCase(),
            'succeeded',
            'VIP Subscription Payment',
          );
        }

        console.log(`[LemonSqueezy] User ${userId} payment recorded: ${amountStr || amount}`);
        break;
      }

      default:
        handled = false;
        break;
    }

    await markSubscriptionEvent(eventRow.id, handled ? 'processed' : 'ignored');
  } catch (err) {
    await markSubscriptionEvent(eventRow.id, 'failed', err.message || String(err));
    throw err;
  }
}

/**
 * Cancel the user's subscription via the LemonSqueezy API.
 * Sends DELETE /subscriptions/:id (cancels at end of billing period).
 *
 * @param {{ id: number }} user
 * @returns {Promise<{ ok: boolean }>}
 */
async function cancelSubscription(user) {
  const row = await dataStore.findUserById(user.id);
  if (!row || !row.ls_subscription_id) {
    throw new Error('NO_ACTIVE_SUBSCRIPTION');
  }

  await apiRequest('DELETE', `/subscriptions/${row.ls_subscription_id}`);

  await dataStore.query(
    `UPDATE users
        SET subscription_status   = 'cancelled',
            subscription_end_date = COALESCE(subscription_end_date, membership_expires_at),
            membership_expires_at = COALESCE(membership_expires_at, subscription_end_date),
            updated_at            = NOW()
      WHERE id = $1`,
    [user.id],
  );

  return { ok: true };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Find a user by their LemonSqueezy subscription ID.
 */
async function findUserByLsSubscription(lsSubscriptionId) {
  const { rows } = await dataStore.query(
    `SELECT * FROM users WHERE ls_subscription_id = $1 LIMIT 1`,
    [String(lsSubscriptionId)],
  );
  return rows[0] || null;
}

/**
 * Find a user by email.
 */
async function findUserByEmail(email) {
  const { rows } = await dataStore.query(
    `SELECT * FROM users WHERE email = $1 LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

function normalizeStatus(status) {
  return normalizeSubscriptionStatus(status);
}

function isActiveStatus(status) {
  return ACTIVE_SUBSCRIPTION_STATUSES.has(normalizeStatus(status));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getSubscriptionEndDate(attributes) {
  return parseDate(attributes.renews_at || attributes.trial_ends_at || attributes.ends_at);
}

function getEventDetails(payload) {
  const meta = payload?.meta || {};
  const data = payload?.data || {};
  const attributes = data.attributes || {};
  const firstOrderItem = attributes.first_order_item || {};
  const eventName = String(meta.event_name || 'unknown');
  const dataType = String(data.type || 'unknown');
  const dataId = data.id ? String(data.id) : null;
  const isSubscription = dataType === 'subscriptions';

  return {
    eventName,
    eventKey: buildEventKey(payload),
    subscriptionId: isSubscription && dataId ? dataId : (attributes.subscription_id ? String(attributes.subscription_id) : null),
    customerId: attributes.customer_id ? String(attributes.customer_id) : null,
    orderId: attributes.order_id ? String(attributes.order_id) : (dataType === 'orders' && dataId ? dataId : null),
    variantId: attributes.variant_id ? String(attributes.variant_id) : (firstOrderItem.variant_id ? String(firstOrderItem.variant_id) : null),
    status: attributes.status ? String(attributes.status) : null,
    amount: Number.isFinite(Number(attributes.subtotal || attributes.total))
      ? Math.round(Number(attributes.subtotal || attributes.total))
      : null,
    currency: attributes.currency ? String(attributes.currency).toLowerCase() : null,
  };
}

function buildEventKey(payload) {
  const meta = payload?.meta || {};
  if (meta.event_id) return `lemonsqueezy:${meta.event_id}`;

  const data = payload?.data || {};
  const attributes = data.attributes || {};
  const source = [
    meta.event_name || 'unknown',
    data.type || 'unknown',
    data.id || attributes.identifier || attributes.order_id || attributes.subscription_id || 'unknown',
    attributes.updated_at || attributes.created_at || attributes.renews_at || attributes.ends_at || '',
    meta.custom_data?.user_id || attributes.user_email || '',
  ].join('|');

  return crypto.createHash('sha256').update(source).digest('hex');
}

async function recordSubscriptionEvent(payload, { userId = null, processedStatus = 'received', errorMessage = null } = {}) {
  const details = getEventDetails(payload);
  const { rows } = await dataStore.query(
    `INSERT INTO subscription_events (
       provider, event_key, event_name, user_id, ls_subscription_id, ls_customer_id,
       ls_order_id, ls_variant_id, status, amount, currency, processed_status,
       error_message, payload, received_at
     )
     VALUES (
       'lemonsqueezy', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13::jsonb, NOW()
     )
     ON CONFLICT (event_key) DO UPDATE
       SET user_id            = COALESCE(EXCLUDED.user_id, subscription_events.user_id),
           ls_subscription_id = COALESCE(EXCLUDED.ls_subscription_id, subscription_events.ls_subscription_id),
           ls_customer_id     = COALESCE(EXCLUDED.ls_customer_id, subscription_events.ls_customer_id),
           ls_order_id        = COALESCE(EXCLUDED.ls_order_id, subscription_events.ls_order_id),
           ls_variant_id      = COALESCE(EXCLUDED.ls_variant_id, subscription_events.ls_variant_id),
           status             = COALESCE(EXCLUDED.status, subscription_events.status),
           amount             = COALESCE(EXCLUDED.amount, subscription_events.amount),
           currency           = COALESCE(EXCLUDED.currency, subscription_events.currency),
           processed_status   = EXCLUDED.processed_status,
           error_message      = EXCLUDED.error_message,
           payload            = EXCLUDED.payload
     RETURNING *`,
    [
      details.eventKey,
      details.eventName,
      userId,
      details.subscriptionId,
      details.customerId,
      details.orderId,
      details.variantId,
      details.status,
      details.amount,
      details.currency,
      processedStatus,
      errorMessage,
      JSON.stringify(payload || {}),
    ],
  );
  return rows[0];
}

async function markSubscriptionEvent(eventId, processedStatus, errorMessage = null) {
  if (!eventId) return null;
  const { rows } = await dataStore.query(
    `UPDATE subscription_events
        SET processed_status = $2,
            error_message = $3,
            processed_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [eventId, processedStatus, errorMessage],
  );
  return rows[0] || null;
}

async function getLatestSubscriptionEventForUser(userId) {
  try {
    const { rows } = await dataStore.query(
      `SELECT id, event_name, status, processed_status, error_message, received_at, processed_at
         FROM subscription_events
        WHERE user_id = $1
        ORDER BY received_at DESC, id DESC
        LIMIT 1`,
      [userId],
    );
    return rows[0] || null;
  } catch (err) {
    console.warn('[LemonSqueezy] latest subscription event lookup failed:', err?.message || err);
    return null;
  }
}

/**
 * Activate VIP for a user.
 */
async function activateVip(userId, subscriptionId, status, endDate, variantId, customerId) {
  const sets = [
    `membership_type       = 'vip'`,
    `ls_subscription_id    = $2`,
    `subscription_status   = $3`,
    `subscription_end_date = $4`,
    `membership_expires_at = $4`,
    `updated_at            = NOW()`,
  ];
  const params = [userId, subscriptionId, status, endDate];

  if (variantId) {
    params.push(variantId);
    sets.push(`ls_variant_id = $${params.length}`);
  }
  if (customerId) {
    params.push(customerId);
    sets.push(`ls_customer_id = $${params.length}`);
  }

  await dataStore.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1`,
    params,
  );
}

async function syncSubscriptionFromAttributes(userId, subscriptionId, attributes) {
  const status = normalizeStatus(attributes.status);
  const endDate = getSubscriptionEndDate(attributes);
  const variantId = attributes.variant_id ? String(attributes.variant_id) : null;
  const customerId = attributes.customer_id ? String(attributes.customer_id) : null;

  if (isActiveStatus(status)) {
    await activateVip(userId, subscriptionId, status, endDate, variantId, customerId);
    return;
  }

  if (HARD_INACTIVE_SUBSCRIPTION_STATUSES.has(status)) {
    await expireSubscription(userId, subscriptionId, status, parseDate(attributes.ends_at) || endDate || new Date());
    return;
  }

  await dataStore.query(
    `UPDATE users
        SET ls_subscription_id    = $2,
            subscription_status   = $3,
            subscription_end_date = $4,
            membership_expires_at = CASE WHEN $4 > NOW() THEN $4 ELSE membership_expires_at END,
            ls_variant_id         = COALESCE($5, ls_variant_id),
            ls_customer_id        = COALESCE($6, ls_customer_id),
            updated_at            = NOW()
      WHERE id = $1`,
    [userId, subscriptionId, status, endDate, variantId, customerId],
  );
}

async function syncCancelledSubscription(userId, subscriptionId, attributes, endsAt) {
  const variantId = attributes.variant_id ? String(attributes.variant_id) : null;
  const customerId = attributes.customer_id ? String(attributes.customer_id) : null;
  await dataStore.query(
    `UPDATE users
        SET membership_type       = CASE WHEN $3 > NOW() THEN membership_type ELSE 'free' END,
            ls_subscription_id    = $2,
            subscription_status   = 'cancelled',
            subscription_end_date = $3,
            membership_expires_at = CASE WHEN $3 > NOW() THEN $3 ELSE NULL END,
            ls_variant_id         = COALESCE($4, ls_variant_id),
            ls_customer_id        = COALESCE($5, ls_customer_id),
            updated_at            = NOW()
      WHERE id = $1`,
    [userId, subscriptionId, endsAt, variantId, customerId],
  );
}

async function expireSubscription(userId, subscriptionId, status, endedAt) {
  await dataStore.query(
    `UPDATE users
        SET membership_type       = 'free',
            ls_subscription_id    = $2,
            subscription_status   = $3,
            subscription_end_date = $4,
            membership_expires_at = NULL,
            updated_at            = NOW()
      WHERE id = $1`,
    [userId, subscriptionId, normalizeStatus(status), endedAt],
  );
}

/**
 * Insert a row into the payments table (idempotent via ON CONFLICT).
 */
async function recordPayment(userId, lsPaymentId, amount, currency, status, description) {
  await dataStore.query(
    `INSERT INTO payments (user_id, ls_payment_id, amount, currency, status, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (ls_payment_id) DO NOTHING`,
    [userId, lsPaymentId, amount, currency, status, description],
  );
}

async function getSubscriptionAdminSummary() {
  const [usersResult, paymentsResult, eventsResult, latestResult] = await Promise.all([
    dataStore.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE membership_type IS NOT NULL
            AND membership_type <> 'free'
        )::int AS paid_members,
        COUNT(*) FILTER (
          WHERE subscription_status IN ('active', 'on_trial', 'trialing')
        )::int AS active_subscriptions,
        COUNT(*) FILTER (
          WHERE subscription_status = 'cancelled'
            AND subscription_end_date > NOW()
        )::int AS cancelling_at_period_end,
        COUNT(*) FILTER (
          WHERE subscription_status IN ('past_due', 'paused', 'unpaid')
        )::int AS billing_issues
      FROM users
    `),
    dataStore.query(`
      SELECT
        COALESCE(SUM(amount), 0)::bigint AS total_amount,
        COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::bigint AS amount_30d,
        COUNT(*)::int AS payment_count
      FROM payments
      WHERE status = 'succeeded'
    `),
    dataStore.query(`
      SELECT
        COUNT(*) FILTER (WHERE processed_status = 'failed' AND received_at >= NOW() - INTERVAL '7 days')::int AS failed_7d,
        COUNT(*) FILTER (WHERE processed_status = 'ignored' AND received_at >= NOW() - INTERVAL '7 days')::int AS ignored_7d,
        COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours')::int AS events_24h
      FROM subscription_events
    `),
    dataStore.query(`
      SELECT id, event_name, status, processed_status, error_message, received_at, processed_at
      FROM subscription_events
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `),
  ]);

  return {
    users: usersResult.rows[0] || {},
    payments: paymentsResult.rows[0] || {},
    events: eventsResult.rows[0] || {},
    latest_event: latestResult.rows[0] || null,
  };
}

async function getSubscriptionBusinessMetrics({ days = 30 } = {}) {
  const normalizedDays = normalizeMetricDays(days, 30, 365);
  const monthlyVariantId = process.env.LEMONSQUEEZY_MONTHLY_VARIANT_ID || '';
  const yearlyVariantId = process.env.LEMONSQUEEZY_YEARLY_VARIANT_ID || '';
  const monthlyPriceCents = parseCentsEnv('LEMONSQUEEZY_MONTHLY_PRICE_CENTS');
  const yearlyPriceCents = parseCentsEnv('LEMONSQUEEZY_YEARLY_PRICE_CENTS');
  const yearlyMonthlyEquivalentCents = yearlyPriceCents > 0 ? Math.round(yearlyPriceCents / 12) : 0;

  const [
    revenueResult,
    userResult,
    eventResult,
    dailyResult,
    variantResult,
  ] = await Promise.all([
    dataStore.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'succeeded'), 0)::bigint AS total_revenue_cents,
         COALESCE(SUM(amount) FILTER (
           WHERE status = 'succeeded' AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
         ), 0)::bigint AS period_revenue_cents,
         COALESCE(SUM(amount) FILTER (
           WHERE status = 'succeeded' AND created_at >= date_trunc('day', NOW())
         ), 0)::bigint AS today_revenue_cents,
         COUNT(*) FILTER (WHERE status = 'succeeded')::int AS total_payment_count,
         COUNT(*) FILTER (
           WHERE status = 'succeeded' AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS period_payment_count,
         COUNT(DISTINCT user_id) FILTER (
           WHERE status = 'succeeded' AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS period_paying_users,
         COALESCE(ROUND(AVG(amount) FILTER (
           WHERE status = 'succeeded' AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
         )), 0)::int AS period_avg_payment_cents
       FROM payments`,
      [normalizedDays],
    ),
    dataStore.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE email IS NULL OR email NOT LIKE 'guest_%@temp.linglish.local'
        )::int AS registered_users,
        COUNT(*) FILTER (
          WHERE membership_type IS NOT NULL
            AND membership_type <> 'free'
        )::int AS paid_members,
        COUNT(*) FILTER (
          WHERE subscription_status IN ('active', 'on_trial', 'trialing')
        )::int AS active_subscriptions,
        COUNT(*) FILTER (
          WHERE subscription_status = 'cancelled'
            AND subscription_end_date > NOW()
        )::int AS cancelling_at_period_end,
        COUNT(*) FILTER (
          WHERE subscription_status IN ('past_due', 'paused', 'unpaid')
        )::int AS billing_issues,
        COUNT(*) FILTER (
          WHERE subscription_status IN ('active', 'on_trial', 'trialing')
            AND ($1::text = '' OR ls_variant_id IS NULL OR ls_variant_id NOT IN ($1::text, $2::text))
        )::int AS unmapped_active_subscriptions
      FROM users`,
      [monthlyVariantId, yearlyVariantId],
    ),
    dataStore.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE event_name = 'subscription_created'
             AND received_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS new_subscriptions,
         COUNT(*) FILTER (
           WHERE event_name = 'subscription_cancelled'
             AND received_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS cancellations,
         COUNT(*) FILTER (
           WHERE event_name = 'subscription_expired'
             AND received_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS expirations,
         COUNT(*) FILTER (
           WHERE event_name = 'subscription_payment_success'
             AND received_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS payment_success_events,
         COUNT(*) FILTER (
           WHERE processed_status = 'failed'
             AND received_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS failed_events,
         COUNT(*) FILTER (
           WHERE processed_status = 'ignored'
             AND received_at >= NOW() - ($1::int * INTERVAL '1 day')
         )::int AS ignored_events
       FROM subscription_events`,
      [normalizedDays],
    ),
    dataStore.query(
      `WITH days AS (
         SELECT generate_series(
           (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date,
           CURRENT_DATE,
           '1 day'::interval
         )::date AS date
       ),
       payment_daily AS (
         SELECT
           DATE(created_at) AS date,
           COALESCE(SUM(amount), 0)::bigint AS revenue_cents,
           COUNT(*)::int AS payment_count
         FROM payments
         WHERE status = 'succeeded'
           AND created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         GROUP BY DATE(created_at)
       ),
       event_daily AS (
         SELECT
           DATE(received_at) AS date,
           COUNT(*) FILTER (WHERE event_name = 'subscription_created')::int AS new_subscriptions,
           COUNT(*) FILTER (WHERE event_name = 'subscription_cancelled')::int AS cancellations,
           COUNT(*) FILTER (WHERE processed_status = 'failed')::int AS failed_events
         FROM subscription_events
         WHERE received_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         GROUP BY DATE(received_at)
       )
       SELECT
         d.date,
         COALESCE(pd.revenue_cents, 0)::bigint AS revenue_cents,
         COALESCE(pd.payment_count, 0)::int AS payment_count,
         COALESCE(ed.new_subscriptions, 0)::int AS new_subscriptions,
         COALESCE(ed.cancellations, 0)::int AS cancellations,
         COALESCE(ed.failed_events, 0)::int AS failed_events
       FROM days d
       LEFT JOIN payment_daily pd ON pd.date = d.date
       LEFT JOIN event_daily ed ON ed.date = d.date
       ORDER BY d.date ASC`,
      [normalizedDays],
    ),
    dataStore.query(`
      SELECT
        COALESCE(ls_variant_id, 'unknown') AS variant_id,
        COUNT(*)::int AS subscriptions
      FROM users
      WHERE subscription_status IN ('active', 'on_trial', 'trialing')
      GROUP BY COALESCE(ls_variant_id, 'unknown')
      ORDER BY subscriptions DESC
    `),
  ]);

  const users = userResult.rows[0] || {};
  const activeSubscriptions = Number(users.active_subscriptions || 0);
  let estimatedMrrCents = 0;
  let mappedSubscriptions = 0;
  let unmappedActiveSubscriptions = Number(users.unmapped_active_subscriptions || 0);
  const hasVariantPricing = Boolean(monthlyVariantId || yearlyVariantId) && Boolean(monthlyPriceCents || yearlyPriceCents);

  for (const item of variantResult.rows) {
    const variantId = String(item.variant_id || 'unknown');
    const count = Number(item.subscriptions || 0);
    if (monthlyVariantId && variantId === monthlyVariantId && monthlyPriceCents > 0) {
      estimatedMrrCents += count * monthlyPriceCents;
      mappedSubscriptions += count;
    } else if (yearlyVariantId && variantId === yearlyVariantId && yearlyMonthlyEquivalentCents > 0) {
      estimatedMrrCents += count * yearlyMonthlyEquivalentCents;
      mappedSubscriptions += count;
    } else if (!monthlyVariantId && !yearlyVariantId && monthlyPriceCents > 0) {
      estimatedMrrCents += count * monthlyPriceCents;
      mappedSubscriptions += count;
    }
  }

  if (mappedSubscriptions > 0) {
    unmappedActiveSubscriptions = Math.max(0, activeSubscriptions - mappedSubscriptions);
  }

  const revenue = revenueResult.rows[0] || {};
  const events = eventResult.rows[0] || {};
  const registeredUsers = Number(users.registered_users || 0);
  const paidMembers = Number(users.paid_members || 0);

  return {
    days: normalizedDays,
    currency: 'usd',
    revenue: {
      total_revenue_cents: Number(revenue.total_revenue_cents || 0),
      period_revenue_cents: Number(revenue.period_revenue_cents || 0),
      today_revenue_cents: Number(revenue.today_revenue_cents || 0),
      total_payment_count: Number(revenue.total_payment_count || 0),
      period_payment_count: Number(revenue.period_payment_count || 0),
      period_paying_users: Number(revenue.period_paying_users || 0),
      period_avg_payment_cents: Number(revenue.period_avg_payment_cents || 0),
    },
    subscriptions: {
      registered_users: registeredUsers,
      paid_members: paidMembers,
      active_subscriptions: activeSubscriptions,
      cancelling_at_period_end: Number(users.cancelling_at_period_end || 0),
      billing_issues: Number(users.billing_issues || 0),
      paid_conversion_rate: registeredUsers > 0 ? Number(((paidMembers / registeredUsers) * 100).toFixed(2)) : 0,
    },
    events: {
      new_subscriptions: Number(events.new_subscriptions || 0),
      cancellations: Number(events.cancellations || 0),
      expirations: Number(events.expirations || 0),
      payment_success_events: Number(events.payment_success_events || 0),
      failed_events: Number(events.failed_events || 0),
      ignored_events: Number(events.ignored_events || 0),
    },
    estimated_mrr: {
      amount_cents: estimatedMrrCents,
      configured: hasVariantPricing || monthlyPriceCents > 0,
      monthly_price_cents: monthlyPriceCents,
      yearly_price_cents: yearlyPriceCents,
      monthly_variant_id: monthlyVariantId || null,
      yearly_variant_id: yearlyVariantId || null,
      unmapped_active_subscriptions: unmappedActiveSubscriptions,
    },
    variants: variantResult.rows,
    daily: dailyResult.rows.map((row) => ({
      date: row.date,
      revenue_cents: Number(row.revenue_cents || 0),
      payment_count: Number(row.payment_count || 0),
      new_subscriptions: Number(row.new_subscriptions || 0),
      cancellations: Number(row.cancellations || 0),
      failed_events: Number(row.failed_events || 0),
    })),
  };
}

async function listSubscriptionEvents({ limit = 50, offset = 0, processedStatus = null, eventName = null } = {}) {
  const where = [];
  const values = [];
  let idx = 1;

  if (processedStatus) {
    where.push(`se.processed_status = $${idx++}`);
    values.push(processedStatus);
  }
  if (eventName) {
    where.push(`se.event_name = $${idx++}`);
    values.push(eventName);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countValues = values.slice();
  const countResult = await dataStore.query(
    `SELECT COUNT(*)::int AS c FROM subscription_events se ${whereSql}`,
    countValues,
  );

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  values.push(safeLimit, safeOffset);

  const { rows } = await dataStore.query(
    `SELECT
       se.id,
       se.event_name,
       se.user_id,
       u.email AS user_email,
       se.ls_subscription_id,
       se.ls_customer_id,
       se.ls_order_id,
       se.ls_variant_id,
       se.status,
       se.amount,
       se.currency,
       se.processed_status,
       se.error_message,
       se.received_at,
       se.processed_at
     FROM subscription_events se
     LEFT JOIN users u ON u.id = se.user_id
     ${whereSql}
     ORDER BY se.received_at DESC, se.id DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  );

  return { items: rows, total: countResult.rows[0]?.c || 0 };
}

module.exports = {
  createCheckoutSession,
  getSubscriptionStatus,
  createCustomerPortalSession,
  verifyWebhookSignature,
  handleWebhookEvent,
  cancelSubscription,
  getSubscriptionAdminSummary,
  getSubscriptionBusinessMetrics,
  listSubscriptionEvents,
};
