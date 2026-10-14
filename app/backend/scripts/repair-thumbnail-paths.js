#!/usr/bin/env node
/**
 * 修复历史遗留的坏封面路径。
 *
 * 背景：两台服务器共用同一个数据库，但缩略图各存各的本地盘。
 * 老的生成逻辑把 Date.now() 写进文件名，于是同一个视频在两台机器上
 * 生成出两个不同的文件名，数据库里只存得下一个 —— 另一台必然 404。
 * 另有一批 YouTube 视频，因为老脚本拿 video_path（一条 URL）去截帧，
 * 永远被跳过，两台机器上都没有封面。
 *
 * 本脚本只做重命名 + 回写路径，不重新截帧：
 *   目标文件名由「源视频文件名」推导，两台机器算出来必然一致。
 *   本机已有的旧文件（无论带哪台机器的时间戳前缀）都会被重命名过去。
 *
 * 两台服务器都要跑一遍，顺序无关。
 *
 * 用法：
 *   node scripts/repair-thumbnail-paths.js [--dry-run]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const dataStore = require('../data-store');

const STATIC_DIR = path.join(__dirname, '../public');
const THUMBS_DIR = path.join(STATIC_DIR, 'thumbnails');
const DRY = process.argv.includes('--dry-run');

/**
 * 能用来截帧的本地文件（也用来推导封面文件名）。
 * 本地上传在 video_path，YouTube 视频在 local_video_path。
 */
function localSourcePath(video) {
  return [video.video_path, video.local_video_path]
    .find((p) => typeof p === 'string' && p && !/^https?:\/\//i.test(p)) || null;
}

/** 目标封面名：直接取源视频文件名，不带任何时间戳，两台机器结果一致。 */
function targetThumbName(video) {
  const src = localSourcePath(video);
  if (!src) return null;
  return `${path.basename(src, path.extname(src))}.jpg`;
}

/**
 * 在本机找到这个视频现有的封面文件。
 * 库里记的名字可能是另一台机器的（前缀时间戳不同），
 * 但去掉前缀时间戳后的尾巴两台是一样的，按尾巴匹配即可。
 */
function findExistingThumb(dbBaseName, localFiles) {
  if (localFiles.has(dbBaseName)) return dbBaseName;
  const tail = dbBaseName.replace(/^\d{13}-/, '');
  if (tail === dbBaseName) return null;
  for (const f of localFiles) {
    if (f === tail || f.endsWith(`-${tail}`)) return f;
  }
  return null;
}

function headStatus(url) {
  return new Promise((resolve) => {
    try {
      const req = https.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.end();
    } catch (err) {
      resolve(0);
    }
  });
}

// maxresdefault 只有源片 ≥720p 才存在，否则 404。hqdefault 一定有。
//
// 关键：国内那台机器访问 YouTube CDN 本来就不通，探测超时会被误当成 404，
// 从而把 121 张好封面全部"降级"掉。所以只在拿到确凿证据时才改：
// maxresdefault 探测失败 **且** 同一视频的 hqdefault 探测成功 —— 这才说明
// 是这个分辨率不存在，而不是网络不通。
async function repairRemote(video, tally) {
  const url = video.thumbnail_path;
  if (!/maxresdefault/i.test(url)) { tally.remote += 1; return; }
  if (await headStatus(url) === 200) { tally.remote += 1; return; }

  const fallback = video.youtube_video_id
    ? `https://img.youtube.com/vi/${video.youtube_video_id}/hqdefault.jpg`
    : url.replace(/maxresdefault\.(jpg|webp)/i, 'hqdefault.jpg').replace('/vi_webp/', '/vi/');

  if (await headStatus(fallback) !== 200) {
    console.log(`  跳过 id=${video.id}：hqdefault 也探测不到，判定为网络不通而非封面缺失`);
    tally.remoteUnverifiable += 1;
    return;
  }

  if (!DRY) await dataStore.updateVideoResource(video.id, { thumbnail_path: fallback });
  console.log(`  远程封面降级 id=${video.id} -> ${fallback}`);
  tally.remoteFixed += 1;
}

async function main() {
  await dataStore.init();
  const videos = await dataStore.listVideoResources();
  const localFiles = new Set(
    fs.existsSync(THUMBS_DIR) ? fs.readdirSync(THUMBS_DIR).filter((f) => f.endsWith('.jpg')) : [],
  );

  const tally = { fixed: 0, alreadyOk: 0, needsRegen: 0, remote: 0, remoteFixed: 0, remoteUnverifiable: 0 };
  const regenIds = [];

  for (const video of videos) {
    const p = video.thumbnail_path;
    if (typeof p === 'string' && /^https?:\/\//i.test(p)) {
      await repairRemote(video, tally);
      continue;
    }

    const target = targetThumbName(video);
    if (!target) { regenIds.push(video.id); tally.needsRegen += 1; continue; }
    const targetAbs = path.join(THUMBS_DIR, target);
    const targetPublic = `/static/thumbnails/${target}`;

    const dbBase = typeof p === 'string' && p.startsWith('/static/thumbnails/') ? path.basename(p) : null;
    const existing = localFiles.has(target)
      ? target
      : (dbBase ? findExistingThumb(dbBase, localFiles) : null);

    if (!existing) { regenIds.push(video.id); tally.needsRegen += 1; continue; }

    if (existing === target && p === targetPublic) { tally.alreadyOk += 1; continue; }

    if (!DRY) {
      if (existing !== target) {
        fs.renameSync(path.join(THUMBS_DIR, existing), targetAbs);
        localFiles.delete(existing);
        localFiles.add(target);
      }
      if (p !== targetPublic) await dataStore.updateVideoResource(video.id, { thumbnail_path: targetPublic });
    }
    console.log(`  修复 id=${video.id} ${existing} -> ${target}`);
    tally.fixed += 1;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`重命名并回写: ${tally.fixed}`);
  console.log(`本来就正常:   ${tally.alreadyOk}`);
  console.log(`远程封面:     ${tally.remote} (降级修复 ${tally.remoteFixed}, 探测不到跳过 ${tally.remoteUnverifiable})`);
  console.log(`需重新截帧:   ${tally.needsRegen}${regenIds.length ? ' -> ' + regenIds.join(',') : ''}`);
  if (DRY) console.log('(DRY RUN，未落盘)');
  console.log('='.repeat(60));
  process.exit(0);
}

main().catch((err) => {
  console.error('脚本执行出错:', err);
  process.exit(1);
});
