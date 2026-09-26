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

// The contact owner's user id from a bridge's contact host
// ({ router, getOwnerUserId(), isEnabled() }), or null when contact is off or
// no owner id is set.
function contactOwnerOf(host) {
  if (!host) return null;
  const enabled = typeof host.isEnabled === 'function' && host.isEnabled() === true;
  const owner = typeof host.getOwnerUserId === 'function' ? String(host.getOwnerUserId() || '').trim() : '';
  return enabled && owner ? owner : null;
}

// Telegram and Discord differ only in their limits.
function bridgeCapabilities({ maxOptions, maxChars }) {
  return {
    buttons: true, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: true,
    interrupts: true, maxOptions, maxChars
  };
}

// Whether an inbound bridge message is a contact reply, and with what
// correlation. A leading "#<token>" the router knows on this channel names
// its question and wins (review T10 round 2); only without one does a reply
// to a contact message count, and `replyTo` is looked up only as a message
// reference, never as a token (review T10 I1). The bridge passes `replyTo`
// only where a reply can be a contact reply (the owner's private chat / DM,
// preflight M17). Returns null or { correlationId, deliveryRef }.
function matchContactReply(router, channel, text, replyTo) {
  const token = leadingToken(text);
  if (token && router.knows(channel, token)) return { correlationId: token, deliveryRef: null };
  const ref = replyTo == null ? '' : String(replyTo);
  if (ref && router.knows(channel, ref, { ref: true })) return { correlationId: ref, deliveryRef: ref };
  return null;
}

// After a contact reply the router refused (not owner-proven): true swallows
// it (an allowlisted sender, as the plan says); false hands it to the
// bridge's normal unauthorized path, so a live token looks the same to a
// stranger as a made-up one (review T10 M4, no token oracle).
function swallowRefusedContact(allowlistManager, channel, senderId, groupId) {
  return Boolean(allowlistManager && allowlistManager.isAllowed(channel, senderId, groupId));
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
function discordError(err, { secret = null } = {}) {
  const message = redact(err && err.message ? err.message : String(err), secret);
  if (err && Number.isInteger(err.status)) return httpStatusError(err.status, message);
  return new ContactDeliveryError('unreachable', message);
}

module.exports = {
  contactOwnerProven, contactOwnerOf, bridgeCapabilities, matchContactReply, swallowRefusedContact,
  callbackData, parseCallback, leadingToken, buttonRows, telegramError, discordError, redact
};
