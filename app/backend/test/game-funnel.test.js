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
const { getGameFunnelStats } = require('../data-store/queries/analytics');
const adminAnalyticsHtml = fs.readFileSync(path.resolve(__dirname, '../../frontend/admin-analytics.html'), 'utf8');

test.after(() => {
  dataStoreCore.init = originalCore.init;
  dataStoreCore.dbUnavailable = originalCore.dbUnavailable;
  dataStoreCore.pool.query = originalCore.query;
});

function extractNamedFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain available for the admin game funnel`);
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

test('game funnel aggregates each completed gameplay phase', async () => {
  const queries = [];
  dataStoreCore.pool.query = async (sql) => {
    queries.push(sql);
    if (sql.includes('view_events')) {
      return { rows: [{
        view_events: 12,
        view_users: 10,
        start_events: 8,
        start_users: 8,
        complete_events: 3,
        complete_users: 3,
        boss_events: 1,
        boss_users: 1,
        pass_events: 0,
        pass_users: 0,
        learn_events: 7,
        learn_users: 7,
        matching_events: 6,
        matching_users: 6,
        spelling_events: 2,
        spelling_users: 2,
        quiz_events: 4,
        quiz_users: 4,
        boss_phase_events: 1,
        boss_phase_users: 1,
      }] };
    }
    return { rows: [] };
  };

  const funnel = await getGameFunnelStats({ days: 7 });
  const phaseQuery = queries.find((sql) => sql.includes('view_events')) || '';

  assert.match(phaseQuery, /'game_phase_complete'/);
  for (const phase of ['learn', 'matching', 'spelling', 'quiz', 'boss']) {
    assert.match(phaseQuery, new RegExp(`properties->>'phase'\\) = '${phase}'`));
  }
  assert.deepEqual(
    funnel.phases.map((phase) => ({
      key: phase.key,
      events: phase.events,
      users: phase.users,
      rate: phase.rate_from_level_start,
    })),
    [
      { key: 'learn', events: 7, users: 7, rate: 87.5 },
      { key: 'matching', events: 6, users: 6, rate: 75 },
      { key: 'spelling', events: 2, users: 2, rate: 25 },
      { key: 'quiz', events: 4, users: 4, rate: 50 },
      { key: 'boss', events: 1, users: 1, rate: 12.5 },
    ],
  );
});

test('admin game funnel renders phase completion cards', () => {
  const wrap = { innerHTML: '' };
  const document = {
    getElementById(id) { return id === 'game-phase-steps' ? wrap : null; },
  };
  const renderPhases = new Function(
    'document',
    'AdminUtils',
    'formatPercent',
    `return (${extractNamedFunction(adminAnalyticsHtml, 'renderGamePhaseSteps')});`,
  )(
    document,
    { escapeHtml: (value) => String(value) },
    (value) => `${value}%`,
  );

  renderPhases([{ label: '完成速答', events: 4, users: 4, rate_from_level_start: 50 }]);

  assert.match(adminAnalyticsHtml, /id="game-phase-steps"/);
  assert.match(wrap.innerHTML, /完成速答/);
  assert.match(wrap.innerHTML, /开始关卡 50%/);
  assert.match(wrap.innerHTML, /事件 4 次/);
});

test('admin game funnel passes API phases through the full loading path', async () => {
  const phases = [{ key: 'quiz', label: '完成速答', events: 4, users: 4, rate_from_level_start: 50 }];
  const period = { value: '7' };
  const note = { textContent: '' };
  let renderedPhases = null;
  const document = {
    getElementById(id) {
      if (id === 'game-funnel-period') return period;
      if (id === 'game-funnel-note') return note;
      return null;
    },
  };
  const loadFunnel = new Function(
    'document',
    'AdminAPI',
    'renderGameFunnelSteps',
    'renderGamePhaseSteps',
    'renderGameFunnelChart',
    'renderGameChapters',
    'formatPercent',
    'console',
    `return (${extractNamedFunction(adminAnalyticsHtml, 'loadGameFunnel')});`,
  )(
    document,
    { get: async () => ({ days: 7, steps: [], phases, daily: [], chapters: [] }) },
    () => {},
    (value) => { renderedPhases = value; },
    () => {},
    () => {},
    (value) => `${value}%`,
    { error: () => {} },
  );

  await loadFunnel();

  assert.deepEqual(renderedPhases, phases);
});
