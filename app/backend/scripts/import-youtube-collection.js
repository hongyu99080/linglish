#!/usr/bin/env node
/**
 * One-off importer: add a YouTube channel's videos to Linglish as a collection (合集).
 *
 * Online import only — it stores the YouTube URL as `video_path` and never
 * downloads the video file. Transcripts come from the caption tiers in
 * services/youtube.js (Innertube -> yt-dlp -> web scrape); the Whisper STT
 * fallback used by routes/youtube.js is deliberately NOT wired up here, since
 * it would have to download the full video to transcribe it.
 *
 * Usage:
 *   node scripts/import-youtube-collection.js \
 *     --channel "https://www.youtube.com/@VolkaEnglish/videos" \
 *     --collection "Volka English" \
 *     --uploader 1 \
 *     --limit 20 \
 *     [--dry-run]
 */

require('dotenv').config();

const { execFile } = require('child_process');
const dataStore = require('../data-store');
const youtubeService = require('../services/youtube');

// YouTube rate-limits bursts of caption requests (HTTP 429). Import serially
// with a pause between videos rather than in parallel.
const DELAY_BETWEEN_VIDEOS_MS = 4000;
const ENUMERATE_TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'dry-run') {
      args.dryRun = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * List the newest videos on a channel. `--flat-playlist` returns id/title/
 * duration/thumbnail in a single request, so we don't need a per-video
 * getVideoInfo() call (fewer requests = less chance of tripping HTTP 429).
 */
function listChannelVideos(channelUrl, limit) {
  const args = [
    '--flat-playlist',
    '--playlist-end', String(limit),
    '--no-warnings',
    '-J',
    channelUrl,
  ];
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy) args.push('--proxy', proxy);

  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { timeout: ENUMERATE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr?.trim() || error.message));
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch (parseErr) {
        return reject(new Error(`Could not parse yt-dlp output: ${parseErr.message}`));
      }
      const entries = (payload.entries || [])
        .filter((entry) => entry && entry.id)
        .map((entry) => ({
          videoId: entry.id,
          title: entry.title || entry.id,
          duration: entry.duration ? Math.round(entry.duration) : null,
          // The flat-playlist thumbnails are storyboard variants with expiring
          // signatures; the canonical hqdefault URL is stable.
          thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${entry.id}`,
        }));
      resolve({ channel: payload.channel || payload.uploader || null, entries });
    });
  });
}

async function importVideo({ video, collectionName, uploaderId, language }) {
  // video_path carries a global UNIQUE constraint, so the lookup must NOT be
  // scoped to this uploader: a video another user already imported cannot be
  // inserted again, and scoping the check to uploader_id would let us try
  // anyway and die on the constraint. Prefer our own row when one exists.
  const existing = await dataStore.pool.query(
    `SELECT id, has_subtitles, uploader_id, collection_name FROM video_resources
     WHERE youtube_video_id = $1 AND video_type = 'youtube'
     ORDER BY (uploader_id = $2) DESC, id
     LIMIT 1`,
    [video.videoId, uploaderId],
  );

  let resource = existing.rows[0] || null;

  // Someone else already owns this video. We can't create a second row, so
  // adopt the existing one into the collection instead of failing.
  if (resource && String(resource.uploader_id) !== String(uploaderId)) {
    if (resource.collection_name !== collectionName) {
      await dataStore.updateVideoResource(resource.id, { collection_name: collectionName });
    }
    return {
      outcome: resource.has_subtitles ? 'adopted' : 'no_subtitles',
      resourceId: resource.id,
      ownedBy: resource.uploader_id,
      error: resource.has_subtitles ? undefined : 'existing row owned by another user has no subtitles',
    };
  }

  // Only rows that already have subtitles are done. A row left at
  // completed_no_subtitles (YouTube 429, transient network error) should be
  // retried on a re-run rather than skipped forever — so reuse its id instead
  // of creating a duplicate.
  if (resource && resource.has_subtitles) {
    return { outcome: 'skipped', resourceId: resource.id };
  }

  const isRetry = Boolean(resource);
  if (!resource) {
    resource = await dataStore.createVideoResource({
      uploader_id: uploaderId,
      title: video.title,
      description: '',
      video_path: video.url, // YouTube reference only — no local file.
      thumbnail_path: video.thumbnail,
      duration_sec: video.duration,
      status: 'processing',
      failure_reason: null,
      video_type: 'youtube',
      youtube_video_id: video.videoId,
      subtitle_language: language,
      is_public: true,
      collection_name: collectionName,
      transcript: null,
      transcript_segments: null,
      has_subtitles: false,
      word_count: 0,
      unique_word_count: 0,
    });
  }

  try {
    const transcriptData = await youtubeService.getTranscript(video.url, language);
    const words = youtubeService.extractWords(transcriptData.transcript);

    await dataStore.updateVideoResource(resource.id, {
      transcript: transcriptData.transcript,
      transcript_segments: transcriptData.segments,
      has_subtitles: true,
      word_count: words.length,
      unique_word_count: new Set(words).size,
      // 'ready' is what the rest of the library uses; 'completed' only appears
      // on a couple of legacy rows.
      status: 'ready',
      failure_reason: null,
    });

    return {
      outcome: 'imported',
      resourceId: resource.id,
      segments: transcriptData.segments.length,
      source: transcriptData.source,
      isRetry,
    };
  } catch (error) {
    await dataStore.updateVideoResource(resource.id, {
      status: 'completed_no_subtitles',
      failure_reason: `No subtitles: ${error.message}`,
      has_subtitles: false,
    });
    return { outcome: 'no_subtitles', resourceId: resource.id, error: error.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channelUrl = args.channel;
  const collectionName = args.collection;
  const uploaderId = Number(args.uploader);
  const limit = Number(args.limit) || 20;
  const language = args.language || 'en';

  if (!channelUrl || !collectionName || !Number.isInteger(uploaderId)) {
    console.error('Usage: node scripts/import-youtube-collection.js --channel <url> --collection <name> --uploader <userId> [--limit 20] [--language en] [--dry-run]');
    process.exit(1);
  }

  const uploader = await dataStore.pool.query('SELECT id, username FROM users WHERE id = $1', [uploaderId]);
  if (!uploader.rows.length) {
    console.error(`Uploader ${uploaderId} does not exist.`);
    process.exit(1);
  }

  console.log(`Enumerating up to ${limit} videos from ${channelUrl} ...`);
  const { channel, entries } = await listChannelVideos(channelUrl, limit);
  console.log(`Channel: ${channel || 'unknown'} — ${entries.length} video(s) found.`);
  console.log(`Collection: "${collectionName}"  Uploader: ${uploader.rows[0].username} (${uploaderId})\n`);

  if (args.dryRun) {
    entries.forEach((video, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${video.videoId}  ${video.title}`);
    });
    console.log('\nDry run — nothing written.');
    return;
  }

  const tally = { imported: 0, skipped: 0, adopted: 0, no_subtitles: 0, failed: 0 };
  let consecutiveMisses = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const video = entries[i];
    const label = `[${i + 1}/${entries.length}] ${video.title.slice(0, 60)}`;
    try {
      const result = await importVideo({ video, collectionName, uploaderId, language });
      tally[result.outcome] += 1;
      if (result.outcome === 'imported') {
        const tag = result.isRetry ? ' (retry)' : '';
        console.log(`${label}\n    ✓ id=${result.resourceId} segments=${result.segments} source=${result.source}${tag}`);
        consecutiveMisses = 0;
      } else if (result.outcome === 'skipped') {
        console.log(`${label}\n    - already imported (id=${result.resourceId})`);
      } else if (result.outcome === 'adopted') {
        console.log(`${label}\n    + added to collection (id=${result.resourceId}, owned by user ${result.ownedBy})`);
      } else {
        console.log(`${label}\n    ! no subtitles (id=${result.resourceId}): ${result.error}`);
        consecutiveMisses += 1;
      }
    } catch (error) {
      tally.failed += 1;
      consecutiveMisses += 1;
      console.error(`${label}\n    ✗ ${error.message}`);
    }

    // Several misses in a row usually means YouTube started rate-limiting us
    // rather than that these particular videos lack captions. Back off so the
    // rest of the run isn't wasted; failed rows stay retryable on a re-run.
    if (consecutiveMisses >= 3) {
      const cooldown = Math.min(consecutiveMisses, 8) * 30000;
      console.log(`    … ${consecutiveMisses} misses in a row, cooling down ${cooldown / 1000}s`);
      await sleep(cooldown);
    }

    if (i < entries.length - 1) await sleep(DELAY_BETWEEN_VIDEOS_MS);
  }

  console.log(`\nDone. imported=${tally.imported} skipped=${tally.skipped} adopted=${tally.adopted} no_subtitles=${tally.no_subtitles} failed=${tally.failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Import failed:', error.message);
    process.exit(1);
  });
