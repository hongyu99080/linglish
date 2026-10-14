/**
 * Test Invidious instances to find working ones
 */

const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Get proxy from environment
const PROXY = process.env.OPENAI_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

// Official Invidious instances from https://docs.invidious.io/instances/
const instances = [
  'yewtu.be',
  'inv.nadeko.net',
  'invidious.f5.si',
  'invidious.nerdvpn.de',
  'inv.perditum.com',
  // Older instances (may not work)
  'invidious.jing.rocks',
  'invidious.private.coffee',
  'invidious.io.lol',
  'yt.artemislena.eu',
  'invidious.fdn.fr',
  'inv.tux.pizza',
];

// Test video ID
const TEST_VIDEO_ID = 'HFRd1RAJqpk';

/**
 * Test a single Invidious instance
 */
function testInstance(instanceHost) {
  return new Promise((resolve) => {
    const url = `https://${instanceHost}/embed/${TEST_VIDEO_ID}`;
    const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

    console.log(`Testing ${instanceHost}...`);

    const startTime = Date.now();
    const req = https.get(url, {
      agent,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, (res) => {
      const responseTime = Date.now() - startTime;

      if (res.statusCode === 200) {
        console.log(`✓ ${instanceHost} - OK (${responseTime}ms)`);
        resolve({ host: instanceHost, status: 'ok', responseTime, statusCode: 200 });
      } else {
        console.log(`✗ ${instanceHost} - HTTP ${res.statusCode} (${responseTime}ms)`);
        resolve({ host: instanceHost, status: 'error', responseTime, statusCode: res.statusCode });
      }

      // Consume response to free up memory
      res.resume();
    });

    req.on('error', (error) => {
      const responseTime = Date.now() - startTime;
      console.log(`✗ ${instanceHost} - ${error.message} (${responseTime}ms)`);
      resolve({ host: instanceHost, status: 'error', responseTime, error: error.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.log(`✗ ${instanceHost} - Timeout`);
      resolve({ host: instanceHost, status: 'timeout', responseTime: 10000 });
    });
  });
}

/**
 * Test all instances
 */
async function testAllInstances() {
  console.log('Testing Invidious instances...\n');
  console.log(`Using proxy: ${PROXY || 'None'}\n`);

  const results = [];

  for (const instance of instances) {
    const result = await testInstance(instance);
    results.push(result);
    // Wait a bit between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n=== Test Results ===\n');

  // Sort by status and response time
  const working = results.filter(r => r.status === 'ok').sort((a, b) => a.responseTime - b.responseTime);
  const failed = results.filter(r => r.status !== 'ok');

  console.log('Working instances (sorted by speed):');
  working.forEach((r, i) => {
    console.log(`${i + 1}. ${r.host} (${r.responseTime}ms)`);
  });

  console.log('\nFailed instances:');
  failed.forEach(r => {
    console.log(`- ${r.host} (${r.error || 'HTTP ' + r.statusCode || r.status})`);
  });

  console.log('\n=== Recommended instance list ===\n');
  console.log('const instances = [');
  working.forEach(r => {
    console.log(`  '${r.host}',`);
  });
  // Keep some failed ones as fallback
  failed.slice(0, 2).forEach(r => {
    console.log(`  '${r.host}', // fallback`);
  });
  console.log('];\n');
}

// Run tests
testAllInstances().catch(console.error);
