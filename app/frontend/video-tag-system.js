/**
 * Video Tag System - 视频标签系统
 *
 * 功能:
 * 1. 预设标签：我的、职场、购物、生活、影视
 * 2. 自定义标签：每个用户可以创建自己的标签
 * 3. 多标签支持：一个视频可以有多个标签
 * 4. 智能过滤：可以按标签筛选视频
 */

(function (window) {
  'use strict';

  // 预设标签配置
  const PRESET_TAGS = [
    { id: 'my', name: '我的', icon: '⭐', color: '#0f766e' },
    { id: 'work', name: '职场', icon: '💼', color: '#f97316' },
    { id: 'shopping', name: '购物', icon: '🛒', color: '#ec4899' },
    { id: 'life', name: '生活', icon: '🏠', color: '#14b8a6' },
    { id: 'entertainment', name: '影视', icon: '🎬', color: '#f59e0b' },
    { id: 'kids', name: '儿童', icon: '🧸', color: '#38bdf8' }
  ];
  // 若接口未返回全局标签时的数字ID映射（线上已用1-6）
  const PRESET_ID_MAP = {
    '1': 'my',
    '2': 'work',
    '3': 'shopping',
    '4': 'life',
    '5': 'entertainment',
    '6': 'kids'
  };

  // 获取用户标识
  function getUserKey() {
    try {
      const email = localStorage.getItem('userEmail') ||
        sessionStorage.getItem('userEmail') ||
        localStorage.getItem('linglish_user_email') ||
        'guest';
      return `user_${email}`;
    } catch (e) {
      return 'user_guest';
    }
  }

  // 获取存储键名
  function getStorageKey(key) {
    return `linglish_${getUserKey()}_${key}`;
  }

  // 安全的 localStorage 操作
  function safeGetItem(key, defaultValue = null) {
    try {
      const value = localStorage.getItem(key);
      if (!value || value === 'undefined' || value === 'null') {
        return defaultValue;
      }
      return JSON.parse(value);
    } catch (e) {
      console.warn('[TagSystem] Error reading from localStorage:', e);
      return defaultValue;
    }
  }

  function safeSetItem(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('[TagSystem] Error writing to localStorage:', e);
      return false;
    }
  }

  function isDebugEnabled() {
    try { return localStorage.getItem('linglish_debug') === '1'; } catch (_) { }
    return false;
  }

  function clearAuthTokens() {
    const keys = ['linglish_token', 'authToken', 'token'];
    try { keys.forEach(k => localStorage.removeItem(k)); } catch (_) { }
    try { keys.forEach(k => sessionStorage.removeItem(k)); } catch (_) { }
  }

  // 标签系统核心类
  class VideoTagSystem {
    constructor() {
      // 内存副本，避免浏览器拒绝 localStorage 导致数据丢失
      this.memoryVideoTags = {};
      this.serverCache = {
        globalTags: [],
        userTags: [],
        prefs: { hidden: [], pinned: [], alias: {} }
      };
      this.fetchedVideoIds = new Set();
      // 数据版本号：标签映射/服务端缓存每次变化时递增，供渲染缓存键使用
      this.dataVersion = 0;
      this.init();
    }

    get customTagsKey() { return getStorageKey('custom_tags'); }
    get videoTagsKey() { return getStorageKey('video_tags'); }
    get prefKey() { return getStorageKey('tag_prefs'); }

    init() {
      if (!safeGetItem(this.customTagsKey)) {
        safeSetItem(this.customTagsKey, []);
      }
      if (!safeGetItem(this.videoTagsKey)) {
        safeSetItem(this.videoTagsKey, {});
      }
      if (!safeGetItem(this.prefKey)) {
        safeSetItem(this.prefKey, { hidden: [], pinned: [], alias: {} });
      }
    }

    // 将预设标签 ID 映射到后端的全局标签 ID（按名称匹配）
    resolveServerTagId(tagId) {
      if (!tagId) return null;
      if (/^\d+$/.test(String(tagId))) return Number(tagId);
      const preset = PRESET_TAGS.find(t => t.id === tagId);
      if (!preset) return null;
      const serverMatch = (this.serverCache.globalTags || []).find(t => t.name === preset.name);
      return serverMatch ? Number(serverMatch.id) : null;
    }

    /**
     * 获取标签的数字 ID（用于后端存储）
     * @param {string} tagId - 标签 ID
     * @returns {number|null} 数字 ID，如果无法解析则返回 null
     */
    getNumericId(tagId) {
      if (!tagId) return null;
      const sid = String(tagId);
      if (sid.startsWith('u:')) return Number(sid.slice(2));

      // 1. 如果已经是数字字符串，直接返回
      if (/^\d+$/.test(sid)) return Number(sid);

      // 2. 尝试从 serverCache 中查找（通过 resolveServerTagId）
      const resolved = this.resolveServerTagId(sid);
      if (resolved !== null) return resolved;

      // 3. 静态回退：反查 PRESET_ID_MAP
      // PRESET_ID_MAP 是 '1': 'my'，我们需要 'my' -> 1
      const entry = Object.entries(PRESET_ID_MAP).find(([k, v]) => v === sid);
      if (entry) return Number(entry[0]);

      return null;
    }

    // ===== 标签管理 =====

    /**
     * 获取所有预设标签
     * @returns {Array} 预设标签数组
     */
    getPresetTags() {
      return [...PRESET_TAGS];
    }

    /**
     * 获取所有自定义标签
     * @returns {Array} 自定义标签数组
     */
    getCustomTags() {
      // 服务器个人标签
      if (this.serverCache.userTags && this.serverCache.userTags.length) {
        return this.serverCache.userTags.map(t => ({ ...t, id: `u:${t.id}`, custom: true, scope: 'user' }));
      }
      // 本地占位（兼容老数据）
      const tags = safeGetItem(this.customTagsKey, []);
      return Array.isArray(tags) ? tags.map(t => ({ ...t, id: `u:${t.id}`, custom: true, scope: 'user_local' })) : [];
    }

    /**
     * 获取所有标签（预设 + 自定义）
     * @returns {Array} 所有标签数组
     */
    getAllTags() {
      const globals = (this.serverCache.globalTags || []).map(t => ({ ...t, scope: 'global' }));
      const personals = this.getCustomTags();
      const presets = this.getPresetTags().map(t => ({ ...t, scope: 'global' }));

      const merged = [];
      const seenId = new Set();
      const seenName = new Set();
      const push = (t) => {
        if (!t) return;
        const id = String(t.id);
        const name = (t.name || '').trim();
        // 检查ID或名称是否已存在（去重）
        if (seenId.has(id) || (name && seenName.has(name))) return;
        seenId.add(id);
        if (name) seenName.add(name);
        merged.push(t);
      };

      globals.forEach(push);
      presets.forEach(push); // 始终补齐预设，防止占位符覆盖

      // 若仅有数字ID（如6）出现在视频标签里，补充对应的预设对象
      Object.entries(PRESET_ID_MAP).forEach(([numId, presetKey]) => {
        const preset = PRESET_TAGS.find(t => t.id === presetKey);
        if (preset && !seenId.has(numId)) {
          push({ ...preset, id: numId, scope: 'global' });
        }
      });

      return [...merged, ...personals];
    }

    getPreferences() {
      // 优先使用有数据的 serverCache，否则回落本地存储
      const hasServerPrefs = this.serverCache.prefs
        && Array.isArray(this.serverCache.prefs.hidden)
        && this.serverCache.prefs.hidden.length + (this.serverCache.prefs.pinned?.length || 0) + Object.keys(this.serverCache.prefs.alias || {}).length > 0;
      const p = hasServerPrefs
        ? this.serverCache.prefs
        : safeGetItem(this.prefKey, {});
      return {
        hidden: Array.isArray(p.hidden) ? p.hidden.map(id => String(id)) : [],
        pinned: Array.isArray(p.pinned) ? p.pinned.map(id => String(id)) : [],
        alias: (() => {
          const map = {};
          if (p.alias && typeof p.alias === 'object') {
            Object.entries(p.alias).forEach(([k, v]) => {
              if (v && typeof v === 'string') map[String(k)] = v;
            });
          }
          return map;
        })()
      };
    }

    savePreferences(p) {
      const data = {
        hidden: Array.isArray(p.hidden) ? p.hidden.map(id => String(id)) : [],
        pinned: Array.isArray(p.pinned) ? p.pinned.map(id => String(id)) : [],
        alias: (() => {
          const map = {};
          if (p.alias && typeof p.alias === 'object') {
            Object.entries(p.alias).forEach(([k, v]) => {
              if (v && typeof v === 'string') map[String(k)] = v;
            });
          }
          return map;
        })()
      };
      safeSetItem(this.prefKey, data);
      this.serverCache.prefs = data;
    }

    toggleHide(tagId) {
      const prefs = this.getPreferences();
      const key = String(tagId);
      const serverId = this.resolveServerTagId(key);
      const ids = serverId !== null ? [key, String(serverId)] : [key];
      const hiddenSet = new Set(prefs.hidden);
      const hasAny = ids.some(id => hiddenSet.has(id));
      if (hasAny) {
        prefs.hidden = prefs.hidden.filter(id => !ids.includes(id));
      } else {
        prefs.hidden = Array.from(new Set([...prefs.hidden, ...ids]));
      }
      this.savePreferences(prefs);
      return !ids.some(id => prefs.hidden.includes(id));
    }

    togglePin(tagId) {
      const prefs = this.getPreferences();
      const key = String(tagId);
      const serverId = this.resolveServerTagId(key);
      const ids = serverId !== null ? [key, String(serverId)] : [key];
      const pinnedSet = new Set(prefs.pinned);
      const hasAny = ids.some(id => pinnedSet.has(id));
      if (hasAny) {
        prefs.pinned = prefs.pinned.filter(id => !ids.includes(id));
      } else {
        prefs.pinned = Array.from(new Set([...ids, ...prefs.pinned]));
      }
      this.savePreferences(prefs);
      return ids.some(id => prefs.pinned.includes(id));
    }

    isHidden(tagId) {
      return this.getPreferences().hidden.includes(String(tagId));
    }

    getVisibleTags(options = { includePersonal: true, includeGlobal: true }) {
      const includePersonal = options.includePersonal !== false;
      const includeGlobal = options.includeGlobal !== false;
      const prefs = this.getPreferences();
      const aliasMap = prefs.alias || {};
      const all = this.getAllTags().filter(t => {
        if (!includePersonal && (t.scope || '').startsWith('user')) return false;
        if (!includeGlobal && (t.scope || 'global') === 'global') return false;
        return true;
      });
      const visible = all
        .filter(t => !prefs.hidden.includes(String(t.id)))
        .map(t => {
          const display = aliasMap[String(t.id)];
          return {
            ...t,
            originalName: t.name,
            name: display || t.name,
            displayName: display || t.name
          };
        });
      const pinnedSet = new Set(prefs.pinned.map(String));
      const pinned = visible.filter(t => pinnedSet.has(String(t.id)));
      const rest = visible.filter(t => !pinnedSet.has(String(t.id)));
      rest.sort((a, b) => {
        const aScope = a.scope || 'global';
        const bScope = b.scope || 'global';
        if (aScope !== bScope) {
          // 全局优先，其次个人/本地
          if (aScope === 'global') return -1;
          if (bScope === 'global') return 1;
          if (aScope === 'user' && bScope !== 'user') return -1;
          if (bScope === 'user' && aScope !== 'user') return 1;
        }
        return (a.name || '').localeCompare(b.name || '');
      });
      return [...pinned, ...rest];
    }

    setAlias(tagId, alias) {
      const prefs = this.getPreferences();
      const a = (alias || '').trim();
      const key = String(tagId);
      if (a) prefs.alias[key] = a;
      else delete prefs.alias[key];
      this.savePreferences(prefs);
    }

    // ====== Server Sync ======
    async loadFromServer(apiBase, token) {
      if (!token) return false;
      const base = apiBase || '';
      try {
        const res = await fetch(`${base}/tags`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) {
          let body = '';
          try { body = await res.text(); } catch (_) { }
          console.warn('[TagSystem] loadFromServer failed status:', res.status, res.statusText, body);
          if (res.status === 401) {
            console.warn('[TagSystem] Token expired, clearing auth tokens');
            clearAuthTokens();
          }
          // 失败时仍使用本地偏好，避免刷新后丢失隐藏/置顶
          const localPrefs = this.getPreferences();
          this.serverCache.prefs = localPrefs;
          console.warn('[TagSystem] Using local prefs because server returned error', localPrefs);
          return false;
        }
        const data = await res.json();
        this.serverCache.globalTags = Array.isArray(data.global_tags) ? data.global_tags : [];
        this.serverCache.userTags = Array.isArray(data.user_tags) ? data.user_tags : [];
        this.dataVersion++;
        const serverPrefs = data.preferences && Array.isArray(data.preferences)
          ? {
            hidden: data.preferences.filter(p => p.hidden).map(p => p.tag_id),
            pinned: data.preferences.filter(p => p.pinned).map(p => p.tag_id),
            alias: data.preferences.reduce((acc, p) => {
              if (p.alias) acc[p.tag_id] = p.alias;
              return acc;
            }, {})
          }
          : null;

        // 如果后端没有偏好记录，保留本地偏好，避免刷新后丢失
        if (serverPrefs && (serverPrefs.hidden.length || serverPrefs.pinned.length || Object.keys(serverPrefs.alias).length)) {
          this.serverCache.prefs = serverPrefs;
          this.savePreferences(serverPrefs);
          console.log('[TagSystem] Loaded prefs from server', serverPrefs);
        } else {
          const local = this.getPreferences();
          this.serverCache.prefs = local;
          console.warn('[TagSystem] Server returned no tag preferences, keeping local prefs');
        }

        // 若存在本地自定义标签（custom_xxx），自动上报为个人标签并迁移引用
        await this.migrateLocalCustomTagsToServer(base, token);

        console.log('[TagSystem] loadFromServer globals:', this.serverCache.globalTags.length, 'userTags:', this.serverCache.userTags.length);
        return true;
      } catch (e) {
        console.warn('[TagSystem] loadFromServer failed', e);
        // 失败时仍使用本地偏好，避免刷新后丢失隐藏/置顶
        const localPrefs = this.getPreferences();
        this.serverCache.prefs = localPrefs;
        console.warn('[TagSystem] Using local prefs because server load failed', localPrefs);
        return false;
      }
    }

    /**
     * 将本地自定义标签（custom_xxx）同步为服务器个人标签，并迁移视频引用
     */
    async migrateLocalCustomTagsToServer(apiBase, token) {
      try {
        const localCustom = safeGetItem(this.customTagsKey, []);
        if (!Array.isArray(localCustom) || !localCustom.length) return;
        const mapping = {};
        for (const tag of localCustom) {
          if (!tag || !tag.name) continue;
          try {
            const resp = await fetch(`${apiBase}/user-tags`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: tag.name, icon: tag.icon || '🏷️', color: tag.color || '#64748b' })
            });
            if (!resp.ok) {
              console.warn('[TagSystem] migrateLocalCustomTagsToServer create failed', tag.name, resp.status);
              continue;
            }
            const data = await resp.json();
            if (data && data.tag && data.tag.id) {
              mapping[tag.id] = String(data.tag.id);
              this.serverCache.userTags = [...(this.serverCache.userTags || []), data.tag];
            }
          } catch (e) {
            console.warn('[TagSystem] migrateLocalCustomTagsToServer error', e);
          }
        }
        if (!Object.keys(mapping).length) return;
        // 替换视频标签中的旧ID
        const videoTags = this.getAllVideoTags();
        let changed = false;
        Object.keys(videoTags).forEach(vid => {
          const mapped = (videoTags[vid] || []).map(tid => mapping[tid] ? mapping[tid] : tid);
          const uniq = Array.from(new Set(mapped));
          if (uniq.join(',') !== (videoTags[vid] || []).join(',')) {
            videoTags[vid] = uniq;
            changed = true;
          }
        });
        if (changed) {
          safeSetItem(this.videoTagsKey, videoTags);
          this.memoryVideoTags = videoTags;
          console.log('[TagSystem] migrateLocalCustomTagsToServer: updated video tag references', mapping);
        }
        // 清理本地占位
        safeSetItem(this.customTagsKey, []);
      } catch (e) {
        console.warn('[TagSystem] migrateLocalCustomTagsToServer outer error', e);
      }
    }

    async savePreferencesToServer(apiBase, token) {
      if (!apiBase || !token) return false;
      try {
        const prefs = this.getPreferences();
        const payload = [];
        const tagIds = new Set([...prefs.hidden, ...prefs.pinned, ...Object.keys(prefs.alias || {})]);
        // 允许的全局标签 ID：后端返回 + 预设数字映射（1-6）
        const allowedGlobalIds = new Set(
          [
            ...(this.serverCache.globalTags || []).map(t => String(t.id)),
            ...Object.keys(PRESET_ID_MAP) // 1~6
          ].filter(id => /^\d+$/.test(id))
        );
        tagIds.forEach(id => {
          const sid = String(id);
          let serverId = null;
          if (allowedGlobalIds.has(sid)) {
            serverId = Number(sid);
          } else {
            const resolved = this.resolveServerTagId(sid);
            if (resolved !== null && allowedGlobalIds.has(String(resolved))) {
              serverId = resolved;
            }
          }
          if (serverId === null) return;
          payload.push({
            tag_id: Number(serverId),
            hidden: prefs.hidden.includes(sid) || prefs.hidden.includes(String(serverId)),
            pinned: prefs.pinned.includes(sid) || prefs.pinned.includes(String(serverId)),
            alias: prefs.alias ? (prefs.alias[String(serverId)] || prefs.alias[sid]) : null
          });
        });
        if (payload.length) {
          console.log('[TagSystem] savePreferencesToServer payload', payload);
          const resp = await fetch(`${apiBase}/tag-preferences`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: payload })
          });
          if (!resp.ok) {
            const text = await resp.text();
            console.warn('[TagSystem] savePreferencesToServer failed status', resp.status, text);
          } else {
            console.log('[TagSystem] savePreferencesToServer success');
          }
        } else {
          console.warn('[TagSystem] savePreferencesToServer skipped: no numeric global tag ids available. Ensure tags exist in DB.');
        }
        return true;
      } catch (e) {
        console.warn('[TagSystem] savePreferencesToServer failed', e);
        return false;
      }
    }

    /**
     * 批量同步视频标签映射
     * @param {string} apiBase - API 基础 URL
     * @param {string} token - 认证 token
     * @param {Array<number|string>} videoIds - 视频 ID 数组
     * @param {Object} options - 选项 { force: boolean }
     * @returns {Promise<boolean>} 是否成功
     */
    async syncVideoTagsFromServer(apiBase, token, videoIds, options = {}) {
      if (!token || !Array.isArray(videoIds) || videoIds.length === 0) {
        console.warn('[TagSystem] syncVideoTagsFromServer: invalid params');
        return false;
      }

      const base = apiBase || '';
      const headers = { 'Authorization': `Bearer ${token}` };

      const normalizeVideoId = (val) => {
        const num = Number(String(val || '').trim());
        if (!Number.isInteger(num) || num <= 0) return null;
        return num;
      };
      const uniqueIds = Array.from(new Set(videoIds.map(normalizeVideoId).filter(v => v !== null)));
      if (uniqueIds.length === 0) return true;

      // 默认只同步本地未缓存的 videoId；如需强制刷新，传 options.force = true
      const allCached = this.getAllVideoTags();
      const idsToSync = options?.force
        ? uniqueIds
        : uniqueIds.filter(vid => !Object.prototype.hasOwnProperty.call(allCached, String(vid)));

      let successCount = 0;

      // 优先使用批量接口，显著降低网络请求数量
      if (idsToSync.length > 0) {
        try {
          const res = await fetch(`${base}/videos/tags/batch`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_ids: idsToSync })
          });
          if (res.ok) {
            const data = await res.json();
            const items = Array.isArray(data?.items) ? data.items : [];
            for (const item of items) {
              const vid = item?.video_id;
              if (!vid) continue;
              const globalIds = (item.global_tag_ids || []).map(id => String(id));
              const userIds = (item.user_tag_ids || []).map(id => `u:${id}`);
              const merged = [...globalIds, ...userIds];
              this.setVideoTags(vid, merged);
              if (merged.length > 0) successCount++;
            }
            console.log('[TagSystem] syncVideoTagsFromServer complete (batch)', { total: idsToSync.length, withTags: successCount });
            return true;
          }

          // 若后端尚未部署批量接口，回退到逐个接口
          if (res.status !== 404) {
            let body = '';
            try { body = await res.text(); } catch (_) { }
            console.warn('[TagSystem] batch tags endpoint failed, fallback to per-video', res.status, body);
          }
        } catch (e) {
          console.warn('[TagSystem] batch tags endpoint error, fallback to per-video', e);
        }
      }

      // 回退：分批逐个获取（兼容旧后端）
      const batchSize = 10;
      const batches = [];
      for (let i = 0; i < idsToSync.length; i += batchSize) {
        batches.push(idsToSync.slice(i, i + batchSize));
      }

      for (const batch of batches) {
        const promises = batch.map(async (videoId) => {
          try {
            const res = await fetch(`${base}/videos/${videoId}/tags`, { headers });
            if (!res.ok) {
              console.warn('[TagSystem] syncVideoTagsFromServer fetch failed', videoId, res.status);
              return;
            }
            const data = await res.json();
            const globalIds = (data.global_tag_ids || []).map(id => String(id));
            const userIds = (data.user_tag_ids || []).map(id => `u:${id}`);
            const merged = [...globalIds, ...userIds];
            this.setVideoTags(videoId, merged);
            if (merged.length > 0) successCount++;
          } catch (e) {
            console.warn('[TagSystem] syncVideoTagsFromServer error', videoId, e);
          }
        });
        await Promise.all(promises);
      }

      console.log('[TagSystem] syncVideoTagsFromServer complete (per-video)', { total: idsToSync.length, withTags: successCount });
      return true;
    }

    async createPersonalTag(apiBase, token, name, icon = '🏷️', color = '#64748b') {
      if (!apiBase || !token || !name) return null;
      try {
        const res = await fetch(`${apiBase}/user-tags`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, icon, color })
        });
        if (!res.ok) throw new Error('create personal tag failed');
        const data = await res.json();
        if (data.tag) {
          this.serverCache.userTags = [...(this.serverCache.userTags || []), data.tag];
          return data.tag;
        }
      } catch (e) {
        console.warn('[TagSystem] createPersonalTag failed', e);
      }
      return null;
    }

    /**
     * 清理本地/内存中的用户标签引用，防止删除失败后 UI 仍然保留陈旧标签
     * @param {string|number} tagId
     */
    removeUserTagFromCache(tagId) {
      if (!tagId) return;
      const rawId = String(tagId).replace(/^u:/, '');

      // 从服务端缓存移除（用于渲染）
      if (Array.isArray(this.serverCache.userTags)) {
        this.serverCache.userTags = this.serverCache.userTags.filter(t => String(t.id) !== rawId);
      }

      // 清理本地自定义标签存储（旧数据兜底）
      const customTags = safeGetItem(this.customTagsKey, []);
      if (Array.isArray(customTags) && customTags.length) {
        const filtered = customTags.filter(tag => String(tag.id) !== rawId);
        if (filtered.length !== customTags.length) {
          safeSetItem(this.customTagsKey, filtered);
        }
      }

      // 清理视频标签引用，防止残留
      const videoTags = this.getAllVideoTags();
      Object.keys(videoTags).forEach(k => {
        videoTags[k] = videoTags[k].filter(id => {
          const sid = String(id);
          return sid !== rawId && sid !== `u:${rawId}`;
        });
        if (videoTags[k].length === 0) delete videoTags[k];
      });
      safeSetItem(this.videoTagsKey, videoTags);
    }

    async deletePersonalTag(apiBase, token, tagId) {
      if (!tagId) return false;
      // Strip 'u:' prefix if present
      const rawId = String(tagId).replace(/^u:/, '');

      // 本地/内存先行移除，避免后续渲染使用陈旧数据
      const cleanup = () => this.removeUserTagFromCache(rawId);

      if (!apiBase || !token) {
        cleanup();
        return false;
      }

      try {
        const res = await fetch(`${apiBase}/user-tags/${rawId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        // If 404, it's already gone, consider it success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete personal tag failed: ${res.status}`);
        }

        cleanup();
        return true;
      } catch (e) {
        console.warn('[TagSystem] deletePersonalTag failed', e);
        cleanup();
        return false;
      }
    }

    /**
     * 添加自定义标签
     * @param {string} name - 标签名称
     * @param {string} icon - 标签图标（可选）
     * @param {string} color - 标签颜色（可选）
     * @returns {Object|null} 新创建的标签对象，如果失败返回 null
     */
    addCustomTag(name, icon = '🏷️', color = '#64748b') {
      if (!name || typeof name !== 'string') {
        console.warn('[TagSystem] Invalid tag name');
        return null;
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        console.warn('[TagSystem] Tag name cannot be empty');
        return null;
      }

      // 检查是否已存在同名标签（包括预设标签）
      const allTags = this.getAllTags();
      if (allTags.some(tag => tag.name === trimmedName)) {
        console.warn('[TagSystem] Tag already exists:', trimmedName);
        return null;
      }

      // 创建新标签
      // Use raw storage read to avoid prefix duplication later
      const customTags = safeGetItem(this.customTagsKey, []);
      const newTag = {
        id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: trimmedName,
        icon: icon || '🏷️',
        color: color || '#64748b',
        custom: true,
        createdAt: new Date().toISOString()
      };

      customTags.push(newTag);
      safeSetItem(this.customTagsKey, customTags);

      return newTag;
    }

    /**
     * 删除自定义标签
     * @param {string} tagId - 标签 ID
     * @returns {boolean} 是否删除成功
     */
    deleteCustomTag(tagId) {
      if (!tagId) return false;

      // Cannot delete preset tags
      if (PRESET_TAGS.some(tag => tag.id === tagId)) {
        console.warn('[TagSystem] Cannot delete preset tag');
        return false;
      }

      // Normalize ID to match raw storage format if possible.
      const rawId = String(tagId).replace(/^u:/, '');

      // Read RAW storage
      const customTags = safeGetItem(this.customTagsKey, []);
      const filteredTags = customTags.filter(tag => String(tag.id) !== rawId);

      const wasRemoved = filteredTags.length !== customTags.length;

      if (wasRemoved) {
        safeSetItem(this.customTagsKey, filteredTags);
      }

      // Remove references from caches regardless to keep UI in sync
      this.removeUserTagFromCache(rawId);

      return wasRemoved;
    }

    /**
     * 更新自定义标签
     * @param {string} tagId - 标签 ID
     * @param {Object} updates - 更新的属性
     * @returns {boolean} 是否更新成功
     */
    updateCustomTag(tagId, updates) {
      if (!tagId || !updates) return false;

      // 不能更新预设标签
      if (PRESET_TAGS.some(tag => tag.id === tagId)) {
        console.warn('[TagSystem] Cannot update preset tag');
        return false;
      }

      const customTags = this.getCustomTags();
      const tagIndex = customTags.findIndex(tag => tag.id === tagId);

      if (tagIndex === -1) {
        console.warn('[TagSystem] Tag not found:', tagId);
        return false;
      }

      // 更新标签
      customTags[tagIndex] = {
        ...customTags[tagIndex],
        ...updates,
        id: tagId, // 确保 ID 不被修改
        custom: true, // 确保标记为自定义
        updatedAt: new Date().toISOString()
      };

      safeSetItem(this.customTagsKey, customTags);
      return true;
    }

    // ===== 视频标签管理 =====

    /**
     * 获取所有视频标签映射
     * @returns {Object} 视频标签映射 { videoId: [tagId1, tagId2, ...] }
     */
    getAllVideoTags() {
      // 优先内存缓存，再回落到 localStorage
      const stored = safeGetItem(this.videoTagsKey, null);
      if (stored && typeof stored === 'object') {
        this.memoryVideoTags = stored;
        return stored;
      }
      if (this.memoryVideoTags && typeof this.memoryVideoTags === 'object') {
        return this.memoryVideoTags;
      }
      this.memoryVideoTags = {};
      return {};
    }

    /**
     * 获取指定视频的标签
     * @param {string|number} videoId - 视频 ID
     * @returns {Array} 标签 ID 数组
     */
    getVideoTags(videoId) {
      if (!videoId) return [];
      const videoTags = this.getAllVideoTags();
      const tags = videoTags[String(videoId)] || [];
      return Array.isArray(tags) ? tags : [];
    }

    /**
     * 为视频添加标签
     * @param {string|number} videoId - 视频 ID
     * @param {string} tagId - 标签 ID
     * @returns {boolean} 是否添加成功
     */
    addTagToVideo(videoId, tagId) {
      if (!videoId || !tagId) return false;

      // 验证标签是否存在
      const allTags = this.getAllTags();
      if (!allTags.some(tag => tag.id === tagId)) {
        console.warn('[TagSystem] Tag not found:', tagId);
        return false;
      }

      const videoTags = this.getAllVideoTags();
      const videoIdStr = String(videoId);

      if (!videoTags[videoIdStr]) {
        videoTags[videoIdStr] = [];
      }

      // 检查是否已添加
      if (videoTags[videoIdStr].includes(tagId)) {
        console.warn('[TagSystem] Tag already added to video');
        return false;
      }

      videoTags[videoIdStr].push(tagId);
      this.memoryVideoTags = videoTags;
      safeSetItem(this.videoTagsKey, videoTags);

      return true;
    }

    /**
     * 从视频移除标签
     * @param {string|number} videoId - 视频 ID
     * @param {string} tagId - 标签 ID
     * @returns {boolean} 是否移除成功
     */
    removeTagFromVideo(videoId, tagId) {
      if (!videoId || !tagId) return false;

      const videoTags = this.getAllVideoTags();
      const videoIdStr = String(videoId);

      if (!videoTags[videoIdStr]) {
        return false;
      }

      const initialLength = videoTags[videoIdStr].length;
      videoTags[videoIdStr] = videoTags[videoIdStr].filter(tid => tid !== tagId);

      if (videoTags[videoIdStr].length === initialLength) {
        return false; // 标签不存在，无需移除
      }

      // 如果视频没有标签了，删除该视频的条目
      if (videoTags[videoIdStr].length === 0) {
        delete videoTags[videoIdStr];
      }

      this.memoryVideoTags = videoTags;
      safeSetItem(this.videoTagsKey, videoTags);
      return true;
    }

    /**
     * 切换视频标签（如果已有则移除，否则添加）
     * @param {string|number} videoId - 视频 ID
     * @param {string} tagId - 标签 ID
     * @returns {boolean} 添加后的状态（true 表示已添加，false 表示已移除）
     */
    toggleVideoTag(videoId, tagId) {
      const videoTags = this.getVideoTags(videoId);
      if (videoTags.includes(tagId)) {
        this.removeTagFromVideo(videoId, tagId);
        return false;
      } else {
        this.addTagToVideo(videoId, tagId);
        return true;
      }
    }

    /**
     * 设置视频的所有标签（替换现有标签）
     * @param {string|number} videoId - 视频 ID
     * @param {Array} tagIds - 标签 ID 数组
     * @returns {boolean} 是否设置成功
     */
    setVideoTags(videoId, tagIds) {
      if (!videoId || !Array.isArray(tagIds)) return false;

      // 预备集合：服务器返回的全局/个人标签ID
      const serverGlobalIdSet = new Set((this.serverCache.globalTags || []).map(t => String(t.id)));
      const serverUserIdSet = new Set((this.serverCache.userTags || []).map(t => `u:${t.id}`));

      // 确保所有ID为字符串
      const incomingIds = tagIds.map(id => String(id));
      // 将数字ID映射为预设key，仅当它不是服务器已知的全局/个人标签时
      const canonicalIds = [];
      incomingIds.forEach(sid => {
        // 1) 已有前缀的用户标签
        if (serverUserIdSet.has(sid)) {
          canonicalIds.push(sid);
          return;
        }
        // 2) 后端返回的旧数字用户标签（与全局可能同号），优先识别为用户标签
        if (/^\d+$/.test(sid) && serverUserIdSet.has(`u:${sid}`)) {
          canonicalIds.push(`u:${sid}`);
          return;
        }
        // 3) 已知全局标签
        if (serverGlobalIdSet.has(sid)) {
          canonicalIds.push(sid);
          return;
        }
        // 4) 已知预设映射 (Relaxed: allow mapping even if not in serverGlobalIdSet to handle offline/load failure)
        if (PRESET_ID_MAP[sid]) {
          canonicalIds.push(PRESET_ID_MAP[sid]);
          return;
        }
        // 5) 未知数字：保留原样（假设是全局标签 ID，等待 loadFromServer 加载真实数据）
        // 不再转换为 u:${sid}，因为这会导致全局标签被误识别为用户标签
        if (/^\d+$/.test(sid)) {
          canonicalIds.push(sid);
          return;
        }
        // 6) 其他保留原样
        const mapped = PRESET_ID_MAP[sid] || sid;
        canonicalIds.push(mapped);
      });
      // 去重
      const uniqueIds = Array.from(new Set(canonicalIds));

      // 若有未知标签，将其注入相应列表（占位显示）
      // 但只为明确的用户标签（u: 前缀）创建占位符，全局标签不创建占位符
      const allTags = this.getAllTags();
      const knownIds = new Set(allTags.map(t => String(t.id)));
      uniqueIds.forEach(sid => {
        if (!knownIds.has(sid)) {
          // 检查是否是预设标签
          const preset = PRESET_TAGS.find(t => t.id === sid);
          if (preset) {
            knownIds.add(sid);
            return;
          }

          // 只为明确的用户标签（u: 前缀）创建占位符
          // 纯数字 ID 应该是全局标签，不创建占位符（等待 loadFromServer 加载真实数据）
          const isUserScope = String(sid).startsWith('u:');
          if (!isUserScope) {
            // 纯数字全局标签，不创建占位符，直接跳过
            // 标签数据应该通过 loadFromServer 获取
            return;
          }

          const placeholderId = String(sid).replace(/^u:/, '');
          const placeholder = {
            id: placeholderId,
            name: `我的标签${placeholderId}`,
            icon: '🏷️',
            color: '#64748b',
            scope: 'user'
          };
          if (!this.serverCache.userTags) this.serverCache.userTags = [];
          // 避免重复添加
          if (!this.serverCache.userTags.some(t => String(t.id) === placeholderId)) {
            this.serverCache.userTags.push(placeholder);
          }
          knownIds.add(sid);
        }
      });

      const videoTags = this.getAllVideoTags();
      const videoIdStr = String(videoId);

      if (uniqueIds.length === 0) {
        // 如果没有有效标签，删除该视频的标签
        delete videoTags[videoIdStr];
      } else {
        videoTags[videoIdStr] = uniqueIds;
      }

      this.memoryVideoTags = videoTags;
      safeSetItem(this.videoTagsKey, videoTags);
      this.dataVersion++;
      try {
        if (isDebugEnabled()) {
          console.log('[TagSystem] setVideoTags', {
            videoId: videoIdStr,
            incomingIds,
            tagsCount: incomingIds.length
          });
        }
      } catch (_) { }
      return true;
    }

    // ===== 查询和筛选 =====

    /**
     * 按标签筛选视频
     * @param {Array} videos - 视频数组
     * @param {string|Array} tagIds - 单个标签 ID 或标签 ID 数组
     * @param {string} mode - 筛选模式：'any'（任意标签匹配）或 'all'（所有标签都匹配）
     * @returns {Array} 筛选后的视频数组
     */
    filterVideosByTags(videos, tagIds, mode = 'any') {
      if (!Array.isArray(videos)) return [];
      if (!tagIds) return videos;

      const tagIdArray = Array.isArray(tagIds) ? tagIds : [tagIds];
      const tagIdStrings = tagIdArray.map(id => String(id));
      if (tagIdArray.length === 0) return videos;

      return videos.filter(video => {
        const videoTagIds = this.getVideoTags(video.id).map(id => String(id));

        if (mode === 'all') {
          // 所有指定的标签都必须存在
          return tagIdStrings.every(tagId => videoTagIds.includes(tagId));
        } else {
          // 任意一个标签匹配即可
          return tagIdStrings.some(tagId => videoTagIds.includes(tagId));
        }
      });
    }

    /**
     * 获取没有任何标签的视频
     * @param {Array} videos - 视频数组
     * @returns {Array} 没有标签的视频数组
     */
    getUntaggedVideos(videos) {
      if (!Array.isArray(videos)) return [];

      return videos.filter(video => {
        const videoTags = this.getVideoTags(video.id);
        return videoTags.length === 0;
      });
    }

    /**
     * 获取标签统计信息
     * @param {Array} videos - 视频数组
     * @returns {Object} 标签统计信息
     */
    getTagStatistics(videos) {
      if (!Array.isArray(videos)) {
        videos = [];
      }

      const allTags = this.getVisibleTags ? this.getVisibleTags() : this.getAllTags();
      const stats = {};

      allTags.forEach(tag => {
        const tagIdStr = String(tag.id);
        const taggedVideos = this.filterVideosByTags(videos, tagIdStr);
        stats[tagIdStr] = {
          tag: tag,
          count: taggedVideos.length,
          videos: taggedVideos
        };
      });

      // 添加未标记视频的统计
      stats['_untagged'] = {
        tag: { id: '_untagged', name: '未标记', icon: '📋', color: '#94a3b8' },
        count: this.getUntaggedVideos(videos).length,
        videos: this.getUntaggedVideos(videos)
      };

      return stats;
    }

    /**
     * 根据标签 ID 获取标签对象
     * @param {string} tagId - 标签 ID
     * @returns {Object|null} 标签对象，如果不存在返回 null
     */
    getTagById(tagId) {
      const allTags = this.getAllTags();
      const tag = allTags.find(tag => String(tag.id) === String(tagId));
      if (!tag) return null;
      const prefs = this.getPreferences();
      const alias = prefs.alias && prefs.alias[String(tag.id)];
      return {
        ...tag,
        originalName: tag.name,
        name: alias || tag.name,
        displayName: alias || tag.name
      };
    }

    /**
     * 获取视频的标签对象数组
     * @param {string|number} videoId - 视频 ID
     * @returns {Array} 标签对象数组
     */
    getVideoTagObjects(videoId) {
      const tagIds = this.getVideoTags(videoId);
      const hiddenSet = new Set(this.getPreferences().hidden.map(String));
      return tagIds
        .map(tagId => this.getTagById(tagId))
        .filter(tag => tag !== null && !hiddenSet.has(String(tag.id)));
    }

    // ===== 导入/导出 =====

    /**
     * 导出标签数据
     * @returns {Object} 标签系统数据
     */
    exportData() {
      return {
        customTags: this.getCustomTags(),
        videoTags: this.getAllVideoTags(),
        exportedAt: new Date().toISOString()
      };
    }

    /**
     * 导入标签数据
     * @param {Object} data - 标签系统数据
     * @param {boolean} merge - 是否合并（true）还是替换（false）
     * @returns {boolean} 是否导入成功
     */
    importData(data, merge = false) {
      if (!data || typeof data !== 'object') return false;

      try {
        if (merge) {
          // 合并模式：保留现有数据，添加新数据
          const existingCustomTags = this.getCustomTags();
          const existingVideoTags = this.getAllVideoTags();

          // 合并自定义标签（避免重复）
          const customTags = data.customTags || [];
          const mergedCustomTags = [...existingCustomTags];
          customTags.forEach(tag => {
            if (!mergedCustomTags.some(t => t.id === tag.id)) {
              mergedCustomTags.push(tag);
            }
          });

          // 合并视频标签
          const videoTags = data.videoTags || {};
          const mergedVideoTags = { ...existingVideoTags };
          Object.keys(videoTags).forEach(videoId => {
            if (mergedVideoTags[videoId]) {
              // 合并标签，避免重复
              const existingTags = new Set(mergedVideoTags[videoId]);
              videoTags[videoId].forEach(tagId => existingTags.add(tagId));
              mergedVideoTags[videoId] = Array.from(existingTags);
            } else {
              mergedVideoTags[videoId] = videoTags[videoId];
            }
          });

          safeSetItem(this.customTagsKey, mergedCustomTags);
          this.memoryVideoTags = mergedVideoTags;
          safeSetItem(this.videoTagsKey, mergedVideoTags);
        } else {
          // 替换模式：完全替换现有数据
          safeSetItem(this.customTagsKey, data.customTags || []);
          this.memoryVideoTags = data.videoTags || {};
          safeSetItem(this.videoTagsKey, this.memoryVideoTags);
        }

        return true;
      } catch (e) {
        console.error('[TagSystem] Error importing data:', e);
        return false;
      }
    }

    /**
     * 清空所有标签数据（仅自定义标签和视频标签，保留预设标签）
     * @returns {boolean} 是否清空成功
     */
    clearAllData() {
      try {
        safeSetItem(this.customTagsKey, []);
        this.memoryVideoTags = {};
        safeSetItem(this.videoTagsKey, {});
        return true;
      } catch (e) {
        console.error('[TagSystem] Error clearing data:', e);
        return false;
      }
    }
  }

  // 创建全局单例
  window.VideoTagSystem = new VideoTagSystem();

  console.log('[TagSystem] Video Tag System initialized');

})(window);
