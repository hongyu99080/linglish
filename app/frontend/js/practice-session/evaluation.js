/**
 * Evaluation Module
 * Handles speech evaluation, recording processing, and feedback
 */

import { evaluateSpeech } from './api-client.js';

/**
 * Trim silence from audio blob
 * @param {Blob} blob - Audio blob
 * @param {number} threshold - Silence threshold (default 0.01)
 * @param {boolean} isMobile - Whether on mobile device
 * @returns {Promise<Object>} - Trimmed blob and metadata
 */
export async function trimSilence(blob, threshold = 0.01, isMobile = false) {
  try {
    console.log(`[静音裁剪] 开始处理, 大小: ${(blob.size / 1024).toFixed(2)}KB, 移动端: ${isMobile}`);

    const arrayBuffer = await blob.arrayBuffer();
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    let audioBuffer = null;
    try {
      if (audioContext.decodeAudioData.length > 1) {
        // Callback-based API
        audioBuffer = await new Promise((resolve, reject) => {
          audioContext.decodeAudioData(
            arrayBuffer.slice(0),
            (decoded) => resolve(decoded),
            (error) => reject(error || new Error('decode-failed'))
          );
        });
      } else {
        // Promise-based API
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      }
    } catch (err) {
      console.error('[静音裁剪] 解码音频失败:', err);
      throw err;
    }

    if (!audioBuffer) {
      throw new Error('Failed to decode audio');
    }

    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const channelCount = audioBuffer.numberOfChannels;

    console.log(`[静音裁剪] 音频信息: 采样率=${sampleRate}Hz, 时长=${(length / sampleRate).toFixed(2)}s, 通道数=${channelCount}`);

    // Find first and last non-silent sample
    let firstSoundSample = length;
    let lastSoundSample = 0;

    for (let channel = 0; channel < channelCount; channel++) {
      const channelData = audioBuffer.getChannelData(channel);

      // Find first sound
      for (let i = 0; i < length; i++) {
        if (Math.abs(channelData[i]) > threshold) {
          firstSoundSample = Math.min(firstSoundSample, i);
          break;
        }
      }

      // Find last sound
      for (let i = length - 1; i >= 0; i--) {
        if (Math.abs(channelData[i]) > threshold) {
          lastSoundSample = Math.max(lastSoundSample, i);
          break;
        }
      }
    }

    // Add small padding
    const paddingSamples = Math.floor(sampleRate * 0.05); // 50ms padding
    firstSoundSample = Math.max(0, firstSoundSample - paddingSamples);
    lastSoundSample = Math.min(length - 1, lastSoundSample + paddingSamples);

    const startOffset = firstSoundSample / sampleRate;
    const endOffset = (length - 1 - lastSoundSample) / sampleRate;
    const trimmedLength = lastSoundSample - firstSoundSample + 1;
    const trimmedDuration = trimmedLength / sampleRate;

    console.log(`[静音裁剪] 检测结果: 开头静音=${startOffset.toFixed(2)}s, 结尾静音=${endOffset.toFixed(2)}s, 裁剪后时长=${trimmedDuration.toFixed(2)}s`);

    // On mobile, return virtual trim (store offsets, don't re-encode)
    if (isMobile) {
      console.log('[静音裁剪] 移动端虚拟裁剪 (不重新编码)');
      return {
        blob, // Return original blob
        trimmedDuration,
        startOffset,
        endOffset,
        virtual: true
      };
    }

    // Desktop: perform actual trimming
    const trimmedBuffer = audioContext.createBuffer(
      channelCount,
      trimmedLength,
      sampleRate
    );

    for (let channel = 0; channel < channelCount; channel++) {
      const originalData = audioBuffer.getChannelData(channel);
      const trimmedData = trimmedBuffer.getChannelData(channel);
      for (let i = 0; i < trimmedLength; i++) {
        trimmedData[i] = originalData[firstSoundSample + i];
      }
    }

    // Encode trimmed buffer
    const trimmedBlob = await encodeAudioBuffer(trimmedBuffer, audioContext);

    console.log(`[静音裁剪] 完成, 原始大小: ${(blob.size / 1024).toFixed(2)}KB, 裁剪后大小: ${(trimmedBlob.size / 1024).toFixed(2)}KB`);

    await audioContext.close();

    return {
      blob: trimmedBlob,
      trimmedDuration,
      startOffset,
      endOffset,
      virtual: false
    };

  } catch (err) {
    console.error('[静音裁剪] 处理失败:', err);
    // Return original blob on error
    return {
      blob,
      trimmedDuration: null,
      startOffset: 0,
      endOffset: 0,
      virtual: false
    };
  }
}

/**
 * Encode audio buffer to blob
 * @param {AudioBuffer} audioBuffer - Audio buffer
 * @param {AudioContext} audioContext - Audio context
 * @returns {Promise<Blob>} - Encoded audio blob
 */
async function encodeAudioBuffer(audioBuffer, audioContext) {
  return new Promise((resolve, reject) => {
    const dest = audioContext.createMediaStreamDestination();
    const onlineSource = audioContext.createBufferSource();
    onlineSource.buffer = audioBuffer;
    onlineSource.connect(dest);

    const chunks = [];
    let mediaRecorder = null;

    // Determine best MIME type
    let mimeType = '';
    if (MediaRecorder.isTypeSupported('audio/mp4')) {
      mimeType = 'audio/mp4';
    } else if (MediaRecorder.isTypeSupported('audio/mpeg')) {
      mimeType = 'audio/mpeg';
    } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    } else {
      mimeType = ''; // Use default
    }

    try {
      if (mimeType) {
        mediaRecorder = new MediaRecorder(dest.stream, { mimeType });
      } else {
        mediaRecorder = new MediaRecorder(dest.stream);
      }
    } catch (err) {
      reject(new Error(`Failed to create MediaRecorder: ${err.message}`));
      return;
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      resolve(blob);
    };

    mediaRecorder.onerror = (error) => {
      reject(error);
    };

    // Start recording and playback
    mediaRecorder.start();
    onlineSource.start(0);

    // Stop after buffer duration
    const duration = audioBuffer.duration;
    setTimeout(() => {
      try {
        if (mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        onlineSource.stop();
        onlineSource.disconnect();
      } catch (stopErr) {
        console.warn('[编码] 停止录音时出错:', stopErr);
      }
    }, (duration + 0.1) * 1000);
  });
}

/**
 * Evaluate recording against reference
 * @param {Object} line - Practice line object
 * @param {Blob} blob - Recording blob
 * @param {Function} onSuccess - Success callback
 * @param {Function} onFailure - Failure callback
 * @param {Object} options - Options
 * @param {boolean} options.skipApiCall - Skip API call (for saving only)
 * @returns {Promise} - Promise that resolves when evaluation is complete
 */
export async function evaluateRecording(line, blob, onSuccess, onFailure, options = {}) {
  try {
    console.log(`[录音评估] 开始处理录音，大小: ${(blob.size / 1024).toFixed(2)}KB, 类型: ${blob.type}`);

    // Trim silence
    let processedBlob = blob;
    let trimmedDuration = null;
    let startOffset = 0;
    let endOffset = 0;

    try {
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone|Mobi/i.test(navigator.userAgent);
      console.log(`[录音评估] 移动端: ${isMobile}, 准备裁剪静音`);

      const result = await trimSilence(blob, 0.01, isMobile);
      processedBlob = result.blob;
      trimmedDuration = result.trimmedDuration;
      startOffset = result.startOffset || 0;
      endOffset = result.endOffset || 0;

      if (trimmedDuration !== null) {
        console.log(`[录音处理] 静音裁剪完成，时长: ${trimmedDuration.toFixed(2)}s, 开头偏移: ${startOffset.toFixed(2)}s`);
      } else {
        console.log(`[录音处理] 静音裁剪跳过或失败，使用原始录音`);
      }
    } catch (err) {
      console.error('[录音处理] 静音裁剪失败:', err);
      console.warn('[录音处理] 使用原始录音');
    }

    // Validate processed blob
    if (!processedBlob || processedBlob.size === 0) {
      console.error('[录音评估] 处理后的录音无效！');
      if (onFailure) onFailure();
      return;
    }

    console.log(`[录音评估] 准备保存录音，大小: ${(processedBlob.size / 1024).toFixed(2)}KB`);

    // If skipApiCall is set, return without calling API (for save-only scenarios)
    if (options.skipApiCall) {
      return {
        blob: processedBlob,
        trimmedDuration,
        startOffset,
        endOffset,
        passed: true,
        score: 1.0,
        words: [],
        hypothesis: ''
      };
    }

    // Get reference text from line
    const referenceText = line?.text || line?.content || '';
    if (!referenceText) {
      console.warn('[录音评估] 无参考文本，跳过API评分');
      return {
        blob: processedBlob,
        trimmedDuration,
        startOffset,
        endOffset,
        passed: true,
        score: 1.0,
        words: [],
        hypothesis: ''
      };
    }

    // Call pronunciation assessment API
    let apiResult = null;
    let passed = true;
    let score = 1.0;
    let words = [];
    let hypothesis = '';

    try {
      console.log(`[录音评估] 调用API评分，参考文本: "${referenceText.substring(0, 50)}..."`);
      apiResult = await evaluateSpeech({
        audioBlob: processedBlob,
        referenceText,
      });

      if (apiResult && apiResult.assessment) {
        const accuracy = apiResult.assessment.accuracy || 0;
        score = accuracy / 100; // Convert 0-100 to 0-1
        words = apiResult.assessment.words || [];
        hypothesis = apiResult.hypothesis || '';
        passed = score >= 0.8; // 80% threshold for passing

        console.log(`[录音评估] API评分结果: 准确度=${accuracy}%, 通过=${passed}, 单词数=${words.length}`);
      }
    } catch (apiErr) {
      console.error('[录音评估] API评分失败:', apiErr);
      // On API error, default to pass to avoid blocking user
      passed = true;
      score = 1.0;
    }

    return {
      blob: processedBlob,
      trimmedDuration,
      startOffset,
      endOffset,
      passed,
      score,
      words,
      hypothesis
    };

  } catch (err) {
    console.error('[录音评估] 评估失败:', err);
    if (onFailure) onFailure();
    throw err;
  }
}

/**
 * Calculate word-level accuracy
 * @param {string} reference - Reference text
 * @param {string} recognized - Recognized text
 * @returns {Object} - Accuracy metrics
 */
export function calculateWordAccuracy(reference, recognized) {
  if (!reference || !recognized) {
    return {
      accuracy: 0,
      correctWords: 0,
      totalWords: 0,
      correctIndexes: []
    };
  }

  const refWords = reference.toLowerCase().match(/\b[\w']+\b/g) || [];
  const recWords = recognized.toLowerCase().match(/\b[\w']+\b/g) || [];

  const correctIndexes = [];
  let correctCount = 0;

  refWords.forEach((word, index) => {
    if (recWords[index] === word) {
      correctIndexes.push(index);
      correctCount++;
    }
  });

  const accuracy = refWords.length > 0 ? correctCount / refWords.length : 0;

  return {
    accuracy,
    correctWords: correctCount,
    totalWords: refWords.length,
    correctIndexes
  };
}

/**
 * Generate feedback message based on score
 * @param {number} score - Evaluation score (0-1)
 * @param {Array} words - Word-level evaluation results
 * @returns {Object} - Feedback object with emoji, text, type, and details
 */
export function generateFeedback(score, words = []) {
  // Excellent performance
  if (score >= 0.9) {
    return {
      emoji: '✅',
      text: '太棒了！发音非常标准！',
      type: 'success',
      details: null
    };
  }

  // Good performance (passes threshold)
  if (score >= 0.8) {
    return {
      emoji: '👍',
      text: '不错！继续加油！',
      type: 'success',
      details: null
    };
  }

  // Below threshold - needs improvement
  const missingWords = words.filter(w => w.type === 'missing').map(w => w.word);
  const extraWords = words.filter(w => w.type === 'extra').map(w => w.word);

  let detailText = '';
  if (missingWords.length > 0) {
    detailText = `缺少: "${missingWords.slice(0, 3).join(', ')}"`;
    if (missingWords.length > 3) {
      detailText += ` 等${missingWords.length}个词`;
    }
  } else if (extraWords.length > 0) {
    detailText = `多说了: "${extraWords.slice(0, 3).join(', ')}"`;
  }

  if (score >= 0.5) {
    return {
      emoji: '⚠️',
      text: '需要改进',
      type: 'warning',
      details: detailText || '注意每个单词的发音'
    };
  }

  return {
    emoji: '🔄',
    text: '再试一次',
    type: 'retry',
    details: detailText || '慢慢来，仔细听原声'
  };
}

/**
 * Compare user recording with reference audio
 * @param {Blob} userRecording - User's recording
 * @param {string} referenceAudioUrl - Reference audio URL
 * @returns {Promise<Object>} - Comparison result
 */
export async function compareWithReference(userRecording, referenceAudioUrl) {
  // This is a placeholder for future implementation
  // Would involve:
  // 1. Speech-to-text on user recording
  // 2. Feature extraction from both recordings
  // 3. Comparison and scoring
  // 4. Word-level feedback

  console.log('[对比分析] 暂未实现详细对比功能');

  return {
    overallScore: 0.85,
    pronunciationScore: 0.9,
    fluencyScore: 0.8,
    completenessScore: 0.85,
    feedback: generateFeedback(0.85)
  };
}
