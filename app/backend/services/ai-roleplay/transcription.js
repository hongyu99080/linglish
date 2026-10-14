'use strict';

const path = require('path');
const { tmpdir } = require('os');
const { randomBytes } = require('crypto');
const { readFile, writeFile } = require('fs/promises');

const {
  parseBase64DataUrl,
  convertAudioToWav,
  removeFileSafe,
} = require('../../utils/audio');
const { normalizeTranscript } = require('./contracts');

const MIN_DURATION_SECONDS = 0.2;
const MAX_DURATION_SECONDS = 120;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function normalizeDurationSeconds(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_DURATION_SECONDS || value > MAX_DURATION_SECONDS) {
    return null;
  }
  return value;
}

function extensionFromMime(mimeType = '') {
  const normalized = String(mimeType).toLowerCase().split(';')[0].trim();
  switch (normalized) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/aac':
      return 'aac';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/webm':
    default:
      return 'webm';
  }
}

function getDefaultTranscribePracticeWav() {
  return require('../video-transcription').transcribePracticeWav;
}

async function removeTempFileSilently(filePath) {
  await removeFileSafe(filePath, { silent: true });
}

async function cleanupTempFiles(paths, removeTempFile) {
  const seen = new Set();
  let cleanupFailed = false;
  for (const filePath of paths) {
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    try {
      await removeTempFile(filePath);
    } catch (_) {
      // Cleanup failures must not replace the primary result or reveal temp paths.
      cleanupFailed = true;
    }
  }
  return cleanupFailed;
}

function createRoleplayTranscriber(dependencies = {}) {
  const {
    parseBase64DataUrl: parseDataUrl = parseBase64DataUrl,
    convertAudioToWav: convertToWav = convertAudioToWav,
    transcribePracticeWav: transcribeWav = getDefaultTranscribePracticeWav(),
    writeFile: writeTempFile = writeFile,
    readFile: readTempFile = readFile,
    removeFileSafe: removeTempFile = removeTempFileSilently,
    tmpdir: getTmpdir = tmpdir,
    randomBytes: createRandomBytes = randomBytes,
  } = dependencies;

  async function transcribe({ audioData, durationSeconds, language }) {
    const normalizedDuration = normalizeDurationSeconds(durationSeconds);
    if (normalizedDuration === null) {
      fail('INVALID_AUDIO_DURATION');
    }

    const { mimeType, buffer } = parseDataUrl(audioData);
    const token = createRandomBytes(4).toString('hex');
    const basePath = path.join(getTmpdir(), `roleplay-fast-${token}`);
    const inputPath = `${basePath}.${extensionFromMime(mimeType)}`;
    let wavPath = null;
    let response = null;
    let primaryError = null;
    try {
      await writeTempFile(inputPath, buffer);
      wavPath = await convertToWav(inputPath, 16000);

      const result = await transcribeWav(wavPath, {
        language: 'en',
        diarize: false,
        wordTimestamps: false,
        vadFilter: true,
      });

      const transcript = normalizeTranscript(result?.text || '');
      if (!transcript) {
        fail('EMPTY_TRANSCRIPT');
      }

      void readTempFile;
      void language;

      response = {
        transcript,
        provider: result?.provider || 'custom',
        duration_seconds: normalizedDuration,
      };
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanupFailed = await cleanupTempFiles([wavPath, inputPath], removeTempFile);
      if (primaryError) {
        throw primaryError;
      }
      if (cleanupFailed) {
        fail('TEMP_CLEANUP_FAILED');
      }
    }

    return response;
  }

  return {
    transcribe,
  };
}

module.exports = {
  createRoleplayTranscriber,
};
