'use strict';
// The importers, in detection order, and the one that claims a file.
const claudeCode = require('./claude-code-jsonl');
const kingLouie = require('./king-louie-json');
const markdown = require('./markdown-transcript');

// Markdown is last: it claims a file by its headings, the loosest test.
const IMPORTERS = Object.freeze([claudeCode, kingLouie, markdown]);

// The importer that claims the file, with what it read while deciding
// (`loaded`, for an importer that has to parse the whole file to know: its
// parse and preview take it back and do not read the file again), or null.
// `options` go to each importer's detect or load (size and line limits).
async function claimImporter(filePath, options) {
  for (const importer of IMPORTERS) {
    if (typeof importer.load === 'function') {
      const loaded = importer.load(filePath, options);
      if (loaded !== null && loaded !== undefined) return { importer, loaded };
    } else if (await importer.detect(filePath, options)) {
      return { importer, loaded: undefined };
    }
  }
  return null;
}

async function detectImporter(filePath, options) {
  const claimed = await claimImporter(filePath, options);
  return claimed ? claimed.importer : null;
}

module.exports = { IMPORTERS, detectImporter, claimImporter };
