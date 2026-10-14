/**
 * Check if a translation is a placeholder
 * @param {string} value - Translation text
 * @returns {boolean} - True if it's a placeholder
 */
function isPlaceholderTranslation(value) {
  return typeof value === 'string' && (value.startsWith('[译]') || value.startsWith('[待翻译]'));
}

/**
 * Clean translation text, removing unnecessary marks and formatting
 * @param {string} translation - Raw translation text
 * @returns {string} - Cleaned translation
 */
function cleanTranslation(translation) {
  if (!translation || typeof translation !== 'string') {
    return translation;
  }

  let cleaned = translation;

  // 1. 移除HTML标签和实体（防止MyMemory返回垃圾广告）
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/&[a-z]+;/gi, '');

  // 2. 移除方括号内的拼音（如 [ying3 pian4]）
  cleaned = cleaned.replace(/\s*\[[a-z0-9\s]+\]/gi, '');

  // 3. 移除圆括号内的拼音（如 (jiào yuǎn de)）
  cleaned = cleaned.replace(/\s*\([a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ\s0-9]+\)/gi, '');

  // 4. 移除词性标记：v. n. adj. adv. prep. conj. pron. etc.
  cleaned = cleaned.replace(/\b(v|n|adj|adv|prep|conj|pron|vt|vi|int|art|num|abbr)\.\s*/gi, '');

  // 5. 处理繁体/简体重复格式：較遠的 较远的 → 较远的（移除繁体）
  cleaned = cleaned.replace(/([\u4E00-\u9FA5]+)\s+([\u4E00-\u9FA5]+)(?=\s|$)/g, (match, trad, simp) => {
    // 如果两个词长度相同且不完全一样，很可能是繁简对应，保留第二个（简体）
    if (trad.length === simp.length && trad !== simp) {
      return simp;
    }
    return match; // 否则保持原样
  });

  // 6. 移除繁体/简体双语格式：較遠的 / 较远的 → 较远的
  cleaned = cleaned.replace(/[\u4E00-\u9FA5]+\s*[\/／]\s*([\u4E00-\u9FA5]+)/g, '$1');

  // 7. 移除开头的原英文单词（如"number 序列号" → "序列号"）
  // 只有当英文单词后面紧跟中文时才移除
  cleaned = cleaned.replace(/^[a-zA-Z]+\s+([\u4E00-\u9FA5])/g, '$1');

  // 8. 移除URL和邮箱
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/gi, '');
  cleaned = cleaned.replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '');

  // 9. 移除QQ号、电话号等数字串
  cleaned = cleaned.replace(/QQ\s*[0-9]+/gi, '');
  cleaned = cleaned.replace(/\b[0-9]{6,}\b/g, '');

  // 10. 移除常见的垃圾文本标记
  const spamMarkers = ['狗窝吧', '提供繁简中文汉化支持', '【', '】', '薛定谔'];
  spamMarkers.forEach(marker => {
    cleaned = cleaned.replace(new RegExp(marker, 'g'), '');
  });

  // 11. 清理空格和标点
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/\s*,\s*/g, '，');
  cleaned = cleaned.replace(/\s*;\s*/g, '；');

  // 12. 移除连续的重复标点
  cleaned = cleaned.replace(/([，。；：、])\1+/g, '$1');

  // 13. 移除首尾的标点符号和特殊字符
  cleaned = cleaned.replace(/^[，。；：、\|\s]+|[，。；：、\|\s]+$/g, '');

  // 14. 如果清理后只剩下标点或空白，返回空字符串
  if (!cleaned || /^[\s，。；：、\|\-]+$/.test(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Detect and translate proper nouns
 * @param {string} word - Word to check
 * @returns {string|null} - Translation with label or null if not a proper noun
 */
function detectProperNoun(word) {
  const normalized = word.toLowerCase();

  // 检测是否是专有名词（首字母大写）
  const isCapitalized = word && word[0] === word[0].toUpperCase() && word.slice(1).toLowerCase() === word.slice(1);

  if (!isCapitalized) {
    return null; // 不是专有名词
  }

  // 检测地名（常见地名后缀）
  const placeSuffixes = ['ton', 'ville', 'burg', 'borough', 'ford', 'field', 'wood', 'land', 'port', 'chester', 'shire', 'bridge', 'ham', 'stead', 'mouth', 'pool', 'minster'];
  if (placeSuffixes.some(suffix => normalized.endsWith(suffix))) {
    return `${word}（地名）`;
  }

  // 检测软件/品牌名称（全大写或驼峰命名）
  const isBrandLike = /^[A-Z][a-z]*$/.test(word) || /^[A-Z]+$/.test(word) || /^[A-Z][a-z]+[A-Z]/.test(word);
  const techBrandKeywords = ['soft', 'tech', 'app', 'ware', 'sys', 'net', 'web', 'data', 'cloud', 'link', 'book', 'gram', 'tube'];
  if (isBrandLike && techBrandKeywords.some(kw => normalized.includes(kw))) {
    return `${word}（品牌/软件）`;
  }

  // 检测人名（常见名字模式）
  const commonNameEndings = ['son', 'sen', 'ez', 'ski', 'ov', 'ova', 'ian', 'yan', 'man', 'er'];
  if (commonNameEndings.some(ending => normalized.endsWith(ending)) && word.length >= 4) {
    return `${word}（人名）`;
  }

  // 短词（2-5个字母）全大写可能是缩写
  if (word.length >= 2 && word.length <= 5 && /^[A-Z]+$/.test(word)) {
    return `${word}（缩写）`;
  }

  // 默认：保留原词并标注为专有名词
  return `${word}（专有名词）`;
}

/**
 * Check if a word is possibly a proper name
 * @param {string} word - Word to check
 * @returns {boolean} - True if it looks like a proper name
 */
function isPossibleProperName(word) {
  // 首字母大写通常是人名或地名
  if (word && word[0] === word[0].toUpperCase() && word.slice(1).toLowerCase() === word.slice(1)) {
    return true;
  }

  // 常见人名/地名后缀
  const properNameSuffixes = ['ton', 'ville', 'burg', 'ford', 'field', 'wood', 'land', 'port', 'chester'];
  if (properNameSuffixes.some(suffix => word.toLowerCase().endsWith(suffix))) {
    return true;
  }

  return false;
}

/**
 * Check if original word is onomatopoeia/interjection
 * @param {string} word - Word to check
 * @returns {boolean} - True if it's onomatopoeia/interjection
 */
function isOnomatopoeia(word) {
  const normalized = word.toLowerCase().replace(/[!?.]/g, '');

  // Common onomatopoeia patterns
  const patterns = [
    /^(wh?ee+|yay+|yee+|whoo+|woo+|yoo+|yeah+)$/i,  // 兴奋: weeee, yay, yeah
    /^(ow+|ouch+|ugh+|argh+|oof+|ack+)$/i,          // 痛苦: ouch, ow
    /^(shh+|psst+|tsk+|hm+|uh+|er+|um+)$/i,         // 语气词: shh, hmm
    /^(ha+|he+|ho+)$/i,                              // 笑声: haha, hehe
    /^(boo+|eek+|ahh+|oh+)$/i,                       // 惊讶: boo, eek
    /^(zzz+|snore+)$/i,                              // 睡觉: zzz
  ];

  return patterns.some(pattern => pattern.test(normalized));
}

/**
 * Check if translation is valid
 * @param {string} translation - Translation text
 * @param {string} originalWord - Original word
 * @returns {boolean} - True if translation is valid
 */
function isValidTranslation(translation, originalWord) {
  if (!translation || typeof translation !== 'string') {
    return false;
  }

  // 检查原词是否是不完整的缩写词（应该被拒绝）
  const incompleteContractions = ['didn', 'doesn', 'wasn', 'weren', 'haven', 'hasn', 'hadn', 'wouldn', 'shouldn', 'couldn', 'mightn', 'mustn'];
  if (incompleteContractions.includes(originalWord.toLowerCase())) {
    console.log(`[Translation Validation] Incomplete contraction detected: "${originalWord}"`);
    return false;
  }

  // 翻译不应该完全等于原文（说明翻译失败）
  const translationLower = translation.toLowerCase();
  const originalLower = originalWord.toLowerCase();

  // 如果完全相同或仅大小写不同，检查是否是人名/地名/品牌名
  if (translationLower === originalLower) {
    // For proper nouns and brand names, if translation is the same as original (case-insensitive),
    // this is actually valid for brands/proper nouns that don't translate
    // Accept it as valid to allow Google Translate's result to be used
    if (isPossibleProperName(originalWord)) {
      console.log(`[Translation Validation] Proper name returned as-is (valid): "${translation}"`);
      return true; // Accept as valid translation (proper noun)
    }

    // Check if it's a brand name or technical term (usually capitalized or all caps)
    const isLikelyBrandName = /^[A-Z][a-z]*$/.test(originalWord) || /^[A-Z]+$/.test(originalWord);
    if (isLikelyBrandName) {
      console.log(`[Translation Validation] Likely brand/technical name returned as-is (valid): "${translation}"`);
      return true; // Accept as valid translation (brand name)
    }

    console.log(`[Translation Validation] Translation identical to original: "${translation}"`);
    return false;
  }

  // 【放宽验证】检查中文字符数量，但更宽松
  const translationClean = translation.replace(/[\s，。！？；：、""''《》【】（）]/g, '');
  const chineseChars = (translationClean.match(/[\u4e00-\u9fa5]/g) || []).length;

  // 对于短词（≤6字母），1个中文字符就够了
  // 对于长词，至少需要2个中文字符
  // 但如果有中文字符，就不要因为包含原词而拒绝（技术术语通常如此）
  const minChineseChars = originalWord.length <= 6 ? 1 : 2;

  // 只有在完全没有足够中文字符，且翻译基本就是原词时才拒绝
  if (chineseChars < minChineseChars) {
    // 检查是否翻译主要就是原词（去除标点后80%以上是原词）
    const englishInTranslation = translationClean.replace(/[\u4e00-\u9fa5]/g, '');
    const originalRatio = englishInTranslation.toLowerCase().includes(originalLower) ?
      originalLower.length / translationClean.length : 0;

    if (originalRatio > 0.8) {
      console.log(`[Translation Validation] Translation is mostly original word with too few Chinese characters: "${translation}"`);
      return false;
    }
  }

  // 单词翻译长度不应该超过原词的15倍（放宽限制，防止返回整段话）
  if (translation.length > originalWord.length * 15) {
    console.log(`[Translation Validation] Translation too long: "${translation}" for word "${originalWord}"`);
    return false;
  }

  // 翻译不应该包含过多标点符号（可能是句子而非词义）
  // 但是允许用逗号、顿号分隔的多个同义词，这是好的翻译
  // 对于复杂定义（特别是金融、技术术语），允许更多标点来准确传达含义
  const punctuationCount = (translation.match(/[。！？；：""''《》【】（）]/g) || []).length;
  const commaCount = (translation.match(/[，、]/g) || []).length;

  // 动态限制：根据翻译长度调整允许的标点数量
  // 短翻译（<20字符）：最多3个标点
  // 中等翻译（20-50字符）：最多8个标点
  // 长翻译（>50字符）：最多15个标点
  let maxPunctuation;
  if (translation.length < 20) {
    maxPunctuation = 3;
  } else if (translation.length < 50) {
    maxPunctuation = 8;
  } else {
    maxPunctuation = 15;
  }

  if (punctuationCount > maxPunctuation) {
    console.log(`[Translation Validation] Too many punctuation marks (${punctuationCount}/${maxPunctuation} for length ${translation.length}): "${translation}"`);
    return false;
  }

  // 逗号限制也放宽：短翻译5个，长翻译10个
  const maxCommas = translation.length < 30 ? 5 : 10;
  if (commaCount > maxCommas) {
    console.log(`[Translation Validation] Too many commas (${commaCount}/${maxCommas}): "${translation}"`);
    return false;
  }

  // 检查是否包含不应该出现的英文字母（翻译应该主要是中文）
  // 但放宽标准：如果翻译中有足够的中文字符，允许一些英文字母
  const englishLetterCount = (translation.match(/[a-zA-Z]/g) || []).length;

  // 如果有至少3个中文字符，允许最多40%的英文字母
  // 否则，允许最多20%的英文字母
  const maxEnglishRatio = chineseChars >= 3 ? 0.4 : 0.2;

  if (englishLetterCount > translation.length * maxEnglishRatio) {
    console.log(`[Translation Validation] Too many English letters (${englishLetterCount}/${translation.length}): "${translation}"`);
    return false;
  }

  // 检查是否包含奇怪的符号（波浪号、下划线、星号等）
  const weirdSymbols = /[~_*#@$%^&+=<>|\\]/;
  if (weirdSymbols.test(translation)) {
    console.log(`[Translation Validation] Contains weird symbols: "${translation}"`);
    return false;
  }

  // 检查是否包含拟声词（通常是翻译错误，除非原词本身就是拟声词）
  const onomatopoeiaChars = ['哗', '啪', '咚', '嘭', '呼', '嗖', '咔', '砰', '嘶', '呜', '哐', '咣', '咕', '嘟', '哎', '呀'];
  if (onomatopoeiaChars.some(sound => translation.includes(sound))) {
    // 如果原词本身是拟声词/感叹词，翻译成拟声词是合理的
    if (originalWord && isOnomatopoeia(originalWord)) {
      console.log(`[Translation Validation] Original word is onomatopoeia, allowing onomatopoeia in translation: "${translation}"`);
      return true; // 允许
    }
    console.log(`[Translation Validation] Contains onomatopoeia: "${translation}"`);
    return false;
  }

  return true;
}

/**
 * Detect common error patterns in translation
 * @param {string} translation - Translation text
 * @param {string} originalWord - Original word
 * @returns {Array<string>} - Array of error pattern names
 */
function detectErrorPatterns(translation, originalWord) {
  const errors = [];

  // 错误模式1: 专业术语/生僻词（包含不常见的字）
  const uncommonChars = ['铣', '削', '焊', '镀', '锻', '铸', '轧', '淬', '钎', '铆', '钳', '铲', '锉', '锯', '锤', '锥', '钻', '铝', '铜', '铁', '钢', '镍'];
  if (uncommonChars.some(char => translation.includes(char))) {
    // 排除一些确实包含这些字的常用词
    const validExceptions = ['钢笔', '铁路', '地铁', '铜币'];
    if (!validExceptions.some(ex => translation.includes(ex))) {
      errors.push('contains_technical_terms');
    }
  }

  // 错误模式1.5: 机械/工业专用词
  const technicalTerms = ['车削', '铣削', '焊接', '锻造', '铸造', '轧制', '淬火', '回火', '钎焊'];
  if (technicalTerms.some(term => translation.includes(term))) {
    errors.push('mechanical_term');
  }

  // 错误模式2: 音译而非意译（单字且与原词长度接近）
  const chineseCharCount = (translation.match(/[\u4e00-\u9fa5]/g) || []).length;
  // 排除常见的合理单字翻译
  const validSingleCharWords = {
    'ok': ['好', '行', '可以'],
    'bye': ['拜'],
    'no': ['不', '否'],
    'yes': ['是'],
    'one': ['一'],
    'two': ['二'],
    'three': ['三'],
    'four': ['四'],
    'five': ['五'],
    'six': ['六'],
    'seven': ['七'],
    'eight': ['八'],
    'nine': ['九'],
    'ten': ['十'],
  };

  const isValidSingleChar = validSingleCharWords[originalWord.toLowerCase()]?.includes(translation);

  if (chineseCharCount === 1 && originalWord.length <= 3 && !isValidSingleChar) {
    errors.push('possible_transliteration');
  }

  // 错误模式3: 时间相关的错误（星期、月份等）
  const timeWords = ['周一', '周二', '周三', '周四', '周五', '周六', '周日', '星期'];
  if (timeWords.some(word => translation.includes(word)) &&
      !['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'week'].includes(originalWord.toLowerCase())) {
    errors.push('incorrect_time_translation');
  }

  // 错误模式4: 方向词错误映射
  const directionMap = {
    'left': ['左', '左边', '左转'],
    'right': ['右', '右边', '对', '正确'],
    'up': ['上', '向上'],
    'down': ['下', '向下'],
    'turn': ['转', '转弯', '转向'],
    'straight': ['直', '笔直', '直接'],
  };
  for (const [word, validTranslations] of Object.entries(directionMap)) {
    if (originalWord.toLowerCase() === word) {
      if (!validTranslations.some(valid => translation.includes(valid))) {
        errors.push('incorrect_direction');
      }
    }
  }

  // 错误模式5: 代词错误
  const pronounMap = {
    'we': ['我们'],
    'they': ['他们', '她们', '它们'],
    'you': ['你', '您'],
    'i': ['我'],
    'he': ['他'],
    'she': ['她'],
    'it': ['它', '这'],
  };
  for (const [word, validTranslations] of Object.entries(pronounMap)) {
    if (originalWord.toLowerCase() === word) {
      if (!validTranslations.some(valid => translation.includes(valid))) {
        errors.push('incorrect_pronoun');
      }
    }
  }

  // 错误模式6: 不完整的翻译（以量词、助词开头或结尾）
  const incompleteStarters = ['个', '在', '的', '了', '是', '和', '与', '或', '但', '及', '以'];
  const incompleteEnders = ['的', '了', '着', '过', '中', '上', '下'];
  if (incompleteStarters.some(starter => translation.startsWith(starter)) ||
      incompleteEnders.some(ender => translation.endsWith(ender) && chineseCharCount <= 3)) {
    errors.push('incomplete_translation');
  }

  // 错误模式7: 包含问号或特殊符号（表示翻译不确定）
  if (translation.includes('？') || translation.includes('?') ||
      translation.includes('[') || translation.includes(']')) {
    errors.push('uncertain_translation');
  }

  // 错误模式7.5: 包含奇怪符号（波浪号、下划线等）
  const weirdSymbols = /[~_*#@$%^&+=<>|\\]/;
  if (weirdSymbols.test(translation)) {
    errors.push('weird_symbols');
  }

  // 错误模式7.6: 包含拟声词（通常是低质量翻译，除非原词本身是拟声词）
  const onomatopoeiaList = ['哗', '啪', '咚', '嘭', '呼', '嗖', '咔', '砰', '嘶', '呜', '哐', '咣', '咕', '嘟', '哎', '呀'];
  if (onomatopoeiaList.some(sound => translation.includes(sound))) {
    // 如果原词本身是拟声词/感叹词，翻译成拟声词是合理的
    if (!isOnomatopoeia(originalWord)) {
      errors.push('onomatopoeia');
    }
  }

  // 错误模式8: 生僻词检测（使用不常见的字）
  // 注意：移除了"尔"（常用于人名音译如"撒切尔"）、"缓和"和"减轻"（常用词）
  const uncommonWords = ['唤作', '曰', '乃', '矣', '焉', '兮', '於', '吾', '汝'];
  if (uncommonWords.some(word => translation.includes(word))) {
    errors.push('archaic_or_uncommon');
  }

  // 错误模式9: 单字翻译但原词是常见多音节词（很可能不准确）
  if (chineseCharCount === 1 && originalWord.length > 4) {
    const commonWords = ['understand', 'beautiful', 'important', 'different', 'information'];
    if (commonWords.includes(originalWord.toLowerCase())) {
      errors.push('oversimplified_translation');
    }
  }

  return errors;
}

/**
 * Score translation quality (higher is better)
 * @param {string} translation - Translation text
 * @param {string} originalWord - Original word (optional)
 * @returns {number} - Quality score (0-100+)
 */
function scoreTranslation(translation, originalWord = '') {
  let score = 100;

  // Special handling for proper nouns: if translation contains parentheses annotation
  // (e.g., "Facebook（社交平台）"), give it a high score as it's well-annotated
  if (translation.includes('（') && translation.includes('）')) {
    const hasProperNounPattern = /^[A-Za-z\s]+（[^）]+）$/.test(translation);
    if (hasProperNounPattern) {
      console.log(`[Translation Quality] Detected annotated proper noun: "${translation}" (high score)`);
      return 150; // High score for well-annotated proper nouns
    }
  }

  // 长度惩罚：翻译越短越好（合理范围内）
  if (translation.length > 20) {
    score -= (translation.length - 20) * 2;
  }

  // 标点符号惩罚（但不要太严格）
  const punctuationCount = (translation.match(/[，。！？；：、""''《》【】（）]/g) || []).length;
  score -= punctuationCount * 3; // 降低惩罚从5到3

  // 括号内容惩罚（括号通常表示额外说明，不是核心翻译）
  const bracketCount = (translation.match(/[（(][^)）]+[)）]/g) || []).length;
  score -= bracketCount * 10;

  // 顿号/逗号分隔的多个选项是好的（表示多个含义）
  const commaCount = (translation.match(/、|，/g) || []).length;
  if (commaCount >= 1 && commaCount <= 3) {
    score += 15; // 提高奖励
  }

  // 检测常见错误模式并严重惩罚
  if (originalWord) {
    const errors = detectErrorPatterns(translation, originalWord);
    if (errors.length > 0) {
      console.log(`[Translation Quality] Detected error patterns for "${originalWord}" -> "${translation}": ${errors.join(', ')}`);
      score -= errors.length * 25; // 降低惩罚从30到25
    }
  }

  // 简洁度加分（2-8个字的翻译是最理想的）
  const chineseCharCount = (translation.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (chineseCharCount >= 2 && chineseCharCount <= 8) {
    score += 20; // 提高奖励
  } else if (chineseCharCount >= 1 && chineseCharCount <= 2) {
    score += 12; // 1-2个字也不错
  }

  // 如果翻译纯粹是中文（没有英文字母），加分
  const englishLetterCount = (translation.match(/[a-zA-Z]/g) || []).length;
  if (englishLetterCount === 0 && chineseCharCount >= 2) {
    score += 10; // 纯中文翻译加分
  }

  // 常见词汇加分（包含常用字）
  const commonChars = ['的', '了', '在', '是', '人', '有', '中', '大', '为', '上', '个', '国', '我', '以', '要', '他', '时', '来', '用', '们', '生', '到', '作', '地', '于', '出', '就', '分', '对', '成', '会', '可', '主', '发', '年', '动', '同', '工', '也', '能', '下', '得', '说', '看', '着', '子', '经', '去', '过', '想', '好', '道', '小', '多', '之', '最', '自'];
  const commonCharCount = translation.split('').filter(char => commonChars.includes(char)).length;
  if (commonCharCount > 0) {
    score += commonCharCount * 2; // 降低每个常用字的加分从3到2，避免过度奖励
  }

  // 完整词组加分（包含常见词组结构）
  const goodPatterns = ['...的', '...了', '...着', '...过', '...起来', '...下去', '...出来', '...进去'];
  const hasGoodPattern = goodPatterns.some(pattern => {
    const regex = new RegExp(pattern.replace('...', '.+'));
    return regex.test(translation);
  });
  if (hasGoodPattern) {
    score += 8; // 提高奖励
  }

  // 如果原词较短（<=5个字母）且翻译简洁（2-4个中文字符），额外加分
  if (originalWord && originalWord.length <= 5 && chineseCharCount >= 2 && chineseCharCount <= 4) {
    score += 10;
  }

  return Math.max(0, score);
}

module.exports = {
  isPlaceholderTranslation,
  cleanTranslation,
  detectProperNoun,
  isPossibleProperName,
  isOnomatopoeia,
  isValidTranslation,
  detectErrorPatterns,
  scoreTranslation,
};
