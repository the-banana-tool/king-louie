// src/channels/bridge-contact.js
// Pieces the Telegram and Discord bridges share for contact (cases stage 4
// spec §3.1): owner proof (R43), button callback data, error mapping.
const { ContactDeliveryError } = require('./channel-plugin');

// kl_q_<token>_<optionIndex>: 17 bytes, far under Telegram's 64-byte
// callback_data limit. Anchored end to end, ASCII only (no `u` flag, so `\d`
// is 0-9), a single-digit index: anything else is malformed.
const CALLBACK = /^kl_q_([0-9A-Za-z]{6})_(\d)$/;
const TOKEN = /^[0-9A-Za-z]{6}$/;
const TOKEN_PREFIX = /^#([0-9A-Za-z]{6})\b/;
const MAX_CALLBACK_BYTES = 17;

// Owner-proven only when the message arrived in the contact target (a
// private chat / DM with the owner) AND the sender is the contact owner. The
// allowlist alone never suffices.
function contactOwnerProven({ isPrivate, chatId, senderId, target, ownerUserId }) {
  return Boolean(isPrivate && target && ownerUserId
    && String(chatId) === String(target) && String(senderId) === String(ownerUserId));
}

function callbackData(token, index) {
  const data = `kl_q_${token}_${index}`;
  if (!TOKEN.test(String(token)) || !Number.isInteger(index) || !CALLBACK.test(data) || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) {
    throw new TypeError(`invalid contact callback: token ${JSON.stringify(String(token))}, option ${index}`);
  }
  return data;
}

function parseCallback(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) return null;
  const m = CALLBACK.exec(data);
  return m ? { token: m[1].toUpperCase(), index: Number(m[2]) } : null;
}

function leadingToken(text) {
  const m = TOKEN_PREFIX.exec(String(text || '').trim());
  return m ? m[1].toUpperCase() : null;
}

const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// One row per answerable item with 1..maxOptions options. Items that are not
// answerable on this channel (approvals, app-only questions: owner decision
// M22) are notices and get no buttons; neither does an item whose token could
// not make valid callback data.
function buttonRows(items, maxOptions) {
  return (items || [])
    .filter((it) => it && it.answerable === true && TOKEN.test(String(it.token))
      && Array.isArray(it.options) && it.options.length > 0 && it.options.length <= maxOptions && it.options.length <= 10)
    .map((it) => it.options.map((o, i) => ({ label: cut(`${it.n}. ${o.label}`, 40), data: callbackData(it.token, i) })));
}

function httpStatusError(status, message) {
  if (status === 400) return new ContactDeliveryError('rejected', message);
  if (status === 401 || status === 403 || status === 404) return new ContactDeliveryError('not-configured', message);
  if (status === 413) return new ContactDeliveryError('too-large', message);
  if (status === 429) return new ContactDeliveryError('rate-limited', message);
  return new ContactDeliveryError('unreachable', message);
}

// Replaces every occurrence of a secret (a bot token, which sits in the API
// URL) so it never reaches an error or a log line.
function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.split(String(secret)).join('<bot-token>') : s;
}

// callTelegram throws "Telegram <method> failed: <status> …" or
// "Telegram <method> error: …" (ok: false); fetch throws on the network, and
// on a bad URL with the URL (and so the token) in the message.
function telegramError(err, { secret = null } = {}) {
  const message = redact(err && err.message ? err.message : String(err), secret);
  const m = /failed: (\d{3})/.exec(message);
  if (m) return httpStatusError(Number(m[1]), message);
  if (/ error: /.test(message)) return new ContactDeliveryError('rejected', message);
  return new ContactDeliveryError('unreachable', message);
}

// discord.js DiscordAPIError / HTTPError carry a numeric `status`.
function discordError(err) {
  if (err && Number.isInteger(err.status)) return httpStatusError(err.status, err.message);
  return new ContactDeliveryError('unreachable', err && err.message ? err.message : String(err));
}

module.exports = { contactOwnerProven, callbackData, parseCallback, leadingToken, buttonRows, telegramError, discordError, redact };
