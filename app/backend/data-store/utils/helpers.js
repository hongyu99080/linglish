/**
 * 检查句子中是否包含指定单词（使用词边界匹配）
 * @param {string} sentence - 要检查的句子
 * @param {string} word - 要查找的单词
 * @returns {boolean} - 是否包含该单词
 */
function containsWord(sentence, word) {
  if (!sentence || !word) return false;
  // 使用词边界 \b 确保完整单词匹配
  const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return regex.test(sentence);
}

function ensureRoleNames(roleCount, roleNames) {
  const k = Number(roleCount) || 2;
  const names = Array.isArray(roleNames) ? roleNames.filter((n) => typeof n === 'string') : [];
  if (names.length === k) return names;
  const out = [];
  for (let i = 0; i < k; i += 1) {
    out[i] = names[i] && names[i].trim() ? names[i].trim() : `Speaker ${i + 1}`;
  }
  return out;
}

module.exports = {
  containsWord,
  ensureRoleNames,
};
