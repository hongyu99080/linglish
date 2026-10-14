const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/**
 * YouTube Downloader Service
 * Downloads YouTube videos to local storage for mainland China users
 * Uses youtubei.js (YouTube's InnerTube API)
 */

// Lazy-load Innertube (ESM module) using dynamic import
let innertubePromise = null;
async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = import('youtubei.js').then(module => module.Innertube);
  }
  return innertubePromise;
}

// Proxy configuration
let proxyAgent = null;
function getProxyAgent() {
  if (proxyAgent !== null) {
    return proxyAgent; // Return cached agent (could be undefined if no proxy)
  }

  // Priority 1: Check for explicit YOUTUBE_PROXY setting
  const youtubeProxy = process.env.YOUTUBE_PROXY;

  // Explicitly disabled?
  if (youtubeProxy === '' || youtubeProxy === 'false' || youtubeProxy === 'none') {
    console.log('[YouTube Downloader] Proxy explicitly disabled via YOUTUBE_PROXY');
    proxyAgent = undefined;
    return undefined;
  }

  // If YOUTUBE_PROXY is set, use it
  if (youtubeProxy) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      proxyAgent = new HttpsProxyAgent(youtubeProxy);
      console.log('[YouTube Downloader] Using YouTube proxy:', youtubeProxy.replace(/\/\/.*:.*@/, '//***:***@')); // Hide credentials
      return proxyAgent;
    } catch (err) {
      console.warn('[YouTube Downloader] Failed to create proxy agent:', err.message);
      proxyAgent = undefined;
      return undefined;
    }
  }

  // Priority 2: Detect Claude Code environment (development/testing)
  // Claude Code sets GLOBAL_AGENT_HTTP_PROXY and CCR_TEST_GITPROXY
  const isClaudeCodeEnv = process.env.CCR_TEST_GITPROXY === '1' ||
                          process.env.GLOBAL_AGENT_HTTP_PROXY;

  if (isClaudeCodeEnv) {
    // In Claude Code environment, use system proxy (required for network access)
    const systemProxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
                       process.env.HTTP_PROXY || process.env.http_proxy;

    if (systemProxy) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        proxyAgent = new HttpsProxyAgent(systemProxy);
        console.log('[YouTube Downloader] Claude Code environment detected, using system proxy');
        return proxyAgent;
      } catch (err) {
        console.warn('[YouTube Downloader] Failed to create system proxy agent:', err.message);
      }
    }
  }

  // Priority 3: Production server - use direct connection
  console.log('[YouTube Downloader] Using direct connection (production mode)');
  proxyAgent = undefined;
  return undefined;
}

// Directory for storing downloaded YouTube videos
const YOUTUBE_VIDEO_DIR = path.join(__dirname, '../public/videos/youtube');

// Ensure directory exists
async function ensureYouTubeDir() {
  try {
    await fsp.mkdir(YOUTUBE_VIDEO_DIR, { recursive: true });
  } catch (err) {
    console.error('[YouTube Downloader] Failed to create YouTube directory:', err);
  }
}

/**
 * Download YouTube video to local storage
 * @param {string} videoId - YouTube video ID (11 characters)
 * @param {Object} options - Download options
 * @returns {Promise<Object>} Download result with local path
 */
async function downloadVideo(videoId, options = {}) {
  const startTime = Date.now();

  try {
    console.log('[YouTube Downloader] Starting download for video:', videoId);

    await ensureYouTubeDir();

    // Generate filename
    const filename = `${videoId}-${Date.now()}.mp4`;
    const filePath = path.join(YOUTUBE_VIDEO_DIR, filename);
    const publicPath = `/videos/youtube/${filename}`;

    // Initialize Innertube client
    console.log('[YouTube Downloader] Initializing YouTube client...');
    const Innertube = await getInnertube();

    // Configure client options with browser-like headers
    const clientOptions = {
      cache: undefined, // Disable caching for better reliability
      cookie: process.env.YOUTUBE_COOKIES || undefined,
      // Add custom fetch to set browser-like headers
      fetch: async (input, init = {}) => {
        const opts = { ...init };

        // Add browser-like headers to avoid detection
        if (!opts.headers) {
          opts.headers = {};
        }

        // Set User-Agent to look like a real browser
        if (!opts.headers['User-Agent']) {
          opts.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        }

        // Add other browser headers
        if (!opts.headers['Accept-Language']) {
          opts.headers['Accept-Language'] = 'en-US,en;q=0.9';
        }

        // Add proxy agent if configured
        const agent = getProxyAgent();
        if (agent) {
          opts.dispatcher = agent; // For undici-based fetch
        }

        return fetch(input, opts);
      },
    };

    const youtube = await Innertube.create(clientOptions);

    // Get video info
    console.log('[YouTube Downloader] Fetching video info...');
    const videoInfo = await youtube.getInfo(videoId);

    console.log('[YouTube Downloader] Video title:', videoInfo.basic_info.title);
    console.log('[YouTube Downloader] Duration:', videoInfo.basic_info.duration, 'seconds');

    // Check if video is available
    if (videoInfo.playability_status?.status === 'ERROR') {
      throw new Error(`Video unavailable: ${videoInfo.playability_status.reason || 'Unknown reason'}`);
    }

    // Select format - prefer 360p or 480p for compatibility
    // youtubei.js provides streaming_data with formats array
    const formats = videoInfo.streaming_data?.formats || [];
    const adaptiveFormats = videoInfo.streaming_data?.adaptive_formats || [];
    const allFormats = [...formats, ...adaptiveFormats];

    if (allFormats.length === 0) {
      throw new Error('No video formats available');
    }

    // Find a good quality format with both video and audio (itag 18 = 360p)
    let selectedFormat = allFormats.find(f => f.itag === 18) || // 360p with audio
                        allFormats.find(f => f.itag === 22) || // 720p with audio
                        formats[0]; // Fallback to first available

    if (!selectedFormat) {
      throw new Error('No suitable video format found');
    }

    console.log('[YouTube Downloader] Selected format:', selectedFormat.quality_label || selectedFormat.quality);
    console.log('[YouTube Downloader] Container:', selectedFormat.mime_type?.split(';')[0] || 'unknown');

    // Download video using the download method
    console.log('[YouTube Downloader] Starting download...');

    // Create write stream
    const writeStream = fs.createWriteStream(filePath);
    let downloadedBytes = 0;
    let lastLogTime = Date.now();

    // Download the video - youtubei.js provides a download method
    const stream = await videoInfo.download({
      type: 'video+audio', // Get video with audio
      quality: '360p', // Prefer 360p for better compatibility
      format: 'mp4', // MP4 container
    });

    // Pipe to file
    stream.pipe(writeStream);

    // Track progress
    stream.on('data', (chunk) => {
      downloadedBytes += chunk.length;

      const now = Date.now();
      if (now - lastLogTime > 5000) {
        const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(2);
        console.log(`[YouTube Downloader] Downloaded: ${downloadedMB} MB`);
        lastLogTime = now;
      }
    });

    return new Promise((resolve, reject) => {
      stream.on('error', (error) => {
        console.error('[YouTube Downloader] Stream error:', error);
        writeStream.destroy();

        // Clean up partial file
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            console.error('[YouTube Downloader] Failed to clean up partial file:', unlinkErr);
          }
        });

        reject(error);
      });

      writeStream.on('error', (error) => {
        console.error('[YouTube Downloader] Write stream error:', error);
        stream.destroy();

        // Clean up partial file
        fs.unlink(filePath, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            console.error('[YouTube Downloader] Failed to clean up partial file:', unlinkErr);
          }
        });

        reject(error);
      });

      writeStream.on('finish', async () => {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        const fileSizeMB = (downloadedBytes / 1024 / 1024).toFixed(2);

        console.log('[YouTube Downloader] ✓ Download completed');
        console.log('[YouTube Downloader] Duration:', duration, 'seconds');
        console.log('[YouTube Downloader] File size:', fileSizeMB, 'MB');
        console.log('[YouTube Downloader] File path:', filePath);

        // Get file stats
        try {
          const stats = await fsp.stat(filePath);

          resolve({
            success: true,
            localPath: publicPath,
            absolutePath: filePath,
            fileSize: stats.size,
            duration: parseInt(videoInfo.basic_info.duration, 10) || 0,
            title: videoInfo.basic_info.title || 'Unknown',
            downloadDuration: parseFloat(duration),
          });
        } catch (err) {
          console.error('[YouTube Downloader] Failed to get file stats:', err);
          reject(err);
        }
      });
    });
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error('[YouTube Downloader] ✗ Download failed after', duration, 'seconds');
    console.error('[YouTube Downloader] Error:', error.message);
    if (error.stack) {
      console.error('[YouTube Downloader] Stack:', error.stack);
    }

    throw new Error(`Failed to download YouTube video: ${error.message}`);
  }
}

/**
 * Check if video is already downloaded
 * @param {string} videoId - YouTube video ID
 * @returns {Promise<string|null>} Local path if exists, null otherwise
 */
async function checkExistingDownload(videoId) {
  try {
    await ensureYouTubeDir();

    const files = await fsp.readdir(YOUTUBE_VIDEO_DIR);
    const matchingFile = files.find(file => file.startsWith(videoId));

    if (matchingFile) {
      const filePath = path.join(YOUTUBE_VIDEO_DIR, matchingFile);
      const stats = await fsp.stat(filePath);

      // Check if file is not empty
      if (stats.size > 0) {
        return `/videos/youtube/${matchingFile}`;
      }
    }

    return null;
  } catch (err) {
    console.error('[YouTube Downloader] Error checking existing download:', err);
    return null;
  }
}

/**
 * Delete downloaded video file
 * @param {string} localPath - Local video path (e.g., /videos/youtube/xxx.mp4)
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteDownload(localPath) {
  try {
    if (!localPath || !localPath.includes('/videos/youtube/')) {
      console.warn('[YouTube Downloader] Invalid local path:', localPath);
      return false;
    }

    const filename = localPath.replace('/videos/youtube/', '');
    const filePath = path.join(YOUTUBE_VIDEO_DIR, filename);

    await fsp.unlink(filePath);
    console.log('[YouTube Downloader] Deleted file:', filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[YouTube Downloader] File already deleted:', localPath);
      return true;
    }

    console.error('[YouTube Downloader] Failed to delete file:', err);
    return false;
  }
}

module.exports = {
  downloadVideo,
  checkExistingDownload,
  deleteDownload,
};
