#!/usr/bin/env node
/**
 * 批量为缺少缩略图的视频生成缩略图
 *
 * 使用方法：
 * node scripts/generate-missing-thumbnails.js
 *
 * 可选参数：
 * --dry-run    只检查，不实际生成
 * --limit=N    限制处理视频数量
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const dataStore = require('../data-store');

// 获取 ffmpeg
let ffmpeg;
let ffmpegAvailable = false;
try {
  ffmpeg = require('fluent-ffmpeg');
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller?.path) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    ffmpegAvailable = true;
  }
  try {
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    if (ffprobeInstaller?.path) {
      ffmpeg.setFfprobePath(ffprobeInstaller.path);
    }
  } catch (e) {
    if (process.env.FFPROBE_PATH) {
      try { ffmpeg.setFfprobePath(process.env.FFPROBE_PATH); } catch (_) {}
    }
  }
} catch (err) {
  console.error('❌ FFmpeg 不可用，无法生成缩略图');
  process.exit(1);
}

const STATIC_DIR = path.join(__dirname, '../public');
const VIDEO_DIR = path.join(STATIC_DIR, 'videos');
const THUMBS_DIR = path.join(STATIC_DIR, 'thumbnails');

/**
 * 找出能用来截帧的本地文件。
 * 本地上传的视频在 video_path，YouTube 视频在 local_video_path（后台下载后写入）。
 * 两者都是 /videos/... 形式的公开路径，映射到 public/ 下。
 * @returns {string|null} 绝对路径；没有可用文件时返回 null
 */
function resolveVideoSource(video) {
  const candidates = [video.video_path, video.local_video_path]
    .filter((p) => typeof p === 'string' && p && !/^https?:\/\//i.test(p));
  for (const rel of candidates) {
    const abs = path.join(STATIC_DIR, rel.replace(/^\//, ''));
    try {
      require('fs').statSync(abs);
      return abs;
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

/**
 * 为单个视频生成缩略图
 */
async function generateThumbnail(videoPath, videoId) {
  try {
    await fs.mkdir(THUMBS_DIR, { recursive: true });

    // 文件名必须可复现：两台服务器共用一个数据库、各自本地生成缩略图。
    // 原来带 Date.now() 前缀，同一个视频在两台机器上得到两个不同文件名，
    // 库里只存得下一个，另一台必然 404（历史上 228 个本地视频就是这么坏的）。
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const thumbName = `${baseName}.jpg`;
    const thumbAbs = path.join(THUMBS_DIR, thumbName);

    console.log(`  📸 生成缩略图: ${thumbName}`);

    // 先用 ffprobe 获取时长，再在 10% 位置截帧；
    // 关键：scale+pad 保持原始宽高比，竖屏视频用 pillarbox 黑边填充到 640x360，
    // 避免 9:16 源被强制缩放到 16:9 导致人脸被横向拉伸失真。
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, data) => {
        if (err) return reject(err);
        const d = (data && data.format && data.format.duration) || 0;
        resolve(Number(d) || 0);
      });
    });
    const ts = Math.max(0.5, Math.min(duration * 0.1 || 1, Math.max(0.5, duration - 0.3)));

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .on('error', (err) => {
          console.error(`  ❌ 生成失败:`, err.message);
          reject(err);
        })
        .on('end', () => {
          console.log(`  ✅ 生成成功`);
          resolve();
        })
        .inputOptions(['-ss', String(ts)])
        .outputOptions([
          '-vframes', '1',
          '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black',
          '-q:v', '3',
          '-y',
        ])
        .output(thumbAbs)
        .run();
    });

    const publicPath = `/static/thumbnails/${thumbName}`;
    return publicPath;
  } catch (err) {
    console.error(`  ❌ 缩略图生成失败:`, err.message);
    return null;
  }
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isForce = args.includes('--force');
  const limitArg = args.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

  console.log('🎬 视频缩略图批量生成工具');
  console.log('='.repeat(60));

  if (isDryRun) {
    console.log('⚠️  DRY RUN 模式 - 只检查，不实际生成');
  }

  if (limit) {
    console.log(`📊 限制处理数量: ${limit} 个视频`);
  }
  console.log('');

  // 初始化数据库
  await dataStore.init();

  // 获取所有视频
  const videos = await dataStore.listVideoResources();
  console.log(`📹 总共找到 ${videos.length} 个视频\n`);

  // 筛选出需要处理的视频
  const needThumbnails = videos.filter(v => {
    if (isForce) return true; // --force：全部重新生成（例如修正竖屏失真）
    // 远程封面（YouTube CDN）不落本地盘，statSync 必然失败，不能当成缺图。
    if (typeof v.thumbnail_path === 'string' && /^https?:\/\//i.test(v.thumbnail_path)) return false;
    // 如果有缩略图路径，检查文件是否存在
    if (v.thumbnail_path) {
      const thumbPath = v.thumbnail_path.replace(/^\/static\/thumbnails\//, '');
      const fullPath = path.join(THUMBS_DIR, thumbPath);
      try {
        require('fs').statSync(fullPath);
        return false; // 文件存在，不需要生成
      } catch {
        console.log(`⚠️  视频 ID ${v.id}: 缩略图记录存在但文件丢失 (${v.thumbnail_path})`);
        return true;
      }
    }
    return true; // 没有缩略图路径，需要生成
  });

  console.log(`🔍 发现 ${needThumbnails.length} 个视频缺少缩略图\n`);

  if (needThumbnails.length === 0) {
    console.log('✅ 所有视频都已有缩略图！');
    process.exit(0);
  }

  const toProcess = limit ? needThumbnails.slice(0, limit) : needThumbnails;

  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const video = toProcess[i];
    console.log(`\n[${i + 1}/${toProcess.length}] 处理视频 ID: ${video.id}`);
    console.log(`  标题: ${video.title}`);
    console.log(`  文件: ${video.video_path}`);

    // YouTube 视频的 video_path 是一条 URL，截不出帧。
    // 但只要后台已经下载过（local_video_path），就能拿本地副本截图。
    const source = resolveVideoSource(video);
    if (!source) {
      console.log(`  ⚠️  跳过: 找不到可截帧的本地文件 (${video.video_path})`);
      skipCount++;
      continue;
    }
    const videoFullPath = source;

    if (isDryRun) {
      console.log(`  🔍 [DRY RUN] 将生成缩略图`);
      continue;
    }

    // 生成缩略图
    const thumbnailPath = await generateThumbnail(videoFullPath, video.id);

    if (thumbnailPath) {
      // 更新数据库
      try {
        await dataStore.updateVideoResource(video.id, { thumbnail_path: thumbnailPath });
        console.log(`  💾 已更新数据库: ${thumbnailPath}`);
        successCount++;
      } catch (err) {
        console.error(`  ❌ 数据库更新失败:`, err.message);
        failCount++;
      }
    } else {
      failCount++;
    }

    // 避免过快处理导致资源问题
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 处理完成统计:');
  console.log(`  ✅ 成功: ${successCount}`);
  console.log(`  ❌ 失败: ${failCount}`);
  console.log(`  ⚠️  跳过: ${skipCount}`);
  console.log('='.repeat(60));

  process.exit(0);
}

// 运行主函数
main().catch(err => {
  console.error('💥 脚本执行出错:', err);
  process.exit(1);
});
