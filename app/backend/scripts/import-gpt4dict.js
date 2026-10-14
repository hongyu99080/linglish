'use strict';

/**
 * import-gpt4dict.js
 *
 * Imports DictionaryByGPT4 open-source word data into word_deep_cache table.
 * Source: https://github.com/Ceelog/DictionaryByGPT4 (CC-BY-SA-4.0)
 *
 * The source file (gptwords.json) is in JSONL format — one JSON per line:
 *   {"word":"...", "content":"### 分析词义\n\n...\n### 列举例句\n..."}
 *
 * Usage:
 *   cd app/backend
 *   node scripts/import-gpt4dict.js /path/to/gptwords.json
 *   node scripts/import-gpt4dict.js        # defaults to /tmp/gptwords.json
 *
 * Download the data first:
 *   curl -L https://raw.githubusercontent.com/Ceelog/DictionaryByGPT4/master/gptwords.json -o /tmp/gptwords.json
 */

const fs      = require('fs');
const readline = require('readline');
const path    = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Markdown section extractor ────────────────────────────────────────────────

/**
 * Extract the text content of a specific ### section from markdown.
 * @param {string} content - full markdown content
 * @param {string} name    - partial section header to match (e.g. "词根分析")
 * @returns {string}
 */
function extractSection(content, name) {
  const lines   = content.split('\n');
  let inSection = false;
  const result  = [];

  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (inSection) break;                 // next section — stop
      if (line.includes(name)) {
        inSection = true;
        continue;                           // skip the heading line itself
      }
    } else if (inSection) {
      result.push(line);
    }
  }

  return result.join('\n').trim();
}

/**
 * Build the raw_json blob to store in word_deep_cache.
 * We mark source = 'gpt4dict' so the frontend can render differently.
 * We also extract approximate values for the structured fields.
 */
function buildRawJson(word, content) {
  // --- rough field extraction ---
  const rootText    = extractSection(content, '词根分析');
  const affixText   = extractSection(content, '词缀分析');
  const histText    = extractSection(content, '发展历史');
  const meaningText = extractSection(content, '分析词义');
  const memoryText  = extractSection(content, '记忆辅助');
  const storyText   = extractSection(content, '小故事');

  // etymology.evolution: combine root + history, truncate
  const evolutionRaw = [rootText, affixText, histText]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const evolution = evolutionRaw.slice(0, 250);

  // core_image.metaphor: first meaningful sentence of meaning
  const metaphor = (meaningText.split('\n').find(l => l.trim().length > 10) || '')
    .trim()
    .slice(0, 150);

  // philosophy: first 2 non-empty lines of story
  const storyLines = storyText.split('\n').filter(l => l.trim());
  const philosophy = storyLines.slice(0, 2).join('\n').trim().slice(0, 300);

  return {
    source:     'gpt4dict',
    content_md: content,
    etymology: {
      roots:     [],
      cognates:  [],
      evolution: evolution,
    },
    core_image: {
      formula:  memoryText.slice(0, 150).split('\n')[0] || '',
      metaphor: metaphor,
    },
    comparisons: [],
    mermaid:     '',
    philosophy:  philosophy,
  };
}

// ── Database helpers ──────────────────────────────────────────────────────────

async function loadExistingWords(client) {
  const res = await client.query('SELECT word FROM word_deep_cache');
  return new Set(res.rows.map(r => r.word.toLowerCase()));
}

async function flushBatch(client, batch) {
  // Use a transaction per batch for performance
  await client.query('BEGIN');
  try {
    for (const { word, rawJson } of batch) {
      await client.query(`
        INSERT INTO word_deep_cache (word, etymology, core_image, comparisons, mermaid_chart, philosophy, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (word) DO NOTHING
      `, [
        word,
        JSON.stringify(rawJson.etymology),
        JSON.stringify(rawJson.core_image),
        JSON.stringify(rawJson.comparisons),
        rawJson.mermaid,
        rawJson.philosophy,
        JSON.stringify(rawJson),
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function importGpt4Dict(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    console.error('Download with:');
    console.error('  curl -L https://raw.githubusercontent.com/Ceelog/DictionaryByGPT4/master/gptwords.json -o /tmp/gptwords.json');
    process.exit(1);
  }

  const client = await pool.connect();

  try {
    console.log('Loading existing words from DB...');
    const existingWords = await loadExistingWords(client);
    console.log(`Found ${existingWords.size} words already in cache — these will be skipped.`);

    const rl = readline.createInterface({
      input:    fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    let imported = 0;
    let skipped  = 0;
    let errored  = 0;
    let lineNum  = 0;
    const BATCH  = 100;
    let batch    = [];

    for await (const line of rl) {
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        errored++;
        continue;
      }

      const word = ((entry.word || '').toLowerCase().trim());
      if (!word) { errored++; continue; }

      if (existingWords.has(word)) {
        skipped++;
        continue;
      }

      const rawJson = buildRawJson(word, entry.content || '');
      batch.push({ word, rawJson });

      if (batch.length >= BATCH) {
        await flushBatch(client, batch);
        imported += batch.length;
        batch = [];
        process.stdout.write(`\r  Imported: ${imported}  Skipped: ${skipped}  Errors: ${errored}   `);
      }
    }

    // flush remainder
    if (batch.length > 0) {
      await flushBatch(client, batch);
      imported += batch.length;
    }

    console.log(`\n\nDone!`);
    console.log(`  Imported : ${imported}`);
    console.log(`  Skipped  : ${skipped} (already in cache)`);
    console.log(`  Errors   : ${errored} (parse failures)`);
    console.log(`  Total    : ${lineNum} lines processed`);

  } finally {
    client.release();
    await pool.end();
  }
}

const filePath = process.argv[2] || '/tmp/gptwords.json';
console.log(`Importing DictionaryByGPT4 from: ${filePath}`);
importGpt4Dict(filePath).catch(err => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
