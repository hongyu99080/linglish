const { execFile, spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * YouTube Downloader using yt-dlp
 *
 * yt-dlp is the most reliable YouTube downloader available
 * It's a fork of youtube-dl with active development and better support
 *
 * Installation:
 *   Linux: curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp
 *   Or: pip install yt-dlp
 *
 * Advantages over youtubei.js:
 *   - Works reliably from servers without complex proxy setup
 *   - Better error handling and retry logic
 *   - Supports cookies for authentication
 *   - Actively maintained with frequent updates
 *   - Works with 1000+ websites, not just YouTube
 */

// Local yt-dlp binary path (prefer local installation over system)
const YT_DLP_PATH = path.join(__dirname, '../bin/yt-dlp');
const YT_DLP_BIN = fs.existsSync(YT_DLP_PATH) ? YT_DLP_PATH : 'yt-dlp';

// Directory for storing downloaded YouTube videos
const YOUTUBE_VIDEO_DIR = path.join(__dirname, '../public/videos/youtube');

// Ensure directory exists
async function ensureYouTubeDir() {
  try {
    await fsp.mkdir(YOUTUBE_VIDEO_DIR, { recursive: true });
  } catch (err) {
    console.error('[yt-dlp] Failed to create YouTube directory:', err);
  }
}

/**
 * Check if yt-dlp is installed
 */
async function checkYtDlpInstalled() {
  try {
    const { stdout } = await execFileAsync(YT_DLP_BIN, ['--version']);
    console.log('[yt-dlp] Version:', stdout.trim());
    console.log('[yt-dlp] Binary path:', YT_DLP_BIN);
    return true;
  } catch (err) {
    console.error('[yt-dlp] Not installed or not in PATH');
    console.error('[yt-dlp] Tried path:', YT_DLP_BIN);
    return false;
  }
}

/**
 * Get video information without downloading
 */
async function getVideoInfo(videoUrl) {
  try {
    console.log('[yt-dlp] Getting video info for:', videoUrl);

    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-check-certificate', // Skip SSL verification for proxy/sandbox environments
      videoUrl,
    ];

    // Add proxy if configured
    const proxy = process.env.YOUTUBE_PROXY;
    if (proxy) {
      args.push('--proxy', proxy);
      console.log('[yt-dlp] Using proxy');
    }

    const { stdout } = await execFileAsync(YT_DLP_BIN, args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for JSON
    });

    const info = JSON.parse(stdout);

    return {
      videoId: info.id,
      title: info.title,
      description: info.description || '',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      uploader: info.uploader || '',
      uploadDate: info.upload_date || '',
      viewCount: info.view_count || 0,
      likeCount: info.like_count || 0,
    };
  } catch (err) {
    console.error('[yt-dlp] Failed to get video info:', err.message);
    throw new Error(`Failed to get video info: ${err.message}`);
  }
}

/**
 * Download YouTube video to local storage
 * @param {string} videoUrl - Full YouTube URL or video ID
 * @param {Object} options - Download options
 * @returns {Promise<Object>} Download result with local path
 */
async function downloadVideo(videoUrl, options = {}) {
  const startTime = Date.now();

  try {
    console.log('[yt-dlp] Starting download for:', videoUrl);

    // Ensure URL is complete
    if (!videoUrl.startsWith('http')) {
      videoUrl = `https://www.youtube.com/watch?v=${videoUrl}`;
    }

    await ensureYouTubeDir();

    // Get video info first
    const info = await getVideoInfo(videoUrl);
    const videoId = info.videoId;

    // Generate filename
    const timestamp = Date.now();
    const filename = `${videoId}-${timestamp}.mp4`;
    const filePath = path.join(YOUTUBE_VIDEO_DIR, filename);
    const publicPath = `/videos/youtube/${filename}`;

    console.log('[yt-dlp] Video title:', info.title);
    console.log('[yt-dlp] Duration:', info.duration, 'seconds');
    console.log('[yt-dlp] Downloading to:', filePath);

    // Build yt-dlp command
    const args = [
      // Output template
      '-o', filePath,

      // Format selection (360p or best available, mp4 preferred)
      '-f', 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best',

      // Merge to mp4
      '--merge-output-format', 'mp4',

      // No playlist
      '--no-playlist',

      // Skip SSL verification for proxy/sandbox environments
      '--no-check-certificate',

      // Retry options
      '--retries', '3',
      '--fragment-retries', '3',

      // Progress output
      '--newline',
      '--progress',

      // User agent (appear as browser)
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

      // Video URL
      videoUrl,
    ];

    // Add proxy if configured
    const proxy = process.env.YOUTUBE_PROXY;
    if (proxy) {
      args.unshift('--proxy', proxy);
      console.log('[yt-dlp] Using proxy');
    }

    // Add cookies if configured
    const cookies = process.env.YOUTUBE_COOKIES_FILE;
    if (cookies && fs.existsSync(cookies)) {
      args.unshift('--cookies', cookies);
      console.log('[yt-dlp] Using cookies file');
    }

    // Execute download with progress tracking
    await new Promise((resolve, reject) => {
      const ytdlp = spawn(YT_DLP_BIN, args);

      let lastProgress = '';

      ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        // Parse progress: [download]  45.0% of   10.50MiB at    1.23MiB/s ETA 00:07
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (progressMatch) {
          const progress = progressMatch[1];
          if (progress !== lastProgress) {
            console.log(`[yt-dlp] Progress: ${progress}%`);
            lastProgress = progress;
          }
        }
      });

      ytdlp.stderr.on('data', (data) => {
        const error = data.toString();
        // Only log significant errors, not warnings
        if (error.includes('ERROR')) {
          console.error('[yt-dlp] Error:', error.trim());
        }
      });

      ytdlp.on('error', (err) => {
        console.error('[yt-dlp] Process error:', err);
        reject(err);
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          console.log('[yt-dlp] Download completed successfully');
          resolve();
        } else {
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });
    });

    // Check file exists and get size
    const stats = await fsp.stat(filePath);
    const fileSize = stats.size;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('[yt-dlp] ✓ Download completed in', elapsed, 'seconds');
    console.log('[yt-dlp] File size:', (fileSize / 1024 / 1024).toFixed(2), 'MB');

    return {
      success: true,
      videoId,
      localPath: publicPath,
      filePath,
      fileSize,
      duration: info.duration,
      title: info.title,
      thumbnail: info.thumbnail,
    };

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error('[yt-dlp] ✗ Download failed after', elapsed, 'seconds');
    console.error('[yt-dlp] Error:', err.message);
    throw new Error(`Failed to download YouTube video: ${err.message}`);
  }
}

/**
 * Check if a video has already been downloaded
 */
async function checkExistingDownload(videoId) {
  try {
    const files = await fsp.readdir(YOUTUBE_VIDEO_DIR);
    const videoFile = files.find(f => f.startsWith(`${videoId}-`));

    if (videoFile) {
      const filePath = path.join(YOUTUBE_VIDEO_DIR, videoFile);
      const stats = await fsp.stat(filePath);

      return {
        exists: true,
        publicPath: `/videos/youtube/${videoFile}`,
        filePath,
        fileSize: stats.size,
      };
    }

    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Delete downloaded video
 */
async function deleteDownload(videoId) {
  try {
    const files = await fsp.readdir(YOUTUBE_VIDEO_DIR);
    const videoFile = files.find(f => f.startsWith(`${videoId}-`));

    if (videoFile) {
      const filePath = path.join(YOUTUBE_VIDEO_DIR, videoFile);
      await fsp.unlink(filePath);
      console.log('[yt-dlp] Deleted video:', videoFile);
      return true;
    }

    return false;
  } catch (err) {
    console.error('[yt-dlp] Failed to delete video:', err);
    return false;
  }
}

module.exports = {
  checkYtDlpInstalled,
  getVideoInfo,
  downloadVideo,
  checkExistingDownload,
  deleteDownload,
};
