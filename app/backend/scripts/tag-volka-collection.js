#!/usr/bin/env node
/**
 * 给 Volka English 合集打标签。
 *
 * 注意：前端筛选读的是 video_tags 关系表（video_id + tag_id），
 * 不是 video_resources.tags 这个 JSONB 列 —— 那一列前端根本不读，
 * 写进去等于没写。所以这里只动 video_tags。
 *
 * 归类依据是标题关键词。整个合集底色是 Comprehensible Input，
 * 统一挂「课程」；其余按内容形态叠加，一个视频可以有多个标签。
 *
 * 用法：
 *   node scripts/tag-volka-collection.js [--dry-run]
 */

require('dotenv').config();
const dataStore = require('../data-store');

const COLLECTION = 'Volka English';
const DRY = process.argv.includes('--dry-run');

// 需要用到的标签。已存在的直接复用 id，缺的按需创建。
const WANTED = ['课程', '生活', '购物', '跟读', '播客', '旅行', '词汇'];

/**
 * 按标题判断该挂哪些标签。
 * 顺序无关，返回标签名数组；「课程」在调用方统一追加。
 */
function classify(title) {
  const t = String(title || '').toLowerCase();
  const has = (...kw) => kw.some((k) => t.includes(k));
  const tags = [];

  // 跟读：Shadowing / Shadow / Speak Along / Copy Me
  if (has('shadow', 'speak along', 'copy me', 'speak with me and shadow')) tags.push('跟读');

  // 播客：Slow English Podcast 系列及其它 podcast
  if (has('podcast')) tags.push('播客');

  // 旅行：明确的国家/地区、旅行场景
  if (has('vietnam', 'hcmc', 'indonesia', 'thailand', 'canada', 'mexico',
          'lima', 'peru', 'ecuador', 'travel', 'trip', 'vacation', 'airport',
          'beach', 'road trip')) tags.push('旅行');

  // 词汇：成组的词/短语/习语教学
  if (has('verbs', 'words', 'vocabulary', 'idiom', 'phrasal', 'slang',
          'questions & answers', 'phrases')) tags.push('词汇');

  // 购物：超市/商场/购物场景
  if (has('shopping', 'grocery', 'mall', 'store')) tags.push('购物');

  // 生活：做饭、家务、日常routine、居家
  if (has('cooking', 'cook', 'chore', 'daily life', 'daily routine',
          'morning routine', 'at home', 'house', 'apartment', 'kitchen',
          'grocery', 'packing', 'pack', 'gym', 'nature')) tags.push('生活');

  return tags;
}

async function resolveTagIds() {
  const { rows } = await dataStore.pool.query('SELECT id, name FROM tags');
  const map = new Map(rows.map((r) => [r.name, r.id]));
  const created = [];

  for (const name of WANTED) {
    if (map.has(name)) continue;
    if (DRY) {
      map.set(name, `NEW:${name}`);
      created.push(name);
      continue;
    }
    const ins = await dataStore.pool.query(
      'INSERT INTO tags (name) VALUES ($1) RETURNING id',
      [name],
    );
    map.set(name, ins.rows[0].id);
    created.push(name);
  }
  if (created.length) console.log(`新建标签: ${created.join('、')}`);
  return map;
}

async function main() {
  await dataStore.init();
  const tagIds = await resolveTagIds();

  const { rows: videos } = await dataStore.pool.query(
    'SELECT id, title FROM video_resources WHERE collection_name = $1 ORDER BY id',
    [COLLECTION],
  );
  console.log(`合集「${COLLECTION}」共 ${videos.length} 个视频\n`);

  // 已有的标签关系，避免重复插入
  const { rows: existing } = await dataStore.pool.query(
    `SELECT video_id, tag_id FROM video_tags
      WHERE video_id = ANY($1::bigint[])`,
    [videos.map((v) => v.id)],
  );
  const had = new Set(existing.map((r) => `${r.video_id}:${r.tag_id}`));

  const tally = {};
  let inserted = 0;

  for (const v of videos) {
    const names = ['课程', ...classify(v.title)];
    for (const name of names) {
      tally[name] = (tally[name] || 0) + 1;
      const tid = tagIds.get(name);
      if (had.has(`${v.id}:${tid}`)) continue;
      if (!DRY) {
        await dataStore.pool.query(
          `INSERT INTO video_tags (video_id, tag_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [v.id, tid],
        );
      }
      inserted += 1;
    }
    console.log(`  ${v.id} [${names.join(' ')}] ${String(v.title).slice(0, 55)}`);
  }

  console.log('\n' + '='.repeat(60));
  for (const name of WANTED) {
    console.log(`  ${name}: ${tally[name] || 0}`);
  }
  console.log(`新增关系: ${inserted}${DRY ? ' (DRY RUN，未落盘)' : ''}`);
  console.log('='.repeat(60));
  process.exit(0);
}

main().catch((err) => {
  console.error('脚本执行出错:', err);
  process.exit(1);
});
