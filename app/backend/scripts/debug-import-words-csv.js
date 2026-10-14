/* eslint-disable no-console */
// Usage:
//   node app/backend/scripts/debug-import-words-csv.js "<csvOrTsvText>"
//
// This script is only for quickly checking delimiter/header detection logic.

function parseCsvLine(line) {
  const fields = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(currentField);
      currentField = '';
    } else {
      currentField += char;
    }
  }
  fields.push(currentField);
  return fields;
}

function parseDelimitedLine(line, delimiter) {
  if (delimiter === '\t') return String(line || '').split('\t');
  return parseCsvLine(String(line || ''));
}

function detectDelimiter(sample) {
  const lines = Array.isArray(sample) ? sample : [String(sample || '')];
  let tabCount = 0;
  let commaCount = 0;
  for (const line of lines) {
    const s = String(line || '');
    tabCount += (s.match(/\t/g) || []).length;
    commaCount += (s.match(/,/g) || []).length;
  }
  if (tabCount > 0 && tabCount >= commaCount) return '\t';
  return ',';
}

const input = process.argv.slice(2).join(' ');
if (!input) {
  console.log('No input.');
  process.exit(1);
}

const raw = String(input).replace(/\\n/g, '\n').replace(/^\uFEFF/, '').trim();
const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const delimiter = detectDelimiter(lines.slice(0, Math.min(lines.length, 20)));
const firstLine = lines[0].replace(/^\uFEFF/, '');
const firstFields = parseDelimitedLine(firstLine, delimiter).map(v => String(v || '').trim());
const firstFieldsLower = firstFields.map(v => v.toLowerCase());
const looksLikeHeader = firstFieldsLower.includes('word') || firstFieldsLower.includes('lemma');

console.log({ lines: lines.length, delimiter: delimiter === '\t' ? 'TSV' : 'CSV', looksLikeHeader, firstFields });

