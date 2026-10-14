const test = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('fs/promises');

function loadSubject() {
  return require('../services/ai-roleplay/transcription');
}

function createDeps(overrides = {}) {
  const calls = {
    writeFile: [],
    readFile: [],
    convertAudioToWav: [],
    transcribePracticeWav: [],
    removeFileSafe: [],
  };

  const deps = {
    parseBase64DataUrl: () => ({
      mimeType: 'audio/webm',
      buffer: Buffer.from('raw audio'),
    }),
    convertAudioToWav: async (inputPath, sampleRate) => {
      calls.convertAudioToWav.push([inputPath, sampleRate]);
      return '/tmp/roleplay-fast-00112233.wav';
    },
    transcribePracticeWav: async (wavPath, options) => {
      calls.transcribePracticeWav.push([wavPath, options]);
      return {
        text: '  hello\u0000   world  ',
        provider: 'custom',
      };
    },
    writeFile: async (filePath, buffer) => {
      calls.writeFile.push([filePath, buffer]);
    },
    readFile: async (filePath) => {
      calls.readFile.push([filePath]);
      return Buffer.from('unused');
    },
    removeFileSafe: async (filePath) => {
      calls.removeFileSafe.push(filePath);
    },
    tmpdir: () => '/tmp',
    randomBytes: () => Buffer.from('00112233', 'hex'),
    ...overrides,
  };

  return { deps, calls };
}

test('transcribe converts valid WebM audio, uses the fast ASR options, normalizes the transcript, and cleans up both temp files', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps();
  const transcriber = createRoleplayTranscriber(deps);

  const result = await transcriber.transcribe({
    audioData: 'data:audio/webm;base64,AAAA',
    durationSeconds: 1.8,
    language: 'fr',
  });

  assert.deepEqual(calls.writeFile, [[
    '/tmp/roleplay-fast-00112233.webm',
    Buffer.from('raw audio'),
  ]]);
  assert.deepEqual(calls.convertAudioToWav, [[
    '/tmp/roleplay-fast-00112233.webm',
    16000,
  ]]);
  assert.deepEqual(calls.transcribePracticeWav, [[
    '/tmp/roleplay-fast-00112233.wav',
    {
      language: 'en',
      diarize: false,
      wordTimestamps: false,
      vadFilter: true,
    },
  ]]);
  assert.deepEqual(calls.removeFileSafe, [
    '/tmp/roleplay-fast-00112233.wav',
    '/tmp/roleplay-fast-00112233.webm',
  ]);
  assert.equal(result.transcript, 'hello world');
  assert.equal(result.provider, 'custom');
  assert.equal(result.duration_seconds, 1.8);
});

test('transcribe rejects invalid audio data before writing temp files', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps({
    parseBase64DataUrl: () => {
      throw new Error('INVALID_AUDIO_DATA');
    },
  });
  const transcriber = createRoleplayTranscriber(deps);

  await assert.rejects(
    () => transcriber.transcribe({
      audioData: 'bad-data',
      durationSeconds: 1,
      language: 'en',
    }),
    /INVALID_AUDIO_DATA/,
  );

  assert.deepEqual(calls.writeFile, []);
  assert.deepEqual(calls.convertAudioToWav, []);
  assert.deepEqual(calls.transcribePracticeWav, []);
  assert.deepEqual(calls.removeFileSafe, []);
});

test('transcribe rejects durations outside 0.2 to 120 seconds before writing temp files', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps();
  const transcriber = createRoleplayTranscriber(deps);

  await assert.rejects(
    () => transcriber.transcribe({
      audioData: 'data:audio/webm;base64,AAAA',
      durationSeconds: 0.1,
      language: 'en',
    }),
    /INVALID_AUDIO_DURATION/,
  );

  await assert.rejects(
    () => transcriber.transcribe({
      audioData: 'data:audio/webm;base64,AAAA',
      durationSeconds: 120.1,
      language: 'en',
    }),
    /INVALID_AUDIO_DURATION/,
  );

  assert.deepEqual(calls.writeFile, []);
  assert.deepEqual(calls.convertAudioToWav, []);
  assert.deepEqual(calls.transcribePracticeWav, []);
  assert.deepEqual(calls.removeFileSafe, []);
});

test('transcribe rejects empty normalized transcripts and still removes both temp files exactly once', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps({
    transcribePracticeWav: async (wavPath, options) => {
      calls.transcribePracticeWav.push([wavPath, options]);
      return {
        text: ' \u0000 \n\t ',
        provider: 'custom',
      };
    },
  });
  const transcriber = createRoleplayTranscriber(deps);

  await assert.rejects(
    () => transcriber.transcribe({
      audioData: 'data:audio/webm;base64,AAAA',
      durationSeconds: 1,
      language: 'en',
    }),
    /EMPTY_TRANSCRIPT/,
  );

  assert.deepEqual(calls.removeFileSafe, [
    '/tmp/roleplay-fast-00112233.wav',
    '/tmp/roleplay-fast-00112233.webm',
  ]);
});

test('transcribe keeps the existing 1000-character bound and still cleans up on overlong ASR output', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps({
    transcribePracticeWav: async (wavPath, options) => {
      calls.transcribePracticeWav.push([wavPath, options]);
      return {
        text: 'x'.repeat(1001),
        provider: 'custom',
      };
    },
  });
  const transcriber = createRoleplayTranscriber(deps);

  await assert.rejects(
    () => transcriber.transcribe({
      audioData: 'data:audio/webm;base64,AAAA',
      durationSeconds: 1,
      language: 'en',
    }),
    /TRANSCRIPT_TOO_LONG/,
  );

  assert.deepEqual(calls.removeFileSafe, [
    '/tmp/roleplay-fast-00112233.wav',
    '/tmp/roleplay-fast-00112233.webm',
  ]);
});

test('transcribe cleans up both temp files exactly once when the ASR provider fails', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps({
    transcribePracticeWav: async (wavPath, options) => {
      calls.transcribePracticeWav.push([wavPath, options]);
      throw new Error('FAST_ASR_DOWN');
    },
  });
  const transcriber = createRoleplayTranscriber(deps);

  await assert.rejects(
    () => transcriber.transcribe({
      audioData: 'data:audio/webm;base64,AAAA',
      durationSeconds: 1,
      language: 'en',
    }),
    /FAST_ASR_DOWN/,
  );

  assert.deepEqual(calls.removeFileSafe, [
    '/tmp/roleplay-fast-00112233.wav',
    '/tmp/roleplay-fast-00112233.webm',
  ]);
});

test('transcribe still attempts the source cleanup when WAV cleanup rejects and preserves the original failure', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps({
    transcribePracticeWav: async (wavPath, options) => {
      calls.transcribePracticeWav.push([wavPath, options]);
      throw new Error('FAST_ASR_DOWN');
    },
    removeFileSafe: async (filePath) => {
      calls.removeFileSafe.push(filePath);
      if (filePath.endsWith('.wav')) {
        throw new Error('CLEANUP_FAILED');
      }
    },
  });
  const transcriber = createRoleplayTranscriber(deps);

  await assert.rejects(
    () => transcriber.transcribe({
      audioData: 'data:audio/webm;base64,AAAA',
      durationSeconds: 1,
      language: 'en',
    }),
    /FAST_ASR_DOWN/,
  );

  assert.deepEqual(calls.removeFileSafe, [
    '/tmp/roleplay-fast-00112233.wav',
    '/tmp/roleplay-fast-00112233.webm',
  ]);
});

test('transcribe rejects with a generic cleanup code after successful ASR when one cleanup fails and still attempts both paths', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);

  try {
    const { deps, calls } = createDeps({
      removeFileSafe: async (filePath) => {
        calls.removeFileSafe.push(filePath);
        if (filePath.endsWith('.wav')) {
          throw new Error('permission denied at /tmp/roleplay-fast-00112233.wav');
        }
      },
    });
    const transcriber = createRoleplayTranscriber(deps);

    await assert.rejects(
      () => transcriber.transcribe({
        audioData: 'data:audio/webm;base64,AAAA',
        durationSeconds: 1,
        language: 'en',
      }),
      (error) => {
        assert.equal(error?.code, 'TEMP_CLEANUP_FAILED');
        assert.equal(error?.message, 'TEMP_CLEANUP_FAILED');
        assert.doesNotMatch(error?.message || '', /roleplay-fast|\/tmp|permission denied/i);
        return true;
      },
    );

    assert.deepEqual(calls.removeFileSafe, [
      '/tmp/roleplay-fast-00112233.wav',
      '/tmp/roleplay-fast-00112233.webm',
    ]);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});

test('transcribe removes a single temp path once when conversion returns the input path', async () => {
  const { createRoleplayTranscriber } = loadSubject();
  const { deps, calls } = createDeps({
    convertAudioToWav: async (inputPath, sampleRate) => {
      calls.convertAudioToWav.push([inputPath, sampleRate]);
      return inputPath;
    },
  });
  const transcriber = createRoleplayTranscriber(deps);

  await transcriber.transcribe({
    audioData: 'data:audio/webm;base64,AAAA',
    durationSeconds: 1,
    language: 'en',
  });

  assert.deepEqual(calls.removeFileSafe, [
    '/tmp/roleplay-fast-00112233.webm',
  ]);
});

test('transcribe default silent cleanup does not emit temp paths when deletes fail', async () => {
  const originalUnlink = fsPromises.unlink;
  const originalWarn = console.warn;
  const warnings = [];
  fsPromises.unlink = async () => {
    const err = new Error('permission denied');
    err.code = 'EPERM';
    throw err;
  };
  console.warn = (...args) => warnings.push(args);

  try {
    const { createRoleplayTranscriber } = loadSubject();
    const { deps } = createDeps({
      transcribePracticeWav: async () => {
        throw new Error('FAST_ASR_DOWN');
      },
    });
    delete deps.removeFileSafe;
    const transcriber = createRoleplayTranscriber(deps);

    await assert.rejects(
      () => transcriber.transcribe({
        audioData: 'data:audio/webm;base64,AAAA',
        durationSeconds: 1,
        language: 'en',
      }),
      /FAST_ASR_DOWN/,
    );
  } finally {
    fsPromises.unlink = originalUnlink;
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});
