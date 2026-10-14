(function (window, document) {
  'use strict';

  const REVIEW_ITEM_MAX_TEXT_LENGTH = 600;

  function reviewSaveFailure() {
    const error = new Error('REVIEW_ITEM_SAVE_FAILED');
    error.code = 'REVIEW_ITEM_SAVE_FAILED';
    return error;
  }

  function requireSuccessfulReviewSave(result) {
    if (!result || !['saved', 'existing'].includes(result.kind)) throw reviewSaveFailure();
    return result;
  }

  function parseReviewSaveResponse(payload) {
    if (!Array.isArray(payload?.items) || payload.items.length !== 1) throw reviewSaveFailure();
    return requireSuccessfulReviewSave(payload.items[0]);
  }

  function createSaveControl({ document: ownerDocument, item, save, announce: announceStatus = () => {} }) {
    const button = ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'button button--secondary';
    button.textContent = '加入复习';
    button.setAttribute('aria-label', '将这条建议加入复习');
    const status = ownerDocument.createElement('p');
    status.className = 'review-card__secondary';
    status.setAttribute('aria-live', 'polite');
    let inFlight = false;

    button.addEventListener('click', async () => {
      if (inFlight || button.disabled) return;
      inFlight = true;
      button.disabled = true;
      status.textContent = '正在加入复习…';
      try {
        const result = requireSuccessfulReviewSave(await save(item));
        const message = item?.kind === 'pronunciation' && result?.kind === 'existing'
          ? '已在发音能力地图中'
          : result?.kind === 'existing' ? '已在复习中' : '已加入复习';
        button.textContent = '已加入复习';
        status.textContent = message;
        announceStatus(message);
      } catch (_) {
        button.disabled = false;
        button.textContent = '加入复习';
        status.textContent = '加入失败，可以重试';
        announceStatus('加入失败，可以重试');
      } finally {
        inFlight = false;
      }
    });

    return { button, status };
  }

  function createReviewRenderer({
    document: ownerDocument,
    container,
    save,
    announce: announceStatus = () => {},
    canonicalAssessmentId = () => null,
  }) {
    function createNode(tag, className, text) {
      const element = ownerDocument.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined && text !== null) element.textContent = String(text);
      return element;
    }

    function createCard(title) {
      const card = createNode('article', 'review-card');
      card.append(createNode('h3', '', title));
      return card;
    }

    function isEligibleText(value) {
      return typeof value === 'string'
        && value.trim().length > 0
        && value.trim().length <= REVIEW_ITEM_MAX_TEXT_LENGTH;
    }

    function appendSaveControl(card, item) {
      const control = createSaveControl({
        document: ownerDocument,
        item,
        save,
        announce: announceStatus,
      });
      card.append(control.button, control.status);
    }

    function render(review) {
      container.replaceChildren();
      const goalsCard = createCard('任务完成');
      const goalList = createNode('ul', 'review-goal-list');
      (review?.goals || []).forEach((goal) => {
        goalList.append(createNode(
          'li',
          '',
          `${goal.completed ? '已完成' : '待继续'}：${goal.label_zh || '沟通目标'}`,
        ));
      });
      if (!goalList.childNodes.length) goalList.append(createNode('li', '', '本次目标记录已保存。'));
      goalsCard.append(goalList);
      container.append(goalsCard);

      const bestCard = createCard('最佳表达');
      bestCard.append(createNode('p', '', review?.best_turn?.text || '你完成了这次真实开口。'));
      container.append(bestCard);

      const correctionCard = createCard('只改一个重点');
      if (review?.correction) {
        const rewrite = review.correction.rewrite || '';
        correctionCard.append(createNode('p', 'review-card__secondary', review.correction.original || ''));
        correctionCard.append(createNode('p', '', rewrite));
        correctionCard.append(createNode('p', 'review-card__secondary', review.correction.reason_zh || ''));
        if (isEligibleText(rewrite)) {
          appendSaveControl(correctionCard, {
            kind: 'correction',
            value: rewrite,
            meaning_zh: review.correction.meaning_zh || '',
          });
        }
      } else {
        correctionCard.append(createNode('p', '', '这次没有需要优先修改的表达。'));
      }
      container.append(correctionCard);

      const nextCard = createCard('下轮目标');
      const nextGoal = (review?.goals || []).find((goal) => goal.required && !goal.completed);
      if (nextGoal) {
        nextCard.append(createNode('p', '', `下一次重点完成：${nextGoal.label_zh || '未完成目标'}`));
      } else if (review?.suggested_phrase?.text) {
        nextCard.append(createNode('p', '', '换一个相近场景，主动用上下面的推荐表达。'));
      } else {
        nextCard.append(createNode('p', '', '换一个相近场景，再用自己的话完成一次。'));
      }
      container.append(nextCard);

      if (review?.suggested_phrase?.text) {
        const phraseText = review.suggested_phrase.text;
        const phraseCard = createCard('推荐表达');
        phraseCard.append(createNode('p', '', phraseText));
        phraseCard.append(createNode('p', 'review-card__secondary', review.suggested_phrase.meaning_zh || ''));
        if (isEligibleText(phraseText)) {
          appendSaveControl(phraseCard, {
            kind: 'suggested_phrase',
            value: phraseText,
            meaning_zh: review.suggested_phrase.meaning_zh || '',
          });
        }
        container.append(phraseCard);
      }

      if (review?.pronunciation?.summary) {
        const pronunciationCard = createCard('发音证据');
        pronunciationCard.append(createNode('p', '', review.pronunciation.summary));
        const assessmentId = canonicalAssessmentId(review.pronunciation.assessment_id);
        if (assessmentId) {
          appendSaveControl(pronunciationCard, {
            kind: 'pronunciation',
            value: String(assessmentId),
          });
        }
        container.append(pronunciationCard);
      }
    }

    return Object.freeze({ render });
  }

  window.LinglishRoleplayReviewLoop = Object.freeze({
    REVIEW_ITEM_MAX_TEXT_LENGTH,
    createSaveControl,
    createReviewRenderer,
    parseReviewSaveResponse,
  });

  const stateModule = window.LinglishRoleplayState;
  const apiModule = window.LinglishRoleplayApi;
  const recorderModule = window.LinglishRoleplayRecorder;
  if (!stateModule || !apiModule || !recorderModule) return;

  const elements = {
    connection: document.getElementById('connection-state'),
    scenarioTitle: document.getElementById('scenario-title'),
    scenarioRole: document.getElementById('scenario-role'),
    levelChip: document.getElementById('level-chip'),
    turnChip: document.getElementById('turn-chip'),
    goalCount: document.getElementById('goal-count'),
    missionGoals: document.getElementById('mission-goals'),
    turnsRemaining: document.getElementById('turns-remaining'),
    turnMarkers: document.getElementById('turn-markers'),
    conversation: document.getElementById('conversation'),
    answerPanel: document.getElementById('answer-panel'),
    answerState: document.getElementById('answer-state'),
    recordingTime: document.getElementById('recording-time'),
    transcriptEditor: document.getElementById('transcript-editor'),
    transcriptInput: document.getElementById('transcript-input'),
    rerecordButton: document.getElementById('rerecord-button'),
    submitTranscript: document.getElementById('submit-transcript'),
    recordButton: document.getElementById('record-button'),
    repeatButton: document.getElementById('repeat-button'),
    slowButton: document.getElementById('slow-button'),
    hintButton: document.getElementById('hint-button'),
    finishButton: document.getElementById('finish-button'),
    hintPanel: document.getElementById('hint-panel'),
    translation: document.getElementById('translation-text'),
    phrase: document.getElementById('phrase-text'),
    review: document.getElementById('review'),
    reviewContent: document.getElementById('review-content'),
    restartButton: document.getElementById('restart-button'),
    errorPanel: document.getElementById('error-panel'),
    errorMessage: document.getElementById('error-message'),
    retryButton: document.getElementById('retry-button'),
    liveStatus: document.getElementById('live-status'),
  };

  const machine = stateModule.createRoleplayStateMachine();
  const api = apiModule.createRoleplayApi({
    getToken: () => window.AuthManager?.getToken?.() || null,
  });
  const turnDrafts = apiModule.createTurnDraftStore();
  const speechRunner = apiModule.createSpeechTurnRunner();
  const recorder = recorderModule.createRoleplayRecorder();
  const captureEpoch = recorderModule.createCaptureEpoch({
    getGeneration: () => machine.snapshot().generation,
  });

  const app = {
    catalog: [],
    scenario: null,
    session: null,
    currentAssistant: null,
    currentTranslation: '',
    currentPhrase: '',
    turns: [],
    pendingTranscript: '',
    requestController: null,
    speechController: null,
    audio: null,
    recordingInterval: null,
    recordingStartedAt: 0,
    lastErrorCode: null,
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function boundedQuery(name, maxLength, pattern) {
    const raw = new URLSearchParams(window.location.search).get(name) || '';
    const value = raw.slice(0, maxLength);
    return !value || (pattern && !pattern.test(value)) ? '' : value;
  }

  function announce(message) {
    elements.liveStatus.textContent = '';
    window.setTimeout(() => { elements.liveStatus.textContent = message; }, 20);
  }

  function setConnection(message) {
    elements.connection.textContent = message;
  }

  function setBusy(isBusy) {
    elements.conversation.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  function beginRequest() {
    if (app.requestController) app.requestController.abort();
    app.requestController = new AbortController();
    return app.requestController;
  }

  function stopSpeech() {
    if (app.speechController) app.speechController.abort();
    app.speechController = null;
    if (app.audio) {
      try {
        app.audio.pause();
        app.audio.currentTime = 0;
      } catch (_) { /* browser audio cleanup */ }
      app.audio = null;
    }
    try { window.speechSynthesis?.cancel(); } catch (_) { /* browser speech cleanup */ }
  }

  function getCompletedGoalIds() {
    const completed = new Set(
      (app.session?.mission_progress?.completed_goal_ids || []).map((id) => String(id)),
    );
    app.turns.forEach((turn) => {
      (turn?.evaluation?.goal_updates || []).forEach((update) => {
        if (update?.status === 'completed') completed.add(String(update.goal_id));
      });
    });
    return completed;
  }

  function renderMission() {
    const goals = Array.isArray(app.scenario?.goals) ? app.scenario.goals : [];
    const completed = getCompletedGoalIds();
    elements.missionGoals.replaceChildren();

    if (!goals.length) {
      elements.missionGoals.append(node(
        'p',
        'empty-guidance',
        '选择场景后，这里会显示本次需要完成的目标。',
      ));
    } else {
      goals.forEach((goal, index) => {
        const done = completed.has(String(goal.id));
        const item = node('div', `mission-goal${done ? ' is-complete' : ''}`);
        item.append(node('span', 'mission-goal__marker', String(index + 1)));
        item.append(node('span', 'mission-goal__label', goal.label_zh || goal.label || '沟通目标'));
        item.append(node('span', 'mission-goal__status', done ? '已完成' : '待完成'));
        elements.missionGoals.append(item);
      });
    }

    elements.goalCount.textContent = `${completed.size} / ${goals.length}`;
    const turnLimit = Math.max(0, Number(app.session?.turn_limit || app.scenario?.turn_limit || 0));
    const turnCount = Math.max(0, Number(app.session?.turn_count || app.turns.length || 0));
    const remaining = Math.max(0, turnLimit - turnCount);
    elements.turnsRemaining.textContent = turnLimit ? String(remaining) : '—';
    elements.turnMarkers.replaceChildren();
    for (let index = 0; index < turnLimit; index += 1) {
      elements.turnMarkers.append(node('span', `turn-marker${index < turnCount ? ' is-used' : ''}`));
    }
    elements.turnChip.textContent = turnLimit ? `第 ${Math.min(turnCount + 1, turnLimit)} / ${turnLimit} 轮` : '尚未开始';
  }

  function renderHeader() {
    if (!app.scenario) return;
    elements.scenarioTitle.textContent = app.scenario.title_zh || app.scenario.title_en || 'AI 场景任务';
    const learnerRole = app.scenario.learner_role || '学习者';
    const assistantRole = app.scenario.assistant_role || '场景角色';
    elements.scenarioRole.textContent = `你扮演${learnerRole}，AI 扮演${assistantRole}。完成目标后即可进入复盘。`;
    const min = app.scenario.cefr_min || app.session?.cefr_level || '';
    const max = app.scenario.cefr_max || min;
    elements.levelChip.textContent = min && max && min !== max ? `${min}–${max}` : (min || '匹配等级');
  }

  function renderCatalog(scenarios) {
    elements.conversation.replaceChildren();
    const intro = node('section', 'catalog-intro');
    intro.append(node('p', 'eyebrow', '先明确目的'));
    intro.append(node('h2', '', '先选目的，再开口'));
    intro.append(node('p', '', '每次只处理一个真实场景，完成 2–4 个目标后进入复盘。'));
    elements.conversation.append(intro);

    const grid = node('div', 'scenario-catalog');
    if (!scenarios.length) {
      grid.append(node('p', 'empty-guidance', '目前没有可用场景，请稍后再试。'));
    }
    scenarios.forEach((scenario) => {
      const card = node('button', 'scenario-card');
      card.type = 'button';
      card.setAttribute('aria-label', '开始这个口语任务');
      const meta = node('span', 'scenario-card__meta');
      const level = scenario.cefr_min === scenario.cefr_max
        ? scenario.cefr_min
        : `${scenario.cefr_min || ''}–${scenario.cefr_max || ''}`;
      meta.append(node('span', '', level || '匹配等级'));
      meta.append(node('span', '', `最多 ${scenario.turn_limit || 6} 轮`));
      card.append(meta);
      card.append(node('strong', '', scenario.title_zh || scenario.title_en || '口语任务'));
      card.append(node(
        'p',
        '',
        `你将作为${scenario.learner_role || '学习者'}，完成 ${(scenario.goals || []).length || 2} 个沟通目标。`,
      ));
      card.append(node('span', 'scenario-card__action', '开始任务'));
      card.addEventListener('click', () => startScenario(String(scenario.id)));
      grid.append(card);
    });
    elements.conversation.append(grid);
  }

  function renderConversation() {
    if (!app.currentAssistant) return;
    elements.conversation.replaceChildren();
    const stage = node('section', 'conversation-stage');
    const current = node('article', 'current-turn');
    current.append(node('p', 'turn-speaker', app.scenario?.assistant_role || 'AI 场景角色'));
    current.append(node('p', 'current-turn__text', app.currentAssistant));
    stage.append(current);

    const history = node('div', 'conversation-history');
    app.turns.slice(-3).forEach((turn) => {
      const learner = node('div', 'history-turn');
      learner.append(node('strong', '', '你的回答'));
      learner.append(node('p', '', turn.learner_text || ''));
      history.append(learner);
    });
    if (!app.turns.length) {
      const guidance = node('div', 'history-turn');
      guidance.append(node('strong', '', '本轮重点'));
      guidance.append(node('p', '', '听清对方的问题，用自己的话完成一个沟通目标。'));
      history.append(guidance);
    }
    stage.append(history);
    elements.conversation.append(stage);
  }

  function renderControls() {
    const status = machine.snapshot().status;
    const ready = status === 'ready';
    const recording = status === 'recording';
    const hasLine = Boolean(app.currentAssistant);
    elements.recordButton.disabled = !ready && !recording;
    elements.repeatButton.disabled = !ready || !hasLine;
    elements.slowButton.disabled = !ready || !hasLine;
    elements.hintButton.disabled = !hasLine || recording;
    elements.finishButton.disabled = !ready || !app.session;
    elements.submitTranscript.disabled = status !== 'evaluating';
    elements.rerecordButton.disabled = status !== 'evaluating';
    elements.recordButton.classList.toggle('is-recording', recording);
    elements.recordButton.textContent = recording ? '停止并识别' : '开始录音';
    elements.recordButton.setAttribute('aria-label', recording ? '停止录音并开始识别' : '开始录音');

    const labels = {
      ready: '轮到你回答',
      ai_speaking: '正在播放 AI 的话',
      recording: '正在录音',
      recognizing: '正在识别你的回答',
      evaluating: '检查识别结果并提交',
      starting: '正在准备场景',
      review: '本次任务已完成',
      recoverable_error: '当前步骤可以重试',
    };
    elements.answerState.textContent = labels[status] || '准备开始';
  }

  function renderHint() {
    elements.translation.textContent = app.currentTranslation || '本句暂无中文提示，请先根据场景尝试理解。';
    elements.phrase.textContent = app.currentPhrase || '先说清楚你的目的，再补充一个具体信息。';
  }

  function updateSession(responseSession) {
    if (!responseSession) return;
    app.session = { ...(app.session || {}), ...responseSession, id: String(responseSession.id || app.session?.id || '') };
    renderHeader();
    renderMission();
  }

  function playAudioUrl(url, rate, signal) {
    return new Promise((resolve, reject) => {
      const audio = new window.Audio(url);
      app.audio = audio;
      audio.playbackRate = rate;
      const cleanup = () => {
        audio.onended = null;
        audio.onerror = null;
        signal?.removeEventListener('abort', onAbort);
        if (app.audio === audio) app.audio = null;
      };
      const onAbort = () => {
        try { audio.pause(); } catch (_) { /* browser audio cleanup */ }
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      audio.onended = () => { cleanup(); resolve(true); };
      audio.onerror = () => { cleanup(); reject(new Error('TTS_PLAYBACK_FAILED')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const playPromise = audio.play();
      if (playPromise?.catch) playPromise.catch((error) => { cleanup(); reject(error); });
    });
  }

  function speakLocally(text, rate, signal) {
    return new Promise((resolve, reject) => {
      if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') {
        resolve(false);
        return;
      }
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = rate;
      const voices = window.speechSynthesis.getVoices?.() || [];
      const voice = voices.find((item) => /^en(-|_)/i.test(item.lang || ''));
      if (voice) utterance.voice = voice;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        window.speechSynthesis.cancel();
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      utterance.onend = () => { cleanup(); resolve(true); };
      utterance.onerror = () => { cleanup(); resolve(false); };
      signal?.addEventListener('abort', onAbort, { once: true });
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  async function playAssistant(rate = 1) {
    if (!app.currentAssistant) return;
    const before = machine.snapshot();
    if (before.status === 'ready') machine.dispatch({ type: 'AI_PLAY_STARTED' });
    const speaking = machine.snapshot();
    if (speaking.status !== 'ai_speaking') return;
    const generation = speaking.generation;
    stopSpeech();
    app.speechController = new AbortController();
    const signal = app.speechController.signal;
    renderControls();
    setConnection('正在播放');
    announce('正在播放 AI 的话');

    const played = await speechRunner.play({
      generation,
      signal,
      text: app.currentAssistant,
      rate,
      isCurrent: (value) => {
        const current = machine.snapshot();
        return current.generation === value && current.status === 'ai_speaking';
      },
      generate: (stageSignal) => api.generateSpeech(app.currentAssistant, stageSignal),
      playAudio: playAudioUrl,
      synthesize: speakLocally,
      finish: (value) => machine.dispatch({ type: 'AI_PLAY_ENDED', generation: value }),
    });
    if (signal.aborted || machine.snapshot().generation !== generation) return;
    if (!played) {
      setConnection('音频暂不可用');
      announce('音频暂不可用，请阅读屏幕上的英文后回答');
    } else {
      setConnection('轮到你');
    }
    renderControls();
  }

  function errorMessage(code) {
    const messages = {
      MICROPHONE_DENIED: '浏览器没有获得麦克风权限。请允许访问后重试。',
      RECORDING_UNAVAILABLE: '当前浏览器无法录音。请更新浏览器或改用支持录音的设备。',
      EMPTY_TRANSCRIPT: '没有识别到清晰英文。靠近麦克风，再说一次。',
      UNAUTHORIZED: '登录状态已失效。请重新登录后继续。',
      TOKEN_EXPIRED: '登录状态已失效。请重新登录后继续。',
      REQUEST_BODY_TOO_LARGE: '录音文件过大，请缩短回答后重试。',
      AUDIO_TOO_LARGE: '录音文件过大，请缩短回答后重试。',
      AI_ROLEPLAY_UNAVAILABLE: 'AI 暂时没有返回结果。你的回答仍保留，可以直接重试。',
    };
    return messages[code] || '当前步骤没有完成。请检查网络后重试。';
  }

  function showError(error) {
    const code = String(error?.code || 'AI_ROLEPLAY_ERROR');
    app.lastErrorCode = code;
    machine.dispatch({ type: 'RECOVERABLE_ERROR', code });
    elements.errorMessage.textContent = errorMessage(code);
    elements.errorPanel.hidden = false;
    setBusy(false);
    setConnection('可以重试');
    renderControls();
    announce(elements.errorMessage.textContent);
  }

  function hideError() {
    elements.errorPanel.hidden = true;
    app.lastErrorCode = null;
  }

  function resetSessionView() {
    elements.review.hidden = true;
    elements.errorPanel.hidden = true;
    elements.answerPanel.hidden = false;
    elements.transcriptEditor.hidden = true;
    elements.hintPanel.hidden = true;
    elements.hintButton.setAttribute('aria-expanded', 'false');
    elements.transcriptInput.value = '';
    app.turns = [];
    app.pendingTranscript = '';
    turnDrafts.discard();
    renderHeader();
    renderMission();
    renderConversation();
    renderHint();
    renderControls();
  }

  async function startScenario(scenarioId) {
    if (!/^[a-z0-9-]{1,80}$/.test(scenarioId)) return;
    captureEpoch.invalidate();
    stopSpeech();
    hideError();
    machine.dispatch({ type: 'SESSION_START' });
    setBusy(true);
    setConnection('正在准备场景');
    const controller = beginRequest();
    try {
      const source = boundedQuery('from', 80, /^[a-z0-9_-]+$/i) || 'catalog';
      const response = await api.startSession({ scenario_id: scenarioId, source }, controller.signal);
      if (controller.signal.aborted) return;
      app.scenario = response.scenario || app.catalog.find((item) => String(item.id) === scenarioId) || null;
      app.session = response.session ? { ...response.session, id: String(response.session.id) } : null;
      app.currentAssistant = response.opening_turn?.assistant?.text || app.scenario?.opening_line || '';
      app.currentTranslation = response.opening_turn?.assistant?.translation_zh || app.scenario?.opening_translation_zh || '';
      app.currentPhrase = '';
      machine.dispatch({ type: 'SESSION_READY', session: app.session });
      resetSessionView();
      setBusy(false);
      setConnection('场景已开始');
      window.history.replaceState(null, '', `?scenario=${encodeURIComponent(scenarioId)}&from=${encodeURIComponent(source)}`);
      announce('场景已开始，请先听 AI 的话');
      await playAssistant(1);
    } catch (error) {
      if (error?.name !== 'AbortError') showError(error);
    }
  }

  function clearRecordingClock() {
    if (app.recordingInterval) window.clearInterval(app.recordingInterval);
    app.recordingInterval = null;
    elements.recordingTime.textContent = '最长 45 秒';
  }

  function startRecordingClock() {
    clearRecordingClock();
    app.recordingStartedAt = Date.now();
    const update = () => {
      const seconds = Math.min(45, Math.floor((Date.now() - app.recordingStartedAt) / 1_000));
      elements.recordingTime.textContent = `${seconds} / 45 秒`;
    };
    update();
    app.recordingInterval = window.setInterval(update, 250);
  }

  async function handleCapturedAudio(result, captureToken) {
    if (!result || !captureEpoch.isCurrent(captureToken)) return;
    clearRecordingClock();
    if (machine.snapshot().status === 'recording') machine.dispatch({ type: 'RECORDING_STOPPED' });
    renderControls();
    setConnection('正在识别');
    setBusy(true);
    try {
      const processed = await captureEpoch.process(captureToken, {
        encode: () => recorderModule.blobToDataUrl(result.blob),
        submit: (audioData) => {
          const controller = beginRequest();
          return api.transcribe({
            audioData,
            durationSeconds: Math.max(0.2, result.durationSeconds),
          }, controller.signal);
        },
      });
      if (processed.stale) return;
      const response = processed.value;
      const transcript = String(response.transcript || '').trim();
      if (!machine.dispatch({
        type: 'RECOGNITION_DONE',
        generation: captureToken.generation,
        transcript,
      })) return;
      app.pendingTranscript = transcript;
      elements.transcriptInput.value = transcript;
      elements.transcriptInput.disabled = false;
      elements.submitTranscript.disabled = false;
      elements.transcriptEditor.hidden = false;
      setBusy(false);
      setConnection('请检查识别结果');
      renderControls();
      elements.transcriptInput.focus();
      announce('识别完成，你可以修改一次，然后提交回答');
    } catch (error) {
      if (error?.name !== 'AbortError') showError(error);
    }
  }

  async function toggleRecording() {
    const status = machine.snapshot().status;
    if (status === 'recording') {
      const generation = machine.snapshot().generation;
      machine.dispatch({ type: 'RECORDING_STOPPED' });
      renderControls();
      try {
        const result = await recorder.stop();
        if (!result && machine.snapshot().status === 'recognizing') {
          captureEpoch.invalidate();
          machine.dispatch({ type: 'RECORDING_CANCELLED', generation });
          setBusy(false);
          setConnection('轮到你');
          renderControls();
          announce('麦克风启动已取消，可以重新录音');
        }
      } catch (error) {
        showError(error);
      }
      return;
    }
    if (status !== 'ready') return;
    stopSpeech();
    hideError();
    turnDrafts.discard();
    if (!machine.dispatch({ type: 'RECORDING_STARTED' })) return;
    const captureToken = captureEpoch.begin(machine.snapshot().generation);
    renderControls();
    setConnection('正在录音');
    announce('录音开始，最长四十五秒');
    try {
      const started = await recorder.start();
      if (!started || !captureEpoch.isCurrent(captureToken)) {
        await recorder.cancel();
        return;
      }
      startRecordingClock();
      recorder.waitForStop()
        .then((result) => handleCapturedAudio(result, captureToken))
        .catch((error) => {
          if (captureEpoch.isCurrent(captureToken)) showError(error);
        });
    } catch (error) {
      showError(error);
    }
  }

  async function submitCurrentTranscript() {
    const snapshot = machine.snapshot();
    if (snapshot.status !== 'evaluating' || !app.session) return;
    const transcript = String(elements.transcriptInput.value || app.pendingTranscript).trim();
    if (!transcript) {
      elements.transcriptInput.focus();
      announce('回答不能为空');
      return;
    }
    const draft = turnDrafts.begin(transcript);
    app.pendingTranscript = draft.transcript;
    elements.transcriptInput.value = draft.transcript;
    elements.transcriptInput.disabled = true;
    elements.submitTranscript.disabled = true;
    setBusy(true);
    setConnection('AI 正在理解你的回答');
    announce('回答已提交，正在生成下一句');
    const generation = snapshot.generation;
    const controller = beginRequest();
    try {
      const response = await api.submitTurn(app.session.id, {
        transcript: draft.transcript,
        turn_key: draft.turnKey,
      }, controller.signal);
      if (controller.signal.aborted || machine.snapshot().generation !== generation) return;
      turnDrafts.resolve(draft.turnKey);
      updateSession(response.session);
      const turn = response.turn || {};
      app.turns.push({ ...turn, learner_text: draft.transcript });
      app.currentAssistant = turn.assistant?.text || '';
      app.currentTranslation = turn.assistant?.translation_zh || '';
      app.currentPhrase = turn.evaluation?.suggested_phrase?.text || '';
      elements.transcriptEditor.hidden = true;
      elements.transcriptInput.value = '';
      app.pendingTranscript = '';
      if (!machine.dispatch({ type: 'AI_DONE', generation, turn })) return;
      renderMission();
      renderConversation();
      renderHint();
      setBusy(false);
      renderControls();
      await playAssistant(1);
      if (app.session?.status === 'completed') {
        await showReview(app.session.review_summary || null);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') showError(error);
    }
  }

  function redoRecording() {
    if (!machine.dispatch({ type: 'REDO_RECORDING' })) return;
    captureEpoch.invalidate();
    turnDrafts.discard();
    app.pendingTranscript = '';
    elements.transcriptInput.value = '';
    elements.transcriptEditor.hidden = true;
    setConnection('轮到你');
    renderControls();
    announce('识别结果已清除，可以重新录音');
  }

  async function saveReviewItem(item) {
    const sessionId = apiModule.canonicalSessionId(app.session?.id);
    const token = window.AuthManager?.getToken?.();
    if (!sessionId || !token) throw new Error('UNAUTHORIZED');
    const response = await window.fetch(`/ai-roleplay/sessions/${sessionId}/review-items`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items: [item] }),
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) { /* sanitized generic failure below */ }
    if (!response.ok) throw reviewSaveFailure();
    return parseReviewSaveResponse(payload);
  }

  function renderReview(review) {
    createReviewRenderer({
      document,
      container: elements.reviewContent,
      save: saveReviewItem,
      announce,
      canonicalAssessmentId: apiModule.canonicalSessionId,
    }).render(review);
  }

  async function showReview(existingReview) {
    stopSpeech();
    setBusy(true);
    setConnection('正在生成复盘');
    let review = existingReview;
    try {
      if (!review) {
        const controller = beginRequest();
        const completed = await api.completeSession(app.session.id, controller.signal);
        if (controller.signal.aborted) return;
        updateSession(completed.session || completed);
        review = completed.review_summary || completed.session?.review_summary || null;
      }
      machine.dispatch({ type: 'REVIEW_READY', review });
      renderReview(review || {});
      elements.answerPanel.hidden = true;
      elements.review.hidden = false;
      setBusy(false);
      setConnection('任务已完成');
      renderControls();
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      elements.review.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      announce('任务完成，复盘已经生成');
    } catch (error) {
      if (error?.name !== 'AbortError') showError(error);
    }
  }

  async function finishSession() {
    if (machine.snapshot().status !== 'ready' || !app.session) return;
    await showReview(null);
  }

  async function loadCatalog() {
    setBusy(true);
    setConnection('正在加载场景');
    const controller = beginRequest();
    try {
      const response = await api.listScenarios({ limit: 12 }, controller.signal);
      if (controller.signal.aborted) return;
      app.catalog = Array.isArray(response.scenarios) ? response.scenarios : [];
      renderCatalog(app.catalog);
      setBusy(false);
      setConnection('请选择场景');
      announce(`已加载 ${app.catalog.length} 个口语场景`);
    } catch (error) {
      if (error?.name !== 'AbortError') showError(error);
    }
  }

  async function retryCurrentStep() {
    const before = machine.snapshot();
    if (!machine.dispatch({ type: 'RETRY' })) return;
    hideError();
    renderControls();
    const after = machine.snapshot();
    if (after.status === 'evaluating' && app.pendingTranscript) {
      elements.transcriptInput.value = app.pendingTranscript;
      elements.transcriptInput.disabled = Boolean(turnDrafts.current());
      elements.submitTranscript.disabled = false;
      elements.transcriptEditor.hidden = false;
      announce('回答已保留，可以再次提交');
      return;
    }
    if (after.status === 'catalog') {
      await loadCatalog();
      return;
    }
    if (before.retryStatus === 'ready') {
      setConnection('轮到你');
      announce('已恢复，可以继续回答');
    }
  }

  async function restartScenario() {
    const scenarioId = String(app.scenario?.id || '');
    machine.dispatch({ type: 'PAGE_EXIT' });
    captureEpoch.invalidate();
    app.session = null;
    app.currentAssistant = null;
    await startScenario(scenarioId);
  }

  function toggleHint() {
    const willOpen = elements.hintPanel.hidden;
    elements.hintPanel.hidden = !willOpen;
    elements.hintButton.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    elements.hintButton.textContent = willOpen ? '收起提示' : '需要提示';
    if (willOpen) announce('中文和可用表达已展开');
  }

  function bindEvents() {
    elements.recordButton.addEventListener('click', toggleRecording);
    elements.repeatButton.addEventListener('click', () => playAssistant(1));
    elements.slowButton.addEventListener('click', () => playAssistant(0.78));
    elements.hintButton.addEventListener('click', toggleHint);
    elements.finishButton.addEventListener('click', finishSession);
    elements.submitTranscript.addEventListener('click', submitCurrentTranscript);
    elements.rerecordButton.addEventListener('click', redoRecording);
    elements.retryButton.addEventListener('click', retryCurrentStep);
    elements.restartButton.addEventListener('click', restartScenario);
    const handlePageExit = () => {
      captureEpoch.invalidate();
      machine.dispatch({ type: 'PAGE_EXIT' });
      turnDrafts.discard();
      app.requestController?.abort();
      stopSpeech();
      clearRecordingClock();
      recorder.cancel().catch(() => {});
    };
    window.addEventListener('pagehide', handlePageExit);
    window.addEventListener('beforeunload', handlePageExit);
  }

  async function init() {
    bindEvents();
    renderControls();
    const token = window.AuthManager?.getToken?.();
    if (!token) {
      showError({ code: 'UNAUTHORIZED' });
      return;
    }
    const scenarioId = boundedQuery('scenario', 80, /^[a-z0-9-]+$/);
    if (scenarioId) {
      await startScenario(scenarioId);
      return;
    }
    await loadCatalog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window, document);
