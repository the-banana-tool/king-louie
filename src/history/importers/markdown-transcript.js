'use strict';
// A Markdown transcript → a chat in the stored message shape (recall spec
// §10.2, stage H4). Markdown has no standard for "who said this", so the
// file is read with one of a few named heading patterns: detect() takes the
// first that fits, and preview() lists every one that fits so the owner can
// pick another before importing.
//
// What it does not do: a file has no times, so each message's timestamp is
// the file's mtime plus one second per message (an order, not a truth); a
// numbered section is one message, even when its text goes on to quote the
// other speaker; setext headings (underlined with === or ---) are not
// headings here.
const fs = require('fs');
const path = require('path');

const KIND = 'markdown-transcript';
const VERSION = 1;
const MAX_BYTES = 32 * 1024 * 1024;
const SAMPLE_CHARS = 200;
const HEADING_CHARS = 120;

const EXTENSION = /\.(md|markdown)$/i;
// An ATX heading: up to three spaces, one to six #, a space, the text, and
// an optional closing run of #.
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// "**User:** text", "User: text", "**User**: text" at the start of a section.
const ROLE_MARKER = /^[ \t]*(\*\*|__)?[ \t]*(user|assistant)[ \t]*(?::[ \t]*(?:\*\*|__)?|(?:\*\*|__)[ \t]*:)[ \t]*(.*)$/i;
const NUMBERED = (word) => new RegExp(`^${word}[ \\t]+#?\\d+[:.]?$`, 'i');

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// A heading's text as a speaker name: emphasis and a trailing colon off,
// spaces collapsed, lower case.
const nameOf = (text) => String(text).replace(/[*_`]/g, '').replace(/:\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const ROLES = new Set(['user', 'assistant']);

// Every heading outside a fenced code block, with its 1-based line number.
function scan(text) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const f = FENCE.exec(line);
    if (fence) {
      // Closed by a run of the same character, at least as long, alone.
      if (f && f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = null;
      return;
    }
    if (f) {
      // A backtick fence's info string holds no backtick (else it is inline code).
      if (f[1][0] === '~' || !f[2].includes('`')) fence = { char: f[1][0], length: f[1].length };
      return;
    }
    const h = HEADING.exec(line);
    if (h) headings.push({ line: index + 1, level: h[1].length, text: h[2].trim(), name: nameOf(h[2]) });
  });
  return { lines, headings };
}

// Sections whose role is the heading itself (User / Assistant at one level).
function speakerSections(level) {
  return ({ headings }) => headings
    .filter((h) => h.level === level && ROLES.has(h.name))
    .map((h) => ({ heading: h, role: h.name }));
}

// Numbered sections ("## Turn 3"): the role comes from a marker on the
// section's first line of text, else the sections alternate, starting with
// the user.
function numberedSections(word) {
  const re = NUMBERED(word);
  return ({ headings }) => headings
    .filter((h) => h.level === 2 && re.test(h.name))
    .map((h) => ({ heading: h, role: null }));
}

// Exactly two speakers at level 2, one of them "Assistant": the other is the
// user. ("User" and "Assistant" is the first pattern, not this one.)
function namedSections({ headings }) {
  const level2 = headings.filter((h) => h.level === 2 && h.name);
  const names = new Set(level2.map((h) => h.name));
  if (names.size !== 2 || !names.has('assistant') || names.has('user')) return [];
  return level2.map((h) => ({ heading: h, role: h.name === 'assistant' ? 'assistant' : 'user' }));
}

const PATTERN_LIST = [
  { id: 'user-assistant-h2', label: '## User / ## Assistant', sections: speakerSections(2) },
  { id: 'user-assistant-h3', label: '### User / ### Assistant', sections: speakerSections(3) },
  { id: 'turn-n', label: '## Turn N', sections: numberedSections('turn') },
  { id: 'message-n', label: '## Message N', sections: numberedSections('message') },
  { id: 'name-assistant', label: '## <Name> / ## Assistant', sections: namedSections }
];
const PATTERNS = Object.freeze(PATTERN_LIST.map(({ id, label }) => Object.freeze({ id, label })));

const trimBlankLines = (list) => {
  let from = 0;
  let to = list.length;
  while (from < to && !list[from].trim()) from += 1;
  while (to > from && !list[to - 1].trim()) to -= 1;
  return list.slice(from, to);
};

// The file read under one pattern: its messages in order (a section with no
// text is left out), and whether that makes it a conversation.
function readWith(pattern, doc) {
  const sections = pattern.sections(doc);
  const out = [];
  let empty = 0;
  let previous = null;
  sections.forEach((section, i) => {
    const next = sections[i + 1];
    let body = trimBlankLines(doc.lines.slice(section.heading.line, next ? next.heading.line - 1 : doc.lines.length));
    let role = section.role;
    if (role === null) {
      const marker = body.length ? ROLE_MARKER.exec(body[0]) : null;
      if (marker) {
        role = marker[2].toLowerCase();
        body = trimBlankLines([marker[3], ...body.slice(1)]);
      } else {
        role = previous === 'user' ? 'assistant' : 'user';
      }
    }
    previous = role;
    const text = body.join('\n');
    if (!text.trim()) { empty += 1; return; }
    out.push({ line: section.heading.line, heading: section.heading, role, text });
  });
  const fits = out.length >= 2 && out.some((m) => m.role === 'user') && out.some((m) => m.role === 'assistant');
  return { pattern, sections: out, empty, firstLine: sections.length ? sections[0].heading.line : null, fits };
}

// Throws TRANSCRIPT_TOO_LARGE or NOT_A_TRANSCRIPT; never returns a partial read.
function load(filePath, maxBytes = MAX_BYTES) {
  const name = typeof filePath === 'string' ? path.basename(filePath) : 'The file';
  if (typeof filePath !== 'string' || !EXTENSION.test(filePath)) throw fail('NOT_A_TRANSCRIPT', `${name} is not a Markdown transcript (.md or .markdown)`);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw fail('NOT_A_TRANSCRIPT', `${name} is not a file`);
  const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : MAX_BYTES;
  if (stat.size > limit) throw fail('TRANSCRIPT_TOO_LARGE', `${name} is larger than a Markdown transcript may be (${limit} bytes)`);
  return { name, mtimeMs: Math.floor(stat.mtimeMs), doc: scan(fs.readFileSync(filePath, 'utf8')) };
}

function patternById(id) {
  const pattern = PATTERN_LIST.find((p) => p.id === id);
  if (!pattern) throw fail('UNKNOWN_PATTERN', `Unknown transcript pattern ${JSON.stringify(id)}; known: ${PATTERN_LIST.map((p) => p.id).join(', ')}`);
  return pattern;
}

// The read to use: the chosen pattern's, or the first pattern's that fits.
function choose(filePath, { pattern, maxBytes } = {}) {
  const chosen = pattern === undefined || pattern === null ? null : patternById(pattern);
  const file = load(filePath, maxBytes);
  const reads = PATTERN_LIST.map((p) => readWith(p, file.doc));
  const read = chosen ? reads.find((r) => r.pattern === chosen) : reads.find((r) => r.fits);
  if (!read || !read.fits) {
    throw fail('NOT_A_TRANSCRIPT', chosen
      ? `${file.name} does not read as a transcript with the pattern ${chosen.label}`
      : `${file.name} is not a transcript: no heading pattern (${PATTERN_LIST.map((p) => p.label).join('; ')}) gives turns from both a user and an assistant`);
  }
  return { file, read, reads };
}

function build(filePath, { file, read }) {
  const { doc, mtimeMs } = file;
  const base = path.basename(filePath, path.extname(filePath));
  // The title: a level-1 heading on the file's first line of text.
  const firstText = doc.lines.findIndex((line) => line.trim());
  const lead = doc.headings.find((h) => h.line === firstText + 1 && h.level === 1 && h.line < read.firstLine);
  const title = lead && lead.text ? lead.text : base;
  let preamble = 0;
  for (let i = 0; i < read.firstLine - 1; i += 1) {
    if (doc.lines[i].trim() && !(lead && lead.line === i + 1)) preamble += 1;
  }
  const messages = read.sections.map((section, i) => ({
    id: `line-${section.line}`,
    seq: i + 1,
    timestamp: new Date(mtimeMs + i * 1000).toISOString(),
    sender: section.role,
    text: section.text
  }));
  const skipped = {};
  if (preamble) skipped.preamble = preamble;
  if (read.empty) skipped.empty = read.empty;
  return {
    chat: { id: `md-${base}`, title, source: KIND, createdAt: messages[0].timestamp, updatedAt: messages.at(-1).timestamp },
    messages,
    compactions: [],
    stats: { unmapped: 0, badLines: 0, duplicates: 0, skipped }
  };
}

const userTurns = (sections) => sections.filter((s) => s.role === 'user').length;

async function detect(filePath, { maxBytes } = {}) {
  try {
    const { doc } = load(filePath, maxBytes);
    return PATTERN_LIST.some((p) => readWith(p, doc).fits);
  } catch {
    return false;
  }
}

async function parse(filePath, { pattern, maxBytes } = {}) {
  return build(filePath, choose(filePath, { pattern, maxBytes }));
}

async function preview(filePath, { pattern, maxBytes } = {}) {
  const chosen = choose(filePath, { pattern, maxBytes });
  const { chat, messages } = build(filePath, chosen);
  return {
    title: chat.title,
    turns: userTurns(chosen.read.sections),
    sample: messages.slice(0, 5).map((m) => ({ seq: m.seq, sender: m.sender, text: m.text.slice(0, SAMPLE_CHARS) })),
    pattern: chosen.read.pattern.id,
    patterns: chosen.reads.filter((r) => r.fits).map((r) => ({ id: r.pattern.id, label: r.pattern.label, turns: userTurns(r.sections) })),
    roles: chosen.read.sections.slice(0, 5).map((s) => ({
      heading: `${'#'.repeat(s.heading.level)} ${s.heading.text}`.slice(0, HEADING_CHARS),
      role: s.role
    }))
  };
}

module.exports = { kind: KIND, version: VERSION, MAX_BYTES, PATTERNS, detect, preview, parse };
