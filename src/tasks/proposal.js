'use strict';

// The scope proposal (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.5):
// one utility-role model call turns a task's text into the sites, classes, minutes and
// dollars a grant card would ask the owner for. The call itself is injected (`callUtility`,
// routed by the caller); this file sends nothing. The answer is checked here, never trusted.

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('tasks/proposal');

// Same grammar as SITE_RE in src/gui/lease-protocol.js (copied: src/tasks stays off src/gui).
const SITE_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ALLOW_CLASSES = Object.freeze(['browser-act', 'files-write', 'logins', 'shell']);
const MAX_SITES = 16;
const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const MIN_USD = 2;
const MAX_USD = 50;
const KEYS = ['allows', 'minutes', 'sites', 'usd'];

const PROMPT_FILE = path.join(__dirname, 'prompts', 'task-scope-v1.md');
const TEXT_DELIMITER = '=== TASK TEXT ===';

function validateProposal(raw) {
  const bad = { ok: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad;
  const keys = Object.keys(raw).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return bad;
  const { sites, allows, minutes, usd } = raw;
  if (!Array.isArray(sites) || sites.length > MAX_SITES
    || !sites.every((s) => typeof s === 'string' && SITE_RE.test(s))) return bad;
  if (!Array.isArray(allows) || !allows.every((a) => ALLOW_CLASSES.includes(a))) return bad;
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return bad;
  if (!Number.isInteger(usd) || usd < MIN_USD || usd > MAX_USD) return bad;
  const sortedAllows = [...new Set(allows)].sort();
  return {
    ok: true,
    proposal: { sites: [...new Set(sites)], allows: sortedAllows, minutes, usd, lookOnly: sortedAllows.length === 0 },
  };
}

// The model's answer as an object, or null: strips a code fence, then parses.
function parseAnswer(answer) {
  if (typeof answer !== 'string') return null;
  let text = answer.trim();
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// { proposal } | { proposal: null, reason: 'malformed' | 'no_model' }. A call that throws (no
// model, no network) is `no_model` and is not retried; a malformed answer is retried once.
async function proposeScope({ text, callUtility }) {
  const prompt = `${fs.readFileSync(PROMPT_FILE, 'utf8').trimEnd()}\n\n${TEXT_DELIMITER}\n${String(text)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let answer;
    try {
      answer = await callUtility(prompt);
    } catch (err) {
      log.warn('the scope proposal call failed', { code: (err && err.code) || 'error' });
      return { proposal: null, reason: 'no_model' };
    }
    const checked = validateProposal(parseAnswer(answer));
    if (checked.ok) return { proposal: checked.proposal };
  }
  return { proposal: null, reason: 'malformed' };
}

module.exports = { validateProposal, proposeScope, ALLOW_CLASSES };
