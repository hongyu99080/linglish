const ytdl = require('@distube/ytdl-core');
const { YoutubeTranscript } = require('@danielxceron/youtube-transcript');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { decodeHtmlEntities } = require('../utils/text-utils');
const { mergeIncompleteSegments, normalizeSegmentsTiming } = require('../utils/segment-merger');
const path = require('path');

/**
 * YouTube Service
 * Handles YouTube video information extraction, subtitle fetching
 */

// Lazy-load Innertube (ESM module) using dynamic import
let innertubePromise = null;
async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = import('youtubei.js').then(module => module.Innertube);
  }
  return innertubePromise;
}

// Configure agent with proxy if available
let agent = null;
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  agent = new HttpsProxyAgent(proxyUrl);
  console.log('[YouTube] Using proxy:', proxyUrl);
}

// Configure ytdl options
const ytdlOptions = {
  requestOptions: {
    timeout: 30000, // 30 seconds timeout
  },
  // Suppress parser warnings - these are non-critical
  // The library can still function without parsing the n-transform function
};

if (agent) {
  ytdlOptions.agent = agent;
}

// Suppress ytdl-core parser warnings (they're not critical errors)
const originalConsoleWarn = console.warn;
const suppressedWarnings = new Set();
console.warn = function(...args) {
  const message = args[0];
  if (typeof message === 'string' &&
      (message.includes('Could not parse n transform') ||
       message.includes('WARNING: Could not parse'))) {
    // Only log once to avoid spam
    if (!suppressedWarnings.has(message)) {
      suppressedWarnings.add(message);
      originalConsoleWarn('[YouTube] Parser warning (suppressed future occurrences):', message.substring(0, 100));
    }
    return;
  }
  originalConsoleWarn.apply(console, args);
};

/**
 * Extract YouTube video ID from URL
 * @param {string} url - YouTube URL
 * @returns {string|null} Video ID or null if invalid
 */
function extractVideoId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Handle various YouTube URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#/]+)/, // Shorts links
    /^([a-zA-Z0-9_-]{11})$/, // Direct video ID
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Validate YouTube URL
 * @param {string} url - YouTube URL
 * @returns {boolean} True if valid YouTube URL
 */
function isValidYouTubeUrl(url) {
  const videoId = extractVideoId(url);
  return videoId !== null && videoId.length === 11;
}

/**
 * Retry helper function
 * @param {Function} fn - Function to retry
 * @param {number} retries - Number of retries
 * @param {number} delay - Delay between retries in ms
 * @returns {Promise<any>} Result of the function
 */
async function retryWithDelay(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`[YouTube] Retry ${i + 1}/${retries} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Get YouTube video info via yt-dlp (more reliable than ytdl-core)
 * @param {string} videoId - YouTube video ID
 * @returns {Promise<Object>} Video information
 */
async function getVideoInfoViaYtDlp(videoId) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-download', '--no-warnings',
      '--js-runtimes', 'node',
      '--remote-components', 'ejs:github',
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    execFile('yt-dlp', args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr?.trim() || error.message));
      }
      try {
        const data = JSON.parse(stdout);
        resolve({
          success: true,
          videoId,
          title: data.title,
          description: data.description || '',
          duration: data.duration || 0,
          thumbnail: data.thumbnail || null,
          author: data.uploader || data.channel || 'Unknown',
          viewCount: data.view_count || 0,
        });
      } catch (e) {
        reject(new Error('Failed to parse yt-dlp output'));
      }
    });
  });
}

/**
 * Get YouTube video info
 * Tries yt-dlp first (more reliable), falls back to ytdl-core
 * @param {string} url - YouTube URL
 * @returns {Promise<Object>} Video information
 */
async function getVideoInfo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  // Try yt-dlp first
  try {
    console.log(`[YouTube] Fetching video info via yt-dlp: ${videoId}`);
    const result = await getVideoInfoViaYtDlp(videoId);
    console.log(`[YouTube] yt-dlp success: ${result.title}`);
    return result;
  } catch (ytDlpError) {
    console.log(`[YouTube] yt-dlp failed: ${ytDlpError.message}, falling back to ytdl-core`);
  }

  // Fallback to ytdl-core
  try {
    const info = await retryWithDelay(async () => {
      return await ytdl.getInfo(videoId, ytdlOptions);
    }, 3, 2000);

    const { videoDetails } = info;

    return {
      success: true,
      videoId,
      title: videoDetails.title,
      description: videoDetails.description,
      duration: parseInt(videoDetails.lengthSeconds, 10),
      thumbnail: videoDetails.thumbnails && videoDetails.thumbnails.length > 0
        ? videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url
        : null,
      author: videoDetails.author?.name || 'Unknown',
      viewCount: parseInt(videoDetails.viewCount, 10) || 0,
    };
  } catch (error) {
    console.error('[YouTube] Failed to get video info:', error.message);
    throw new Error(`Failed to fetch YouTube video info: ${error.message}`);
  }
}

/**
 * Get YouTube video transcript using youtubei.js (Innertube API)
 * This is more reliable than web scraping
 * @param {string} videoId - YouTube video ID
 * @param {string} language - Language code (default: 'en')
 * @returns {Promise<Object>} Transcript data with segments
 */
async function getTranscriptViaInnertube(videoId, language = 'en') {
  try {
    console.log(`[YouTube] Fetching transcript via Innertube API for: ${videoId}`);

    const Innertube = await getInnertube();

    // Create Innertube instance with error handling
    let youtube;
    try {
      youtube = await Innertube.create({
        lang: language || 'en',
        location: 'US',
        retrieve_player: false, // Skip player retrieval to avoid parsing errors
      });
    } catch (createError) {
      // If creation fails due to parser errors, skip and use fallback
      console.warn('[YouTube] Innertube.create failed (likely parser error):', createError.message);
      throw new Error('Innertube initialization failed');
    }

    const info = await youtube.getInfo(videoId);
    const transcriptData = await info.getTranscript();

    if (!transcriptData || !transcriptData.transcript) {
      throw new Error('No transcript data returned from Innertube API');
    }

    // Extract segments from transcript data
    const initialSegments = transcriptData.transcript.content?.body?.initial_segments;

    if (!initialSegments || !Array.isArray(initialSegments)) {
      throw new Error('No transcript segments found in response');
    }

    // Convert to our segment format
    const rawSegments = initialSegments.map((segment, index) => {
      const snippet = segment.snippet || {};
      const startMs = parseInt(snippet.start_ms, 10) || 0;
      const durationMs = parseInt(snippet.duration_ms, 10) || 0;

      return {
        index,
        text: decodeHtmlEntities(snippet.text || ''),
        start: startMs / 1000, // Convert ms to seconds
        end: (startMs + durationMs) / 1000, // Convert ms to seconds
        speaker: null,
      };
    });

    // 智能合并不完整的句子segments
    // YouTube字幕通常按固定时间间隔切分，需要合并成自然句子
    console.log(`[YouTube] Raw segments: ${rawSegments.length}, applying smart merge...`);
    const normalizedSegments = normalizeSegmentsTiming(rawSegments);
    const segments = mergeIncompleteSegments(normalizedSegments, {
      maxMergeGap: 3,           // YouTube字幕间隔较小，使用3秒
      maxSegmentDuration: 25,   // 限制单句最大长度
      minSegmentDuration: 0.8,  // 过短的segment强制合并
    });

    // Combine all text
    const fullText = segments.map(seg => seg.text).join(' ');

    console.log(`[YouTube] Successfully merged into ${segments.length} segments via Innertube`);

    return {
      success: true,
      transcript: fullText,
      segments,
      language,
      source: 'innertube',
    };
  } catch (error) {
    // Log parser-specific errors differently
    if (error.message && (error.message.includes('Unexpected token') || error.message.includes('parser'))) {
      console.warn('[YouTube] Innertube parser error (YouTube may have updated their code):', error.message);
    } else {
      console.error('[YouTube] Innertube transcript fetch failed:', error.message);
    }
    throw error;
  }
}

/**
 * Fetch a transcript by downloading YouTube's own caption track with yt-dlp,
 * then parsing the json3 caption format.
 *
 * This is the most reliable tier in practice: Innertube is prone to youtubei.js
 * parser breakage when YouTube changes their response shape, and the web-scrape
 * library is often blocked — but yt-dlp reaches caption tracks directly and is
 * already the trusted tool for video info/download elsewhere in this service.
 *
 * json3 shape: { events: [ { tStartMs, dDurationMs, segs: [ { utf8 } ] } ] }
 * Window-definition events have no `segs` and are skipped.
 *
 * @param {string} videoId - YouTube video ID
 * @param {string} language - Language code (default: 'en')
 * @returns {Promise<Object>} Transcript data with segments
 */
async function getTranscriptViaYtDlp(videoId, language = 'en') {
  const { execFile } = require('child_process');
  const fsp = require('fs/promises');
  const osMod = require('os');
  const pathMod = require('path');

  // Exact language codes only — never wildcards. YouTube exposes hundreds of
  // "translated from English" tracks (en-en-US, ab-en-US, ...) and a pattern
  // like `en.*` makes yt-dlp fetch them all, which trips YouTube's HTTP 429
  // rate limit partway through.
  const langPref = language && language !== 'auto'
    ? [...new Set([language, 'en', 'en-orig'])].join(',')
    : 'en,en-orig';
  const tmpDir = await fsp.mkdtemp(pathMod.join(osMod.tmpdir(), `linglish-subs-${videoId}-`));
  const outTemplate = pathMod.join(tmpDir, 'cap');

  const args = [
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--write-subs',        // manual/official captions (preferred)
    '--write-auto-subs',   // auto-generated captions (fallback)
    '--sub-langs', langPref,
    '--sub-format', 'json3',
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
    args.push('--proxy', process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  }

  try {
    console.log(`[YouTube] Fetching transcript via yt-dlp captions for: ${videoId}`);
    // Don't reject on a non-zero exit: yt-dlp may fail on ONE requested track
    // (e.g. a 429 on a secondary language) after having already written a
    // perfectly good one. What matters is whether a caption file landed on
    // disk, which we check next.
    const cliError = await new Promise((resolve) => {
      execFile('yt-dlp', args, { timeout: 60000 }, (error, stdout, stderr) => {
        resolve(error ? (stderr?.trim() || error.message) : null);
      });
    });

    // yt-dlp writes cap.<lang>.json3. Pick the best available track:
    // manual/official over auto, exact language over variants.
    const files = (await fsp.readdir(tmpDir)).filter(f => f.endsWith('.json3'));
    if (!files.length) {
      throw new Error(cliError || 'No caption track downloaded by yt-dlp');
    }
    if (cliError) {
      console.warn('[YouTube] yt-dlp reported an error but usable captions were written:', String(cliError).slice(0, 200));
    }
    const preferred =
      files.find(f => f.includes(`.${language}.`) && !f.includes('auto')) ||
      files.find(f => !f.includes('auto')) ||
      files[0];

    const raw = await fsp.readFile(pathMod.join(tmpDir, preferred), 'utf8');
    const data = JSON.parse(raw);
    const events = Array.isArray(data.events) ? data.events : [];

    const rawSegments = [];
    let index = 0;
    for (const ev of events) {
      if (!Array.isArray(ev.segs)) continue;
      const text = decodeHtmlEntities(ev.segs.map(s => s.utf8 || '').join('').trim());
      if (!text) continue;
      const start = (Number(ev.tStartMs) || 0) / 1000;
      const end = start + (Number(ev.dDurationMs) || 0) / 1000;
      rawSegments.push({ index: index++, text, start, end, speaker: null });
    }

    if (!rawSegments.length) {
      throw new Error('yt-dlp caption track contained no text segments');
    }

    console.log(`[YouTube] Raw segments from yt-dlp: ${rawSegments.length}, applying smart merge...`);
    const normalizedSegments = normalizeSegmentsTiming(rawSegments);
    const segments = mergeIncompleteSegments(normalizedSegments, {
      maxMergeGap: 3,
      maxSegmentDuration: 25,
      minSegmentDuration: 0.8,
    });
    const fullText = segments.map(seg => seg.text).join(' ');

    console.log(`[YouTube] Successfully merged into ${segments.length} segments via yt-dlp (${preferred})`);
    return {
      success: true,
      transcript: fullText,
      segments,
      language,
      source: 'yt-dlp',
    };
  } finally {
    // Best-effort cleanup of the temp caption dir.
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Get YouTube video transcript/subtitles
 * Tries Innertube API, then yt-dlp captions, then web scraping.
 * @param {string} url - YouTube URL
 * @param {string} language - Language code (default: 'en')
 * @returns {Promise<Object>} Transcript data with segments
 */
async function getTranscript(url, language = 'en') {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  // Try Innertube API first (more reliable for fetching transcripts)
  // Re-enabled 2024-12-02: Test if youtubei.js now works with current YouTube format
  const ENABLE_INNERTUBE = true;

  // Try Innertube API first (more reliable) - currently disabled
  if (ENABLE_INNERTUBE) {
    try {
      console.log('[YouTube] Attempting transcript fetch via Innertube API...');
      const result = await getTranscriptViaInnertube(videoId, language);
      return result;
    } catch (innertubeError) {
      console.log('[YouTube] Innertube API failed, trying yt-dlp captions:', innertubeError.message);
    }
  }

  // Tier 2: yt-dlp caption download (proven reliable behind geo/parser issues).
  try {
    const result = await getTranscriptViaYtDlp(videoId, language);
    return result;
  } catch (ytDlpError) {
    console.log('[YouTube] yt-dlp caption fetch failed, falling back to web scraping:', ytDlpError.message);
  }

  // Use web scraping method directly
  try {
    // Try multiple language options as fallback
    const languagesToTry = [
      language,                    // User-specified language
      'en',                        // English
      'en-US',                     // US English
      'en-GB',                     // British English
      null,                        // Auto-generated (no language specified)
    ];

      // Remove duplicates while preserving order
      const uniqueLanguages = [...new Set(languagesToTry)];

      let transcript = null;
      let usedLanguage = null;
      let lastError = null;

      // Try each language option until one works (with retry)
      for (const lang of uniqueLanguages) {
        try {
          console.log(`[YouTube] Trying to fetch transcript with language: ${lang || 'auto'}`);

          const options = lang ? { lang } : {};

          // Retry up to 3 times for transcript fetching
          transcript = await retryWithDelay(async () => {
            return await YoutubeTranscript.fetchTranscript(videoId, options);
          }, 3, 2000);

          if (transcript && transcript.length > 0) {
            usedLanguage = lang || 'auto';
            console.log(`[YouTube] Successfully fetched transcript with language: ${usedLanguage}`);
            break;
          }
        } catch (err) {
          lastError = err;
          console.log(`[YouTube] Failed with language ${lang || 'auto'}: ${err.message}`);
          // Continue to next language option
        }
      }

      // If no transcript found after all attempts
      if (!transcript || transcript.length === 0) {
        throw new Error('No transcript available for this video');
      }

      // Convert to our segment format
      // Note: @danielxceron/youtube-transcript returns offset and duration in SECONDS, not milliseconds
      const rawSegments = transcript.map((item, index) => ({
        index,
        text: decodeHtmlEntities(item.text), // Decode HTML entities (e.g., &amp;#39; -> ')
        start: item.offset, // Already in seconds
        end: item.offset + item.duration, // Already in seconds
        speaker: null, // YouTube doesn't provide speaker info
      }));

      // 智能合并不完整的句子segments
      // YouTube字幕通常按固定时间间隔切分，需要合并成自然句子
      console.log(`[YouTube] Raw segments from web-scraping: ${rawSegments.length}, applying smart merge...`);
      const normalizedSegments = normalizeSegmentsTiming(rawSegments);
      const segments = mergeIncompleteSegments(normalizedSegments, {
        maxMergeGap: 3,           // YouTube字幕间隔较小，使用3秒
        maxSegmentDuration: 25,   // 限制单句最大长度
        minSegmentDuration: 0.8,  // 过短的segment强制合并
      });

      // Combine all text
      const fullText = segments.map(seg => seg.text).join(' ');

      console.log(`[YouTube] Successfully merged into ${segments.length} segments via web-scraping`);

      return {
        success: true,
        transcript: fullText,
        segments,
        language: usedLanguage,
        source: 'web-scraping',
      };
    } catch (error) {
      console.error('[YouTube] Failed to get transcript:', error.message);

      // Check if it's a "no transcript" error
      if (error.message && (
        error.message.includes('Could not find transcripts') ||
        error.message.includes('No transcript available') ||
        error.message.includes('Transcript is disabled')
      )) {
        throw new Error('No transcript available for this video. Please try another video or enable captions on YouTube.');
      }

      throw new Error(`Failed to fetch YouTube transcript: ${error.message}`);
    }
}

/**
 * Get available transcript languages for a video
 * @param {string} url - YouTube URL
 * @returns {Promise<Array>} List of available language codes
 */
async function getAvailableLanguages(url) {
  try {
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    // Try to fetch transcripts for common languages
    const languages = ['en', 'zh', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'ja', 'ko'];
    const available = [];

    for (const lang of languages) {
      try {
        await YoutubeTranscript.fetchTranscript(videoId, { lang });
        available.push(lang);
      } catch (e) {
        // Language not available, continue
      }
    }

    return available;
  } catch (error) {
    console.error('[YouTube] Failed to get available languages:', error.message);
    return [];
  }
}

/**
 * Extract words from transcript text
 * @param {string} text - Transcript text
 * @returns {Array<string>} Array of unique words
 */
function extractWords(text) {
  if (!text || typeof text !== 'string') return [];

  const words = text
    .toLowerCase()
    .replace(/['']/g, "'")
    .split(/[\s\-—–]+/)
    .map(word => {
      const cleaned = word.replace(/[^a-z'-]/gi, '');
      return cleaned.replace(/^['\-]+|['\-]+$/g, '');
    })
    .filter(word => {
      return word.length >= 2 &&
             /[a-z]/i.test(word) &&
             !/^\d+$/.test(word) &&
             !/[']{2,}/.test(word);
    });

  return [...new Set(words)];
}

/**
 * Download YouTube video to local file using yt-dlp
 * yt-dlp is more reliable than ytdl-core and bypasses YouTube restrictions
 * @param {string} url - YouTube URL
 * @param {string} outputPath - Local file path to save video
 * @returns {Promise<string>} Path to downloaded video file
 */
async function downloadVideo(url, outputPath) {
  try {
    const fs = require('fs');
    const fsPromises = require('fs/promises');
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`[YouTube Download] Starting download with yt-dlp: ${videoId}`);
    console.log(`[YouTube Download] Output path: ${outputPath}`);

    // Prepare yt-dlp options
    const ytDlpOptions = {
      output: outputPath,
      format: 'bestaudio/best', // Download best audio quality
      noPlaylist: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      jsRuntimes: 'node',
      remoteComponents: 'ejs:github',
      addHeader: [
        'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ],
    };

    // Add proxy if available
    if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      ytDlpOptions.proxy = proxyUrl;
      console.log(`[YouTube Download] Using proxy: ${proxyUrl}`);
    }

    let usedDownloader = 'yt-dlp';
    try {
      // Download video using yt-dlp if available
      console.log('[YouTube Download] Executing yt-dlp...');
      const ytDlp = require('yt-dlp-exec');
      await ytDlp(url, ytDlpOptions);
    } catch (ytDlpErr) {
      console.warn('[YouTube Download] yt-dlp not available or failed:', ytDlpErr.message);

      // Attempt bundled binary if present
      const bundledBinary = path.resolve(__dirname, '..', 'bin', 'yt-dlp');
      const hasBundledBinary = fs.existsSync(bundledBinary);

      if (hasBundledBinary) {
        console.log('[YouTube Download] Trying bundled yt-dlp binary...');
        usedDownloader = 'yt-dlp-bundled';
        try {
          const { spawn } = require('child_process');
          await new Promise((resolve, reject) => {
            const args = [
              '-o', outputPath,
              '-f', 'bestaudio/best',
              '--no-playlist',
              '--no-check-certificates',
              '--prefer-free-formats',
              '--js-runtimes', 'node',
              '--remote-components', 'ejs:github',
              '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              url,
            ];
            if (ytDlpOptions.proxy) {
              args.push('--proxy', ytDlpOptions.proxy);
            }
            const proc = spawn(bundledBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            proc.stdout.on('data', (d) => console.log('[yt-dlp]', d.toString().trim()));
            proc.stderr.on('data', (d) => console.warn('[yt-dlp]', d.toString().trim()));
            proc.on('error', reject);
            proc.on('close', (code) => {
              if (code === 0) resolve();
              else reject(new Error(`yt-dlp binary exited with code ${code}`));
            });
          });
        } catch (binErr) {
          console.warn('[YouTube Download] Bundled yt-dlp failed:', binErr.message);
          usedDownloader = 'ytdl-core';
        }
      } else {
        usedDownloader = 'ytdl-core';
      }

      if (usedDownloader === 'ytdl-core') {
        console.log('[YouTube Download] Falling back to ytdl-core download');
        // Fallback: use ytdl-core to grab best audio
        const audioStream = ytdl(url, {
          filter: 'audioonly',
          quality: 'highestaudio',
          requestOptions: ytdlOptions.requestOptions,
          dlChunkSize: 0,
          highWaterMark: 1 << 25, // 32MB buffer to reduce 403 retry churn
        });

        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(outputPath);
          audioStream.pipe(writeStream);
          audioStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('finish', resolve);
        });
      }
    }

    // Verify file exists and has content
    const stats = await fsPromises.stat(outputPath);
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    console.log(`[YouTube Download] Download completed successfully via ${usedDownloader}`);
    console.log(`[YouTube Download] File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    return outputPath;
  } catch (error) {
    console.error('[YouTube Download] Error:', error.message);

    // Clean up partial file if it exists
    try {
      const fs = require('fs');
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log('[YouTube Download] Cleaned up partial download file');
      }
    } catch (cleanupError) {
      console.warn('[YouTube Download] Failed to clean up:', cleanupError.message);
    }

    throw new Error(`Video download failed: ${error.message}`);
  }
}

module.exports = {
  extractVideoId,
  isValidYouTubeUrl,
  getVideoInfo,
  getTranscript,
  getAvailableLanguages,
  extractWords,
  downloadVideo,
};
