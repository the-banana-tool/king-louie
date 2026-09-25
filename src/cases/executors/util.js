// src/cases/executors/util.js
// Small pure helpers shared by the executor modules (cases stage 3).
//
// Time and file helpers reuse the case-runtime primitives rather than
// reimplementing them (M18): `clock.js` owns local-day/local-time arithmetic
// and time zone validation; `jsonfile.js` owns atomic writes and
// fallback-on-error reads. This module only adds the pieces those two do not
// already provide: weekday counting, the DST-safe instant window, and the
// small value/JSON-text helpers the executor tools need.
const crypto = require('crypto');
const clock = require('../clock');
const jsonfile = require('../jsonfile');

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Executor ids (spec §3.1). The one copy: every executor module imports it
// from here (M18).
const EXECUTOR_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const MINUTE_MS = 60 * 1000;
// The widest UTC offsets are -12 h and +14 h, so a local day starts and ends
// within 14 h of UTC midnight.
const SCAN_MS = 14 * 60 * MINUTE_MS;

function sha256hex(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// clock.validTimeZone(tz) returns the zone string when it is valid IANA zone
// and undefined otherwise (logging once); this wraps it as a boolean so
// callers such as pickTimeZone can treat it as a plain predicate.
function validTimeZone(tz) {
  return typeof tz === 'string' && tz !== '' && clock.validTimeZone(tz) === tz;
}

function hostTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function pickTimeZone(...candidates) {
  for (const tz of candidates) if (validTimeZone(tz)) return tz;
  return hostTimeZone();
}

// clock.localDay expects a Date (or a numeric timestamp); accept an ISO
// string too, the way the plan tools and envelope code call this.
function localDate(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  return clock.localDay(d, tz);
}

function addDays(day, n) {
  return clock.addDays(day, n);
}

function dayToUtcMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// ISO weekday of a calendar date: Monday 1 … Sunday 7.
function weekdayOf(day) {
  const w = new Date(dayToUtcMs(day)).getUTCDay();
  return w === 0 ? 7 : w;
}

function countDays(from, to, weekdays = [1, 2, 3, 4, 5, 6, 7]) {
  if (!DAY_PATTERN.test(String(from)) || !DAY_PATTERN.test(String(to)) || to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (weekdays.includes(weekdayOf(d))) n += 1;
  return n;
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The first instant whose local date is `start` and the last whose local
// date is `end` (spec §3.3), found by scanning minutes around UTC midnight.
function windowInstants(start, end, tz) {
  const first = dayToUtcMs(start);
  let notBefore = null;
  for (let t = first - SCAN_MS; t <= first + SCAN_MS; t += MINUTE_MS) {
    if (localDate(new Date(t), tz) === start) {
      notBefore = isoSeconds(t);
      break;
    }
  }
  const next = dayToUtcMs(addDays(end, 1));
  let notAfter = null;
  for (let t = next + SCAN_MS; t >= next - SCAN_MS; t -= MINUTE_MS) {
    if (localDate(new Date(t), tz) === end) {
      notAfter = isoSeconds(t + 59 * 1000);
      break;
    }
  }
  return { notBefore, notAfter };
}

// temp + rename, so a reader never sees half a file; jsonfile.writeJson
// already implements this (M18).
function writeJsonAtomic(file, value) {
  jsonfile.writeJson(file, value);
}

// jsonfile.readJson already returns `fallback` for a missing or corrupt
// file (M18); this is just the name the executor tests expect.
function readJsonSafe(file, fallback) {
  return jsonfile.readJson(file, fallback);
}

// Tool parameters that carry JSON declare type "string" so every provider
// accepts the schema; they must parse to a plain object.
function parseJsonObject(value, name) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, error: `"${name}" is required: JSON text of an object.` };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
  if (typeof value !== 'string') return { ok: false, error: `"${name}" must be JSON text of an object.` };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    return { ok: false, error: `"${name}" is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `"${name}" must be JSON text of an object.` };
  }
  return { ok: true, value: parsed };
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function roundUsd(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

// The one money and cut helpers for owner-facing text (M18).
function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function cut(text, max = 2000) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

module.exports = {
  DAY_PATTERN,
  EXECUTOR_ID_PATTERN,
  sha256hex,
  validTimeZone,
  hostTimeZone,
  pickTimeZone,
  localDate,
  addDays,
  weekdayOf,
  countDays,
  isoSeconds,
  windowInstants,
  writeJsonAtomic,
  readJsonSafe,
  parseJsonObject,
  valueText,
  roundUsd,
  money,
  cut
};
