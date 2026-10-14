const { WebSocketServer } = require('ws');
const { authenticate } = require('../middleware/auth');
const authService = require('../services/auth');
const { verifyGroupChatTicket } = require('../services/scoped-browser-token');
const dataStore = require('../data-store');
const studyGroups = require('../services/study-groups');

function extractMentions(content) {
  if (!content) return [];
  const matches = content.match(/@([a-zA-Z0-9_\u4e00-\u9fa5]+)/g) || [];
  return Array.from(new Set(matches.map((m) => m.slice(1))));
}

const groupSockets = new Map();

async function authorizeGroupChatRequest(req, options = {}) {
  const url = new URL(req.url || '', 'http://localhost');
  const groupId = Number(url.searchParams.get('groupId'));
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('INVALID_GROUP');

  let user;
  const ticket = url.searchParams.get('ticket');
  if (ticket) {
    const payload = verifyGroupChatTicket(ticket, {
      groupId,
      secret: options.secret,
      now: options.now,
    });
    const findUserById = options.findUserById || dataStore.findUserById;
    const record = await findUserById(payload.sub);
    if (!record) throw new Error('UNAUTHORIZED');
    if (String(record.status || '').toLowerCase() === 'banned') {
      const err = new Error('BANNED');
      err.status = 403;
      throw err;
    }
    user = authService.sanitizeUser(record);
  } else {
    const allowLegacy = options.allowLegacyAccountToken == null
      ? process.env.WS_ALLOW_LEGACY_ACCOUNT_TOKEN === 'true'
      : Boolean(options.allowLegacyAccountToken);
    if (!allowLegacy) throw new Error('UNAUTHORIZED');
    const authenticateRequest = options.authenticateRequest || authenticate;
    user = await authenticateRequest(req);
  }

  const query = options.query || dataStore.query;
  const membership = await query(
    `SELECT role FROM study_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
    [groupId, user.id]
  );
  if (membership.rows.length === 0) throw new Error('NOT_A_MEMBER');
  return { user, groupId };
}

function broadcastGroupChat(groupId, message) {
  const groupSet = groupSockets.get(groupId);
  if (!groupSet || groupSet.size === 0) return false;
  const out = JSON.stringify({ type: 'chat', groupId, message });
  groupSet.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(out);
    }
  });
  return true;
}

function setupGroupChatWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws/group-chat' });
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    let user = null;
    let groupId = null;
    try {
      ({ user, groupId } = await authorizeGroupChatRequest(req));
    } catch (err) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    ws.user = user;
    ws.groupId = groupId;
    if (!groupSockets.has(groupId)) {
      groupSockets.set(groupId, new Set());
    }
    groupSockets.get(groupId).add(ws);
    ws.send(JSON.stringify({ type: 'ready', groupId }));

    ws.on('message', async (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw || ''));
      } catch (_) {
        return;
      }
      if (!payload || payload.type !== 'chat') return;
      const content = String(payload.content || '').trim();
      const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
      const attachments = rawAttachments
        .filter(att => att && typeof att.url === 'string' && typeof att.kind === 'string')
        .map(att => ({ url: att.url, kind: att.kind }))
        .filter(att => att.kind === 'image' || att.kind === 'audio')
        .slice(0, 6);
      if (!content && attachments.length === 0) return;
      if (content.length > 500) {
        ws.send(JSON.stringify({ type: 'error', message: '内容过长，请控制在 500 字以内' }));
        return;
      }
      try {
        const muteCheck = await dataStore.query(
          `SELECT muted_until FROM group_member_mutes
           WHERE group_id = $1 AND user_id = $2 AND muted_until > NOW()
           LIMIT 1`,
          [groupId, user.id]
        );
        if (muteCheck.rows.length > 0) {
          ws.send(JSON.stringify({ type: 'error', message: '你已被禁言，暂时无法发言' }));
          return;
        }
      } catch (_) {
        ws.send(JSON.stringify({ type: 'error', message: '发送失败，请稍后再试' }));
        return;
      }
      try {
        const activity = await studyGroups.postActivity(
          groupId,
          user.id,
          'chat',
          content,
          { attachments, mentions: extractMentions(content) }
        );
        const message = {
          id: activity.id,
          group_id: groupId,
          user_id: user.id,
          username: user.username,
          content,
          created_at: activity.created_at,
          activity_data: activity.activity_data
        };
        broadcastGroupChat(groupId, message);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: '发送失败，请稍后再试' }));
      }
    });

    ws.on('close', () => {
      const groupSet = groupSockets.get(groupId);
      if (groupSet) {
        groupSet.delete(ws);
        if (groupSet.size === 0) {
          groupSockets.delete(groupId);
        }
      }
    });
  });

  return wss;
}

module.exports = { setupGroupChatWebSocket, broadcastGroupChat, authorizeGroupChatRequest };
