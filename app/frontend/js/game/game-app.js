(function (root) {
  'use strict';

  const PACK_URL = '/js/game/word-packs/pack-max.json?v=7';
  // 按屏宽选登录页:PC 落到 mobile-auth 会是被拉宽变形的手机版式。
  const LOGIN_URL = (root.matchMedia && root.matchMedia('(min-width: 900px)').matches)
    ? '/desktop-auth.html?next=%2Fgame.html'
    : '/mobile-auth.html?next=%2Fgame.html';
  const QUIZ_QUESTIONS = 6;
  const BOSS_LEVEL = root.GameLevelEngine.BOSS_LEVEL;
  const views = root.GameViews;
  const h = views.h;
  const button = views.button;
  const show = views.show;

  const container = document.getElementById('game-root');
  const reducedMotion = root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 统计是旁路:api-client 若是缓存的旧版本(无 track),游戏照常跑。
  function track(eventName, properties) {
    if (api && typeof api.track === 'function') api.track(eventName, properties);
  }

  let engine = null;
  let store = null;
  let api = null;
  let pack = null;
  let progress = null;

  // 未登录不拦路:静默建游客账号直接开玩(SRS/XP 照常落库,注册后可保留)。
  // 游客接口失败才退回登录页——孩子打开就能玩是第一优先。
  async function ensureToken() {
    const existing = root.AuthManager && root.AuthManager.getToken();
    if (existing) return existing;
    try {
      const response = await fetch('/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) return null;
      const body = await response.json();
      const token = body.access_token || body.token;
      if (!token) return null;
      if (root.AuthManager && typeof root.AuthManager.setToken === 'function') {
        root.AuthManager.setToken(token, true);
      }
      try {
        root.localStorage.setItem('is_guest', 'true');
        root.localStorage.setItem('guest_id', body.guest_id || '');
      } catch (_) { /* 存不进也不拦玩 */ }
      return token;
    } catch (_) {
      return null;
    }
  }

  async function boot() {
    const token = await ensureToken();
    if (!token) { root.location.replace(LOGIN_URL); return; }

    // 共用一个 Audio 元素:每次 new Audio() 会在移动端堆出几十个解码器。
    // 不传 audio 的话 api.speak() 直接返回 false——拼写工坊没有发音就等于没有题面。
    const element = new root.Audio();
    api = root.GameApiClient.createApiClient({
      fetch: root.fetch.bind(root),
      getToken: function () { return root.AuthManager.getToken(); },
      storage: root.localStorage,
      audio: {
        play: function (url) {
          element.src = url;
          return element.play().catch(function () {});
        },
      },
    });
    store = root.GameProgressStore.createProgressStore(root.localStorage);
    progress = store.load();

    const response = await fetch(PACK_URL);
    if (!response.ok) { show(container, [h('p', 'game-error', '词包加载失败,请刷新重试。')]); return; }
    pack = await response.json();

    engine = root.GameLevelEngine.createLevelEngine({ pack, progressStore: store, apiClient: api });
    renderMap();
    api.flushRetryQueue().catch(function () {});
    track('game_view', {
      chapter: progress.currentChapter,
      level: progress.currentLevel,
      parts_unlocked: progress.unlockedParts.length,
    });
  }

  // 地图:顶部六章切换条 + 所在章的纵向关卡路径。已通的旧章可回去刷,
  // 未到的章置灰——整个系列一眼可见,不是"只有一章"。
  function renderMap(viewChapter) {
    const chapter = Number(viewChapter) || progress.currentChapter;
    const stars = root.GameLevelEngine.chapterStars(progress, chapter);
    const gate = root.GameLevelEngine.BOSS_STAR_GATE;
    const themes = { 1: '学校', 2: '文具', 3: '数字', 4: '颜色', 5: '动作', 6: '时间' };
    function bossGateOpenFor(targetChapter) {
      return targetChapter < progress.currentChapter
        || root.GameLevelEngine.chapterStars(progress, targetChapter) >= gate;
    }

    const tabs = h('div', 'game-chapter-tabs');
    pack.chapters.forEach(function (entry) {
      const reachable = entry.chapter <= progress.currentChapter;
      const tab = button('game-chapter-tab',
        entry.chapter + '章 ' + (reachable ? (themes[entry.chapter] || '') : '🔒'),
        function () { renderMap(entry.chapter); });
      tab.disabled = !reachable;
      tab.dataset.active = String(entry.chapter === chapter);
      tabs.appendChild(tab);
    });

    const nodes = [
      h('h1', 'game-map-title', '第 ' + chapter + ' 章 · ' + (themes[chapter] || '')),
      tabs,
      h('p', 'game-map-stars', '⭐ ' + stars + ' / ' + gate),
    ];

    const continueIsBoss = progress.currentLevel === BOSS_LEVEL;
    const continueBossGateOpen = !continueIsBoss || bossGateOpenFor(progress.currentChapter);
    const continueLabel = continueIsBoss
      ? (continueBossGateOpen
        ? '挑战 BOSS'
        : '还差 ' + (gate - root.GameLevelEngine.chapterStars(progress, progress.currentChapter)) + ' 星解锁 BOSS')
      : '继续第 ' + progress.currentLevel + ' 关';
    const continueButton = button('game-btn game-map-continue', continueLabel, function () {
      playLevel(progress.currentLevel, progress.currentChapter);
    });
    continueButton.disabled = !continueBossGateOpen;
    nodes.push(continueButton);

    // 旧章已全通:关卡全开放,随便回去刷星;当前章按推进指针锁。
    const isPastChapter = chapter < progress.currentChapter;
    for (let level = 1; level <= BOSS_LEVEL; level += 1) {
      const levelId = 'c' + chapter + 'l' + level;
      const earned = Number(progress.stars[levelId]) || 0;
      const isBoss = level === BOSS_LEVEL;
      const bossGateOpen = bossGateOpenFor(chapter);
      const locked = isPastChapter
        ? false
        : (level > progress.currentLevel || (isBoss && !bossGateOpen));
      const label = (isBoss ? 'BOSS' : '第 ' + level + ' 关')
        + (earned ? ' ' + '⭐'.repeat(earned) : '');
      const node = button('game-node', label, function () { playLevel(level, chapter); });
      node.disabled = locked;
      node.dataset.current = String(!isPastChapter && level === progress.currentLevel);
      if (isBoss && !isPastChapter && !bossGateOpen) {
        node.appendChild(h('span', 'game-node__gate', '还差 ' + (gate - stars) + ' 星'));
      }
      nodes.push(node);
    }

    nodes.push(button('game-btn game-btn--ghost', '看看我的伙伴', function () { renderCharacter(); }));
    show(container, nodes);
  }

  async function playLevel(level, chapter) {
    // 进关用临时副本选关;progress 本体保住高水位,finishLevel 只在当前章前进指针。
    let session = await engine.startLevel({
      ...progress,
      currentChapter: Number(chapter) || progress.currentChapter,
      currentLevel: level,
    });
    track('game_level_start', {
      chapter: session.chapter,
      level: session.level,
      is_boss: session.isBoss,
    });

    const chapterEntry = pack.chapters.find(function (c) { return c.chapter === session.chapter; });
    const ctx = {
      container,
      api,
      reducedMotion,
      scene: (chapterEntry && chapterEntry.scene) || null,
      session: function () { return session; },
      commit: async function (result) {
        session = await engine.recordResult(session, result);
        return session;
      },
    };

    function trackPhase(phase) {
      track('game_phase_complete', {
        chapter: session.chapter,
        level: session.level,
        is_boss: session.isBoss,
        phase,
      });
    }

    if (session.isBoss) {
      await views.renderBoss(
        ctx,
        function (count) { return engine.bossQuestionWords(session, count); },
        session.newWords
      );
      trackPhase('boss');
    } else {
      await views.renderLearn(ctx, session.newWords);
      trackPhase('learn');
      // 规范 §4.1:连连看单局 8-10 词 = 6 新词 + 2-4 复习词,不是只有新词。
      // 复习词在连连看(认知)和拼写(产出)里各出现一次,正好满足 §5.1「≥2 种题型答对」。
      await views.renderLianliankan(ctx, session.newWords.concat(session.reviewWords));
      trackPhase('matching');
      if (session.reviewWords.length) {
        await views.renderSpelling(ctx, session.reviewWords);
        trackPhase('spelling');
      }
      await views.renderQuiz(ctx, session.newWords.slice(0, QUIZ_QUESTIONS));
      trackPhase('quiz');
    }

    const outcome = await engine.finishLevel(session, progress);
    progress = outcome.progress;
    track('game_level_complete', {
      chapter: session.chapter,
      level: session.level,
      is_boss: session.isBoss,
      stars: outcome.stars,
      accuracy: Math.round(outcome.accuracy * 100),
      boss_status: outcome.bossStatus,
    });
    if (outcome.unlockedPart) {
      track('game_chapter_pass', {
        chapter: session.chapter,
        part: outcome.unlockedPart,
        character_complete: outcome.characterComplete,
      });
    }
    await renderResult(outcome);
  }

  async function renderResult(outcome) {
    const stats = outcome.statsResult;
    // Boss 打赢但正确率没过 90% 掌握线时(won 却没解锁部位),章节不前进——
    // 必须把差距说出来,不然玩家看着"过关!"却发现下一章没开,以为是 bug。
    const bossWonButNotMastered = outcome.bossStatus === 'won' && !outcome.unlockedPart;
    const title = outcome.bossStatus === 'lost' ? '再来一次!'
      : (bossWonButNotMastered ? '打赢了,但还没通关!' : '过关!');
    const nodes = [
      h('h2', 'game-view-title', title),
      h('p', 'game-result-stars', '⭐'.repeat(outcome.stars)),
      h('p', 'game-result-accuracy', '正确率 ' + Math.round(outcome.accuracy * 100) + '%'),
    ];
    if (bossWonButNotMastered) {
      nodes.push(h('p', 'game-result-hint',
        '通关需要正确率达到 90%——再打一次 BOSS,错过的词多听多拼就能过!'));
    }
    if (stats) {
      nodes.push(h('p', 'game-result-xp', '+' + stats.xp_earned + ' XP'));
      nodes.push(h('p', 'game-result-streak', '🔥 连胜 ' + stats.current_streak + ' 天'));
    }
    const stageHost = h('div', 'game-stage');
    if (outcome.unlockedPart) nodes.push(stageHost);
    nodes.push(button('game-btn', '回到地图', renderMap));
    show(container, nodes);

    if (!outcome.unlockedPart) return;
    // Three.js 只在真的要点亮部位时才下载,地图和局内都不加载。
    const module = await import('/js/game/character-stage.js');
    const stage = await module.createCharacterStage(stageHost, {
      unlockedParts: progress.unlockedParts,
      reducedMotion,
    });
    await stage.unlockPart(outcome.unlockedPart);
    if (outcome.characterComplete) await stage.playRevival();
  }

  async function renderCharacter() {
    const stageHost = h('div', 'game-stage');
    show(container, [
      h('h2', 'game-view-title', '我的伙伴'),
      stageHost,
      button('game-btn', '返回', renderMap),
    ]);
    const module = await import('/js/game/character-stage.js');
    await module.createCharacterStage(stageHost, {
      unlockedParts: progress.unlockedParts,
      reducedMotion,
    });
  }

  boot();
})(window);
