/**
 * YouTube Proxy Routes
 * Proxies YouTube content for users in mainland China via Invidious
 * Non-China users are redirected directly to YouTube
 */

const https = require('https');
const { URL } = require('url');
const geoIPService = require('../services/geo-ip');

/**
 * Send JSON response
 */
function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) {
    console.warn('[YouTube Proxy] Attempted to send response after stream closed');
    return false;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });
  res.end(JSON.stringify(payload));
  return true;
}

/**
 * Send error response
 */
function sendError(res, status, message) {
  return sendJson(res, status, { success: false, error: message });
}

/**
 * GET /youtube-proxy/check - Check if user is in China and needs proxy
 */
async function checkGeoLocation(req, res) {
  try {
    const geoInfo = await geoIPService.isRequestFromChina(req);

    return sendJson(res, 200, {
      success: true,
      needsProxy: geoInfo.isChina,
      country: geoInfo.country,
      countryCode: geoInfo.countryCode,
    });
  } catch (error) {
    console.error('[YouTube Proxy] Check geo location error:', error);
    return sendError(res, 500, error.message);
  }
}

/**
 * GET /youtube-proxy/embed/:videoId - Proxy YouTube embed iframe
 * Returns an HTML page that embeds YouTube video through Invidious or direct proxy
 */
async function proxyEmbed(req, res, videoId) {
  try {
    // Check if user is from China
    const geoInfo = await geoIPService.isRequestFromChina(req);

    if (!geoInfo.isChina) {
      // Not from China, redirect to YouTube directly
      res.writeHead(302, {
        'Location': `https://www.youtube.com/embed/${videoId}`,
      });
      res.end();
      return true;
    }

    // Use server-side video proxy with HTML5 video player
    // Server will try direct access first, then fallback to proxy if configured
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Video Player</title>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .loading {
      color: #fff;
      padding: 20px;
      text-align: center;
      font-family: Arial, sans-serif;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }
    .error {
      color: #fff;
      padding: 20px;
      text-align: center;
      font-family: Arial, sans-serif;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 80%;
      max-width: 500px;
    }
    .error a {
      color: #4a9eff;
    }
  </style>
</head>
<body>
  <div class="loading" id="loading">正在加载视频...</div>
  <video
    id="player"
    controls
    controlsList="nodownload"
    style="display:none;"
    preload="metadata"
  ></video>
  <script>
    const videoId = '${videoId}';
    const loading = document.getElementById('loading');
    const player = document.getElementById('player');

    async function loadVideo() {
      try {
        loading.textContent = '正在获取视频信息...';
        console.log('[Proxy Player] Fetching video info for:', videoId);

        // Fetch video info from server (server proxies Invidious API)
        const response = await fetch('/youtube-proxy/video-info/' + videoId);
        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || 'Failed to fetch video info');
        }

        const videoInfo = result.data;
        console.log('[Proxy Player] Video info:', videoInfo.title);

        // Find best quality stream
        // Prefer formatStreams (combined audio+video) for simplicity
        let streamUrl = null;

        if (videoInfo.formatStreams && videoInfo.formatStreams.length > 0) {
          // Sort by quality (prefer 720p or 480p)
          const streams = videoInfo.formatStreams
            .filter(s => s.url && (s.qualityLabel === '720p' || s.qualityLabel === '480p' || s.qualityLabel === '360p'))
            .sort((a, b) => {
              const qualityOrder = { '720p': 3, '480p': 2, '360p': 1 };
              return (qualityOrder[b.qualityLabel] || 0) - (qualityOrder[a.qualityLabel] || 0);
            });

          if (streams.length > 0) {
            streamUrl = streams[0].url;
            console.log('[Proxy Player] Using format stream:', streams[0].qualityLabel, streams[0].type);
          }
        }

        // Fallback to HLS if available
        if (!streamUrl && videoInfo.hlsUrl) {
          streamUrl = videoInfo.hlsUrl;
          console.log('[Proxy Player] Using HLS stream');
        }

        if (!streamUrl) {
          throw new Error('No compatible video stream found');
        }

        loading.textContent = '正在加载视频流...';

        // Use server proxy to stream the video
        const proxyStreamUrl = '/youtube-proxy/stream/' + videoId + '?url=' + encodeURIComponent(streamUrl);
        player.src = proxyStreamUrl;

        // Show player when ready
        player.addEventListener('loadedmetadata', () => {
          console.log('[Proxy Player] Video loaded, duration:', player.duration);
          loading.style.display = 'none';
          player.style.display = 'block';
        });

        player.addEventListener('error', (e) => {
          console.error('[Proxy Player] Video error:', e);
          showError('视频加载失败，请刷新重试');
        });

      } catch (error) {
        console.error('[Proxy Player] Error:', error);
        showError(error.message);
      }
    }

    function showError(message) {
      loading.innerHTML = '<div class="error"><p>⚠️ 视频加载失败</p><p style="font-size:14px;margin:10px 0;color:#aaa;">' + message + '</p><p>解决方案：</p><ul style="text-align:left;font-size:14px;line-height:1.8;"><li>🔄 刷新页面重试</li><li>🌐 <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" style="color:#4a9eff;">在YouTube上观看</a></li><li>🔓 确保网络连接正常</li></ul></div>';
    }

    // Start loading
    loadVideo();
  </script>
</body>
</html>`;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(html);
    return true;
  } catch (error) {
    console.error('[YouTube Proxy] Embed proxy error:', error);
    return sendError(res, 500, error.message);
  }
}

/**
 * GET /youtube-proxy/invidious/:videoId - Proxy Invidious embed page through server
 * NOTE: DEPRECATED - This endpoint is no longer supported
 * Use /youtube-proxy/embed/:videoId instead
 */
async function proxyInvidiousEmbed(req, res, videoId, instanceHost) {
  return sendError(res, 410, 'This endpoint is deprecated. Use /youtube-proxy/embed/:videoId instead');
}

/**
 * GET /youtube-proxy/resource - Proxy any resource through server
 * NOTE: DEPRECATED - This endpoint is no longer supported
 */
async function proxyResource(req, res, url) {
  return sendError(res, 410, 'This endpoint is deprecated');
}

/**
 * GET /youtube-proxy/api-script - Proxy YouTube IFrame API script
 * NOTE: DEPRECATED - Use Invidious embed instead which doesn't require YouTube API
 */
async function proxyAPIScript(req, res) {
  try {
    // Check if user is from China
    const geoInfo = await geoIPService.isRequestFromChina(req);

    if (!geoInfo.isChina) {
      // Not from China, redirect to YouTube directly
      res.writeHead(302, {
        'Location': 'https://www.youtube.com/iframe_api',
      });
      res.end();
      return true;
    }

    // For China users, this endpoint is no longer supported
    // They should use /youtube-proxy/embed/:videoId which uses Invidious
    return sendError(res, 410, 'This endpoint is deprecated. Use /youtube-proxy/embed/:videoId instead');
  } catch (error) {
    console.error('[YouTube Proxy] API script error:', error);
    return sendError(res, 500, error.message);
  }
}

/**
 * GET /youtube-proxy/player-config/:videoId - Get Invidious player config
 */
async function getPlayerConfig(req, res, videoId) {
  try {
    const geoInfo = await geoIPService.isRequestFromChina(req);

    // Return player configuration
    const config = {
      needsProxy: geoInfo.isChina,
      videoId,
      invidiousInstances: [
        'invidious.nerdvpn.de',  // Highest uptime (99.2%)
        'inv.perditum.com',      // Very reliable (99.0%)
        'invidious.f5.si',       // Good (94.6%), Cloudflare protected
        'yewtu.be',              // Official instance (92.0%)
        'inv.nadeko.net',        // Official instance (98.5%), has CAPTCHA
      ],
      embedUrl: geoInfo.isChina
        ? `/youtube-proxy/embed/${videoId}`
        : `https://www.youtube.com/embed/${videoId}`,
    };

    return sendJson(res, 200, {
      success: true,
      config,
    });
  } catch (error) {
    console.error('[YouTube Proxy] Player config error:', error);
    return sendError(res, 500, error.message);
  }
}

/**
 * GET /youtube-proxy/video-info/:videoId - Get video info from Invidious
 * Fetches video metadata including available stream URLs
 */
async function getVideoInfo(req, res, videoId) {
  try {
    const instances = [
      'invidious.nerdvpn.de',
      'inv.perditum.com',
      'invidious.f5.si',
      'yewtu.be',
      'inv.nadeko.net',
    ];

    // Try each Invidious instance until one succeeds
    for (const instance of instances) {
      try {
        console.log(`[YouTube Proxy] Fetching video info from ${instance}...`);
        const apiUrl = `https://${instance}/api/v1/videos/${videoId}`;

        const videoInfo = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Request timeout'));
          }, 8000);

          https.get(apiUrl, {
            timeout: 8000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json',
            },
          }, (proxyRes) => {
            clearTimeout(timeout);

            if (proxyRes.statusCode !== 200) {
              reject(new Error(`HTTP ${proxyRes.statusCode}`));
              return;
            }

            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error('Invalid JSON response'));
              }
            });
          }).on('error', reject).on('timeout', () => reject(new Error('Request timeout')));
        });

        console.log(`[YouTube Proxy] ✓ Successfully fetched video info from ${instance}`);

        // Return video info with stream URLs
        return sendJson(res, 200, {
          success: true,
          data: {
            videoId,
            title: videoInfo.title,
            author: videoInfo.author,
            lengthSeconds: videoInfo.lengthSeconds,
            adaptiveFormats: videoInfo.adaptiveFormats,
            formatStreams: videoInfo.formatStreams,
            hlsUrl: videoInfo.hlsUrl,
            instance,
          },
        });
      } catch (error) {
        console.warn(`[YouTube Proxy] Failed to fetch from ${instance}:`, error.message);
        // Continue to next instance
        continue;
      }
    }

    return sendError(res, 502, 'All Invidious instances failed');
  } catch (error) {
    console.error('[YouTube Proxy] Video info error:', error);
    return sendError(res, 500, error.message);
  }
}

/**
 * GET /youtube-proxy/stream/:videoId - Stream video through server proxy
 * Proxies video stream from Invidious/YouTube to client
 */
async function streamVideo(req, res, videoId) {
  try {
    res.disableCompression = true;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const streamUrl = url.searchParams.get('url');
    const itag = url.searchParams.get('itag');

    if (!streamUrl) {
      return sendError(res, 400, 'Missing stream URL parameter');
    }

    console.log(`[YouTube Proxy] Streaming video: ${videoId}`);

    const parsedUrl = new URL(streamUrl);

    // Helper function to create stream request with redirect handling
    const createStreamRequest = (targetUrl, redirectCount = 0) => {
      // Prevent infinite redirect loops
      if (redirectCount > 5) {
        console.error('[YouTube Proxy] Too many redirects');
        return Promise.resolve(sendError(res, 502, 'Too many redirects while fetching stream'));
      }

      const currentUrl = new URL(targetUrl);
      const options = {
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Range': req.headers.range || 'bytes=0-',
          'Referer': currentUrl.origin,
        },
      };

      return new Promise((resolve) => {
        const proxyReq = https.get(targetUrl, options, (proxyRes) => {
          console.log(`[YouTube Proxy] Stream response status: ${proxyRes.statusCode}`);

          // Handle redirects (301, 302, 303, 307, 308)
          if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            const redirectUrl = proxyRes.headers.location;
            console.log(`[YouTube Proxy] Following redirect to: ${redirectUrl.substring(0, 100)}...`);

            // Consume the response to prevent memory leaks
            proxyRes.resume();

            // Follow the redirect
            resolve(createStreamRequest(redirectUrl, redirectCount + 1));
            return;
          }

          // Only stream if we get a success status
          if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 206) {
            console.error(`[YouTube Proxy] Unexpected status code: ${proxyRes.statusCode}`);
            proxyRes.resume();
            if (!res.headersSent) {
              sendError(res, proxyRes.statusCode, `Stream returned status ${proxyRes.statusCode}`);
              resolve(false);
            } else {
              resolve(false);
            }
            return;
          }

          // Forward headers
          const headers = {
            'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
            'Access-Control-Allow-Headers': 'Range',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
          };

          if (proxyRes.headers['content-length']) {
            headers['Content-Length'] = proxyRes.headers['content-length'];
          }
          if (proxyRes.headers['content-range']) {
            headers['Content-Range'] = proxyRes.headers['content-range'];
          }
          if (proxyRes.headers['accept-ranges']) {
            headers['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
          }

          res.writeHead(proxyRes.statusCode, headers);

          // Pipe the stream
          proxyRes.pipe(res);

          proxyRes.on('end', () => {
            console.log(`[YouTube Proxy] Stream completed for ${videoId}`);
            resolve(true);
          });

          proxyRes.on('error', (error) => {
            console.error(`[YouTube Proxy] Stream error:`, error);
            if (!res.headersSent) {
              sendError(res, 502, 'Stream error');
            }
            resolve(false);
          });
        });

        proxyReq.on('error', (error) => {
          console.error(`[YouTube Proxy] Stream request error:`, error);
          if (!res.headersSent) {
            sendError(res, 502, 'Failed to fetch stream');
            resolve(false);
          } else {
            resolve(false);
          }
        });

        proxyReq.on('timeout', () => {
          proxyReq.destroy();
          if (!res.headersSent) {
            sendError(res, 504, 'Stream request timeout');
            resolve(false);
          } else {
            resolve(false);
          }
        });
      });
    };

    // Stream the video
    return await createStreamRequest(streamUrl);
  } catch (error) {
    console.error('[YouTube Proxy] Stream error:', error);
    return sendError(res, 500, error.message);
  }
}

/**
 * Register YouTube proxy routes
 */
async function registerYouTubeProxyRoutes(pathname, req, res) {
  // Parse URL to get query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryParams = url.searchParams;

  // GET /youtube-proxy/check - Check if user needs proxy
  if (pathname === '/youtube-proxy/check' && req.method === 'GET') {
    return await checkGeoLocation(req, res);
  }

  // GET /youtube-proxy/embed/:videoId - Proxy YouTube embed
  const embedMatch = pathname.match(/^\/youtube-proxy\/embed\/([a-zA-Z0-9_-]+)$/);
  if (embedMatch && req.method === 'GET') {
    const videoId = embedMatch[1];
    return await proxyEmbed(req, res, videoId);
  }

  // GET /youtube-proxy/invidious/:videoId - Proxy Invidious embed
  const invidiousMatch = pathname.match(/^\/youtube-proxy\/invidious\/([a-zA-Z0-9_-]+)$/);
  if (invidiousMatch && req.method === 'GET') {
    const videoId = invidiousMatch[1];
    const instanceHost = queryParams.get('instance') || 'invidious.jing.rocks';
    return await proxyInvidiousEmbed(req, res, videoId, instanceHost);
  }

  // GET /youtube-proxy/resource - Proxy any resource
  if (pathname === '/youtube-proxy/resource' && req.method === 'GET') {
    const resourceUrl = queryParams.get('url');
    if (resourceUrl) {
      return await proxyResource(req, res, resourceUrl);
    }
    return sendError(res, 400, 'Missing url parameter');
  }

  // GET /youtube-proxy/api-script - Proxy YouTube IFrame API script
  if (pathname === '/youtube-proxy/api-script' && req.method === 'GET') {
    return await proxyAPIScript(req, res);
  }

  // GET /youtube-proxy/player-config/:videoId - Get player config
  const configMatch = pathname.match(/^\/youtube-proxy\/player-config\/([a-zA-Z0-9_-]+)$/);
  if (configMatch && req.method === 'GET') {
    const videoId = configMatch[1];
    return await getPlayerConfig(req, res, videoId);
  }

  // GET /youtube-proxy/video-info/:videoId - Get video info from Invidious
  const videoInfoMatch = pathname.match(/^\/youtube-proxy\/video-info\/([a-zA-Z0-9_-]+)$/);
  if (videoInfoMatch && req.method === 'GET') {
    const videoId = videoInfoMatch[1];
    return await getVideoInfo(req, res, videoId);
  }

  // GET /youtube-proxy/stream/:videoId - Stream video through server
  const streamMatch = pathname.match(/^\/youtube-proxy\/stream\/([a-zA-Z0-9_-]+)$/);
  if (streamMatch && req.method === 'GET') {
    const videoId = streamMatch[1];
    return await streamVideo(req, res, videoId);
  }

  return false;
}

module.exports = {
  registerYouTubeProxyRoutes,
  checkGeoLocation,
  proxyEmbed,
  proxyInvidiousEmbed,
  proxyResource,
  proxyAPIScript,
  getPlayerConfig,
  getVideoInfo,
  streamVideo,
};
