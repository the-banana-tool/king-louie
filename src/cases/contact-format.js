// src/cases/contact-format.js
// Pure pieces of the contact ladder (cases stage 4 spec §3.5, §4.1, §4.4):
// the policy and its validation, ladder steps, tokens, the batch message,
// reply parsing and address normalization. No I/O.
//
// parseReply/optionOrText/stripQuoted sit on a trust boundary: inbound SMS,
// email and voice text becomes the owner's answer. They pick an option only
// on an exact, unambiguous match and never fall back to a default option.
const crypto = require('crypto');
const { validTimeZone, isRealCalendarDate, toMs } = require('./clock');

const CONTACT_CHANNELS = Object.freeze(['in-app', 'telegram', 'discord', 'email', 'sms', 'voice', 'ntfy', 'mobile']);
const STEP_CHANNELS = Object.freeze(['present', 'journal', ...CONTACT_CHANNELS]);
const URGENCIES = Object.freeze(['low', 'normal', 'high']);
const SLACK_ERROR = 'slack is not a contact channel: it has no sender allowlist';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// A whole token only: anchored, no flags (no lastIndex state), Crockford
// upper case (no I, L, O, U).
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const RFC3339 = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const TRUNCATE_AT = 280;
const TRUNCATED = ' (open King Louie for the full text)';
// Upper bounds (the spec only says "int ≥ 0"); they stop absurd values that
// would park a question forever or overflow timer arithmetic.
const MAX_BATCH_DELAY_SEC = 3600;
const MAX_AFTER_MIN = 7 * 24 * 60;
const MAX_PRESENCE_MIN = 24 * 60;

const DEFAULT_CONTACT_POLICY = Object.freeze({
  batchDelaySec: 60,
  ladders: {
    low: [{ channel: 'in-app' }, { channel: 'journal' }, { channel: 'email', digest: true }],
    normal: [{ channel: 'present' }, { channel: 'telegram', afterMin: 30 }, { channel: 'email', afterMin: 240 }],
    high: [{ channel: 'present' }, { channel: 'sms', afterMin: 15 }, { channel: 'voice', afterMin: 30 }]
  },
  quietHours: null,
  away: null,
  digest: { channel: 'email', at: '08:00' },
  presence: { desktopIdleMin: 5, recentInboundMin: 10 }
});

const clone = (v) => JSON.parse(JSON.stringify(v));
const isIntIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const STEP_KEYS = ['channel', 'afterMin', 'digest'];
const PRESENCE_KEYS = ['desktopIdleMin', 'recentInboundMin'];
// Ladder steps that are not a contact channel: they can't carry a digest.
const NON_CONTACT_STEPS = ['present', 'journal'];

function unknownKey(obj, allowed, path) {
  const key = Object.keys(obj).find((k) => !allowed.includes(k));
  return key === undefined ? null : `contactPolicy.${path}.${key} is not a known key`;
}

function defaultPolicy() {
  return clone(DEFAULT_CONTACT_POLICY);
}

// Fills missing top-level fields from the default; used when reading settings.
function effectivePolicy(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = defaultPolicy();
  return {
    batchDelaySec: isIntIn(p.batchDelaySec, 0, MAX_BATCH_DELAY_SEC) ? p.batchDelaySec : d.batchDelaySec,
    ladders: { ...d.ladders, ...(p.ladders && typeof p.ladders === 'object' ? p.ladders : {}) },
    quietHours: p.quietHours === undefined ? d.quietHours : p.quietHours,
    away: p.away === undefined ? d.away : p.away,
    digest: p.digest === undefined ? d.digest : p.digest,
    presence: { ...d.presence, ...(p.presence && typeof p.presence === 'object' ? p.presence : {}) }
  };
}

function channelError(name) {
  if (name === 'slack') return SLACK_ERROR;
  if (!STEP_CHANNELS.includes(name)) return `unknown contact channel "${name}"`;
  return null;
}

// RFC3339 with a real calendar date (Date.parse alone rolls Feb 30 over to
// March and accepts 24:00).
function isRfc3339(value) {
  const m = typeof value === 'string' ? RFC3339.exec(value) : null;
  return Boolean(m) && isRealCalendarDate(m[1]) && Number.isFinite(toMs(value));
}

// §4.1. Returns { ok: true, policy } (normalized; a past away is cleared) or
// { ok: false, error }.
function validatePolicy(input, { now = new Date() } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('the contact policy must be an object');
  const known = ['batchDelaySec', 'ladders', 'quietHours', 'away', 'digest', 'presence'];
  for (const key of Object.keys(input)) if (!known.includes(key)) return fail(`contactPolicy.${key} is not a known key`);
  for (const key of ['ladders', 'presence']) {
    if (input[key] !== undefined && !isPlainObject(input[key])) return fail(`contactPolicy.${key} must be an object`);
  }
  const p = effectivePolicy(input);
  if (input.batchDelaySec !== undefined && !isIntIn(input.batchDelaySec, 0, MAX_BATCH_DELAY_SEC)) {
    return fail(`batchDelaySec must be an integer from 0 to ${MAX_BATCH_DELAY_SEC}`);
  }
  const ladders = {};
  for (const u of Object.keys(p.ladders)) {
    if (!URGENCIES.includes(u)) return fail(`ladders.${u} is not an urgency (low, normal, high)`);
    const steps = p.ladders[u];
    if (!Array.isArray(steps) || steps.length === 0) return fail(`ladders.${u} must be a non-empty list of steps`);
    let last = 0;
    ladders[u] = [];
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      if (!s || typeof s !== 'object' || typeof s.channel !== 'string') return fail(`ladders.${u}[${i}] needs a channel`);
      const extra = unknownKey(s, STEP_KEYS, `ladders.${u}[${i}]`);
      if (extra) return fail(extra);
      const err = channelError(s.channel);
      if (err) return fail(err);
      if (s.digest === true && NON_CONTACT_STEPS.includes(s.channel)) return fail(`ladders.${u}[${i}]: a digest step must be a contact channel`);
      const afterMin = s.afterMin === undefined ? (i === 0 ? 0 : last) : s.afterMin;
      if (!isIntIn(afterMin, 0, MAX_AFTER_MIN)) return fail(`ladders.${u}[${i}].afterMin must be an integer from 0 to ${MAX_AFTER_MIN}`);
      if (afterMin < last) return fail(`ladders.${u}[${i}].afterMin must not be smaller than the step before it`);
      if (s.digest !== undefined && typeof s.digest !== 'boolean') return fail(`ladders.${u}[${i}].digest must be true or false`);
      if (s.digest === true && i !== steps.length - 1) return fail(`ladders.${u}[${i}]: only the last step can be a digest step`);
      last = afterMin;
      ladders[u].push({ channel: s.channel, afterMin, ...(s.digest === true ? { digest: true } : {}) });
    }
  }
  let quietHours = null;
  if (p.quietHours !== null) {
    const q = p.quietHours;
    if (!isPlainObject(q)) return fail('quietHours must be null or { start, end, breakthrough }');
    const extra = unknownKey(q, ['start', 'end', 'breakthrough'], 'quietHours');
    if (extra) return fail(extra);
    if (typeof q.start !== 'string' || typeof q.end !== 'string' || !HHMM.test(q.start) || !HHMM.test(q.end)) {
      return fail('quietHours.start and end must be HH:MM');
    }
    if (q.start === q.end) return fail('quietHours.start and end must differ');
    const breakthrough = q.breakthrough === undefined ? ['high'] : q.breakthrough;
    if (!Array.isArray(breakthrough) || !breakthrough.every((u) => URGENCIES.includes(u))) return fail('quietHours.breakthrough must list urgencies');
    quietHours = { start: q.start, end: q.end, breakthrough: [...breakthrough] };
  }
  let away = null;
  if (p.away !== null) {
    const a = p.away;
    if (!isPlainObject(a)) return fail('away must be null or { mode, until }');
    const extra = unknownKey(a, ['mode', 'until'], 'away');
    if (extra) return fail(extra);
    if (!['email-only', 'in-app-only'].includes(a.mode)) return fail('away.mode must be email-only or in-app-only');
    if (!isRfc3339(a.until)) return fail('away.until must be an RFC3339 date-time');
    away = toMs(a.until) > now.getTime() ? { mode: a.mode, until: a.until } : null;
  }
  let digest = null;
  if (p.digest !== null) {
    const d = p.digest;
    if (!isPlainObject(d)) return fail('digest must be null or { channel, at }');
    const extra = unknownKey(d, ['channel', 'at'], 'digest');
    if (extra) return fail(extra);
    const err = channelError(d.channel);
    if (err) return fail(err);
    if (NON_CONTACT_STEPS.includes(d.channel)) return fail('digest.channel must be a contact channel');
    if (typeof d.at !== 'string' || !HHMM.test(d.at)) return fail('digest.at must be HH:MM');
    digest = { channel: d.channel, at: d.at };
  }
  const presence = {};
  const extraPresence = unknownKey(p.presence, PRESENCE_KEYS, 'presence');
  if (extraPresence) return fail(extraPresence);
  for (const key of PRESENCE_KEYS) {
    const v = p.presence[key];
    if (!isIntIn(v, 1, MAX_PRESENCE_MIN)) return fail(`presence.${key} must be an integer from 1 to ${MAX_PRESENCE_MIN}`);
    presence[key] = v;
  }
  return { ok: true, policy: { batchDelaySec: p.batchDelaySec, ladders, quietHours, away, digest, presence } };
}

// The steps the host can run: known channels only, afterMin non-decreasing,
// `digest` kept only on the (filtered) last step.
function usableSteps(steps) {
  const kept = steps.filter((s) => STEP_CHANNELS.includes(s.channel));
  let last = 0;
  return kept.map((s, i) => {
    last = Math.max(last, s.afterMin);
    return { channel: s.channel, afterMin: last, digest: s.digest === true && i === kept.length - 1 };
  });
}

// An owner ladder as steps; a missing afterMin repeats the one before it.
function ownerSteps(list) {
  if (!Array.isArray(list)) return [];
  let prev = 0;
  return usableSteps(list.filter(isPlainObject).map((s) => {
    prev = isIntIn(s.afterMin, 0, MAX_AFTER_MIN) ? s.afterMin : prev;
    return { channel: s.channel, afterMin: prev, digest: s.digest === true };
  }));
}

// The steps for one question: the owner ladder, replaced by case.yaml
// `channels[urgency]` (or the dotted `urgency.<u>` alias) when present (§4.4).
// Names the host cannot use are dropped; `call` means `voice`. Never empty:
// an override that keeps nothing falls back to the owner ladder, and an empty
// owner ladder to `normal`, then to DEFAULT_CONTACT_POLICY.
function resolveSteps(policy, urgency, caseChannels = null) {
  const ladders = isPlainObject(policy?.ladders) ? policy.ladders : {};
  const d = DEFAULT_CONTACT_POLICY.ladders;
  let owner = [];
  for (const candidate of [ladders[urgency], ladders.normal, d[urgency], d.normal]) {
    owner = ownerSteps(candidate);
    if (owner.length) break;
  }
  let override = null;
  if (isPlainObject(caseChannels)) {
    override = caseChannels[urgency] ?? caseChannels[`urgency.${urgency}`] ?? null;
  }
  if (!Array.isArray(override) || !override.length) return owner;
  const steps = usableSteps(override.map((raw, i) => {
    const s = typeof raw === 'string' ? { channel: raw } : (isPlainObject(raw) ? raw : {});
    const channel = s.channel === 'call' ? 'voice' : s.channel;
    let afterMin = s.afterMin;
    if (!isIntIn(afterMin, 0, MAX_AFTER_MIN)) {
      afterMin = i < owner.length ? owner[i].afterMin : owner[owner.length - 1].afterMin + 30 * (i - owner.length + 1);
    }
    return { channel, afterMin, digest: s.digest === true };
  }));
  return steps.length ? steps : owner;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

// A contact relay's baseUrl: `https:`, or `http:` to loopback only (SSRF, §8).
function assertRelayBaseUrl(baseUrl) {
  let u;
  try {
    u = new URL(String(baseUrl));
  } catch {
    throw new Error(`relay baseUrl "${baseUrl}" is not a URL`);
  }
  if (u.protocol === 'https:') return u.origin + u.pathname.replace(/\/$/, '');
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u.origin + u.pathname.replace(/\/$/, '');
  throw new Error(`relay baseUrl must be https:, or http: to loopback (got ${u.protocol}//${u.hostname})`);
}

// Six Crockford base32 characters (30 bits) from crypto.randomBytes (a
// CSPRNG). A token alone never answers: the adapter also proves the owner.
function newToken(randomBytes = crypto.randomBytes) {
  const n = randomBytes(4).readUInt32BE(0) >>> 2;
  let out = '';
  for (let i = 5; i >= 0; i -= 1) out += CROCKFORD[(n >>> (i * 5)) & 31];
  return out;
}

// TODO(C3 merge, preflight M19): replaced by C3's `normalizeRecipient`
// (`require('./executors/normalize')`, channel `call`/`email`) for sms, voice
// and email when C3 lands, so gate recipients and the owner check agree.
// C3's version also refuses ambiguous bare digits and returns { ok, value }.
function normalizeAddress(channelId, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (channelId === 'sms' || channelId === 'voice') {
    let s = raw.replace(/[\s\-.()]/g, '');
    if (s.startsWith('00')) s = `+${s.slice(2)}`;
    return /^\+\d{8,15}$/.test(s) ? s : null;
  }
  if (channelId === 'email') {
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
    const addr = (m ? m[1] : raw).toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
  }
  return raw;
}

// Display only (no arithmetic): the zone check and fallback come from clock.js.
const FORMATTERS = new Map();
function formatter(timeZone) {
  const tz = validTimeZone(timeZone) || '';
  if (!FORMATTERS.has(tz)) {
    FORMATTERS.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }));
  }
  return FORMATTERS.get(tz);
}

// 'Sep 25 18:00' in the owner's zone.
function formatShort(date, timeZone) {
  const p = {};
  for (const part of formatter(timeZone).formatToParts(new Date(date))) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.month} ${p.day} ${p.hour}:${p.minute}`;
}

const URGENCY_RANK = { high: 0, normal: 1, low: 2 };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function subjectFor(items) {
  const kinds = new Set(items.map((i) => i.kind));
  const noun = kinds.size === 1 ? [...kinds][0] : 'item';
  const high = items.filter((i) => i.urgency === 'high').length;
  return `King Louie: ${plural(items.length, noun)}${high ? ` (${high} high)` : ''}`;
}

// entries: [{ caseId, caseTitle, token, record }] across cases. Returns the
// §3.1 message { subject, text, items }. On a channel without authenticated
// replies an approval is only announced (answerable: false).
function renderBatch(entries, {
  batchToken, maxChars = 4000, maxOptions = 6, authenticated = true,
  firstAuthenticated = 'the King Louie app', timeZone = '', truncate = false
} = {}) {
  const sorted = [...entries].sort((a, b) => (URGENCY_RANK[a.record.urgency] ?? 1) - (URGENCY_RANK[b.record.urgency] ?? 1)
    || String(a.record.createdAt).localeCompare(String(b.record.createdAt)));
  const items = sorted.map((e, i) => {
    const r = e.record;
    const answerable = !(r.kind === 'approval' && !authenticated);
    let text = r.text;
    if (truncate && text.length > TRUNCATE_AT) text = `${text.slice(0, TRUNCATE_AT)}${TRUNCATED}`;
    if (!answerable) text = `Approval needed in ${e.caseTitle}: ${text} Answer in King Louie or ${firstAuthenticated}.`;
    const options = answerable ? (r.options || []).slice(0, maxOptions) : [];
    return {
      n: i + 1, token: e.token, caseId: e.caseId, questionId: r.id, caseTitle: e.caseTitle,
      kind: r.kind, text, options, urgency: r.urgency, answerable, expiresAt: r.expiresAt || null
    };
  });
  const lines = [subjectFor(items), ''];
  for (const it of items) {
    const tag = it.urgency === 'high' ? '[HIGH] ' : '';
    lines.push(it.answerable ? `${it.n}. ${tag}${it.caseTitle} — ${it.text}` : `${it.n}. ${tag}${it.text}`);
    if (it.options.length) lines.push(`   ${it.options.map((o) => `${o.id}) ${o.label}`).join('   ')}`);
  }
  const replyable = items.filter((it) => it.answerable && it.kind !== 'briefing');
  if (replyable.length) {
    const hint = (it) => {
      const answer = it.options.length ? it.options[0].id : '<answer>';
      return items.length === 1 ? `"#${batchToken} ${answer}"` : `"#${batchToken} ${it.n} ${answer}"`;
    };
    // A reply without the code may only pick an option (parseReply).
    let footer = `Reply ${replyable.slice(0, 2).map(hint).join(' / ')}. Start a free-text answer with #${batchToken}.`;
    const expiring = items.filter((it) => it.expiresAt);
    if (expiring.length) footer += ` Expires: ${expiring.map((it) => `${it.n}) ${formatShort(it.expiresAt, timeZone)}`).join(', ')}.`;
    lines.push('', footer);
  }
  let text = lines.join('\n');
  if (text.length > maxChars && !truncate) {
    return renderBatch(entries, { batchToken, maxChars, maxOptions, authenticated, firstAuthenticated, timeZone, truncate: true });
  }
  return { subject: subjectFor(items), text, items, tooLarge: text.length > maxChars };
}

const TRAILING = /[\s.!?,;:]+$/;
const matchKey = (v) => String(v ?? '').trim().replace(TRAILING, '').toLowerCase();

// `<rest>` names an option when it equals an option id or label
// (case-insensitive, trimmed, trailing punctuation dropped on both sides),
// else it is text. An empty key, or a key that matches more than one option
// (an id equal to another option's label, two equal labels), is text: no
// option is ever chosen by guess or by position.
function optionOrText(options, rest) {
  const raw = String(rest ?? '').trim();
  const key = matchKey(raw);
  if (!key) return { text: raw };
  const hits = (options || []).filter((o) => o && (matchKey(o.id) === key || matchKey(o.label) === key));
  return hits.length === 1 ? { optionId: hits[0].id } : { text: raw };
}

const WHICH = (batchToken) => `Which question? Reply "#${batchToken} <n> <answer>".`;
// `#` + six token characters at the very start of the line, then whitespace
// or the end: "#K7QD4M1 a", "#K7QD4M:1" and "x #K7QD4M" are not tokens.
const LINE_TOKEN = /^#([0-9A-Za-z]{6})(?:\s+(.*))?$/;
const sameAnswer = (a, b) => a.optionId === b.optionId && a.text === b.text;

// True when `rest` starts with the item's rendered header ("[HIGH] <caseTitle>
// — "): a quoted copy of the question, not an answer.
function isItemHeader(item, rest) {
  if (!item.caseTitle) return false;
  const body = rest.startsWith('[HIGH] ') ? rest.slice('[HIGH] '.length) : rest;
  return body.startsWith(`${item.caseTitle} — `);
}

const SENT_FROM = /^Sent from my\b/i;

// Ruling T2-join: a threaded reply to a single-item batch is ONE answer. Strip
// the quoted history and a `-- ` signature block (stripQuoted), drop trailing
// "Sent from my …" lines and quoted item headers; the rest is an option when
// it exactly matches one, else one `{ text }` of its non-empty lines. null
// when nothing is left.
function singleThreadAnswer(item, text) {
  const lines = stripQuoted(text).split('\n').map((l) => l.trim());
  while (lines.length && (!lines[lines.length - 1] || SENT_FROM.test(lines[lines.length - 1]))) lines.pop();
  const body = lines.filter((l) => l && !isItemHeader(item, l.replace(/^\d{1,2}[.)]?\s+/, '')));
  return body.length ? optionOrText(item.options, body.join('\n')) : null;
}

// batch: { batchToken, items: [{ n, token, options, caseTitle? }] }.
// `threaded`: the reply is already tied to this batch (a Telegram/Discord
// reply, an email in the thread), so the #TOKEN may be left out. In a
// multi-item batch a tokenless line may then only pick an option by exact
// match: free text needs the token (a `{ text }` answer becomes a `user`
// fact, so a stray signature or quoted line must never land on the wrong
// question). A threaded reply to a single-item batch that names no token is
// one answer, free text allowed (singleThreadAnswer, rulings T2-single and
// T2-join); if it names a token, only its tokened lines count. Returns { answers: [{ item, answer }], ack }
// where ack is set only when nothing parsed. Ignored: `>` quoted lines, a
// line repeating an item's header, and text that fits none of the named
// item's options but exactly one of another item's (a swapped token or
// number). Two different answers to one item in one reply are ambiguous and
// that item is dropped.
function parseReply(batch, text, { threaded = false } = {}) {
  const items = batch.items || [];
  const byN = (n) => items.find((it) => it.n === n) || null;
  const found = [];
  const answerFor = (item, rest, freeText) => {
    if (!rest || isItemHeader(item, rest)) return;
    const answer = optionOrText(item.options, rest);
    if (!('optionId' in answer)) {
      if (!freeText) return;
      if (items.some((other) => other !== item && 'optionId' in optionOrText(other.options, rest))) return;
    }
    found.push({ item, answer });
  };
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('>'));
  const namesToken = (line) => {
    const m = LINE_TOKEN.exec(line);
    const token = m ? m[1].toUpperCase() : null;
    return Boolean(token) && (token === batch.batchToken || items.some((it) => it.token === token));
  };
  if (threaded && items.length === 1 && !lines.some(namesToken)) {
    const answer = singleThreadAnswer(items[0], text);
    return answer ? { answers: [{ item: items[0], answer }], ack: null } : { answers: [], ack: WHICH(batch.batchToken) };
  }
  for (const line of lines) {
    const m = LINE_TOKEN.exec(line);
    let rest = line;
    if (m) {
      const token = m[1].toUpperCase();
      rest = m[2] || '';
      if (!TOKEN_RE.test(token)) continue;
      const q = items.find((it) => it.token === token);
      if (q) {
        answerFor(q, rest, true);
        continue;
      }
      if (token !== batch.batchToken) continue;
    } else if (!threaded || items.length === 1) {
      // a single-item reply that names a token: only its tokened lines count
      continue;
    }
    const numbered = /^(\d{1,2})[.)]?\s+(.+)$/.exec(rest);
    if (numbered && byN(Number(numbered[1]))) {
      answerFor(byN(Number(numbered[1])), numbered[2], Boolean(m));
    } else if (items.length === 1) {
      answerFor(items[0], rest, true);
    }
  }
  const answers = [];
  const conflicted = new Set();
  for (const f of found) {
    if (conflicted.has(f.item)) continue;
    const prior = answers.findIndex((a) => a.item === f.item);
    if (prior === -1) answers.push(f);
    else if (!sameAnswer(answers[prior].answer, f.answer)) {
      answers.splice(prior, 1);
      conflicted.add(f.item);
    }
  }
  return answers.length ? { answers, ack: null } : { answers: [], ack: WHICH(batch.batchToken) };
}

// Where quoted history starts in an email body. Everything from there on is
// dropped: the quoted original lists every option and would parse as answers.
const QUOTE_SEPARATORS = [
  /^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i, // Outlook desktop, Android, Gmail forward
  /^\s*_{10,}\s*$/, // Outlook web / mobile
  /^-- $/, // RFC 3676 signature delimiter
  /^\s*King Louie: \d+ (question|approval|briefing|item)s?\b/ // our own batch, pasted back without quoting
];
const HEADER_LINE = /^\s*(Sent|Date|To|Cc|Subject):\s/i;

function quoteStartsAt(lines, i) {
  const line = lines[i];
  if (QUOTE_SEPARATORS.some((re) => re.test(line))) return true;
  // "On <date>, <name> wrote:", possibly wrapped onto the next line.
  if (/^\s*On\s/.test(line)) {
    if (/\bwrote:\s*$/.test(line)) return true;
    if (i + 1 < lines.length && /\bwrote:\s*$/.test(lines[i + 1]) && !/^\s*$/.test(lines[i + 1])) return true;
  }
  // An Outlook header block: "From: …" followed by Sent:/Date:/To:/Subject:.
  if (/^\s*From:\s/i.test(line) && i + 1 < lines.length && HEADER_LINE.test(lines[i + 1])) return true;
  return false;
}

// Email bodies: drop `>` lines and everything from the start of the quoted
// history ("On … wrote:", an Original Message / Outlook separator or header
// block, a signature, or the batch text itself).
function stripQuoted(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (quoteStartsAt(lines, i)) break;
    if (/^\s*>/.test(lines[i])) continue;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

module.exports = {
  CONTACT_CHANNELS,
  STEP_CHANNELS,
  URGENCIES,
  SLACK_ERROR,
  TOKEN_RE,
  DEFAULT_CONTACT_POLICY,
  defaultPolicy,
  effectivePolicy,
  validatePolicy,
  resolveSteps,
  newToken,
  normalizeAddress,
  assertRelayBaseUrl,
  formatShort,
  renderBatch,
  optionOrText,
  parseReply,
  stripQuoted
};
