(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameViews = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 棋盘按实际词数算,不写死:buildBoard 从左上角起逐格填,格子多于 词数×2 会留下一片空白。
  // 规范 §4.1 的 6×4 是满局(12 词)尺寸,实际单局 8-10 词 → 4×4 或 5×4。
  const BOARD_COLS = 4;
  const LIANLIANKAN_MS = 90000;   // 规范 §4.1:单局限时 90 秒
  const COMBO_THRESHOLD = 3;      // 规范 §4.1:连续 3 次进 combo
  const SHAKE_MS = 500;           // 配错抖动 + 变灰的时长

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // 一切可点的东西都是真 <button>:键盘可达是验收项,<div onclick> 不可达。
  function button(className, text, onClick) {
    const node = h('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function show(container, nodes) {
    container.textContent = '';
    nodes.forEach(function (node) { container.appendChild(node); });
  }

  // 词条插图:优先自托管 Twemoji SVG(CC-BY 4.0,fetch-twemoji.js 下载),
  // 无对应素材的条目(纯数字/序数)回退为文本 emoji。onerror 兜底防 404 裂图。
  const TWEMOJI_DIR = '/images/game/twemoji/';

  function emojiCode(emoji) {
    const cleaned = emoji.indexOf('‍') < 0 ? emoji.replace(/️/g, '') : emoji;
    const points = [];
    for (const ch of cleaned) points.push(ch.codePointAt(0).toString(16));
    return points.join('-');
  }

  function art(word, className) {
    if (!word || !word.emoji) return null;
    const img = document.createElement('img');
    img.className = className;
    img.src = TWEMOJI_DIR + emojiCode(word.emoji) + '.svg';
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.loading = 'lazy';
    img.addEventListener('error', function () {
      const fallback = h('span', className, word.emoji);
      if (img.parentNode) img.parentNode.replaceChild(fallback, img);
    });
    return img;
  }

  // 真实照片词图(languageguide 式):有 photo 用照片,加载失败降级到 emoji 插图。
  function photoArt(word, className) {
    if (!word || !word.photo) return art(word, className.replace('photo', 'art'));
    const img = document.createElement('img');
    img.className = className;
    img.src = word.photo;
    img.alt = word.zh || '';
    img.loading = 'lazy';
    img.addEventListener('error', function () {
      const fallback = art(word, className.replace('photo', 'art'));
      if (fallback && img.parentNode) img.parentNode.replaceChild(fallback, img);
      else if (img.parentNode) img.parentNode.removeChild(img);
    });
    return img;
  }

  // 学:整体场景图(languageguide 式)——全景常驻,脉冲标记跳到当前词的位置;
  // 词条无场景坐标时退回单词卡。点卡片播发音,同时把词加进服务端词库(SRS 跟踪)。
  function renderLearn(ctx, words) {
    return new Promise(function (resolve) {
      let index = 0;
      const hasScene = Boolean(ctx.scene) && words.some(function (w) { return w.spot; });
      const card = h('article', 'game-card game-learn-card');
      const counter = h('p', 'game-learn-counter');
      const next = button('game-btn', '下一个', function () {
        index += 1;
        if (index >= words.length) return resolve();
        paint();
      });

      let sceneBox = null;
      let marker = null;
      if (hasScene) {
        // 场景本身可点:点整幅图重播当前词发音,图不再是"点了没反应"的死区。
        sceneBox = button('game-scene', '', function () { ctx.api.speak(words[index].lemma); });
        sceneBox.setAttribute('aria-label', '点击场景重听当前单词发音');
        const img = document.createElement('img');
        img.className = 'game-scene__img';
        img.src = ctx.scene;
        img.alt = '';
        sceneBox.appendChild(img);
        marker = h('div', 'game-scene__marker');
        marker.setAttribute('aria-hidden', 'true');
        sceneBox.appendChild(marker);
      }

      function paint() {
        const word = words[index];
        counter.textContent = (index + 1) + ' / ' + words.length;
        const nodes = [];
        if (hasScene && word.spot) {
          marker.style.left = word.spot[0] + '%';
          marker.style.top = word.spot[1] + '%';
          marker.style.display = 'block';
          // 重挂类名重启脉冲动画,让视线跟着标记跳。
          marker.classList.remove('game-scene__marker--pulse');
          void marker.offsetWidth;
          marker.classList.add('game-scene__marker--pulse');
        } else if (marker) {
          marker.style.display = 'none';
        }
        // 词卡主图:真实照片优先(场景图管"它在哪",照片管"它长什么样",两者互补)。
        const picture = photoArt(word, 'game-learn-photo');
        if (picture) nodes.push(picture);
        nodes.push(
          h('p', 'game-learn-word', word.lemma),
          h('p', 'game-learn-ipa', word.ipa || ''),
          h('p', 'game-learn-zh', word.zh),
          button('game-btn game-btn--ghost', '🔊 再听一次', function () { ctx.api.speak(word.lemma); })
        );
        show(card, nodes);
        next.textContent = index === words.length - 1 ? '开始游戏' : '下一个';
        ctx.api.speak(word.lemma);
        ctx.api.addWord(word.lemma);
      }

      const layout = [h('h2', 'game-view-title', '认识新词'), counter];
      if (sceneBox) layout.push(sceneBox);
      layout.push(card, next);
      show(ctx.container, layout);
      paint();
    });
  }

  // 连连看:英↔中配对。90 秒限时,连击 ≥3 进 combo,同一词第 2 次配错浮出中文提示。
  function renderLianliankan(ctx, words) {
    return new Promise(function (resolve) {
      const engine = window.GameLianliankan;
      const rows = Math.ceil((words.length * 2) / BOARD_COLS);
      let board = engine.buildBoard(words, { rows, cols: BOARD_COLS });
      let picked = null;
      let combo = 0;
      const missCount = {};

      const timerLabel = h('p', 'game-timer');
      const comboLabel = h('p', 'game-combo');
      const grid = h('div', 'game-board');
      const deadline = Date.now() + LIANLIANKAN_MS;
      const ticker = setInterval(function () {
        const left = Math.max(0, deadline - Date.now());
        timerLabel.textContent = Math.ceil(left / 1000) + ' 秒';
        if (left === 0) finish();
      }, 200);

      function finish() {
        clearInterval(ticker);
        resolve();
      }

      function cellButton(cell) {
        const word = wordFor(cell.lemma);
        // 中文面带插图,配对变成「图意 ↔ 英文」而不止「译文 ↔ 英文」。
        const face = cell.face === 'en' ? cell.lemma : word.zh;
        const node = button('game-cell', face, function () { pick(cell); });
        if (cell.face === 'zh') {
          // 照片优先:emoji 是近似联想(desk 没有专属 emoji),照片才是准确图意。
          const picture = photoArt(word, 'game-cell__photo');
          if (picture) node.insertBefore(picture, node.firstChild);
        }
        node.dataset.cleared = String(cell.cleared);
        node.style.gridArea = (cell.row + 1) + ' / ' + (cell.col + 1);
        if (picked && picked.id === cell.id) node.dataset.picked = 'true';
        if (missCount[cell.lemma] >= 2 && cell.face === 'en') {
          node.appendChild(h('span', 'game-cell__hint', wordFor(cell.lemma).zh));
        }
        return node;
      }

      function wordFor(lemma) {
        return words.find(function (w) { return w.lemma === lemma; }) || { zh: '' };
      }

      function paint() {
        show(grid, board.cells.filter(function (c) { return !c.cleared; }).map(cellButton));
        comboLabel.textContent = combo >= COMBO_THRESHOLD ? 'COMBO ×' + combo : '';
        comboLabel.dataset.active = String(combo >= COMBO_THRESHOLD);
      }

      async function pick(cell) {
        if (!picked) { picked = cell; paint(); return; }
        if (picked.id === cell.id) { picked = null; paint(); return; }

        // 认对即消,不设经典连连看的两折连线门槛:被围住的词对会"配不上"
        // 且按答错记(combo 清零 + SRS 记错)——孩子认对了词却被路径规则惩罚。
        const matched = picked.lemma === cell.lemma && picked.face !== cell.face;
        const lemma = picked.lemma;
        if (matched) {
          board = engine.clearPair(board, picked.id, cell.id);
          combo += 1;
          ctx.api.speak(lemma);
          picked = null;
          paint();
          await ctx.commit({ lemma, gameType: engine.GAME_TYPE, isCorrect: true });
          if (engine.isBoardCleared(board)) finish();
          return;
        }

        combo = 0;
        missCount[lemma] = (missCount[lemma] || 0) + 1;
        grid.dataset.shake = 'true';
        setTimeout(function () { delete grid.dataset.shake; }, SHAKE_MS);
        picked = null;
        paint();
        await ctx.commit({ lemma, gameType: engine.GAME_TYPE, isCorrect: false });
      }

      show(ctx.container, [h('h2', 'game-view-title', '单词连连看'), timerLabel, comboLabel, grid]);
      paint();
    });
  }

  // 拼写工坊:不显示英文,TTS 发音就是题面。卡住 10 秒自动亮下一个字母。
  function renderSpelling(ctx, words) {
    const engine = window.GameSpelling;
    return words.reduce(function (chain, word) {
      return chain.then(function () {
        return new Promise(function (resolve) {
          let challenge = engine.buildChallenge(word);
          const slots = h('p', 'game-spell-slots');
          const tiles = h('div', 'game-tiles');
          let hintTimer = setTimeout(hint, engine.HINT_DELAY_MS);

          function hint() {
            challenge = engine.revealHint(challenge);
            afterChange();
          }

          function afterChange() {
            clearTimeout(hintTimer);
            if (engine.isComplete(challenge)) return done(false);
            hintTimer = setTimeout(hint, engine.HINT_DELAY_MS);
            paint();
          }

          async function done(timedOut) {
            clearTimeout(hintTimer);
            const scored = engine.scoreChallenge(challenge, { timedOut });
            await ctx.commit({
              lemma: challenge.lemma,
              gameType: engine.GAME_TYPE,
              isCorrect: scored.tier === 'perfect',
            });
            resolve();
          }

          function paint() {
            slots.textContent = challenge.filled
              .map(function (id) {
                return challenge.tiles.find(function (t) { return t.id === id; }).letter;
              })
              .join(' ') || '_ '.repeat(challenge.lemma.length);
            show(tiles, challenge.tiles
              .filter(function (tile) { return !challenge.filled.includes(tile.id); })
              .map(function (tile) {
                return button('game-tile', tile.letter, function () {
                  const result = engine.placeTile(challenge, tile.id);
                  if (!result.accepted) {
                    tiles.dataset.shake = 'true';
                    setTimeout(function () { delete tiles.dataset.shake; }, SHAKE_MS);
                    return;
                  }
                  challenge = result.challenge;
                  afterChange();
                });
              }));
          }

          show(ctx.container, [
            h('h2', 'game-view-title', '拼写工坊'),
            button('game-btn game-btn--ghost', '🔊 播放发音', function () { ctx.api.speak(word.lemma); }),
            (function () {
              const line = h('p', 'game-spell-zh', word.zh);
              const picture = photoArt(word, 'game-spell-photo');
              if (picture) line.insertBefore(picture, line.firstChild);
              return line;
            })(),
            slots,
            tiles,
          ]);
          ctx.api.speak(word.lemma);
          paint();
        });
      });
    }, Promise.resolve());
  }

  // 速答:4 选 1,每题 3 秒;超时按答错记。Boss 关复用同一个引擎。
  function askQuestion(ctx, word, pool, title) {
    const engine = window.GameQuiz;
    return new Promise(function (resolve) {
      const question = engine.buildQuestion(word, pool);
      const bar = h('div', 'game-countdown');
      const timer = setTimeout(function () { answer(-1); }, engine.TIME_PER_QUESTION_MS);
      let settled = false;

      async function answer(index) {
        // 触屏双击会连开两枪:两次 commit、一次错扣两盾。答一次就锁死。
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const graded = engine.gradeAnswer(question, index);
        await ctx.commit({
          lemma: question.lemma,
          gameType: engine.GAME_TYPE,
          isCorrect: graded.isCorrect,
        });
        resolve(graded);
      }

      show(ctx.container, [
        h('h2', 'game-view-title', title),
        bar,
        h('p', 'game-quiz-prompt', question.prompt),
        h('div', 'game-options'),
      ]);
      const options = ctx.container.querySelector('.game-options');
      question.options.forEach(function (option, index) {
        options.appendChild(button('game-btn game-btn--option', option, function () { answer(index); }));
      });
      bar.style.animationDuration = engine.TIME_PER_QUESTION_MS + 'ms';
    });
  }

  function renderQuiz(ctx, words) {
    return words.reduce(function (chain, word) {
      return chain.then(function () { return askQuestion(ctx, word, words, '限时速答'); });
    }, Promise.resolve());
  }

  // Boss:每轮问 engine 要一批词(自动偏向错词),血量护盾从实时 session 读。
  async function renderBoss(ctx, nextWords, chapterWords) {
    let round = nextWords(1);
    while (round.length > 0) {
      const state = ctx.session().boss;
      const hp = h('p', 'game-boss-hp', '❤️ ' + state.hp + ' / ' + state.maxHp);
      const shields = h('p', 'game-boss-shields', '🛡 '.repeat(Math.max(0, state.shields)));
      show(ctx.container, [hp, shields]);
      await askQuestion(ctx, round[0], chapterWords, 'BOSS 战');
      if (window.GameBoss.bossOutcome(ctx.session().boss).status !== 'ongoing') return;
      round = nextWords(1);
    }
  }

  return { h, button, show, renderLearn, renderLianliankan, renderSpelling, renderQuiz, renderBoss };
});
