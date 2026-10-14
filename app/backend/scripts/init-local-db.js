#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs/promises');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const migrationsDirectory = path.resolve(__dirname, '../../../docs/db/migrations');
const baseMigrations = [
  'V1__initial_schema.sql',
  'V2__learning_core.sql',
  'V3__training_loop.sql',
  'V4__events_and_indexes.sql',
];
const baseTables = [
  'users', 'user_profiles', 'articles', 'content_rights', 'media_assets', 'audio_segments',
  'words', 'user_vocabulary', 'reading_sessions', 'word_interactions', 'daily_stats',
  'training_sessions', 'ai_scores', 'events',
];

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL in app/backend/.env before initializing the database.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path = public');
    // Serialize bootstrap attempts without locking any existing application tables.
    await client.query('SELECT pg_advisory_xact_lock($1)', [1876432901]);
    const { rows } = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const existing = new Set(rows.map(row => row.tablename));
    if (baseTables.every(table => existing.has(table))) {
      await client.query('COMMIT');
      console.log('Base schema already exists; no existing data was changed.');
      return;
    }
    if (existing.size > 0) {
      throw new Error('Database is not empty and has an incomplete base schema. Use a new empty database.');
    }

    for (const filename of baseMigrations) {
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
      await client.query(sql);
      console.log(`Applied ${filename}`);
    }
    await client.query('COMMIT');
    console.log('Base schema initialized. Start the app to create auxiliary tables and fictional seed data.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

initializeDatabase().catch(error => {
  console.error(`Database initialization failed: ${error.message}`);
  process.exitCode = 1;
});
