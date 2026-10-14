(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishFirstLessonGoal = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const STORAGE_KEY = 'linglish.firstLesson.goal.v1';
  function day(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
  function valid(record) {
    return record && /^\d+$/.test(record.videoId) && Array.isArray(record.ids)
      && record.ids.length > 0 && record.ids.length <= 3
      && record.ids.every(id => typeof id === 'string')
      && Number.isFinite(record.createdAt);
  }
  function createStore(storage, clock = Date.now) {
    let memory = {};
    let unsaved = false;
    function read() {
      if (unsaved) return memory;
      try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY));
        if (parsed && parsed.version === 1 && parsed.subjects && typeof parsed.subjects === 'object') memory = parsed.subjects;
      } catch (_) { /* In-memory goals remain usable when storage is unavailable. */ }
      return memory;
    }
    function latest(subject) {
      const records = read();
      const record = Object.prototype.hasOwnProperty.call(records, subject) ? records[subject] : null;
      return valid(record) ? { ...record, ids: record.ids.slice() } : null;
    }
    function sync(snapshot, segments, ids) {
      if (!snapshot || !snapshot.subject || !/^\d+$/.test(snapshot.videoId) || !Array.isArray(ids) || !ids.length) return null;
      const now = clock();
      const practiced = new Set(snapshot.practicedSegmentIds || []);
      let record = latest(snapshot.subject);
      if (!record || record.videoId !== String(snapshot.videoId) || record.ids.some(id => !ids.includes(id))
        || (record.completedAt && day(record.completedAt) !== day(now))) {
        const targets = ids.filter((id, index) => {
          const segment = segments[index] || {};
          const duration = Number(segment.end ?? segment.end_sec) - Number(segment.start ?? segment.start_sec);
          return !practiced.has(id) && (!Number.isFinite(duration) || duration <= 18);
        }).slice(0, 3);
        if (!targets.length) return null;
        record = { videoId: String(snapshot.videoId), ids: targets, createdAt: now, completedAt: null };
      }
      const completedCount = record.ids.filter(id => practiced.has(id)).length;
      const complete = completedCount === record.ids.length;
      const newlyCompleted = complete && !record.completedAt;
      record = {
        ...record, completedCount, total: record.ids.length, complete,
        completedAt: complete ? (record.completedAt || now) : null,
        updatedAt: now,
      };
      memory[snapshot.subject] = record;
      let saved = false;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, subjects: memory }));
        saved = true; unsaved = false;
      } catch (_) { unsaved = true; }
      const nextId = record.ids.find(id => !practiced.has(id));
      return { ...record, ids: record.ids.slice(), saved, newlyCompleted, nextIndex: nextId ? ids.indexOf(nextId) : -1 };
    }
    return { sync, latest };
  }
  function resumeHref(record, mobile) {
    if (!record || !/^\d+$/.test(record.videoId)) return null;
    return `./video-reader${mobile ? '' : '-desktop'}.html?focus=first_lesson&from=today_goal_resume&videoId=${record.videoId}`;
  }
  function createCard(container, options) {
    if (!container) return { update() {}, hide() {}, setState() {}, feedback() {} };
    const doc = container.ownerDocument;
    container.classList.add('first-lesson-goal');
    const status = doc.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const title = doc.createElement('strong');
    const detail = doc.createElement('p');
    const meter = doc.createElement('progress');
    meter.setAttribute('aria-label', '小目标跟读进度');
    status.append(title, detail, meter);
    const actions = doc.createElement('div');
    actions.className = 'first-lesson-goal-actions';
    const listen = doc.createElement('button');
    listen.type = 'button'; listen.textContent = '先听原句';
    const record = doc.createElement('button');
    record.type = 'button'; record.textContent = '跟读这句';
    record.className = 'goal-primary';
    const back = doc.createElement('a');
    back.textContent = '回到今日计划'; back.href = options.mobile ? './mobile-today.html' : './today.html';
    actions.append(listen, record, back);
    const feedback = doc.createElement('p');
    feedback.className = 'goal-feedback';
    feedback.setAttribute('role', 'status');
    container.replaceChildren(status, actions, feedback);
    let current = null;
    let busy = 'idle';
    listen.addEventListener('click', () => { if (current && busy === 'idle') options.listen(current.nextIndex); });
    record.addEventListener('click', () => { if (current) options.record(current.nextIndex); });
    function setState(value) {
      busy = value;
      listen.disabled = value !== 'idle';
      record.disabled = value === 'requesting' || value === 'evaluating';
      record.textContent = { recording: '完成录音', requesting: '正在请求麦克风…', evaluating: '正在评估…' }[value] || '跟读这句';
    }
    function update(goal) {
      current = goal;
      container.hidden = !goal;
      if (!goal) return;
      title.textContent = goal.complete ? `小目标完成 · ${goal.total} 句已开口` : `今天先练 ${goal.total} 句 · ${goal.completedCount}/${goal.total}`;
      detail.textContent = goal.complete
        ? (goal.saved ? '已保存在此浏览器。下次从「今日」接着练；整段视频进度另计。' : '本次已完成。浏览器未能保存进度，请勿关闭页面。')
        : '先听，再跟读；收到通过的评估才计数。不必一次练完整段视频。';
      meter.max = goal.total; meter.value = goal.completedCount;
      if (goal.complete) feedback.textContent = '';
      listen.hidden = goal.complete; record.hidden = goal.complete; back.hidden = !goal.complete;
      setState(busy);
    }
    return { update, setState, hide: () => update(null), feedback: text => { feedback.textContent = current?.complete ? '' : (text || ''); } };
  }
  function renderResume(container, options) {
    if (!container) return;
    const goal = createStore(options.storage).latest(options.subject);
    const href = resumeHref(goal, options.mobile);
    container.hidden = !href;
    container.replaceChildren();
    if (!href) return;
    container.classList.add('first-lesson-goal');
    const title = container.ownerDocument.createElement('strong');
    const detail = container.ownerDocument.createElement('p');
    const link = container.ownerDocument.createElement('a');
    title.textContent = goal.complete ? '上次的小目标已完成，今天继续开口' : `接着上次练 · ${Number(goal.completedCount) || 0}/${goal.ids.length} 句`;
    detail.textContent = '保留了此浏览器中的练习位置，直接回到同一段视频。';
    link.className = 'goal-primary'; link.href = href; link.textContent = goal.complete ? '继续学习' : '继续未完成的跟读';
    link.addEventListener('click', () => options.emit?.('first_lesson_goal_resume', { video_resource_id: goal.videoId, completed: goal.complete === true }));
    container.append(title, detail, link);
  }
  return { createStore, createCard, renderResume, resumeHref };
});
