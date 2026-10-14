#!/usr/bin/env node

/**
 * 诊断单词提取问题
 *
 * 用法：
 * node scripts/diagnose-word-extraction.js "I know, they're all over the neighborhood."
 */

// 复制video-reader.html中的单词提取逻辑
function extractWords(text) {
  const words = text
    .toLowerCase()
    .replace(/['']/g, "'")
    .split(/[\s\-—–]+/) // 先按空格和连字符分割
    .filter(word => {
      // 移除所有非字母、非连字符、非撇号的字符
      const cleaned = word.replace(/[^a-z'-]/gi, '');
      // 再移除首尾的连字符和撇号
      const trimmed = cleaned.replace(/^['\-]+|['\-]+$/g, '');

      // 过滤条件：
      // 1. 长度至少2个字符
      // 2. 包含至少一个字母
      // 3. 不是纯数字
      // 4. 不包含连续的特殊字符
      return trimmed.length >= 2 &&
             /[a-z]/i.test(trimmed) &&
             !/^\d+$/.test(trimmed) &&
             !/[']{2,}/.test(trimmed); // 不包含连续的撇号
    })
    .map(word => {
      // 最终清理：移除所有非字母、非连字符、非撇号的字符，再移除首尾的标点
      const cleaned = word.replace(/[^a-z'-]/gi, '');
      return cleaned.replace(/^['\-]+|['\-]+$/g, '');
    });

  return words;
}

// 复制wordHtml中的单词清理逻辑
function cleanWord(part) {
  const clean = part
    .replace(/['']/g, "'")  // 统一引号
    .replace(/[^a-z'-]/gi, '') // 移除非字母字符（保留连字符和撇号）
    .replace(/^['\-]+|['\-]+$/g, ''); // 移除首尾的连字符和撇号

  return clean;
}

// 测试
const testSentence = process.argv[2] || "I know, they're all over the neighborhood.";

console.log('原始句子:', testSentence);
console.log('');

const words = extractWords(testSentence);
console.log('提取的单词:');
words.forEach((word, index) => {
  console.log(`  ${index + 1}. "${word}"`);
});

console.log('');
console.log('测试 wordHtml 清理:');
const testWords = testSentence.split(/\s+/);
testWords.forEach(word => {
  const cleaned = cleanWord(word);
  if (cleaned && cleaned.length >= 2 && /[a-z]/i.test(cleaned)) {
    console.log(`  原文: "${word}" -> 清理后: "${cleaned}"`);
  }
});

console.log('');
console.log('检查 "neighborhood" 是否被正确提取:');
const hasNeighborhood = words.includes('neighborhood');
const hasNeighbor = words.includes('neighbor');
console.log(`  包含 "neighborhood": ${hasNeighborhood}`);
console.log(`  包含 "neighbor": ${hasNeighbor}`);

if (!hasNeighborhood && hasNeighbor) {
  console.log('');
  console.log('⚠️  警告: "neighborhood" 被错误地提取为 "neighbor"！');
} else if (hasNeighborhood) {
  console.log('');
  console.log('✅ "neighborhood" 正确提取！');
}
