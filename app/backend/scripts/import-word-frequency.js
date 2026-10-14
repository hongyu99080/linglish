/**
 * Import Word Frequency Data
 *
 * Updates words table with frequency_rank based on standard word frequency lists.
 * Uses a combination of common English word lists ranked by frequency.
 *
 * Usage: node scripts/import-word-frequency.js
 */

require('dotenv').config();
const { Pool } = require('pg');

// Top 10000 most common English words by frequency
// This is a simplified list - in production, you'd want to use a more comprehensive source
// like COCA (Corpus of Contemporary American English) or Google Books Ngrams

const COMMON_WORDS_TOP_3000 = [
  // Top 100 (rank 1-100)
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
  'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
  'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
  'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
  // 101-200
  'is', 'was', 'are', 'been', 'has', 'had', 'did', 'does', 'were', 'being',
  'am', 'been', 'very', 'more', 'much', 'too', 'here', 'where', 'why', 'how',
  'many', 'each', 'few', 'those', 'both', 'between', 'own', 'same', 'long', 'little',
  'such', 'right', 'before', 'must', 'through', 'great', 'still', 'while', 'found', 'part',
  'may', 'should', 'might', 'since', 'though', 'without', 'enough', 'once', 'toward', 'upon',
  'never', 'always', 'really', 'something', 'nothing', 'everything', 'anything', 'someone', 'everyone', 'anyone',
  'place', 'thing', 'world', 'hand', 'life', 'home', 'night', 'house', 'man', 'woman',
  'child', 'children', 'word', 'fact', 'head', 'side', 'water', 'room', 'mother', 'father',
  'family', 'friend', 'school', 'money', 'story', 'point', 'government', 'company', 'number', 'problem',
  'system', 'program', 'question', 'group', 'country', 'area', 'week', 'month', 'today', 'morning',
  // 201-500 (more common words)
  'city', 'book', 'job', 'game', 'case', 'woman', 'team', 'eye', 'door', 'car',
  'body', 'music', 'face', 'paper', 'girl', 'boy', 'food', 'road', 'hour', 'war',
  'love', 'idea', 'kind', 'mind', 'heart', 'town', 'line', 'power', 'money', 'name',
  'word', 'business', 'issue', 'service', 'office', 'president', 'law', 'court', 'moment', 'voice',
  'reason', 'information', 'health', 'history', 'action', 'report', 'care', 'effect', 'view', 'study',
  'research', 'death', 'order', 'class', 'center', 'hope', 'level', 'form', 'development', 'control',
  'social', 'national', 'local', 'political', 'public', 'international', 'economic', 'military', 'human', 'personal',
  'real', 'best', 'small', 'large', 'major', 'important', 'different', 'possible', 'old', 'young',
  'black', 'white', 'big', 'little', 'able', 'high', 'low', 'early', 'late', 'next',
  'last', 'sure', 'true', 'free', 'full', 'special', 'hard', 'clear', 'strong', 'wrong',
  'open', 'close', 'simple', 'certain', 'single', 'past', 'likely', 'recent', 'common', 'poor',
  'whole', 'left', 'far', 'short', 'final', 'main', 'private', 'general', 'available', 'natural',
  'bad', 'happy', 'nice', 'beautiful', 'pretty', 'easy', 'difficult', 'necessary', 'perfect', 'ready',
  'start', 'begin', 'seem', 'help', 'show', 'hear', 'play', 'run', 'move', 'live',
  'believe', 'hold', 'bring', 'happen', 'write', 'provide', 'sit', 'stand', 'lose', 'pay',
  'meet', 'include', 'continue', 'set', 'learn', 'change', 'lead', 'understand', 'watch', 'follow',
  'stop', 'create', 'speak', 'read', 'allow', 'add', 'spend', 'grow', 'open', 'walk',
  'win', 'offer', 'remember', 'love', 'consider', 'appear', 'buy', 'wait', 'serve', 'die',
  'send', 'expect', 'build', 'stay', 'fall', 'cut', 'reach', 'kill', 'remain', 'suggest',
  'raise', 'pass', 'sell', 'require', 'report', 'decide', 'pull', 'develop', 'break', 'receive',
  // 501-1000
  'need', 'feel', 'put', 'try', 'leave', 'call', 'keep', 'let', 'mean', 'ask',
  'turn', 'tell', 'find', 'become', 'wear', 'carry', 'talk', 'drive', 'enter', 'produce',
  'eat', 'return', 'agree', 'support', 'hit', 'cover', 'catch', 'draw', 'choose', 'cause',
  'finish', 'drop', 'fight', 'throw', 'fill', 'push', 'imagine', 'seek', 'save', 'perform',
  'join', 'teach', 'touch', 'pick', 'enjoy', 'suppose', 'apply', 'share', 'accept', 'suffer',
  'explain', 'prevent', 'reduce', 'establish', 'prepare', 'wonder', 'maintain', 'force', 'avoid', 'replace',
  'realize', 'contain', 'relate', 'claim', 'achieve', 'discover', 'ensure', 'reflect', 'improve', 'handle',
  'identify', 'determine', 'publish', 'remove', 'address', 'represent', 'reveal', 'obtain', 'present', 'indicate',
  'appreciate', 'notice', 'express', 'train', 'miss', 'connect', 'afford', 'complete', 'collect', 'compare',
  'deliver', 'extend', 'experience', 'protect', 'measure', 'involve', 'exist', 'mention', 'attend', 'occur',
  // More words to fill 1000-3000 range
  'music', 'movie', 'film', 'song', 'show', 'dance', 'art', 'picture', 'photo', 'camera',
  'computer', 'phone', 'internet', 'website', 'email', 'message', 'video', 'technology', 'science', 'math',
  'language', 'english', 'chinese', 'spanish', 'french', 'japanese', 'german', 'italian', 'russian', 'arabic',
  'america', 'american', 'china', 'chinese', 'europe', 'european', 'asia', 'asian', 'africa', 'african',
  'doctor', 'teacher', 'student', 'worker', 'manager', 'police', 'lawyer', 'engineer', 'writer', 'artist',
  'animal', 'dog', 'cat', 'bird', 'fish', 'horse', 'cow', 'pig', 'chicken', 'sheep',
  'tree', 'flower', 'plant', 'garden', 'park', 'forest', 'river', 'lake', 'ocean', 'mountain',
  'weather', 'rain', 'snow', 'sun', 'wind', 'cloud', 'hot', 'cold', 'warm', 'cool',
  'breakfast', 'lunch', 'dinner', 'meal', 'drink', 'coffee', 'tea', 'milk', 'juice', 'beer',
  'restaurant', 'hotel', 'airport', 'station', 'hospital', 'bank', 'store', 'shop', 'market', 'mall',
  // Additional common verbs
  'wake', 'sleep', 'dream', 'cry', 'laugh', 'smile', 'sing', 'fly', 'swim', 'climb',
  'jump', 'kick', 'ride', 'cook', 'clean', 'wash', 'fix', 'check', 'test', 'plan',
  'design', 'manage', 'organize', 'control', 'operate', 'solve', 'analyze', 'evaluate', 'assess', 'review',
  // Common adjectives
  'quiet', 'loud', 'soft', 'rough', 'smooth', 'heavy', 'light', 'thick', 'thin', 'wide',
  'narrow', 'deep', 'shallow', 'fast', 'slow', 'quick', 'safe', 'dangerous', 'careful', 'careless',
  'smart', 'stupid', 'clever', 'wise', 'foolish', 'crazy', 'normal', 'strange', 'weird', 'odd',
  'rich', 'expensive', 'cheap', 'valuable', 'useful', 'useless', 'helpful', 'harmful', 'positive', 'negative',
  // Common nouns
  'baby', 'adult', 'person', 'people', 'citizen', 'member', 'leader', 'chief', 'boss', 'employee',
  'customer', 'client', 'patient', 'guest', 'visitor', 'neighbor', 'stranger', 'enemy', 'partner', 'couple',
  'marriage', 'wedding', 'birthday', 'holiday', 'vacation', 'trip', 'journey', 'adventure', 'experience', 'memory',
  'thought', 'feeling', 'emotion', 'mood', 'attitude', 'behavior', 'habit', 'skill', 'ability', 'talent',
  'knowledge', 'wisdom', 'truth', 'lie', 'secret', 'mystery', 'answer', 'solution', 'method', 'technique',
  'process', 'procedure', 'step', 'stage', 'phase', 'period', 'term', 'season', 'century', 'decade',
  'future', 'past', 'present', 'tomorrow', 'yesterday', 'tonight', 'afternoon', 'evening', 'midnight', 'noon',
  'second', 'minute', 'hour', 'day', 'week', 'month', 'year', 'age', 'generation', 'era',
];

async function importWordFrequency() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('Starting word frequency import...');
    console.log(`Total words in frequency list: ${COMMON_WORDS_TOP_3000.length}`);

    // Create a map of word -> rank
    const wordRanks = new Map();
    COMMON_WORDS_TOP_3000.forEach((word, index) => {
      const normalized = word.toLowerCase().trim();
      if (!wordRanks.has(normalized)) {
        wordRanks.set(normalized, index + 1);
      }
    });

    console.log(`Unique words in frequency list: ${wordRanks.size}`);

    // Update words in database
    let updated = 0;
    let notFound = 0;

    for (const [word, rank] of wordRanks) {
      const result = await pool.query(
        `UPDATE words SET frequency_rank = $1, updated_at = NOW()
         WHERE word_lowercase = $2 AND (frequency_rank IS NULL OR frequency_rank = 0)
         RETURNING id`,
        [rank, word]
      );

      if (result.rowCount > 0) {
        updated++;
      } else {
        notFound++;
      }
    }

    console.log(`\nResults:`);
    console.log(`  Updated: ${updated} words`);
    console.log(`  Not found in DB: ${notFound} words`);

    // Also update words that aren't in our list but exist in DB
    // Give them a default rank based on lookup_count (more popular = lower rank)
    console.log('\nAssigning default ranks to remaining words based on popularity...');

    const remainingResult = await pool.query(`
      WITH ranked_words AS (
        SELECT id,
               CASE
                 WHEN lookup_count >= 100 THEN 3001 + ROW_NUMBER() OVER (PARTITION BY (lookup_count >= 100) ORDER BY lookup_count DESC, id)
                 WHEN lookup_count >= 10 THEN 5001 + ROW_NUMBER() OVER (PARTITION BY (lookup_count >= 10 AND lookup_count < 100) ORDER BY lookup_count DESC, id)
                 ELSE 8001 + ROW_NUMBER() OVER (PARTITION BY (lookup_count < 10 OR lookup_count IS NULL) ORDER BY lookup_count DESC NULLS LAST, id)
               END as computed_rank
        FROM words
        WHERE frequency_rank IS NULL OR frequency_rank = 0
      )
      UPDATE words w
      SET frequency_rank = rw.computed_rank,
          updated_at = NOW()
      FROM ranked_words rw
      WHERE w.id = rw.id
      RETURNING w.id
    `);

    console.log(`  Assigned default ranks to: ${remainingResult.rowCount} additional words`);

    // Show summary
    const summaryResult = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE frequency_rank <= 3000) as beginner,
        COUNT(*) FILTER (WHERE frequency_rank > 3000 AND frequency_rank <= 8000) as intermediate,
        COUNT(*) FILTER (WHERE frequency_rank > 8000) as advanced
      FROM words
      WHERE frequency_rank > 0
    `);

    const summary = summaryResult.rows[0];
    console.log('\nWord distribution by level:');
    console.log(`  Beginner (rank 1-3000): ${summary.beginner}`);
    console.log(`  Intermediate (rank 3001-8000): ${summary.intermediate}`);
    console.log(`  Advanced (rank 8001+): ${summary.advanced}`);
    console.log(`  Total with rank: ${summary.total}`);

    console.log('\nWord frequency import complete!');

  } catch (err) {
    console.error('Error importing word frequency:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

importWordFrequency().catch(console.error);
