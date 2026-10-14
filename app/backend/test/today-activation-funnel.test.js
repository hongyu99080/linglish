const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataStoreCore = require('../data-store/core');
const originalCore = {
  init: dataStoreCore.init,
  dbUnavailable: dataStoreCore.dbUnavailable,
  query: dataStoreCore.pool.query,
};
dataStoreCore.init = async () => dataStoreCore.pool;
dataStoreCore.dbUnavailable = () => false;
delete require.cache[require.resolve('../data-store/queries/analytics')];
const { getTodayActivationFunnel } = require('../data-store/queries/analytics');
const adminAnalyticsHtml = fs.readFileSync(path.resolve(__dirname, '../../frontend/admin-analytics.html'), 'utf8');

test.after(() => {
  dataStoreCore.init = originalCore.init;
  dataStoreCore.dbUnavailable = originalCore.dbUnavailable;
  dataStoreCore.pool.query = originalCore.query;
});

function extractNamedFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain available for the admin chart contract`);
  const openBrace = source.indexOf('{', start);
  let depth = 0;
  let quote = null;

  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Unable to parse ${name}`);
}

function parseStepDefinitions(sql) {
  const match = sql.match(/step_defs AS \(\s*SELECT \* FROM \(VALUES([\s\S]*?)\) AS s\(key, label, sort_order\)/);
  assert.ok(match, 'Today funnel step definitions must be present');
  return Array.from(match[1].matchAll(/\('([^']+)',\s*'[^']+',\s*(\d+)\)/g), ([, key, order]) => ({ key, order: Number(order) }));
}

function executeWorkspaceReadyStage(sql, windowedEvents) {
  const match = sql.match(/SELECT\s+(DISTINCT\s+)?'workspace_ready' AS key, subject_key\s+FROM windowed\s+WHERE event_name = '([^']+)'/);
  assert.ok(match, 'workspace-ready stage must select its readiness event from windowed subjects');
  const rows = windowedEvents
    .filter((event) => event.event_name === match[2])
    .map((event) => ({ key: 'workspace_ready', subject_key: event.subject_key }));
  const countedRows = match[1]
    ? Array.from(new Map(rows.map((row) => [`${row.key}:${row.subject_key}`, row])).values())
    : rows;
  return {
    events: countedRows.length,
    users: new Set(countedRows.map((row) => row.subject_key)).size,
  };
}

function extractProjectionAliases(sql) {
  const match = sql.match(/SELECT\s+d\.date,([\s\S]*?)\s+FROM days d/);
  assert.ok(match, 'daily query must project a day row');
  return Array.from(match[1].matchAll(/AS\s+(\w+)/g), ([, alias]) => alias);
}

test('Today funnel preserves readiness event rows while deduplicating visitors and exposes daily readiness', async () => {
  const queries = [];
  dataStoreCore.pool.query = async (sql) => {
    queries.push(sql);
    if (queries.length === 1) {
      return { rows: [
        { key: 'workspace_view', label: '进入今日工作台', events: 10, users: 2 },
        { key: 'plan_loaded', label: '计划加载成功', events: 4, users: 2 },
        { key: 'next_action_click', label: '点击下一步', events: 3, users: 2 },
        { key: 'workspace_ready', label: '首课工作区就绪', events: 2, users: 2 },
        { key: 'video_watch', label: '产生视频观看', events: 6, users: 2 },
      ] };
    }
    if (queries.length === 2) {
      return { rows: [{
        date: '2026-08-08',
        workspace_view_users: 2,
        workspace_view_events: 10,
        plan_loaded_users: 2,
        plan_loaded_events: 4,
        next_action_click_users: 2,
        next_action_click_events: 3,
        workspace_ready_users: 2,
        workspace_ready_events: 2,
        video_watch_users: 2,
        video_watch_events: 6,
        practice_completed_users: 0,
        practice_completed_events: 0,
        next_session_commitment_users: 0,
        next_session_commitment_events: 0,
        upgrade_click_users: 0,
        upgrade_click_events: 0,
      }] };
    }
    return { rows: [] };
  };

  const funnel = await getTodayActivationFunnel({ days: 30 });
  const readiness = funnel.steps.find((step) => step.key === 'workspace_ready');
  const stepDefinitions = parseStepDefinitions(queries[0]);
  const stageCounts = executeWorkspaceReadyStage(queries[0], [
    { event_name: 'today_first_lesson_workspace_ready', subject_key: 'v:one' },
    { event_name: 'today_first_lesson_workspace_ready', subject_key: 'v:one' },
  ]);

  assert.deepEqual(
    readiness && {
      events: readiness.events,
      users: readiness.users,
      rate_from_start: readiness.rate_from_start,
    },
    { events: 2, users: 2, rate_from_start: 100 },
  );
  assert.deepEqual(stageCounts, { events: 2, users: 1 });
  assert.deepEqual(
    stepDefinitions.map((step) => step.key),
    ['workspace_view', 'plan_loaded', 'next_action_click', 'workspace_ready', 'video_watch', 'practice_completed', 'next_session_commitment', 'upgrade_click'],
  );
  assert.deepEqual(
    extractProjectionAliases(queries[1]).slice(0, 6),
    [
      'workspace_view_users',
      'workspace_view_events',
      'plan_loaded_users',
      'plan_loaded_events',
      'next_action_click_users',
      'next_action_click_events',
    ],
  );
  for (const { key } of stepDefinitions) {
    assert.doesNotMatch(
      queries[0],
      new RegExp(`SELECT\\s+DISTINCT\\s+'${key}' AS key`),
      `${key} must preserve raw event rows for diagnostics`,
    );
  }
  assert.equal(funnel.daily[0].workspace_ready_users, 2);
  assert.equal(funnel.daily[0].workspace_ready_events, 2);
});

test('admin Today funnel cards and summary lead with deduplicated visitors', async () => {
  const wrap = { innerHTML: '' };
  const note = { textContent: '' };
  const period = { value: '30' };
  const document = {
    getElementById(id) {
      if (id === 'today-funnel-steps') return wrap;
      if (id === 'today-funnel-note') return note;
      if (id === 'today-funnel-period') return period;
      return null;
    },
  };
  const steps = [
    { key: 'workspace_view', label: '进入今日工作台', events: 10, users: 2, rate_from_start: 100, rate_from_previous: 100 },
    { key: 'workspace_ready', label: '首课工作区就绪', events: 2, users: 2, rate_from_start: 100, rate_from_previous: 100 },
  ];
  const renderSteps = new Function(
    'document',
    'AdminUtils',
    'formatPercent',
    `return (${extractNamedFunction(adminAnalyticsHtml, 'renderTodayFunnelSteps')});`,
  )(document, { escapeHtml: (value) => String(value) }, (value) => `${value}%`);
  const loadFunnel = new Function(
    'document',
    'AdminAPI',
    'renderTodayFunnelSteps',
    'renderTodayFunnelChart',
    'renderTodayActions',
    'formatPercent',
    'console',
    `return (${extractNamedFunction(adminAnalyticsHtml, 'loadTodayFunnel')});`,
  )(
    document,
    { get: async () => ({ days: 30, steps, daily: [], actions: [] }) },
    () => {},
    () => {},
    () => {},
    (value) => `${value}%`,
    { error: () => {} },
  );

  renderSteps(steps);
  await loadFunnel();

  assert.match(wrap.innerHTML, /today-funnel-value">2</);
  assert.match(wrap.innerHTML, /去重访客/);
  assert.match(wrap.innerHTML, /诊断事件行 10/);
  assert.match(note.textContent, /工作台去重访客 2 人（诊断事件行 10）/);
  assert.match(note.textContent, /首课工作区就绪率 100%/);
});

test('admin Today funnel chart renders deduplicated visitor datasets', () => {
  let renderedConfig = null;
  const CaptureChart = function CaptureChart(context, config) {
    renderedConfig = config;
    this.destroy = () => {};
  };
  const renderWithCapture = new Function(
    'Chart',
    'document',
    'todayFunnelChart',
    `return (${extractNamedFunction(adminAnalyticsHtml, 'renderTodayFunnelChart')});`,
  )(
    CaptureChart,
    { getElementById: () => ({}) },
    null,
  );

  renderWithCapture([{
    date: '2026-08-08',
    workspace_view_users: 9,
    workspace_view_events: 30,
    workspace_ready_users: 7,
    workspace_ready_events: 20,
  }]);

  const readinessDataset = renderedConfig.data.datasets.find((dataset) => dataset.label === '首课工作区就绪 · 去重访客');
  assert.deepEqual(readinessDataset && readinessDataset.data, [7]);
  assert.equal(renderedConfig.data.datasets.some((dataset) => /事件/.test(dataset.label)), false);
});
