#!/usr/bin/env node
/**
 * Script to fix missing video durations by extracting them using ffprobe
 * Usage: node app/backend/scripts/fix-video-durations.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const ffmpeg = require('fluent-ffmpeg');

// Configure ffmpeg and ffprobe
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller?.path) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  }
  const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
  if (ffprobeInstaller?.path) {
    ffmpeg.setFfprobePath(ffprobeInstaller.path);
  }
} catch (err) {
  console.warn('FFmpeg/FFprobe installer not available:', err.message);
  if (process.env.FFPROBE_PATH) {
    ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
  }
}

const dataStore = require('../data-store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Extract video duration using ffprobe
 */
async function extractDuration(videoPath) {
  const absolutePath = path.join(PUBLIC_DIR, videoPath.startsWith('/') ? videoPath.slice(1) : videoPath);

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(absolutePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const duration = metadata?.format?.duration;
        if (duration && Number.isFinite(Number(duration))) {
          const durationSeconds = Math.round(Number(duration));
          resolve(durationSeconds);
        } else {
          resolve(null);
        }
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

/**
 * Main function to fix all videos with missing durations
 */
async function fixAllVideoDurations() {
  console.log('🔍 Fetching all videos...');

  try {
    const videos = await dataStore.listVideoResources();
    console.log(`📹 Found ${videos.length} videos in database`);

    const videosNeedingFix = videos.filter(v => !v.duration_sec || v.duration_sec === 0);
    console.log(`⚠️  ${videosNeedingFix.length} videos need duration fix`);

    if (videosNeedingFix.length === 0) {
      console.log('✅ All videos already have valid durations!');
      return;
    }

    let fixed = 0;
    let failed = 0;

    for (const video of videosNeedingFix) {
      try {
        console.log(`\n📝 Processing video #${video.id}: "${video.title}"`);
        console.log(`   Path: ${video.video_path}`);

        const duration = await extractDuration(video.video_path);

        if (duration !== null) {
          await dataStore.updateVideoResource(video.id, {
            duration_sec: duration
          });
          console.log(`   ✅ Updated duration: ${duration} seconds`);
          fixed++;
        } else {
          console.log(`   ⚠️  Could not extract duration from video file`);
          failed++;
        }
      } catch (err) {
        console.error(`   ❌ Failed to process video #${video.id}: ${err.message}`);
        failed++;
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 Summary:');
    console.log(`   Total videos processed: ${videosNeedingFix.length}`);
    console.log(`   ✅ Successfully fixed: ${fixed}`);
    console.log(`   ❌ Failed: ${failed}`);
    console.log('='.repeat(50));

  } catch (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  fixAllVideoDurations()
    .then(() => {
      console.log('\n✨ Done!');
      process.exit(0);
    })
    .catch(err => {
      console.error('\n❌ Script failed:', err);
      process.exit(1);
    });
}

module.exports = { fixAllVideoDurations, extractDuration };
