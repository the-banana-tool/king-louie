// src/channels/email-transports.js
// The two email transports (cases stage 4 spec §3.2):
//   transport.send({ to, from, subject, text, headers, idempotencyKey }) → { messageId, relayId? }
//   transport.poll(onItem) → undefined; onItem({ kind: 'reply', … } | { kind: 'bounce', originalMessageId, status, diagnostic })
//     is awaited per message, which is marked seen only after it resolves
//     (null for the relay: its events arrive through the relay client)
//   transport.close()
// `relay` speaks the contact relay contract; `imap-smtp` uses nodemailer,
// imapflow and mailparser (pure JS), with their own loggers turned off.
// SMTP/IMAP passwords come from the vault through getPassword and never
// reach an error message or a log line.
const { topAuthResults } = require('./email-channel');
const { ContactDeliveryError } = require('./channel-plugin');
const { createLogger } = require('../logging');

// At most this many UNSEEN messages per poll (the rest wait for the next),
// each at most this big (a bigger one is marked seen and skipped).
const MAX_MESSAGES_PER_POLL = 50;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_TRACKED_ATTEMPTS = 1000;
// A handler that never settles would hold the INBOX lock and the IMAP session
// and stall every later poll: it fails the attempt after this long instead.
const HANDLE_TIMEOUT_MS = 60 * 1000;

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handling timed out after ${ms} ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// `relay` is a ContactRelayClient; the channel exposes it (EmailChannel.relay)
// so the router routes that relay's events here.
function createRelayEmailTransport({ relay }) {
  return {
    idempotent: true,
    relay,
    async send({ to, from, subject, text, headers = {}, idempotencyKey }) {
      const out = await relay.send({ channel: 'email', to, from, subject, text, headers, correlation: { deliveryId: headers['X-KL-Delivery'] || null } }, { idempotencyKey });
      return { messageId: headers['Message-ID'] || null, relayId: out.id };
    },
    poll: null,
    async close() {}
  };
}

const MESSAGE_ID_LINE = /^Message-ID:\s*(<[^>\s]+>)/gim;
const KL_MESSAGE_ID = /^<kl-d-[^@>\s]+@[^>\s]+>$/i;
const STATUS_LINE = /^Status:\s*([0-9.]+)/im;
const DIAGNOSTIC_LINE = /^Diagnostic-Code:\s*(.+)$/im;
const ACTION_LINE = /^Action:\s*([a-z-]+)/gim;
const DAEMON_SENDER = /^(mailer-daemon|postmaster)@/i;
const AUTO_PRECEDENCE = new Set(['bulk', 'junk', 'list', 'auto_reply']);

function contentText(part) {
  if (!part || part.content === undefined || part.content === null) return '';
  return Buffer.isBuffer(part.content) ? part.content.toString('utf8') : String(part.content);
}

function headerText(parsed, name) {
  const v = parsed.headers && typeof parsed.headers.get === 'function' ? parsed.headers.get(name) : null;
  if (v === undefined || v === null) return '';
  return String(typeof v === 'object' && 'value' in v ? v.value : v).trim().toLowerCase();
}

// An auto-reply (RFC 3834 Auto-Submitted, the common X- headers, Precedence).
function isAutomatic(parsed) {
  const auto = headerText(parsed, 'auto-submitted');
  if (auto && auto !== 'no') return true;
  if (headerText(parsed, 'x-autoreply') || headerText(parsed, 'x-autorespond')) return true;
  return AUTO_PRECEDENCE.has(headerText(parsed, 'precedence'));
}

// mailparser's result → a reply, a bounce, or an ignored message. A delivery
// report or an automatic message is never a reply.
function classifyParsed(parsed) {
  const ct = parsed.headers && typeof parsed.headers.get === 'function' ? parsed.headers.get('content-type') : null;
  const ctValue = ct ? String(ct.value || ct).toLowerCase() : '';
  if (ctValue === 'multipart/report') {
    if (String(ct.params?.['report-type'] || '').toLowerCase() !== 'delivery-status') return { kind: 'ignored', reason: 'report' };
    // mailparser folds message/delivery-status into the text; the headers of
    // the original stay an attachment (text/rfc822-headers or message/rfc822).
    const parts = [String(parsed.text || ''), ...(parsed.attachments || []).map(contentText)];
    const actions = parts.flatMap((t) => [...t.matchAll(ACTION_LINE)].map((m) => m[1].toLowerCase()));
    // A delay or success notice is not a bounce.
    if (actions.length && !actions.includes('failed')) return { kind: 'ignored', reason: `delivery report (${[...new Set(actions)].join(', ')})` };
    const ids = parts.flatMap((t) => [...t.matchAll(MESSAGE_ID_LINE)].map((m) => m[1]));
    const status = parts.map((t) => STATUS_LINE.exec(t)).find(Boolean);
    const diagnostic = parts.map((t) => DIAGNOSTIC_LINE.exec(t)).find(Boolean);
    return {
      kind: 'bounce',
      originalMessageId: ids.find((id) => KL_MESSAGE_ID.test(id)) || ids[0] || null,
      status: status ? status[1] : null,
      diagnostic: diagnostic ? diagnostic[1].trim().slice(0, 500) : null
    };
  }
  const fromList = parsed.from?.value || [];
  const fromHeaders = (parsed.headerLines || []).filter((h) => String(h.key).toLowerCase() === 'from').length;
  // One From header naming one address, or no sender at all.
  const from = fromList.length === 1 && fromHeaders <= 1 ? String(fromList[0].address || '') : '';
  if (DAEMON_SENDER.test(from)) return { kind: 'ignored', reason: 'mail system message' };
  if (isAutomatic(parsed)) return { kind: 'ignored', reason: 'automatic reply' };
  // mailparser derives text from HTML; none left means nothing to read. The
  // content is never logged, only the Message-ID.
  if (!String(parsed.text || '').trim() && parsed.html) {
    return { kind: 'ignored', warn: true, reason: `HTML reply ${String(parsed.messageId || '(no Message-ID)').slice(0, 200)} has no readable text; dropped` };
  }
  const refs = parsed.references;
  return {
    kind: 'reply',
    from,
    subject: parsed.subject || '',
    text: parsed.text || '',
    inReplyTo: parsed.inReplyTo || null,
    references: Array.isArray(refs) ? refs : (refs ? String(refs).split(/\s+/) : []),
    messageId: parsed.messageId || null,
    date: parsed.date && !Number.isNaN(new Date(parsed.date).getTime()) ? new Date(parsed.date).toISOString() : null,
    authResultsTop: topAuthResults(parsed.headerLines)
  };
}

// Replace every secret in `text` (a server may echo a credential back).
function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) if (secret) s = s.split(String(secret)).join('[redacted]');
  return s;
}

// nodemailer failures → the contact error codes, secrets redacted.
function smtpError(err, secrets = []) {
  const code = Number(err && err.responseCode);
  const message = redact(`SMTP: ${err && err.message ? err.message : String(err)}`, secrets);
  if (code === 552) return new ContactDeliveryError('too-large', message);
  if (code === 530 || code === 535 || err?.code === 'EAUTH') return new ContactDeliveryError('not-configured', message);
  if (code >= 500 && code < 600) return new ContactDeliveryError('rejected', message);
  if (code === 421 || code === 450 || code === 451 || code === 452) return new ContactDeliveryError('rate-limited', message);
  return new ContactDeliveryError('unreachable', message);
}

// smtp: { host, port, secure, user }; imap: { host, port, user, secure? };
// passwords come from the vault through getPassword('smtp' | 'imap');
// handleTimeoutMs bounds each onItem (default 60 s; a timeout is a failed attempt).
function createImapSmtpTransport({
  smtp, imap, getPassword = () => null, nodemailer = null, ImapFlow = null, simpleParser = null, log = createLogger('contact/email-imap'),
  handleTimeoutMs = HANDLE_TIMEOUT_MS
}) {
  const timeoutMs = Number.isFinite(handleTimeoutMs) && handleTimeoutMs > 0 ? handleTimeoutMs : HANDLE_TIMEOUT_MS;
  const mailer = nodemailer || require('nodemailer');
  const Imap = ImapFlow || require('imapflow').ImapFlow;
  const parse = simpleParser || require('mailparser').simpleParser;
  const password = (which) => {
    const p = getPassword(which);
    return p === undefined || p === null ? null : String(p);
  };
  const secrets = () => [password('smtp'), password('imap')].filter(Boolean);
  let transporter = null;
  const smtpTransport = () => {
    if (!transporter) {
      transporter = mailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure === true,
        ...(smtp.user ? { auth: { user: smtp.user, pass: password('smtp') } } : {}),
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 60000,
        logger: false,
        debug: false
      });
    }
    return transporter;
  };

  // `<uidValidity>:<uid>` → failed handling attempts. A message whose handling fails stays
  // UNSEEN for the next poll; after MAX_ATTEMPTS it is marked seen, so one
  // poison message cannot loop forever.
  const attempts = new Map();
  const markSeen = (client, uid) => client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

  // Each item is handled under the mailbox lock and marked seen only after
  // onItem resolves (spec §3.2). Oversized, unparseable and ignored messages
  // are marked seen at once.
  async function pollMailbox(client, onItem) {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, MAX_MESSAGES_PER_POLL)) {
        const key = `${String(client.mailbox?.uidValidity ?? '')}:${uid}`;
        const msg = await client.fetchOne(String(uid), { source: { maxLength: MAX_MESSAGE_BYTES + 1 }, size: true }, { uid: true });
        let item = null;
        try {
          if (!msg || !msg.source) log.warn(`message ${uid} has no source; skipped`);
          else if ((Number(msg.size) || msg.source.length) > MAX_MESSAGE_BYTES) log.warn(`message ${uid} is over ${MAX_MESSAGE_BYTES} bytes; skipped`);
          else item = classifyParsed(await parse(msg.source));
        } catch (err) {
          log.warn(`could not parse message ${uid}: ${redact(err.message, secrets())}`);
        }
        if (item && item.kind === 'ignored') {
          log[item.warn ? 'warn' : 'info'](`message ${uid} ignored: ${item.reason}`);
          item = null;
        }
        if (item) {
          try {
            await withTimeout(onItem(item), timeoutMs);
          } catch (err) {
            const n = (attempts.get(key) || 0) + 1;
            if (n < MAX_ATTEMPTS) {
              attempts.set(key, n);
              if (attempts.size > MAX_TRACKED_ATTEMPTS) attempts.delete(attempts.keys().next().value);
              log.warn(`message ${uid} left unseen after a failed attempt (${n} of ${MAX_ATTEMPTS}): ${redact(err?.message, secrets())}`);
              continue;
            }
            log.warn(`message ${uid} marked seen and dropped after ${n} attempts: ${redact(err?.message, secrets())}`);
          }
        }
        attempts.delete(key);
        await markSeen(client, uid);
      }
    } finally {
      lock.release();
    }
  }

  return {
    idempotent: false,
    relay: null,
    async send({ to, from, subject, text, headers = {} }) {
      const { 'Message-ID': messageId, ...rest } = headers;
      let info;
      try {
        info = await smtpTransport().sendMail({ to, from, subject, text, ...(messageId ? { messageId } : {}), headers: rest });
      } catch (err) {
        throw smtpError(err, secrets());
      }
      return { messageId: info.messageId || messageId || null, relayId: null };
    },
    async poll(onItem) {
      if (typeof onItem !== 'function') throw new TypeError('poll(onItem) needs a handler');
      const client = new Imap({
        host: imap.host,
        port: imap.port,
        secure: imap.secure !== false,
        auth: { user: imap.user, pass: password('imap') },
        logger: false
      });
      // imapflow emits 'error' on a dropped connection; unheard, it would crash the process.
      if (typeof client.on === 'function') client.on('error', (err) => log.warn(`IMAP connection error: ${redact(err?.message, secrets())}`));
      try {
        await client.connect();
      } catch (err) {
        if (typeof client.close === 'function') client.close();
        throw new Error(`IMAP: ${redact(err?.message, secrets())}`);
      }
      try {
        await pollMailbox(client, onItem);
      } catch (err) {
        throw new Error(`IMAP: ${redact(err?.message, secrets())}`);
      } finally {
        try {
          await client.logout();
        } catch (err) {
          log.debug(`IMAP logout failed: ${redact(err?.message, secrets())}`);
        }
      }
    },
    async close() {
      if (transporter) transporter.close();
      transporter = null;
    }
  };
}

module.exports = { createRelayEmailTransport, createImapSmtpTransport, classifyParsed, smtpError };
