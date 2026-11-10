'use strict';

const { UsageError } = require('../errors');
const { mapOpenAiMessages } = require('./openai-messages');

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The caller adds the row's line number to a CONVERT_ROW message.
function defineConverter({ id, source, prefix, datasetId, needsConfig, columns, pairBy }) {
  const { repo, instanceId, trajectoryId, messages, license } = columns;
  return Object.freeze({
    id,
    source,
    prefix,
    datasetId,
    license: 'CC-BY-4.0',
    needsConfig,
    columns: Object.freeze({ ...columns }),
    describe(row) {
      if (!row || typeof row !== 'object') throw new UsageError('row is not an object', 'CONVERT_ROW');
      if (!nonEmptyString(row[repo])) throw new UsageError(`row has no repo (column ${repo})`, 'CONVERT_ROW');
      if (!Array.isArray(row[messages])) throw new UsageError(`row has no ${messages} (column ${messages})`, 'CONVERT_ROW');
      return {
        repo: row[repo],
        instanceId: row[instanceId] == null ? null : String(row[instanceId]),
        trajectoryId: row[trajectoryId] == null ? null : String(row[trajectoryId]),
        upstreamLicense: license && nonEmptyString(row[license]) ? row[license] : null
      };
    },
    toMessages(row) {
      return mapOpenAiMessages(row?.[messages], { pairBy });
    }
  });
}

const CONVERTERS = Object.freeze(Object.fromEntries(
  [require('./nebius-swe-rebench'), require('./open-swe-traces')]
    .map(defineConverter)
    .map((converter) => [converter.id, converter])
));

module.exports = { CONVERTERS };
