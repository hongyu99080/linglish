#!/usr/bin/env node

const dataStore = require('../data-store');
const { CURATED_WORDS } = require('../services/dictionary/curated-entries');
const { createCurationService, normalizeScope } = require('../services/dictionary/curation');

const COMMANDS = new Set(['audit', 'plan', 'apply', 'rollback']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('--')) throw new Error(`UNKNOWN_ARGUMENT:${token}`);
    const name = token.slice(2);
    if (!['scope', 'expected-revisions', 'confirm', 'batch', 'limit'].includes(name)) {
      throw new Error(`UNKNOWN_OPTION:${name}`);
    }
    if (options[name] !== undefined) throw new Error(`DUPLICATE_OPTION:${name}`);
    const value = args[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`OPTION_VALUE_REQUIRED:${name}`);
    options[name] = value;
    index++;
  }
  return options;
}

function parseScopeValue(value, { required = false, curatedOnly = true } = {}) {
  if (value == null) {
    if (required) throw new Error('SCOPE_REQUIRED');
    return curatedOnly ? [...CURATED_WORDS] : null;
  }
  return normalizeScope(String(value).split(','), { required, curatedOnly });
}

function parseRevisionValue(value, scope) {
  if (!value) throw new Error('EXPECTED_REVISIONS_REQUIRED');
  const parsed = {};
  for (const pair of String(value).split(',')) {
    const match = pair.match(/^([a-z][a-z'-]{0,99})=(\d+)$/);
    if (!match) throw new Error('INVALID_EXPECTED_REVISIONS');
    if (parsed[match[1]] !== undefined) throw new Error(`DUPLICATE_EXPECTED_REVISION:${match[1]}`);
    parsed[match[1]] = Number(match[2]);
  }
  for (const word of scope) {
    if (!Number.isSafeInteger(parsed[word]) || parsed[word] < 1) throw new Error(`EXPECTED_REVISION_REQUIRED:${word}`);
  }
  if (Object.keys(parsed).some((word) => !scope.includes(word))) throw new Error('EXPECTED_REVISION_OUTSIDE_SCOPE');
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) throw new Error('COMMAND_REQUIRED:audit|plan|apply|rollback');
  const options = readOptions(rest);
  const allowedOptions = {
    audit: new Set(['scope', 'limit']),
    plan: new Set(['scope']),
    apply: new Set(['scope', 'expected-revisions', 'confirm']),
    rollback: new Set(['batch', 'confirm']),
  };
  const disallowed = Object.keys(options).find((name) => !allowedOptions[command].has(name));
  if (disallowed) throw new Error(`OPTION_NOT_ALLOWED:${command}:${disallowed}`);

  if (command === 'audit') {
    const limit = options.limit == null ? 500 : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('INVALID_LIMIT');
    return { command, readOnly: true, scope: parseScopeValue(options.scope, { curatedOnly: false }), limit };
  }
  if (command === 'plan') {
    return { command, readOnly: true, scope: parseScopeValue(options.scope) };
  }
  if (command === 'apply') {
    const scope = parseScopeValue(options.scope, { required: true });
    const expectedRevisions = parseRevisionValue(options['expected-revisions'], scope);
    if (options.confirm !== 'APPLY_DICTIONARY_QUALITY') throw new Error('CONFIRM_REQUIRED:APPLY_DICTIONARY_QUALITY');
    return { command, readOnly: false, scope, expectedRevisions };
  }

  if (!options.batch) throw new Error('BATCH_REQUIRED');
  if (options.confirm !== 'ROLLBACK_DICTIONARY_QUALITY') throw new Error('CONFIRM_REQUIRED:ROLLBACK_DICTIONARY_QUALITY');
  if (!UUID_PATTERN.test(options.batch)) throw new Error('INVALID_BATCH_ID');
  return { command, readOnly: false, batchId: options.batch };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  await dataStore.init();
  if (!dataStore.isDatabaseAvailable()) throw new Error('DATASTORE_UNAVAILABLE');
  const service = createCurationService();
  let result;
  if (options.command === 'audit') result = await service.audit({ scope: options.scope, limit: options.limit });
  else if (options.command === 'plan') result = await service.preview({ scope: options.scope });
  else if (options.command === 'apply') result = await service.apply({
    scope: options.scope,
    expectedRevisions: options.expectedRevisions,
    actor: { type: 'cli', id: process.env.USER || 'operator' },
  });
  else result = await service.rollback({
    batchId: options.batchId,
    actor: { type: 'cli', id: process.env.USER || 'operator' },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`dictionary-quality: ${error.message}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await dataStore.pool.end(); } catch (_) { }
    });
}

module.exports = { main, parseArgs };
