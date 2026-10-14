#!/usr/bin/env node

/**
 * YouTube Setup Verification Script
 *
 * Checks that all requirements for YouTube video download functionality are met:
 * - Dependencies installed (youtubei.js)
 * - Directory structure exists
 * - Permissions are correct
 * - Environment variables configured
 * - Network connectivity (optional)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  YouTube Video Download Setup Verification                   ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

let allChecksPassed = true;
const warnings = [];
const errors = [];

// Helper functions
function checkPassed(message) {
  console.log('✓', message);
}

function checkFailed(message) {
  console.log('✗', message);
  allChecksPassed = false;
  errors.push(message);
}

function checkWarning(message) {
  console.log('⚠', message);
  warnings.push(message);
}

// Check 1: Node.js version
console.log('[1/8] Checking Node.js version...');
try {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (major >= 18) {
    checkPassed(`Node.js ${nodeVersion} (>= 18.0.0 required)`);
  } else {
    checkFailed(`Node.js ${nodeVersion} is too old. Version 18+ required for ESM support.`);
  }
} catch (err) {
  checkFailed('Could not determine Node.js version');
}
console.log('');

// Check 2: Dependencies installed
console.log('[2/8] Checking dependencies...');
try {
  const packageJson = require('../package.json');
  const dependencies = packageJson.dependencies || {};

  // Check for youtubei.js
  if (dependencies['youtubei.js']) {
    checkPassed(`youtubei.js dependency declared (${dependencies['youtubei.js']})`);

    // Check if actually installed
    try {
      const youtubeModulePath = require.resolve('youtubei.js');
      checkPassed('youtubei.js module is installed');
    } catch (err) {
      checkFailed('youtubei.js is not installed. Run: npm install');
    }
  } else {
    checkFailed('youtubei.js not in package.json dependencies');
  }

  // Check other required dependencies
  const requiredDeps = ['pg', 'dotenv'];
  for (const dep of requiredDeps) {
    if (dependencies[dep]) {
      checkPassed(`${dep} dependency declared`);
    } else {
      checkWarning(`${dep} not in dependencies (may not be required for YouTube)`);
    }
  }
} catch (err) {
  checkFailed('Could not read package.json: ' + err.message);
}
console.log('');

// Check 3: YouTube videos directory
console.log('[3/8] Checking YouTube videos directory...');
try {
  const youtubeDir = path.join(__dirname, '../public/videos/youtube');

  if (fs.existsSync(youtubeDir)) {
    checkPassed('YouTube videos directory exists');

    // Check permissions
    try {
      const testFile = path.join(youtubeDir, '.write-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      checkPassed('Directory is writable');
    } catch (err) {
      checkFailed('Directory is not writable. Run: chmod 755 public/videos/youtube');
    }

    // Check disk space
    try {
      const stats = fs.statfsSync(youtubeDir);
      const availableGB = (stats.bavail * stats.bsize) / (1024 ** 3);
      if (availableGB > 10) {
        checkPassed(`Sufficient disk space (${availableGB.toFixed(2)} GB available)`);
      } else if (availableGB > 1) {
        checkWarning(`Low disk space (${availableGB.toFixed(2)} GB available). Consider freeing up space.`);
      } else {
        checkFailed(`Very low disk space (${availableGB.toFixed(2)} GB available). Free up space before downloading.`);
      }
    } catch (err) {
      checkWarning('Could not check disk space: ' + err.message);
    }
  } else {
    checkFailed('YouTube videos directory does not exist. Run: mkdir -p public/videos/youtube');
  }
} catch (err) {
  checkFailed('Error checking directory: ' + err.message);
}
console.log('');

// Check 4: Environment variables
console.log('[4/8] Checking environment configuration...');
try {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });

  // Check for .env file
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    checkPassed('.env file exists');
  } else {
    checkWarning('.env file not found. Copy .env.example to .env and configure.');
  }

  // Check proxy configuration
  if (process.env.HTTPS_PROXY) {
    checkPassed(`HTTPS_PROXY configured: ${process.env.HTTPS_PROXY.replace(/\/\/[^@]+@/, '//***@')}`);
  } else {
    checkWarning('HTTPS_PROXY not configured. Required for accessing YouTube from China.');
  }

  // Check optional YouTube cookies
  if (process.env.YOUTUBE_COOKIES) {
    checkPassed('YOUTUBE_COOKIES configured (optional)');
  } else {
    checkWarning('YOUTUBE_COOKIES not configured (optional, helps with some restrictions)');
  }

  // Check database URL
  if (process.env.DATABASE_URL) {
    checkPassed('DATABASE_URL configured');
  } else {
    checkWarning('DATABASE_URL not configured (required for production)');
  }
} catch (err) {
  checkWarning('dotenv not available or error loading .env: ' + err.message);
}
console.log('');

// Check 5: YouTube downloader module
console.log('[5/8] Checking YouTube downloader module...');
try {
  const downloader = require('../services/youtube-downloader');

  if (typeof downloader.downloadVideo === 'function') {
    checkPassed('downloadVideo function available');
  } else {
    checkFailed('downloadVideo function not found in downloader module');
  }

  if (typeof downloader.checkExistingDownload === 'function') {
    checkPassed('checkExistingDownload function available');
  }

  if (typeof downloader.deleteDownload === 'function') {
    checkPassed('deleteDownload function available');
  }
} catch (err) {
  checkFailed('Could not load YouTube downloader module: ' + err.message);
}
console.log('');

// Check 6: Database schema
console.log('[6/8] Checking database schema (skipped in this environment)...');
checkWarning('Database check skipped. Ensure video_resources table has:');
console.log('  - local_video_path column');
console.log('  - local_video_status column');
console.log('  - youtube_video_id column');
console.log('');

// Check 7: Network connectivity (optional)
console.log('[7/8] Checking network connectivity...');
if (process.env.HTTPS_PROXY) {
  checkWarning('Proxy configured. Network test skipped (requires actual proxy access)');
} else {
  checkWarning('No proxy configured. YouTube access will not work from China.');
}
console.log('');

// Check 8: README documentation
console.log('[8/8] Checking documentation...');
try {
  const readmePath = path.join(__dirname, '../public/videos/youtube/README.md');
  if (fs.existsSync(readmePath)) {
    checkPassed('YouTube videos README exists');
  } else {
    checkWarning('README.md not found in youtube directory');
  }
} catch (err) {
  checkWarning('Could not check for README: ' + err.message);
}
console.log('');

// Summary
console.log('═'.repeat(64));
console.log('SUMMARY');
console.log('═'.repeat(64));

if (allChecksPassed && warnings.length === 0) {
  console.log('✓ All checks passed! YouTube video download is ready to use.');
} else if (allChecksPassed && warnings.length > 0) {
  console.log(`✓ Core functionality ready, but ${warnings.length} warning(s):`);
  warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
} else {
  console.log(`✗ Setup incomplete. ${errors.length} error(s) found:`);
  errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  console.log('');
  console.log('Fix these errors before using YouTube download functionality.');
  process.exit(1);
}

console.log('');
console.log('For detailed setup instructions, see:');
console.log('  app/backend/public/videos/youtube/README.md');
console.log('');

process.exit(allChecksPassed ? 0 : 1);
