// src/history/chunker.js
// How one stored message becomes chunks (recall spec §4.3), the same for
// native and imported messages. splitProse is the prose splitter of the old
// conversation compactor (since removed), with its sizes as options.
const CHUNK_DEFAULTS = Object.freeze({ targetChars: 1500, minChars: 40 });
const SUMMARY_MAX = 200;
// Tools whose written text is indexed as prose besides the one-line summary.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
// Parameter keys that make the one-line summary, in order of preference:
// the command (shell tools), the path (file tools), the query (search tools).
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'notebook_path', 'query', 'pattern', 'url'];

function sizes(options = {}) {
  const targetChars = Number.isFinite(options.targetChars) && options.targetChars > 0 ? options.targetChars : CHUNK_DEFAULTS.targetChars;
  const minChars = Number.isFinite(options.minChars) && options.minChars >= 0 ? options.minChars : CHUNK_DEFAULTS.minChars;
  return { targetChars, minChars };
}

function splitProse(text, options = {}) {
  const { targetChars, minChars } = sizes(options);
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (!source.trim()) return [];

  // Blank lines first; an oversized paragraph splits on single lines.
  const paragraphs = [];
  for (const para of source.split(/\n\s*\n/).filter((p) => p.trim())) {
    if (para.length <= targetChars) {
      paragraphs.push(para.trim());
      continue;
    }
    let buf = '';
    for (const line of para.split(/\n/).filter((l) => l.trim())) {
      if (buf && buf.length + line.length + 1 > targetChars) {
        paragraphs.push(buf.trim());
        buf = '';
      }
      buf += (buf ? '\n' : '') + line;
    }
    if (buf.trim()) paragraphs.push(buf.trim());
  }

  // A wall of text with no newlines is hard-split.
  const pieces = [];
  for (const para of paragraphs) {
    if (para.length <= targetChars * 1.5) {
      pieces.push(para);
      continue;
    }
    for (let i = 0; i < para.length; i += targetChars) pieces.push(para.substring(i, i + targetChars).trim());
  }
  // minChars drops only the small fragments of a text that split into more
  // than one piece; a text that is one piece is kept however short, so "the
  // port is 8443" is indexed (owner decision 2026-09-29).
  if (pieces.length === 1) return pieces;
  return pieces.filter((p) => p.length >= minChars);
}

function oneLine(value, max = SUMMARY_MAX) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeJson(value, indent) {
  try {
    const out = JSON.stringify(value, null, indent);
    return out === undefined ? String(value) : out;
  } catch {
    return String(value);
  }
}

function toolUseSummary(message = {}) {
  const name = String((message && message.toolName) || 'tool');
  const params = message && message.parameters && typeof message.parameters === 'object' ? message.parameters : {};
  for (const key of SUMMARY_KEYS) {
    if (typeof params[key] === 'string' && params[key].trim()) return `${name}: ${oneLine(params[key])}`;
  }
  if (Array.isArray(params.edits)) {
    const paths = [...new Set(params.edits.map((e) => e && e.file_path).filter((p) => typeof p === 'string' && p))];
    if (paths.length) return `${name}: ${oneLine(paths.join(', '))}`;
  }
  return `${name}: ${oneLine(safeJson(params).slice(0, SUMMARY_MAX))}`;
}

function writtenContent(message) {
  const p = message.parameters && typeof message.parameters === 'object' ? message.parameters : {};
  const out = [];
  if (typeof p.content === 'string') out.push(p.content);
  if (typeof p.new_string === 'string') out.push(p.new_string);
  if (Array.isArray(p.edits)) {
    for (const edit of p.edits) if (edit && typeof edit.new_string === 'string') out.push(edit.new_string);
  }
  return out;
}

// Spec §4.3 says objects render as pretty JSON. String values print raw
// instead: JSON escapes a newline as \n, which breaks paragraph splitting
// and fuses tokens ("\nbar" indexes as "nbar").
function renderToolResult(result) {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object' || Array.isArray(result)) return safeJson(result, 2);
  const parts = [];
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) continue;
    parts.push(typeof value === 'string' ? `${key}:\n${value}` : `${key}: ${safeJson(value, 2)}`);
  }
  return parts.join('\n\n');
}

function chunkMessage(message, options = {}) {
  const m = message && typeof message === 'object' ? message : {};
  const opts = sizes(options);
  const out = [];
  const add = (kind, texts) => {
    for (const text of texts) out.push({ idx: out.length, kind, text });
  };

  switch (m.sender) {
    case 'user':
    case 'assistant':
      add(m.sender, splitProse(m.text, opts));
      break;
    case 'toolUse':
      add('tool_use', [toolUseSummary(m)]);
      if (WRITE_TOOLS.has(m.toolName)) {
        for (const text of writtenContent(m)) add('tool_use', splitProse(text, opts));
      }
      break;
    case 'toolResult':
      add('tool_result', splitProse(renderToolResult(m.result !== undefined ? m.result : m.text), opts));
      break;
    case 'status':
      // Only an imported compaction summary (owner decision 2026-09-29).
      if (m.meta && m.meta.compaction === true) add('summary', splitProse(m.text, opts));
      break;
    default:
      break;
  }

  if (m.sender !== 'status' && Array.isArray(m.documents)) {
    for (const doc of m.documents) {
      const text = doc && (typeof doc.textContent === 'string' ? doc.textContent : doc.text);
      if (typeof text === 'string') add('attachment', splitProse(text, opts));
    }
  }
  return out;
}

module.exports = { CHUNK_DEFAULTS, splitProse, toolUseSummary, renderToolResult, chunkMessage };
