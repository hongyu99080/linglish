const CURATED_ENTRIES = Object.freeze({
  meeting: Object.freeze({
    word: 'meeting',
    phonetic: 'ˈmiːtɪŋ',
    partOfSpeech: 'noun',
    meanings: Object.freeze([
      Object.freeze({
        partOfSpeech: 'noun',
        definitions: Object.freeze([
          Object.freeze({
            definition: 'An occasion when people come together to discuss or decide something.',
            zh: '会议；会面',
          }),
        ]),
      }),
    ]),
  }),
  the: Object.freeze({
    word: 'the',
    phonetic: 'ðə',
    partOfSpeech: 'determiner',
    meanings: Object.freeze([
      Object.freeze({
        partOfSpeech: 'determiner',
        definitions: Object.freeze([
          Object.freeze({
            definition: 'Used before a noun to refer to a particular person or thing already known or being discussed.',
            zh: '这；那；该（指已知或正在谈论的人或事物）',
          }),
        ]),
      }),
    ]),
  }),
  and: Object.freeze({
    word: 'and',
    phonetic: 'ænd',
    partOfSpeech: 'conjunction',
    meanings: Object.freeze([
      Object.freeze({
        partOfSpeech: 'conjunction',
        definitions: Object.freeze([
          Object.freeze({
            definition: 'Used to connect words, phrases, or clauses.',
            zh: '和；与；并且',
          }),
        ]),
      }),
    ]),
  }),
  have: Object.freeze({
    word: 'have',
    phonetic: 'hæv',
    partOfSpeech: 'verb',
    meanings: Object.freeze([
      Object.freeze({
        partOfSpeech: 'verb',
        definitions: Object.freeze([
          Object.freeze({
            definition: 'To own, hold, or possess something.',
            zh: '有；拥有',
          }),
        ]),
      }),
    ]),
  }),
});

const CURATED_WORDS = Object.freeze(Object.keys(CURATED_ENTRIES));

function getCuratedEntry(word) {
  const entry = CURATED_ENTRIES[String(word || '').trim().toLowerCase()];
  return entry ? structuredClone(entry) : null;
}

module.exports = {
  CURATED_WORDS,
  getCuratedEntry,
};
