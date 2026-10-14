const fs = require('node:fs');
const path = require('node:path');

// 把词包里的 emoji 下载为 Twemoji SVG 插图(jdecked/twemoji v15.1.0,CC-BY 4.0)。
// 自托管:kc 服务器在国内,不能依赖 jsdelivr/github CDN 的运行时可达性。
const TWEMOJI_BASE = 'https://raw.githubusercontent.com/jdecked/twemoji/v15.1.0/assets/svg/';
const OUT_DIR = path.resolve(__dirname, '../../frontend/images/game/twemoji');
const PACK_PATH = path.resolve(__dirname, '../../frontend/js/game/word-packs/pack-max.json');

// Twemoji 文件名规则(同官方 grabTheRightIcon):无 ZWJ 时剔除 FE0F,码点连字符相接。
function toCodePoint(str) {
  const cleaned = str.indexOf('‍') < 0 ? str.replace(/️/g, '') : str;
  const points = [];
  for (const ch of cleaned) points.push(ch.codePointAt(0).toString(16));
  return points.join('-');
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  const emojis = new Set();
  pack.chapters.forEach((c) => c.words.forEach((w) => { if (w.emoji) emojis.add(w.emoji); }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  const missed = [];

  for (const emoji of emojis) {
    const code = toCodePoint(emoji);
    const outPath = path.join(OUT_DIR, code + '.svg');
    if (fs.existsSync(outPath)) { ok += 1; continue; }
    // 先按标准文件名取;404 再试保留 FE0F 的完整序列(个别符号如此收录)。
    let body = await download(TWEMOJI_BASE + code + '.svg');
    if (!body) {
      const full = [...emoji].map((ch) => ch.codePointAt(0).toString(16)).join('-');
      if (full !== code) body = await download(TWEMOJI_BASE + full + '.svg');
    }
    if (body) {
      fs.writeFileSync(outPath, body);
      ok += 1;
    } else {
      missed.push(emoji + ' (' + code + ')');
    }
  }

  console.log('Downloaded/present:', ok, 'of', emojis.size);
  if (missed.length) console.log('No twemoji asset (kept as text):', missed.join(', '));
}

main().catch((err) => { console.error(err); process.exit(1); });
