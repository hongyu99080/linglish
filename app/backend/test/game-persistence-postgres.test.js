const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Pool } = require('pg');

process.env.TZ = 'Asia/Shanghai';

const LEARNING_STATS_MIGRATION = path.resolve(
  __dirname,
  '../../../docs/db/migrations/V22__learning_statistics.sql'
);
const PERMISSIONS_MIGRATION = path.resolve(
  __dirname,
  '../../../docs/db/migrations/V34__learning_statistics_permissions.sql'
);

let dockerAvailable = false;
let containerName = '';
let adminPool;
let appPool;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test.before(async () => {
  const info = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (info.status !== 0) return;

  dockerAvailable = true;
  containerName = `linglish-game-persistence-${process.pid}-${Date.now()}`;
  docker(
    'run', '--detach', '--rm', '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=test',
    '-p', '127.0.0.1::5432',
    'postgres:16-alpine'
  );

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const probe = spawnSync(
      'docker',
      ['exec', containerName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { encoding: 'utf8' }
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'temporary PostgreSQL should become ready');

  const mapping = docker('port', containerName, '5432/tcp').trim();
  const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
  const adminUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  process.env.DATABASE_URL = adminUrl;
  adminPool = new Pool({ connectionString: adminUrl, max: 4 });

  await adminPool.query(`
    CREATE ROLE linklish LOGIN PASSWORD 'test';
    CREATE TABLE users (id SERIAL PRIMARY KEY);
    INSERT INTO users DEFAULT VALUES;

    CREATE TABLE user_vocabulary (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      word TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'learning',
      ease_factor NUMERIC NOT NULL DEFAULT 2.5,
      interval_days NUMERIC NOT NULL DEFAULT 1,
      next_review_at TIMESTAMP,
      last_reviewed_at TIMESTAMP,
      review_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE review_schedule (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      lemma TEXT,
      ease_factor NUMERIC NOT NULL DEFAULT 2.5,
      interval_days NUMERIC NOT NULL DEFAULT 1,
      repetitions INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'new',
      last_review_at TIMESTAMP,
      next_review_at TIMESTAMP,
      due_date DATE,
      total_reviews INTEGER NOT NULL DEFAULT 0,
      correct_reviews INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, item_type, item_id)
    );
    CREATE TABLE review_history (
      id SERIAL PRIMARY KEY,
      schedule_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      review_time TIMESTAMP,
      rating INTEGER,
      ease_factor_before NUMERIC,
      ease_factor_after NUMERIC,
      interval_days_before NUMERIC,
      interval_days_after NUMERIC,
      next_review_at TIMESTAMP
    );
    INSERT INTO user_vocabulary (user_id, word) VALUES (1, 'school');
  `);
});

test.after(async () => {
  try {
    const pools = [appPool, adminPool].filter(Boolean);
    if (dockerAvailable) pools.push(require('../data-store/core').pool);
    await Promise.allSettled(pools.map((pool) => pool.end()));
  } finally {
    if (containerName) {
      spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8' });
    }
  }
});

test('reviewByLemma stores timestamp and due date without PostgreSQL parameter type conflicts', async (t) => {
  if (!dockerAvailable) return t.skip('Docker is unavailable');

  const { reviewByLemma } = require('../services/srs-bridge');
  const result = await reviewByLemma(1, { lemma: 'school', quality: 'good' });
  const stored = await adminPool.query(
    `SELECT due_date::text AS due_date,
            next_review_at::date::text AS next_review_date
       FROM review_schedule
      WHERE id = $1`,
    [result.schedule.id]
  );

  assert.equal(result.item.word, 'school');
  assert.ok(result.schedule.next_review_at);
  assert.equal(stored.rows[0].due_date, stored.rows[0].next_review_date);
});

test('reviewByLemma keeps due date aligned across the Shanghai midnight boundary', async (t) => {
  if (!dockerAvailable) return t.skip('Docker is unavailable');

  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-08-29T17:00:00.000Z'),
  });
  const { reviewByLemma } = require('../services/srs-bridge');
  const result = await reviewByLemma(1, { lemma: 'school', quality: 'good' });
  const stored = await adminPool.query(
    `SELECT due_date::text AS due_date,
            next_review_at::date::text AS next_review_date
       FROM review_schedule
      WHERE id = $1`,
    [result.schedule.id]
  );

  assert.equal(stored.rows[0].due_date, stored.rows[0].next_review_date);
});

test('learning statistics migration grants the app role required table and sequence access', async (t) => {
  if (!dockerAvailable) return t.skip('Docker is unavailable');

  await adminPool.query(fs.readFileSync(LEARNING_STATS_MIGRATION, 'utf8'));
  const permissionsMigration = fs.readFileSync(PERMISSIONS_MIGRATION, 'utf8');
  await adminPool.query(permissionsMigration);
  await adminPool.query(permissionsMigration);

  const port = Number(docker('port', containerName, '5432/tcp').trim().split(':').pop());
  appPool = new Pool({
    connectionString: `postgres://linklish:test@127.0.0.1:${port}/postgres`,
    max: 2,
  });

  const daily = await appPool.query(`
    INSERT INTO daily_learning_stats (user_id, date, minutes_studied, xp_earned)
    VALUES (1, CURRENT_DATE, 1, 10)
    ON CONFLICT (user_id, date) DO UPDATE SET
      minutes_studied = daily_learning_stats.minutes_studied + EXCLUDED.minutes_studied,
      xp_earned = daily_learning_stats.xp_earned + EXCLUDED.xp_earned
    RETURNING minutes_studied, xp_earned
  `);
  const streak = await appPool.query(`
    INSERT INTO learning_streaks (user_id, current_streak, longest_streak)
    VALUES (1, 1, 1)
    ON CONFLICT (user_id) DO UPDATE SET current_streak = learning_streaks.current_streak + 1
    RETURNING current_streak
  `);

  assert.deepEqual(daily.rows[0], { minutes_studied: 1, xp_earned: 10 });
  assert.equal(streak.rows[0].current_streak, 1);
});
