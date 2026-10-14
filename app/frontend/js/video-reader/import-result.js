/**
 * ImportResult - YouTube 导入响应解析（纯函数，无 DOM 依赖）
 *
 * 解析 POST /youtube/import 的响应体，返回：
 *   kind     'created' | 'duplicate' | 'error' | 'invalid'
 *   videoId  跳转目标视频 ID（created/duplicate 时存在）
 *   message  前端展示文案（中文文案由前端决定，后端不下发）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ImportResult = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MESSAGES = {
    created: '恭喜，上传成功！正在跳转...',
    duplicate: '该视频已经在视频库中，正在跳转...',
    invalid: '导入结果异常：未返回视频 ID，请刷新视频库查看'
  };

  function parseImportResult(data) {
    if (!data || typeof data !== 'object' || data.success !== true) {
      var err = data && typeof data.error === 'string' && data.error.trim()
        ? data.error
        : '导入失败，请重试';
      return { kind: 'error', videoId: null, message: err };
    }
    var videoId = data.video && data.video.id != null ? data.video.id : null;
    if (videoId === null) {
      return { kind: 'invalid', videoId: null, message: MESSAGES.invalid };
    }
    return data.alreadyExists === true
      ? { kind: 'duplicate', videoId: videoId, message: MESSAGES.duplicate }
      : { kind: 'created', videoId: videoId, message: MESSAGES.created };
  }

  return {
    parseImportResult: parseImportResult,
    MESSAGES: MESSAGES
  };
});
