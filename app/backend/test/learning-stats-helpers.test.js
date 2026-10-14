const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerLearningStatsRoutes, sanitizeLocalXp } = require('../routes/learning-stats');

const routeSource = fs.readFileSync(
  path.resolve(__dirname, '../routes/learning-stats.js'),
  'utf8'
);

// 截取某个 handler 的函数体(去掉注释,只看真正执行的代码),用于断言各时间窗口的口径
function handlerBody(name) {
  const start = routeSource.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `未找到 ${name}`);
  const next = routeSource.indexOf('\nasync function ', start + 1);
  return routeSource
    .slice(start, next > start ? next : routeSource.length)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

test('sanitizeLocalXp: 非法值归零', () => {
  assert.equal(sanitizeLocalXp(undefined), 0);
  assert.equal(sanitizeLocalXp('abc'), 0);
  assert.equal(sanitizeLocalXp(-50), 0);
});

test('sanitizeLocalXp: 正常值取整', () => {
  assert.equal(sanitizeLocalXp(123.7), 123);
  assert.equal(sanitizeLocalXp('456'), 456);
});

test('sanitizeLocalXp: 超过上限被钳制到 20000', () => {
  assert.equal(sanitizeLocalXp(999999), 20000);
});

test('统计路由将异步认证失败转换为 401', async () => {
  const response = {
    headersSent: false,
    writableEnded: false,
    status: null,
    body: '',
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  };

  const handled = await registerLearningStatsRoutes(
    '/api/stats/log',
    { method: 'POST', headers: {} },
    response,
    new URL('http://localhost/api/stats/log')
  );

  assert.equal(handled, true);
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body), { code: 401, message: 'UNAUTHORIZED' });
});

test('I-5: 迁移只写 local_xp_migrations,不写 daily_learning_stats', () => {
  const body = handlerBody('handleMigrateLocal');
  assert.match(body, /INSERT INTO local_xp_migrations/);
  assert.ok(
    !/daily_learning_stats/.test(body),
    '迁移量一旦落进 daily_learning_stats,就会被本周 XP 与排行榜的 7 天窗口计入'
  );
  assert.match(body, /ON CONFLICT \(user_id\) DO NOTHING/);
});

test('I-5: 终身 XP 与等级仍包含迁移量', () => {
  const fetchBody = routeSource.slice(
    routeSource.indexOf('async function fetchMigratedXp('),
    routeSource.indexOf('async function handleOverview(')
  );
  assert.match(fetchBody, /FROM local_xp_migrations WHERE user_id = \$1/);

  const body = handlerBody('handleOverview');
  assert.match(body, /fetchMigratedXp\(user\.id\)/);
  assert.match(body, /const totalXp = parseInt\(stats\.total_xp, 10\) \+ migratedXp;/);
  assert.match(body, /level: calcLevel\(totalXp\)/);
});

test('I-5: 时间窗口统计只汇总真实赚取的 XP', () => {
  const daily = handlerBody('handleDaily');
  assert.match(daily, /FROM daily_learning_stats/);
  assert.match(daily, /date >= CURRENT_DATE - \(\$2 - 1\) \* INTERVAL '1 day'/);
  assert.ok(!/local_xp_migrations|migratedXp/.test(daily), '每日曲线不得加入迁移量');

  const board = handlerBody('handleLeaderboard');
  assert.match(board, /dls\.date >= CURRENT_DATE - 6/);
  assert.ok(!/local_xp_migrations|migratedXp/.test(board), '排行榜不得加入迁移量');
});
