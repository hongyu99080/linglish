// Lightweight post-editing for Chinese translations to improve fluency and terminology.
// Intentionally rule-based (no network / no paid APIs).

function postEditZh(sourceEn, targetZh) {
  const en = String(sourceEn || '');
  let zh = String(targetZh || '');
  if (!zh) return zh;

  // Normalize common punctuation spacing
  zh = zh.replace(/\s+([，。！？；：])/g, '$1').replace(/([，。！？；：])\s+/g, '$1');

  // Education terminology: "postsecondary school" is better rendered as "高等学府/高等院校"
  // Example: "Harvard University is a famous American postsecondary school."
  if (/post[-\s]?secondary\s+school/i.test(en)) {
    zh = zh.replace(/专上学校/g, '高等学府');
    zh = zh.replace(/大专学校/g, '高等学府');
    zh = zh.replace(/专上教育学校/g, '高等学府');
  }

  if (/post[-\s]?secondary\s+education/i.test(en)) {
    zh = zh.replace(/专上教育/g, '高等教育');
  }

  if (/post[-\s]?secondary\s+institution/i.test(en)) {
    zh = zh.replace(/专上学校/g, '高等学府');
    zh = zh.replace(/专上教育机构/g, '高等教育机构');
  }

  return zh;
}

module.exports = { postEditZh };

