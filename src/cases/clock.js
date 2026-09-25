// src/cases/clock.js
// Local-day and local-time arithmetic in an IANA time zone, with Intl only
// (cases stage 2 spec §14: no date library). An empty or unknown zone means
// the host's own zone.
const { createLogger } = require('../logging');

const log = createLogger('cases/clock');
const warned = new Set();

function validTimeZone(tz) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    if (!warned.has(tz)) {
      warned.add(tz);
      log.warn(`Unknown time zone "${tz}"; using the host time zone.`);
    }
    return undefined;
  }
}

const pad = (n) => String(n).padStart(2, '0');

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimeZone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

function localDay(date, timeZone) {
  const p = parts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// True only for a YYYY-MM-DD string that names a real calendar date: no
// month/day rollover (e.g. "2026-13-45" or "2026-02-30" are rejected).
function isRealCalendarDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Milliseconds the zone is ahead of UTC at instant `ts`.
function offsetMs(ts, timeZone) {
  const p = parts(new Date(ts), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// The instant at `hour:minute` local time on local `day`.
function zonedTime(day, hour, minute, timeZone) {
  const [y, m, d] = String(day).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let ts = guess - offsetMs(guess, timeZone);
  const corrected = guess - offsetMs(ts, timeZone);
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}

function parseHhmm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    if (text) log.warn(`"${text}" is not an HH:MM time; using 09:00.`);
    return [9, 0];
  }
  return [Number(m[1]), Number(m[2])];
}

// The next instant strictly after `now` that reads `hhmm` on the local clock.
function nextLocalTime(now, hhmm, timeZone) {
  const [h, mi] = parseHhmm(hhmm);
  const today = localDay(now, timeZone);
  let t = zonedTime(today, h, mi, timeZone);
  if (t.getTime() <= now.getTime()) t = zonedTime(addDays(today, 1), h, mi, timeZone);
  return t;
}

function nextLocalMidnight(now, timeZone) {
  return zonedTime(addDays(localDay(now, timeZone), 1), 0, 0, timeZone);
}

// YAML turns an unquoted timestamp into a Date; accept both forms.
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value) return Date.parse(value);
  return NaN;
}

module.exports = {
  validTimeZone,
  localDay,
  addDays,
  isRealCalendarDate,
  zonedTime,
  parseHhmm,
  nextLocalTime,
  nextLocalMidnight,
  toMs
};
