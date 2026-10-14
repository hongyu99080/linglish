'use strict';

/**
 * Subscription routes — LemonSqueezy checkout, webhook, status, cancel.
 *
 * Routes:
 *   POST /api/subscription/create-checkout  — create LemonSqueezy checkout URL
 *   POST /api/subscription/webhook          — LemonSqueezy webhook (no auth, raw body)
 *   GET  /api/subscription/status           — current subscription status
 *   GET  /api/subscription/customer-portal  — signed LemonSqueezy customer portal URL
 *   POST /api/subscription/cancel           — cancel subscription
 */

const lemonSqueezyService = require('../services/lemonsqueezy');
const { authenticate } = require('../middleware/auth');
const { sendJson, sendError } = require('../middleware/error-handler');
const { parseBody, parseRawBody } = require('../utils/parsers');

async function requireAdmin(req) {
  const user = await authenticate(req);
  if (!user?.is_admin) {
    const err = new Error('FORBIDDEN');
    err.status = 403;
    throw err;
  }
  return user;
}

/**
 * Register all subscription-related routes.
 *
 * @param {string} pathname
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} true if the route was handled
 */
async function registerSubscriptionRoutes(pathname, req, res) {

  // ── POST /api/subscription/create-checkout ────────────────────────────────
  if (pathname === '/api/subscription/create-checkout' && req.method === 'POST') {
    try {
      const user = await authenticate(req);

      let body;
      try {
        body = await parseBody(req);
      } catch (err) {
        return sendError(res, 400, 'INVALID_JSON');
      }

      const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';

      const result = lemonSqueezyService.createCheckoutSession(user, plan);
      return sendJson(res, 200, { success: true, url: result.url, plan: result.plan });

    } catch (err) {
      if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
        return sendError(res, 401, err.message);
      }
      if (err.message === 'LEMONSQUEEZY_NOT_CONFIGURED') {
        console.error('[Subscription] LemonSqueezy not configured:', err.message);
        return sendError(res, 503, 'PAYMENT_SERVICE_UNAVAILABLE');
      }
      if (
        err.message === 'LEMONSQUEEZY_CHECKOUT_URL_NOT_CONFIGURED' ||
        err.message === 'LEMONSQUEEZY_MONTHLY_CHECKOUT_URL_NOT_CONFIGURED' ||
        err.message === 'LEMONSQUEEZY_YEARLY_CHECKOUT_URL_NOT_CONFIGURED'
      ) {
        console.error('[Subscription] LemonSqueezy checkout URL not configured:', err.message);
        return sendError(res, 503, 'PAYMENT_PLAN_UNAVAILABLE');
      }
      console.error('[Subscription] create-checkout error:', err);
      return sendError(res, 500, 'CHECKOUT_FAILED');
    }
  }

  // ── POST /api/subscription/webhook ────────────────────────────────────────
  // LemonSqueezy sends a raw body + x-signature header.
  if (pathname === '/api/subscription/webhook' && req.method === 'POST') {
    let rawBody;
    try {
      rawBody = await parseRawBody(req);
    } catch (err) {
      console.error('[Subscription] webhook: failed to read body:', err);
      return sendError(res, 400, 'CANNOT_READ_BODY');
    }

    const signature = req.headers['x-signature'];
    if (!signature) {
      return sendError(res, 400, 'MISSING_SIGNATURE');
    }

    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[Subscription] webhook: LEMONSQUEEZY_WEBHOOK_SECRET not configured');
      return sendError(res, 500, 'WEBHOOK_SECRET_NOT_CONFIGURED');
    }

    if (!lemonSqueezyService.verifyWebhookSignature(rawBody, signature, secret)) {
      console.warn('[Subscription] webhook: signature verification failed');
      return sendError(res, 400, 'INVALID_SIGNATURE');
    }

    // Parse the body and process the event
    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch (err) {
      return sendError(res, 400, 'INVALID_JSON');
    }

    // Process asynchronously — always respond 200 immediately
    handleEventSafely(payload);

    return sendJson(res, 200, { received: true });
  }

  // ── GET /api/subscription/status ─────────────────────────────────────────
  if (pathname === '/api/subscription/status' && req.method === 'GET') {
    try {
      const user   = await authenticate(req);
      const status = await lemonSqueezyService.getSubscriptionStatus(user);
      return sendJson(res, 200, { success: true, ...status });
    } catch (err) {
      if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
        return sendError(res, 401, err.message);
      }
      console.error('[Subscription] status error:', err);
      return sendError(res, 500, 'STATUS_FETCH_FAILED');
    }
  }

  // ── GET /api/subscription/customer-portal ────────────────────────────────
  if (pathname === '/api/subscription/customer-portal' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const result = await lemonSqueezyService.createCustomerPortalSession(user);
      return sendJson(res, 200, { success: true, ...result });
    } catch (err) {
      if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
        return sendError(res, 401, err.message);
      }
      if (err.message === 'NO_SUBSCRIPTION') {
        return sendError(res, 404, 'NO_SUBSCRIPTION');
      }
      if (err.message === 'LEMONSQUEEZY_NOT_CONFIGURED') {
        return sendError(res, 503, 'PAYMENT_SERVICE_UNAVAILABLE');
      }
      if (err.message === 'CUSTOMER_PORTAL_UNAVAILABLE') {
        return sendError(res, 503, 'CUSTOMER_PORTAL_UNAVAILABLE');
      }
      console.error('[Subscription] customer portal error:', err);
      return sendError(res, 500, 'CUSTOMER_PORTAL_FAILED');
    }
  }

  // ── GET /admin/subscriptions/summary ─────────────────────────────────────
  if (pathname === '/admin/subscriptions/summary' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const summary = await lemonSqueezyService.getSubscriptionAdminSummary();
      return sendJson(res, 200, summary);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
        return sendError(res, 401, err.message);
      }
      if (err.message === 'FORBIDDEN') {
        return sendError(res, 403, err.message);
      }
      console.error('[Subscription] admin summary error:', err);
      return sendError(res, 500, 'SUBSCRIPTION_SUMMARY_FAILED');
    }
  }

  // ── GET /admin/subscriptions/business ────────────────────────────────────
  if (pathname === '/admin/subscriptions/business' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const metrics = await lemonSqueezyService.getSubscriptionBusinessMetrics({
        days: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30,
      });
      return sendJson(res, 200, metrics);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
        return sendError(res, 401, err.message);
      }
      if (err.message === 'FORBIDDEN') {
        return sendError(res, 403, err.message);
      }
      console.error('[Subscription] business metrics error:', err);
      return sendError(res, 500, 'SUBSCRIPTION_BUSINESS_METRICS_FAILED');
    }
  }

  // ── GET /admin/subscriptions/events ──────────────────────────────────────
  if (pathname === '/admin/subscriptions/events' && req.method === 'GET') {
    try {
      await requireAdmin(req);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const result = await lemonSqueezyService.listSubscriptionEvents({
        limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
        offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0,
        processedStatus: url.searchParams.get('processed_status') || null,
        eventName: url.searchParams.get('event_name') || null,
      });
      return sendJson(res, 200, result);
    } catch (err) {
      if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
        return sendError(res, 401, err.message);
      }
      if (err.message === 'FORBIDDEN') {
        return sendError(res, 403, err.message);
      }
      console.error('[Subscription] admin events error:', err);
      return sendError(res, 500, 'SUBSCRIPTION_EVENTS_FAILED');
    }
  }

  // ── POST /api/subscription/cancel ─────────────────────────────────────────
  if (pathname === '/api/subscription/cancel' && req.method === 'POST') {
    try {
      const user   = await authenticate(req);
      const result = await lemonSqueezyService.cancelSubscription(user);
      return sendJson(res, 200, { success: true, ...result });
    } catch (err) {
      if (err.message === 'UNAUTHORIZED' || err.message === 'TOKEN_EXPIRED') {
        return sendError(res, 401, err.message);
      }
      if (err.message === 'NO_ACTIVE_SUBSCRIPTION') {
        return sendError(res, 404, 'NO_ACTIVE_SUBSCRIPTION');
      }
      if (err.message === 'LEMONSQUEEZY_NOT_CONFIGURED') {
        return sendError(res, 503, 'PAYMENT_SERVICE_UNAVAILABLE');
      }
      console.error('[Subscription] cancel error:', err);
      return sendError(res, 500, 'CANCEL_FAILED');
    }
  }

  return false; // route not handled
}

/**
 * Process a webhook event without throwing — logs errors instead so
 * LemonSqueezy always receives a 200 and doesn't retry on our internal failures.
 */
async function handleEventSafely(payload) {
  try {
    await lemonSqueezyService.handleWebhookEvent(payload);
  } catch (err) {
    const eventName = payload.meta && payload.meta.event_name;
    console.error(`[Subscription] webhook: error handling event ${eventName}:`, err);
  }
}

module.exports = { registerSubscriptionRoutes };
