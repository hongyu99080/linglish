const path = require('path');
const fsp = require('fs/promises');
const { randomBytes } = require('crypto');
const dataStore = require('../data-store');
const { parseBody } = require('../utils/parsers');
const { sendJson, sendError } = require('../middleware/error-handler');
const { authenticate } = require('../middleware/auth');
const { parseBase64DataUrl, getExtensionFromMime } = require('../utils/audio');

const STATIC_DIR = path.join(__dirname, '../public');
const COMMUNITY_RECORDINGS_DIR = path.join(STATIC_DIR, 'recordings', 'community');

function getDateKey() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function storeAudioData(audioData, prefix) {
  const { mimeType, buffer } = parseBase64DataUrl(audioData);
  const ext = getExtensionFromMime(mimeType);
  const dateKey = getDateKey();
  const dir = path.join(COMMUNITY_RECORDINGS_DIR, prefix, dateKey);
  await fsp.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
  const relPath = `/recordings/community/${prefix}/${dateKey}/${filename}`;
  const absPath = path.join(dir, filename);
  await fsp.writeFile(absPath, buffer);
  return relPath;
}

async function registerCommunityRoutes(pathname, req, res, url) {
  // ============================================================================
  // Voice Check-in Plaza
  // ============================================================================
  if (pathname === '/api/community/voice-checkins' && req.method === 'GET') {
    try {
      const user = await authenticate(req);
      const limit = Number(url.searchParams.get('limit')) || 20;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const items = await dataStore.listVoiceCheckins(user.id, { limit, offset });
      // Add is_owner flag to each item
      const isAdmin = user.role === 'admin' || user.is_admin === true;
      const enrichedItems = items.map(item => ({
        ...item,
        is_owner: Number(item.user_id) === Number(user.id),
        can_delete: Number(item.user_id) === Number(user.id) || isAdmin,
      }));
      return sendJson(res, 200, {
        items: enrichedItems,
        current_user_id: user.id,
        is_admin: isAdmin,
      });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  if (pathname === '/api/community/voice-checkins' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const audioData = body?.audio_data || body?.audioData || null;
      const shareToken = String(body?.share_token || body?.shareToken || '').trim();
      const text = body?.text || '';
      const durationSec = Number(body?.duration_sec || body?.durationSec || 0) || null;
      if (!audioData && !shareToken) {
        return sendError(res, 400, 'audio_data or share_token is required');
      }
      let audioPath = null;
      let shareUrl = null;
      let resolvedShareToken = shareToken || null;
      if (audioData) {
        audioPath = await storeAudioData(audioData, 'checkins');
      } else if (shareToken) {
        const share = await dataStore.getPracticeRecordingShareByToken(shareToken);
        if (!share || Number(share.user_id) !== Number(user.id)) {
          return sendError(res, 403, 'Invalid share token');
        }
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host || 'www.example.com';
        shareUrl = `${proto}://${host}/practice-session-desktop.html?share=${encodeURIComponent(shareToken)}`;
      }
      const checkin = await dataStore.createVoiceCheckin(user.id, {
        text,
        audioPath,
        shareUrl,
        shareToken: resolvedShareToken,
        durationSec
      });
      return sendJson(res, 201, { checkin });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  // Delete voice checkin (owner or admin only)
  const deleteMatch = pathname.match(/^\/api\/community\/voice-checkins\/(\d+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    try {
      const user = await authenticate(req);
      const checkinId = Number(deleteMatch[1]);
      const checkin = await dataStore.getVoiceCheckinById(checkinId);
      if (!checkin) {
        return sendError(res, 404, 'Voice checkin not found');
      }
      // Check if user is owner or admin
      const isOwner = Number(checkin.user_id) === Number(user.id);
      const isAdmin = user.role === 'admin' || user.is_admin === true;
      if (!isOwner && !isAdmin) {
        return sendError(res, 403, 'Permission denied: only owner or admin can delete');
      }
      await dataStore.deleteVoiceCheckin(checkinId);
      return sendJson(res, 200, { success: true, message: 'Deleted successfully' });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  const likeMatch = pathname.match(/^\/api\/community\/voice-checkins\/(\d+)\/like$/);
  if (likeMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const checkinId = Number(likeMatch[1]);
      const existing = await dataStore.getVoiceCheckinLike(user.id, checkinId);
      if (existing) {
        await dataStore.removeVoiceCheckinLike(user.id, checkinId);
      } else {
        await dataStore.addVoiceCheckinLike(user.id, checkinId);
      }
      const likeCount = await dataStore.countVoiceCheckinLikes(checkinId);
      return sendJson(res, 200, { liked: !existing, like_count: likeCount });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  const checkinCommentsMatch = pathname.match(/^\/api\/community\/voice-checkins\/(\d+)\/comments$/);
  if (checkinCommentsMatch && req.method === 'GET') {
    try {
      await authenticate(req);
      const checkinId = Number(checkinCommentsMatch[1]);
      const limit = Number(url.searchParams.get('limit')) || 20;
      const items = await dataStore.listVoiceCheckinComments(checkinId, { limit });
      return sendJson(res, 200, { items });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  if (checkinCommentsMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const checkinId = Number(checkinCommentsMatch[1]);
      const body = await parseBody(req);
      const content = String(body?.content || '').trim();
      if (!content) {
        return sendError(res, 400, 'content is required');
      }
      const comment = await dataStore.addVoiceCheckinComment(user.id, checkinId, content);
      return sendJson(res, 201, { comment });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  const ratingMatch = pathname.match(/^\/api\/community\/voice-checkins\/(\d+)\/ratings$/);
  if (ratingMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const checkinId = Number(ratingMatch[1]);
      const body = await parseBody(req);
      const rating = Number(body?.rating || 0);
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        return sendError(res, 400, 'rating must be 1-5');
      }
      const record = await dataStore.upsertVoiceCheckinRating(user.id, checkinId, rating);
      const summary = await dataStore.getVoiceCheckinRatingSummary(checkinId);
      return sendJson(res, 201, {
        rating: record,
        rating_avg: summary?.avg || 0,
        rating_count: summary?.cnt || 0
      });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  // ============================================================================
  // Native Review Requests
  // ============================================================================
  if (pathname === '/api/community/native-reviews' && req.method === 'GET') {
    try {
      await authenticate(req);
      const limit = Number(url.searchParams.get('limit')) || 20;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const items = await dataStore.listNativeReviewRequests(null, { limit, offset });
      return sendJson(res, 200, { items });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  if (pathname === '/api/community/native-reviews' && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const body = await parseBody(req);
      const audioData = body?.audio_data || body?.audioData || null;
      if (!audioData) {
        return sendError(res, 400, 'audio_data is required');
      }
      const text = body?.text || '';
      const audioPath = await storeAudioData(audioData, 'native-reviews');
      const request = await dataStore.createNativeReviewRequest(user.id, { text, audioPath });
      return sendJson(res, 201, { request });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  const nativeCommentsMatch = pathname.match(/^\/api\/community\/native-reviews\/(\d+)\/comments$/);
  if (nativeCommentsMatch && req.method === 'GET') {
    try {
      await authenticate(req);
      const requestId = Number(nativeCommentsMatch[1]);
      const limit = Number(url.searchParams.get('limit')) || 20;
      const items = await dataStore.listNativeReviewComments(requestId, { limit });
      return sendJson(res, 200, { items });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  if (nativeCommentsMatch && req.method === 'POST') {
    try {
      const user = await authenticate(req);
      const requestId = Number(nativeCommentsMatch[1]);
      const body = await parseBody(req);
      const content = String(body?.content || '').trim();
      if (!content) {
        return sendError(res, 400, 'content is required');
      }
      const comment = await dataStore.addNativeReviewComment(user.id, requestId, content);
      return sendJson(res, 201, { comment });
    } catch (err) {
      return sendError(res, err.status || 500, err.message);
    }
  }

  return false;
}

module.exports = { registerCommunityRoutes };
