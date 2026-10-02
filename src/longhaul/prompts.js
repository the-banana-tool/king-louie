'use strict';
// Versioned prompt files (benchmark spec §8.1, §11). Each is read with the
// SHA-256 of its exact bytes, and the hashes go into every run's
// config.json, so a result names the prompt that produced it. A prompt is
// never edited in place: a change is a new file (answer-v2.md) and a new
// PROMPTS entry. Placeholders are {{name}}; fillTemplate replaces them in
// one pass, so a value that itself holds "{{question}}" or "$&" (message
// text often does) is inserted verbatim.
const fs = require('fs');
const path = require('path');
const { sha256Text } = require('./files');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const PROMPTS = Object.freeze({
  answer: 'answer-v1.md',
  judge: 'judge-v1.md',
  summarize: 'summarize-v1.md',
  author: 'author-v1.md'
});
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function loadPrompt(name) {
  const file = PROMPTS[name];
  if (!file) throw new Error(`unknown prompt ${JSON.stringify(name)}`);
  const text = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
  return { name, file, text, sha256: sha256Text(text) };
}

function placeholders(template) {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}

function fillTemplate(template, values) {
  const missing = placeholders(template).filter((k) => !(k in values));
  if (missing.length) throw new Error(`prompt needs ${missing.join(', ')}`);
  return template
    .split(/(\{\{\w+\}\})/)
    .map((part) => {
      const m = /^\{\{(\w+)\}\}$/.exec(part);
      return m ? String(values[m[1]]) : part;
    })
    .join('');
}

module.exports = { PROMPTS, PROMPTS_DIR, loadPrompt, placeholders, fillTemplate };
