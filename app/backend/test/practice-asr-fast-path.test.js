const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const videoTranscription = require('../services/video-transcription');
const pronunciation = require('../services/pronunciation');

test('practice WAV fast path uploads the existing WAV without timestamp or diarization work', async (t) => {
  let requestUrl = null;
  let requestBytes = 0;
  const server = http.createServer((req, res) => {
    requestUrl = req.url;
    req.on('data', (chunk) => {
      requestBytes += chunk.length;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        language: 'en',
        text: 'Hello there.',
        segments: [],
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const fixture = path.join(os.tmpdir(), `practice-fast-${process.pid}.wav`);
  await fs.writeFile(fixture, Buffer.from('RIFF-test-audio'));

  const endpoint = `http://127.0.0.1:${server.address().port}/asr`;
  const result = await videoTranscription.transcribePracticeWav(fixture, { endpoint });

  assert.equal(result.text, 'Hello there.');
  assert.match(requestUrl, /language=en/);
  assert.match(requestUrl, /output=json/);
  assert.match(requestUrl, /vad_filter=true/);
  assert.doesNotMatch(requestUrl, /initial_prompt/);
  assert.doesNotMatch(requestUrl, /word_timestamps/);
  assert.doesNotMatch(requestUrl, /diarize/);
  assert.ok(requestBytes > 14, 'multipart request should include the WAV bytes');

  await fs.unlink(fixture);
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

test('pronunciation fast path scores an existing WAV through local custom ASR', async (t) => {
  let requestUrl = null;
  const server = http.createServer((req, res) => {
    requestUrl = req.url;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        language: 'en',
        text: 'Hello there.',
        segments: [],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const fixture = path.join(os.tmpdir(), `practice-score-${process.pid}.wav`);
  await fs.writeFile(fixture, Buffer.from('RIFF-test-audio'));

  const endpoint = `http://127.0.0.1:${server.address().port}/asr`;
  const result = await pronunciation.assessFileWithAsr(
    fixture,
    'Hello there.',
    { endpoint, durationSeconds: 1.8 },
  );

  assert.equal(result.hypothesis, 'Hello there.');
  assert.equal(result.accuracy, 100);
  assert.equal(result.provider, 'custom');
  assert.equal(result.analysis_version, 'coach-v1');
  assert.equal(result.duration_seconds, 1.8);
  assert.equal(result.coaching.next_action.type, 'continue');
  assert.equal(result.coaching.evidence_level, 'transcript_alignment');
  assert.doesNotMatch(requestUrl, /initial_prompt/);

  await fs.unlink(fixture);
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

test('pronunciation fast path context-reviews a cross-spelling low score', async () => {
  const requestUrls = [];
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestUrls.push(req.url);
    req.resume();
    req.on('end', () => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        language: 'en',
        text: requestCount === 1 ? 'Inglis o cien cien.' : 'English singsing.',
        segments: [],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const fixture = path.join(os.tmpdir(), `practice-context-review-${process.pid}.wav`);
  await fs.writeFile(fixture, Buffer.from('RIFF-test-audio'));
  const endpoint = `http://127.0.0.1:${server.address().port}/asr`;

  const result = await pronunciation.assessFileWithAsr(
    fixture,
    'English singsing.',
    { endpoint },
  );

  assert.equal(requestUrls.length, 2);
  assert.doesNotMatch(requestUrls[0], /initial_prompt/);
  assert.match(requestUrls[1], /initial_prompt=English(?:%20|\+)singsing/);
  assert.equal(result.hypothesis, 'English singsing.');
  assert.equal(result.accuracy, 100);
  assert.equal(result.provider, 'custom-context-review');

  await fs.unlink(fixture);
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

test('pronunciation fast path keeps the unbiased result when context review does not improve it', async () => {
  const requestUrls = [];
  const server = http.createServer((req, res) => {
    requestUrls.push(req.url);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        language: 'en',
        text: "It's a cool bus.",
        segments: [],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const fixture = path.join(os.tmpdir(), `practice-no-context-review-${process.pid}.wav`);
  await fs.writeFile(fixture, Buffer.from('RIFF-test-audio'));
  const endpoint = `http://127.0.0.1:${server.address().port}/asr`;

  const result = await pronunciation.assessFileWithAsr(
    fixture,
    'School bus.',
    { endpoint },
  );

  assert.equal(requestUrls.length, 2);
  assert.doesNotMatch(requestUrls[0], /initial_prompt/);
  assert.match(requestUrls[1], /initial_prompt=School(?:%20|\+)bus/);
  assert.equal(result.hypothesis, "It's a cool bus.");
  assert.equal(result.provider, 'custom');

  await fs.unlink(fixture);
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});
