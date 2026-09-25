// src/channels/email-channel.js
// The email contact channel (cases stage 4 spec §3.2) over a pluggable
// transport: the HTTP relay (default) or IMAP/SMTP. A reply counts only
// from the owner address, naming a live batch, and authenticated (relay
// auth.verified or the topmost Authentication-Results header) or carrying
// the [KL-<batchToken>] token. Email never answers an approval.
const crypto = require('crypto');
const { ChannelPlugin, ContactDeliveryError, GATE_PASSED } = require('./channel-plugin');
const { normalizeAddress, stripQuoted } = require('../cases/contact-format');
const { createLogger } = require('../logging');

const SUBJECT_TOKEN = /\[KL-([0-9A-Za-z]{6})\]/;
const THREAD_ID = /<kl-(d-[^@>\s]+)@/i;
// Mail from these senders is a delivery report, never an answer.
const DAEMON_SENDER = /^(mailer-daemon|postmaster)@/i;
// deliveryId → batchToken of recent sends, so a token that proves the owner
// must be the token of the thread it replies in (sendContact).
const MAX_SENT_TOKENS = 1000;

const domainOf = (address) => {
  const at = String(address || '').lastIndexOf('@');
  return at > 0 ? String(address).slice(at + 1).toLowerCase() : '';
};

// Split an Authentication-Results value on `;`, ignoring semicolons inside
// quoted strings and (nested) comments, and dropping the comments. The header
// is written by the receiving MTA but carries sender-chosen text (an envelope
// sender such as "a;dmarc=pass"@example.org, often inside a comment), which
// must never read as a result of its own.
function authResultsParts(value) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quoted = false;
      continue; // quoted text never counts
    }
    if (depth > 0) {
      if (ch === '\\') i += 1;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '(') {
      depth = 1;
      cur += ' ';
    } else if (ch === ';') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// `a` and `b` are the same domain, or one is a subdomain of the other. The
// parent must itself have two labels, so a bare suffix ("com") never aligns.
function aligned(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.includes('.') && long.endsWith(`.${short}`);
}

// A property value as a domain: `user@example.com`, `@example.com` or `example.com`.
const propDomain = (v) => {
  const s = String(v || '').toLowerCase();
  return s.includes('@') ? domainOf(s) : s;
};

// Only the topmost Authentication-Results header counts (lower ones can be
// forged by the sender); the caller passes that one (topAuthResults). It
// passes when its authserv-id is the trusted one and it shows dmarc=pass for
// the From domain, or spf=pass / dkim=pass aligned with the From domain.
function authResultsPass(value, { trustedAuthServId, fromDomain } = {}) {
  if (!value || !trustedAuthServId || !fromDomain) return false;
  const from = String(fromDomain).toLowerCase();
  const parts = authResultsParts(value);
  const authserv = (parts[0] || '').split(' ')[0].toLowerCase();
  if (authserv !== String(trustedAuthServId).toLowerCase()) return false;
  for (const part of parts.slice(1)) {
    const m = /^([a-z0-9-]+)\s*=\s*([a-z]+)\b(.*)$/i.exec(part);
    if (!m || m[2].toLowerCase() !== 'pass') continue;
    const method = m[1].toLowerCase();
    const props = {};
    for (const p of m[3].matchAll(/([a-z0-9-]+\.[a-z0-9-]+)\s*=\s*(\S+)/gi)) props[p[1].toLowerCase()] = p[2];
    if (method === 'dmarc' && propDomain(props['header.from']) === from) return true;
    if (method === 'spf' && aligned(propDomain(props['smtp.mailfrom']), from)) return true;
    if (method === 'dkim' && aligned(propDomain(props['header.d'] || props['header.i']), from)) return true;
  }
  return false;
}

// headerLines: mailparser's [{ key, line }] in the order they appear.
function topAuthResults(headerLines = []) {
  const first = (headerLines || []).find((h) => String(h.key).toLowerCase() === 'authentication-results');
  if (!first) return null;
  return String(first.line).replace(/^[^:]*:\s*/, '').replace(/\s+/g, ' ').trim();
}

class EmailChannel extends ChannelPlugin {
  // getConfig() → { owner, from, trustedAuthServId }
  constructor({ transport, getConfig = () => ({}), pollSec = 60, log = createLogger('contact/email'), setTimer = setInterval, clearTimer = clearInterval } = {}) {
    super({ id: 'email', label: 'Email', capabilities: ['send'] });
    this.transport = transport || null;
    this.getConfig = getConfig;
    this.pollMs = Math.max(1, Number(pollSec) || 60) * 1000;
    this.log = log;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.replyHandler = null;
    this.statusHandler = null;
    this.timer = null;
    this.polling = false;
    this.sentTokens = new Map();
  }

  // The relay client behind the relay transport (null for IMAP/SMTP). The
  // router routes a relay's events by its `name` (contact.js relayOf).
  get relay() {
    return this.transport?.relay || null;
  }

  config() {
    const c = this.getConfig() || {};
    return {
      owner: normalizeAddress('email', c.owner),
      from: normalizeAddress('email', c.from),
      trustedAuthServId: typeof c.trustedAuthServId === 'string' ? c.trustedAuthServId : ''
    };
  }

  async initialize() {
    if (this.timer || !this.transport || typeof this.transport.poll !== 'function') return;
    this.timer = this.setTimer(() => { this.pollOnce().catch((err) => this.log.warn(`email poll failed: ${err.message}`)); }, this.pollMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  async shutdown() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.transport && typeof this.transport.close === 'function') await this.transport.close();
  }

  normalizeTarget(raw = '') {
    return normalizeAddress('email', raw) || '';
  }

  contactCapabilities() {
    if (!this.transport) return null;
    return {
      buttons: false, richText: false, attachments: false, voice: false, expectsReplies: true, authenticatedReplies: false,
      interrupts: false, maxOptions: 6, maxChars: 20000, idempotentSend: this.transport.idempotent === true
    };
  }

  ownerTarget() {
    const c = this.config();
    return this.transport && c.from ? c.owner : null;
  }

  onContactReply(handler) {
    this.replyHandler = typeof handler === 'function' ? handler : null;
  }

  onContactStatus(handler) {
    this.statusHandler = typeof handler === 'function' ? handler : null;
  }

  // message.text is the rendered batch: notice items ("Answer this in the
  // app: …") already carry no options and no reply hint.
  async sendContact(message, meta = {}) {
    const c = this.config();
    if (!this.transport || !c.owner || !c.from) throw new ContactDeliveryError('not-configured', 'email needs contact.email.owner and contact.email.from');
    const messageId = `<kl-${meta.deliveryId}@${domainOf(c.from)}>`;
    const sent = await this.transport.send({
      to: c.owner,
      from: c.from,
      subject: `${message.subject} [KL-${meta.batchToken}]`,
      text: message.text,
      headers: { 'Message-ID': messageId, 'X-KL-Delivery': String(meta.deliveryId) },
      idempotencyKey: meta.deliveryId
    });
    this.sentTokens.delete(String(meta.deliveryId));
    this.sentTokens.set(String(meta.deliveryId), String(meta.batchToken).toUpperCase());
    if (this.sentTokens.size > MAX_SENT_TOKENS) this.sentTokens.delete(this.sentTokens.keys().next().value);
    return { deliveryId: meta.deliveryId, externalRef: messageId, relayId: sent?.relayId || null };
  }

  // The owner, or a target the outbound gate passed. Acks go in the thread.
  async send(target, text, options = {}) {
    const c = this.config();
    const to = normalizeAddress('email', target);
    if (!to) throw new Error(`email: "${target}" is not an address`);
    if (to !== c.owner && options[GATE_PASSED] !== true) throw new Error(`email: refusing to send to ${to}: not the owner and not through the outbound gate`);
    if (!this.transport || !c.from) throw new ContactDeliveryError('not-configured', 'email needs contact.email.from');
    const headers = {};
    if (options.inReplyTo) {
      headers['In-Reply-To'] = options.inReplyTo;
      headers.References = options.inReplyTo;
    }
    const sent = await this.transport.send({
      to, from: c.from, subject: options.subject || 'King Louie', text: String(text), headers,
      idempotencyKey: options.deliveryId || `ack-${crypto.randomBytes(8).toString('hex')}`
    });
    return { ok: true, relayId: sent?.relayId || null };
  }

  // reply: { from, subject, text, inReplyTo, references[], messageId, authResultsTop?, auth?, autoSubmitted? }
  async handleInbound(reply) {
    const c = this.config();
    const from = normalizeAddress('email', reply.from);
    if (reply.autoSubmitted === true || DAEMON_SENDER.test(from || String(reply.from || ''))) {
      this.log.info(`email from ${from || reply.from} is automatic (a report or an auto-reply); not an answer`);
      return null;
    }
    const subjectToken = SUBJECT_TOKEN.exec(String(reply.subject || ''));
    const body = stripQuoted(reply.text || '');
    const bodyToken = SUBJECT_TOKEN.exec(body);
    const token = (subjectToken || bodyToken)?.[1]?.toUpperCase() || null;
    const threadMatch = [reply.inReplyTo, ...(Array.isArray(reply.references) ? reply.references : [])]
      .map((r) => THREAD_ID.exec(String(r || ''))).find(Boolean);
    const thread = threadMatch ? threadMatch[1] : null;
    if (!thread && !token) {
      this.log.warn(`email reply from ${from || reply.from} names no King Louie batch; dropped`);
      return null;
    }
    const authenticated = reply.auth?.verified === true
      || authResultsPass(reply.authResultsTop, { trustedAuthServId: c.trustedAuthServId, fromDomain: domainOf(from) });
    // Unauthenticated, the token is the proof, so it must be the thread's own
    // token, or else the token alone names the batch: a made-up token then
    // matches nothing.
    let correlation = thread || token;
    if (!authenticated && token && thread && this.sentTokens.get(thread) !== token) correlation = token;
    const ownerProven = Boolean(from && c.owner && from === c.owner && (authenticated || token));
    if (!ownerProven) this.log.warn(`email reply from ${from || reply.from} is not owner-proven; dropped`);
    if (!this.replyHandler) return null;
    const answerText = body.replace(SUBJECT_TOKEN, '').trim();
    const result = await this.replyHandler(correlation, { text: answerText }, {
      channel: 'email', senderId: from || String(reply.from || ''), chatId: null, at: reply.date || null, ownerProven, deliveryRef: reply.inReplyTo || null
    });
    if (result && result.ackText && ownerProven) {
      try {
        await this.send(c.owner, result.ackText, { subject: `Re: ${reply.subject || 'King Louie'}`, inReplyTo: reply.messageId || null });
      } catch (err) {
        this.log.warn(`email ack failed: ${err.message}`);
      }
    }
    return result;
  }

  async handleBounce(b) {
    if (!b.originalMessageId) {
      this.log.warn('email delivery report names no original message; ignored');
      return;
    }
    if (this.statusHandler) await this.statusHandler({ externalRef: b.originalMessageId, status: 'bounced', error: b.diagnostic || b.status || null });
  }

  // A relay `inbound` event with channel email.
  async ingestRelayEvent(ev) {
    return this.handleInbound({
      from: ev.from, subject: ev.subject, text: ev.text, inReplyTo: ev.inReplyTo, references: ev.references || [],
      messageId: ev.messageId || null, auth: ev.auth || null, date: ev.at || null, autoSubmitted: ev.autoSubmitted === true
    });
  }

  // IMAP/SMTP: read UNSEEN replies and DSNs. Anything else (an auto-reply, a
  // read receipt, a delay notice) is `ignored`.
  async pollOnce() {
    if (!this.transport || typeof this.transport.poll !== 'function' || this.polling) return { replies: 0, bounces: 0 };
    this.polling = true;
    try {
      let replies = 0;
      let bounces = 0;
      for (const item of await this.transport.poll()) {
        if (item.kind === 'bounce') {
          bounces += 1;
          await this.handleBounce(item);
        } else if (item.kind === 'reply') {
          replies += 1;
          await this.handleInbound(item);
        }
      }
      return { replies, bounces };
    } finally {
      this.polling = false;
    }
  }
}

module.exports = { EmailChannel, authResultsPass, topAuthResults, domainOf };
