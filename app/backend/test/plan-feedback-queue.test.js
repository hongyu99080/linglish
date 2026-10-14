const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateFeedback } = require('../services/plan-feedback');

const frontend = path.resolve(__dirname, '../../frontend');
const modulePath = path.join(frontend, 'js/mobile-today.js');

// 把移动端页面真正执行的离线队列块抽出来在沙箱里跑,
// 保证测的是页面真正执行的那段代码而不是复制品
function extractQueueBlock(source) {
  const start = source.indexOf("const FEEDBACK_QUEUE_KEY = 'plan_feedback_queue';");
  const endMarker = 'saveFeedbackQueue(loadFeedbackQueue().filter(p => !sent.has(feedbackKey(p))));';
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, '未找到反馈队列代码块');
  return source.slice(start, source.indexOf('}', end + endMarker.length) + 1);
}

function makeQueueSandbox(block, { post }) {
  const store = { linglish_token: 'test-token' };
  const context = {
    API_BASE: '',
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    fetch: post,
    console,
  };
  vm.createContext(context);
  vm.runInContext(
    `${block}\nthis.__api = { loadFeedbackQueue, saveFeedbackQueue, submitFeedback, flushFeedbackQueue, withClientId };`,
    context
  );
  return { api: context.__api, store };
}

const blockFromModule = extractQueueBlock(fs.readFileSync(modulePath, 'utf8'));

test('I-4: flush 期间新入队的反馈不会被覆盖丢失', async () => {
  let sandbox;
  const post = async (_url, options) => {
    // 模拟 flush 进行中用户又点了一次反馈
    const body = JSON.parse(options.body);
    if (body.action === 'too_hard') {
      sandbox.api.saveFeedbackQueue([
        ...sandbox.api.loadFeedbackQueue(),
        { itemType: 'review', action: 'boring', clientId: 'during-flush' },
      ]);
    }
    return { ok: true, status: 200 };
  };
  sandbox = makeQueueSandbox(blockFromModule, { post });

  sandbox.api.saveFeedbackQueue([{ itemType: 'watch', action: 'too_hard', clientId: 'queued-1' }]);
  await sandbox.api.flushFeedbackQueue();

  const left = sandbox.api.loadFeedbackQueue();
  assert.equal(left.length, 1, 'flush 期间入队的项必须保留');
  assert.equal(left[0].clientId, 'during-flush');
});

test('I-4: 只移除发送成功的项,失败的留在队列里', async () => {
  const post = async (_url, options) => {
    const body = JSON.parse(options.body);
    return body.itemType === 'watch' ? { ok: true, status: 200 } : { ok: false, status: 500 };
  };
  const sandbox = makeQueueSandbox(blockFromModule, { post });
  sandbox.api.saveFeedbackQueue([
    { itemType: 'watch', action: 'too_hard', clientId: 'a' },
    { itemType: 'review', action: 'boring', clientId: 'b' },
  ]);

  await sandbox.api.flushFeedbackQueue();
  const left = sandbox.api.loadFeedbackQueue();
  assert.equal(left.map((p) => p.clientId).join(','), 'b');
});

test('I-4: 409 视为已消费,不留在队列里重试', async () => {
  const post = async () => ({ ok: false, status: 409 });
  const sandbox = makeQueueSandbox(blockFromModule, { post });
  sandbox.api.saveFeedbackQueue([{ itemType: 'overall', action: 'rating', rating: 4 }]);
  await sandbox.api.flushFeedbackQueue();
  assert.equal(sandbox.api.loadFeedbackQueue().length, 0);
});

test('I-4: 离线时入队的非 rating 反馈带幂等 clientId', async () => {
  const post = async () => { throw new Error('offline'); };
  const sandbox = makeQueueSandbox(blockFromModule, { post });
  const ok = await sandbox.api.submitFeedback({ itemType: 'watch', action: 'too_hard' });
  assert.equal(ok, false, '离线必须静默降级');
  const [queued] = sandbox.api.loadFeedbackQueue();
  assert.ok(queued.clientId, '非 rating 反馈必须带 clientId');
  // 重放使用同一个 ID,不会生成新的
  assert.equal(sandbox.api.withClientId(queued).clientId, queued.clientId);
});

test('I-4: rating 不带 clientId(由后端每日唯一索引兜底)', async () => {
  const post = async () => { throw new Error('offline'); };
  const sandbox = makeQueueSandbox(blockFromModule, { post });
  await sandbox.api.submitFeedback({ itemType: 'overall', action: 'rating', rating: 5 });
  const [queued] = sandbox.api.loadFeedbackQueue();
  assert.equal(queued.clientId, undefined);
});

test('I-4: 后端接受并校验 clientId,rating 行强制为 null', () => {
  const ok = validateFeedback({ itemType: 'watch', action: 'too_hard', clientId: 'fabc123' });
  assert.equal(ok.clientId, 'fabc123');

  // 非法字符/超长一律丢弃(退化为非幂等写入,而不是让脏值进 SQL)
  assert.equal(validateFeedback({ itemType: 'watch', action: 'too_hard', clientId: "a'--" }).clientId, null);
  assert.equal(validateFeedback({ itemType: 'watch', action: 'too_hard', clientId: 'x'.repeat(65) }).clientId, null);
  assert.equal(validateFeedback({ itemType: 'watch', action: 'too_hard' }).clientId, null);

  const rating = validateFeedback({ itemType: 'overall', action: 'rating', rating: 3, clientId: 'abc' });
  assert.equal(rating.clientId, null);
});
