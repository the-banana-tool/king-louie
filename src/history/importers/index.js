'use strict';
// The importers, in detection order, and the one that claims a file.
const claudeCode = require('./claude-code-jsonl');
const kingLouie = require('./king-louie-json');
const markdown = require('./markdown-transcript');

// Markdown is last: it claims a file by its headings, the loosest test.
const IMPORTERS = Object.freeze([claudeCode, kingLouie, markdown]);

async function detectImporter(filePath) {
  for (const importer of IMPORTERS) {
    if (await importer.detect(filePath)) return importer;
  }
  return null;
}

module.exports = { IMPORTERS, detectImporter };
