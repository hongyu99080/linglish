(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishRoleplayEntrypoints = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCENARIO_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const SOURCE_PATTERN = /^[a-z0-9_]+$/;
  const THEME_PATTERN = /^[\p{L}\p{N}_-]+(?:(?: +| *& *)[\p{L}\p{N}_-]+)*$/u;
  const THEME_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

  function readStorage(storage, key) {
    try {
      return storage?.getItem?.(key);
    } catch (_) {
      return null;
    }
  }

  function callBoolean(target, name) {
    try {
      if (typeof target?.[name] === 'function') return Boolean(target[name]());
      if (typeof target?.[name] === 'boolean') return target[name];
    } catch (_) {
      return null;
    }
    return null;
  }

  function detectGuest(options = {}) {
    const authManagerResult = callBoolean(options.authManager, 'isGuest');
    if (authManagerResult !== null) return authManagerResult;

    const guestCheckResult = callBoolean(options.guestCheck, 'isGuest');
    if (guestCheckResult !== null) return guestCheckResult;

    const localGuest = readStorage(options.localStorage, 'is_guest')
      ?? readStorage(options.localStorage, 'isGuest');
    if (localGuest !== null) return localGuest === 'true';

    const sessionGuest = readStorage(options.sessionStorage, 'is_guest')
      ?? readStorage(options.sessionStorage, 'isGuest');
    return sessionGuest === 'true';
  }

  function boundedText(raw, maxLength, fallback = '') {
    const value = String(raw ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value) return fallback;
    return value.slice(0, maxLength);
  }

  function boundedIdentifier(raw, maxLength, pattern) {
    const value = String(raw ?? '').trim();
    if (!value || value.length > maxLength || !pattern.test(value)) return '';
    return value;
  }

  function boundedTheme(raw) {
    const source = String(raw ?? '');
    if (!source || THEME_CONTROL_PATTERN.test(source)) return '';
    const value = source
      .replace(/\s+/g, ' ')
      .trim();
    if (!value || value.length > 48 || !THEME_PATTERN.test(value)) return '';
    return value;
  }

  function buildRoleplayHref(options = {}) {
    const scenarioId = boundedIdentifier(options.scenarioId, 80, SCENARIO_PATTERN);
    const source = boundedIdentifier(options.source, 32, SOURCE_PATTERN);
    if (!scenarioId || !source) return '';

    const params = new URLSearchParams({ scenario: scenarioId, from: source });
    const theme = boundedTheme(options.theme);
    if (theme) params.set('theme', theme);
    return `./ai-roleplay.html?${params.toString()}`;
  }

  function verifiedHistory(scenario) {
    const history = scenario?.user_history;
    if (!history || history.verified !== true || history.scope !== 'user') return null;
    if (history.status !== 'completed' && history.status !== 'active') return null;
    return history;
  }

  function scenarioHistoryLabel(scenario, options = {}) {
    if (options.isGuest) return '登录或注册后可保留完成记录';
    const history = verifiedHistory(scenario);
    if (!history) return '开始后将在这里显示';
    if (history.status === 'active') return '有一轮未完成的练习';

    const goalCount = Array.isArray(scenario?.goals) ? scenario.goals.length : 0;
    const completed = Number(history.completed_goal_count);
    if (goalCount > 0 && Number.isFinite(completed)) {
      return `上次完成 ${Math.max(0, Math.min(goalCount, completed))}/${goalCount} 个目标`;
    }
    return '已完成过该场景';
  }

  function catalogHistoryLabel(scenarios, options = {}) {
    if (options.isGuest) return '登录后可保留完成记录';
    const safeScenarios = Array.isArray(scenarios) ? scenarios : [];
    const verified = safeScenarios.map(verifiedHistory).filter(Boolean);
    if (!verified.length) return '完成记录暂不可用';
    const completedCount = verified.filter((history) => history.status === 'completed').length;
    if (completedCount > 0) return `已完成 ${completedCount} 个场景`;
    return '有未完成的场景练习';
  }

  function createCatalogController(options = {}) {
    if (typeof options.request !== 'function') throw new TypeError('request is required');
    const getToken = typeof options.getToken === 'function' ? options.getToken : () => '';
    const isGuest = typeof options.isGuest === 'function' ? options.isGuest : () => false;
    const clearAuth = typeof options.clearAuth === 'function' ? options.clearAuth : () => {};
    const onState = typeof options.onState === 'function' ? options.onState : () => {};
    let current = { kind: 'idle', isGuest: false };
    let inFlight = null;

    function emit(next) {
      current = next;
      onState(next);
      return next;
    }

    function load() {
      if (inFlight) return inFlight;
      const token = String(getToken() || '');
      const guest = Boolean(isGuest());
      if (!token) return Promise.resolve(emit({ kind: 'auth_required', isGuest: guest }));

      emit({ kind: 'loading', isGuest: guest });
      inFlight = (async () => {
        let catalogResponse;
        try {
          catalogResponse = await options.request(token);
        } catch (error) {
          return emit({ kind: 'network_error', isGuest: guest, error });
        }

        const status = Number(catalogResponse?.status);
        if (status === 401 || status === 403) {
          clearAuth();
          return emit({ kind: 'auth_expired', isGuest: guest, status });
        }
        if (status === 404) return emit({ kind: 'disabled', isGuest: guest });
        if (!catalogResponse?.ok) {
          return emit({ kind: 'transient_error', isGuest: guest, status });
        }

        let payload;
        try {
          payload = await catalogResponse.json();
        } catch (error) {
          return emit({ kind: 'malformed', isGuest: guest, error });
        }
        if (!payload || !Array.isArray(payload.scenarios)) {
          return emit({ kind: 'malformed', isGuest: guest });
        }
        if (payload.scenarios.length === 0) {
          return emit({ kind: 'empty', isGuest: guest, scenarios: [] });
        }
        return emit({ kind: 'ready', isGuest: guest, scenarios: payload.scenarios });
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    }

    return {
      load,
      retry: load,
      getState: () => current,
    };
  }

  function appendStateAction(document, container, state, onRetry) {
    if (state.kind === 'auth_required' || state.kind === 'auth_expired') {
      const login = document.createElement('a');
      login.className = 'ai-scenario-state__action';
      login.href = `./mobile-auth.html?next=${encodeURIComponent('./mobile-arena.html')}`;
      login.textContent = '前往登录';
      container.appendChild(login);
      return;
    }
    if (!['network_error', 'transient_error', 'malformed'].includes(state.kind)) return;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ai-scenario-state__action';
    retry.textContent = '重新加载';
    if (typeof onRetry === 'function') retry.addEventListener('click', onRetry);
    container.appendChild(retry);
  }

  function renderNonReadyState(options) {
    const { document, listElement, statusElement, state, onRetry } = options;
    const copy = {
      idle: ['正在检查可用场景...', '检查中'],
      loading: ['正在检查可用场景...', '检查中'],
      auth_required: ['请先登录，再查看可用的 AI 场景任务。下方视频模仿练习仍可使用。', '登录后查看'],
      auth_expired: ['登录状态已过期，请重新登录。下方视频模仿练习仍可使用。', '登录已过期'],
      disabled: ['AI 场景任务暂未开放；下方视频模仿练习仍可使用。', '功能暂未开放'],
      empty: ['当前没有可用的 AI 场景任务；下方视频模仿练习仍可使用。', '暂无可用场景'],
      transient_error: ['AI 场景服务暂时不可用，请稍后重试。下方视频模仿练习仍可使用。', '服务暂不可用'],
      network_error: ['网络连接失败，请检查网络后重试。下方视频模仿练习仍可使用。', '网络连接失败'],
      malformed: ['场景数据暂时无法读取，请重新加载。下方视频模仿练习仍可使用。', '数据读取失败'],
    }[state.kind] || ['场景暂时无法显示。下方视频模仿练习仍可使用。', '暂不可用'];

    const container = document.createElement('div');
    container.className = 'ai-scenario-state';
    const message = document.createElement('p');
    message.className = 'ai-scenario-empty';
    message.textContent = copy[0];
    container.appendChild(message);
    appendStateAction(document, container, state, onRetry);
    listElement.replaceChildren(container);
    statusElement.textContent = copy[1];
  }

  function renderScenarioCard(document, scenario, options) {
    const href = buildRoleplayHref({
      scenarioId: scenario?.id,
      source: 'mobile_arena',
      theme: options.theme,
    });
    if (!href) return null;

    const title = boundedText(scenario?.title_zh || scenario?.title_en, 80, 'AI 场景任务');
    const learnerRole = boundedText(scenario?.learner_role, 40, '学习者');
    const assistantRole = boundedText(scenario?.assistant_role, 40, '场景角色');
    const goals = Array.isArray(scenario?.goals) ? scenario.goals : [];
    const firstGoal = boundedText(goals[0]?.label_zh || goals[0]?.label, 100, '完成本次沟通目标');
    const levelMin = boundedIdentifier(scenario?.cefr_min, 2, /^[A-C][1-2]$/);
    const levelMax = boundedIdentifier(scenario?.cefr_max, 2, /^[A-C][1-2]$/);
    const level = levelMin && levelMax && levelMin !== levelMax
      ? `${levelMin}–${levelMax}`
      : (levelMin || levelMax || '匹配等级');

    const card = document.createElement('a');
    card.className = 'ai-mission-card';
    card.href = href;
    card.setAttribute('aria-label', `开始场景：${title}`);

    const meta = document.createElement('span');
    meta.className = 'ai-mission-card__meta';
    meta.textContent = `${level} · 你扮演${learnerRole} · AI 扮演${assistantRole}`;

    const heading = document.createElement('h4');
    heading.className = 'ai-mission-card__title';
    heading.textContent = title;

    const goal = document.createElement('p');
    goal.className = 'ai-mission-card__goal';
    goal.textContent = `本轮目标：${firstGoal}`;

    const status = document.createElement('span');
    status.className = 'ai-mission-card__status';
    status.textContent = scenarioHistoryLabel(scenario, { isGuest: options.isGuest });

    const action = document.createElement('span');
    action.className = 'ai-mission-card__action';
    action.textContent = '开始 AI 对话';

    card.append(meta, heading, goal, status, action);
    return card;
  }

  function renderCatalogState(options = {}) {
    const { document, listElement, statusElement, state = { kind: 'idle' } } = options;
    if (!document || !listElement || !statusElement) return;
    listElement.setAttribute('aria-busy', state.kind === 'loading' ? 'true' : 'false');
    if (state.kind !== 'ready') {
      renderNonReadyState(options);
      return;
    }

    const fragment = document.createDocumentFragment();
    let cardCount = 0;
    state.scenarios.forEach((scenario) => {
      const card = renderScenarioCard(document, scenario, {
        isGuest: state.isGuest,
        theme: options.theme,
      });
      if (!card) return;
      fragment.appendChild(card);
      cardCount += 1;
    });
    if (!cardCount) {
      renderNonReadyState({ ...options, state: { kind: 'malformed', isGuest: state.isGuest } });
      return;
    }
    listElement.replaceChildren(fragment);
    statusElement.textContent = catalogHistoryLabel(state.scenarios, { isGuest: state.isGuest });
  }

  return {
    boundedText,
    buildRoleplayHref,
    catalogHistoryLabel,
    createCatalogController,
    detectGuest,
    renderCatalogState,
    scenarioHistoryLabel,
  };
});
