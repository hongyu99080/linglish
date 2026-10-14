const http = require('http');

/**
 * IP location cache to avoid redundant API calls
 * Format: { ip: { location: '...', timestamp: ... } }
 */
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Query IP location using ip-api.com free API
 * Rate limit: 45 requests per minute
 * @param {string} ip - IP address to query
 * @returns {Promise<string>} Location string (e.g., "中国 广东 深圳" or "United States California Los Angeles")
 */
async function getIPLocation(ip) {
  // Handle special IPs
  if (!ip || ip === '-' || ip === 'unknown' || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) {
    return '本地/内网';
  }

  // Check cache first
  const cached = cache.get(ip);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.location;
  }

  try {
    // Use ip-api.com free API (45 req/min limit)
    // Documentation: https://ip-api.com/docs/api:json
    const location = await new Promise((resolve, reject) => {
      const url = `http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,country,regionName,city,message`;

      const req = http.get(url, { timeout: 5000 }, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            // Check if response is empty
            if (!data || data.trim() === '') {
              console.warn(`[IP Location] Empty response for ${ip}, using fallback`);
              resolve('未知');
              return;
            }

            const result = JSON.parse(data);

            if (result.status === 'success') {
              // Build location string from country, region, city
              const parts = [];
              if (result.country) parts.push(result.country);
              if (result.regionName && result.regionName !== result.country) parts.push(result.regionName);
              if (result.city && result.city !== result.regionName) parts.push(result.city);

              const location = parts.join(' ') || '未知';
              resolve(location);
            } else {
              // API returned error
              console.warn(`[IP Location] API error for ${ip}: ${result.message || 'Unknown error'}`);
              resolve('未知');
            }
          } catch (e) {
            // Log the actual data received for debugging
            console.warn(`[IP Location] JSON parse error for ${ip} (received ${data.length} bytes): ${e.message}`);
            resolve('未知');
          }
        });
      });

      req.on('error', (e) => {
        console.error(`[IP Location] Request failed for ${ip}:`, e.message);
        resolve('未知');
      });

      req.on('timeout', () => {
        req.destroy();
        console.warn(`[IP Location] Request timeout for ${ip}`);
        resolve('未知');
      });
    });

    // Cache the result
    cache.set(ip, {
      location,
      timestamp: Date.now()
    });

    return location;
  } catch (e) {
    console.error(`[IP Location] Unexpected error for ${ip}:`, e);
    return '未知';
  }
}

/**
 * Query multiple IPs in batch with rate limiting
 * @param {string[]} ips - Array of IP addresses
 * @param {number} delayMs - Delay between requests in milliseconds (default: 100ms, much faster while still respecting rate limits)
 * @param {number} maxConcurrent - Maximum number of IPs to query (default: 30, limits total time)
 * @returns {Promise<Map<string, string>>} Map of IP to location
 */
async function getIPLocationsBatch(ips, delayMs = 100, maxConcurrent = 30) {
  const results = new Map();
  const uniqueIps = [...new Set(ips)]; // Remove duplicates

  // Limit the number of IPs to query to avoid long delays
  const ipsToQuery = uniqueIps.slice(0, maxConcurrent);

  // For remaining IPs, return '查询中...' to indicate they're being skipped
  for (let i = maxConcurrent; i < uniqueIps.length; i++) {
    results.set(uniqueIps[i], '未查询');
  }

  for (let i = 0; i < ipsToQuery.length; i++) {
    const ip = ipsToQuery[i];
    const location = await getIPLocation(ip);
    results.set(ip, location);

    // Add delay to respect rate limits (except for last one)
    // With 100ms delay, we can query ~10 IPs per second, well under 45/min limit
    if (i < ipsToQuery.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Clear old cache entries
 */
function cleanCache() {
  const now = Date.now();
  for (const [ip, data] of cache.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      cache.delete(ip);
    }
  }
}

// Clean cache every hour without keeping short-lived workers alive.
setInterval(cleanCache, 60 * 60 * 1000).unref();

module.exports = {
  getIPLocation,
  getIPLocationsBatch,
};
