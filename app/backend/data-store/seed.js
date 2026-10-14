const path = require('path');
const fs = require('fs/promises');
const { pool, dbUnavailable } = require('./core');

const SEED_DIR = path.join(__dirname, '..', 'seed');

async function ensureSeedData() {
  if (dbUnavailable()) return;
  const client = await pool.connect();
  try {
    const [{ rows: articleCountRows }, { rows: mediaCountRows }, { rows: segmentCountRows }] =
      await Promise.all([
        client.query('SELECT COUNT(*)::INT FROM articles'),
        client.query('SELECT COUNT(*)::INT FROM media_assets'),
        client.query('SELECT COUNT(*)::INT FROM audio_segments'),
      ]);

    if (articleCountRows[0].count === 0) {
      await seedArticles(client);
    }
    if (mediaCountRows[0].count === 0) {
      await seedMedia(client);
    }
    if (segmentCountRows[0].count === 0) {
      await seedSegments(client);
    }
  } finally {
    client.release();
  }
}

async function seedArticles(client) {
  const articles = await readJson('articles.json');
  for (const article of articles) {
    await client.query(
      `INSERT INTO articles (id, title, content, level, tags, audio_url, status, created_at, updated_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'published', NOW(), NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        article.id,
        article.title,
        article.content || 'Demo article content for linglish MVP.',
        article.level || null,
        article.tags || [],
        article.audio_url || null,
      ],
    );
  }
  await resetSequence(client, 'articles', 'id');
}

async function seedMedia(client) {
  const media = await readJson('media.json');
  for (const item of media) {
    await client.query(
      `INSERT INTO media_assets (id, article_id, kind, url, duration_sec, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [item.id, item.article_id, item.kind, item.url, item.duration_sec || null],
    );
  }
  await resetSequence(client, 'media_assets', 'id');
}

async function seedSegments(client) {
  const segments = await readJson('segments.json');
  for (const segment of segments) {
    await client.query(
      `INSERT INTO audio_segments (id, media_id, start_ms, end_ms, text, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [segment.id, segment.media_id, segment.start_ms, segment.end_ms, segment.text || null],
    );
  }
  await resetSequence(client, 'audio_segments', 'id');
}

async function readJson(filename) {
  const filePath = path.join(SEED_DIR, filename);
  const contents = await fs.readFile(filePath, 'utf8');
  try {
    if (!contents || contents === 'undefined' || contents === 'null') {
      throw new Error(`Invalid JSON content in ${filename}`);
    }
    return JSON.parse(contents);
  } catch (err) {
    console.error(`[DataStore] Failed to parse JSON from ${filename}:`, err.message);
    throw err;
  }
}

async function resetSequence(client, tableName, column) {
  const sequenceSql = `
    SELECT pg_get_serial_sequence($1, $2) AS seq_name
  `;
  const { rows } = await client.query(sequenceSql, [tableName, column]);
  const seqName = rows[0].seq_name;
  if (!seqName) return;
  await client.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${column}) FROM ${tableName}), 0) + 1, false)`,
    [seqName],
  );
}

module.exports = {
  ensureSeedData,
};
