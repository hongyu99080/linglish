const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');

// Try to configure FFmpeg (same as in server.js)
let ffmpegAvailable = false;
try {
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
  console.warn('FFmpeg installer not available, audio transcoding disabled.');
}

/**
 * Check if audio format should be transcoded to MP4
 */
function shouldTranscodeToMp4Audio(extension) {
  const lower = (extension || '').toLowerCase();
  return ffmpegAvailable && ['webm', 'ogg', 'wav'].includes(lower);
}

/**
 * Transcode audio to MP4/AAC format
 */
function transcodeToMp4Audio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('aac')
      .format('mp4')
      .outputOptions(['-movflags', 'faststart'])
      .on('error', (err) => reject(err))
      .on('end', () => resolve())
      .save(outputPath);
  });
}

/**
 * Convert audio to WAV format for speech processing
 */
async function convertAudioToWav(inputPath, sampleRate = 16000) {
  const tmpFile = path.join(
    os.tmpdir(),
    `linglish-practice-${Date.now()}-${randomBytes(6).toString('hex')}.wav`,
  );

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(sampleRate)
      .format('wav')
      .audioCodec('pcm_s16le')  // 使用标准PCM编码，避免音频截断
      .on('error', reject)
      .on('end', resolve)
      .save(tmpFile);
  });

  return tmpFile;
}

module.exports = {
  ffmpegAvailable,
  shouldTranscodeToMp4Audio,
  transcodeToMp4Audio,
  convertAudioToWav,
};
