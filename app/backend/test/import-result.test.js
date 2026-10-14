const test = require('node:test');
const assert = require('node:assert/strict');

const { parseImportResult, MESSAGES } = require('../../frontend/js/video-reader/import-result');

test('new import resolves to created with video id and success message', () => {
  const result = parseImportResult({ success: true, alreadyExists: false, video: { id: 123 } });
  assert.deepEqual(result, { kind: 'created', videoId: 123, message: MESSAGES.created });
  assert.match(result.message, /恭喜，上传成功/);
});

test('duplicate import resolves to duplicate with existing video id', () => {
  const result = parseImportResult({ success: true, alreadyExists: true, video: { id: 456 } });
  assert.deepEqual(result, { kind: 'duplicate', videoId: 456, message: MESSAGES.duplicate });
  assert.match(result.message, /该视频已经在视频库中/);
});

test('success without video id is flagged invalid, never shows success text', () => {
  for (const data of [
    { success: true, alreadyExists: false },
    { success: true, alreadyExists: false, video: {} },
    { success: true, alreadyExists: true, video: { id: null } },
  ]) {
    const result = parseImportResult(data);
    assert.equal(result.kind, 'invalid');
    assert.equal(result.videoId, null);
    assert.doesNotMatch(result.message, /上传成功/);
  }
});

test('failure responses surface backend error or fallback text', () => {
  assert.deepEqual(
    parseImportResult({ success: false, error: 'Invalid YouTube URL' }),
    { kind: 'error', videoId: null, message: 'Invalid YouTube URL' }
  );
  assert.equal(parseImportResult({ success: false }).message, '导入失败，请重试');
  assert.equal(parseImportResult(null).kind, 'error');
  assert.equal(parseImportResult(undefined).kind, 'error');
  assert.equal(parseImportResult('oops').kind, 'error');
});
