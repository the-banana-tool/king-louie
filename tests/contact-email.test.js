// tests/contact-email.test.js — cases stage 4 §3.2 (email channel and transports).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EmailChannel, authResultsPass, topAuthResults } = require('../src/channels/email-channel');
const { ContactDeliveryError } = require('../src/channels/channel-plugin');
const { createImapSmtpTransport, createRelayEmailTransport } = require('../src/channels/email-transports');
const { ContactRelayClient } = require('../src/channels/relay-client');
const { startFakeSmtp } = require('./helpers/fake-smtp');
const { startFakeRelay } = require('./helpers/fake-contact-relay');

const CONFIG = { owner: 'Owner@Example.com', from: 'kl@example.com', trustedAuthServId: 'mx.example.com' };
const MESSAGE = { subject: 'King Louie: 1 question', text: '1. Lakeside lot — Seller financing?\n   a) No   b) Yes', items: [] };
const META = { deliveryId: 'd-ABC123', batchToken: 'K7QD4M' };

// An IMAP double with imapflow's surface: connect, getMailboxLock, search,
// fetchOne, messageFlagsAdd, logout. `mailbox` holds { uid, source, seen }.
function imapDouble(mailbox) {
  return class FakeImapFlow {
    constructor(options) {
      FakeImapFlow.options = options;
    }

    async connect() {}

    async getMailboxLock(name) {
      FakeImapFlow.locked = name;
      return { release() {} };
    }

    async search(query) {
      return mailbox.filter((m) => (query.seen === false ? !m.seen : true)).map((m) => m.uid);
    }

    async fetchOne(uid) {
      return { source: Buffer.from(mailbox.find((m) => String(m.uid) === String(uid)).source) };
    }

    async messageFlagsAdd(uid, flags) {
      if (flags.includes('\\Seen')) mailbox.find((m) => String(m.uid) === String(uid)).seen = true;
    }

    async logout() {}
  };
}

function rawReply({ subject = 'Re: King Louie: 1 question', inReplyTo = '<kl-d-ABC123@example.com>', body = 'a', auth = [], from = 'owner@example.com' } = {}) {
  return [
    ...auth.map((a) => `Authentication-Results: ${a}`),
    `From: Owner <${from}>`,
    'To: kl@example.com',
    `Subject: ${subject}`,
    'Message-ID: <reply-1@example.com>',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'Date: Fri, 25 Sep 2026 14:05:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    ''
  ].join('\r\n');
}

const DSN = [
  'From: Mail Delivery System <mailer-daemon@mx.example.com>',
  'To: kl@example.com',
  'Subject: Undelivered Mail Returned to Sender',
  'Message-ID: <dsn-1@mx.example.com>',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUNDARY"',
  '',
  '--BOUNDARY',
  'Content-Type: text/plain',
  '',
  'Your message could not be delivered.',
  '--BOUNDARY',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.com',
  '',
  'Final-Recipient: rfc822; owner@example.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 mailbox unavailable',
  '--BOUNDARY',
  'Content-Type: text/rfc822-headers',
  '',
  'Message-ID: <kl-d-ABC123@example.com>',
  'Subject: King Louie: 1 question [KL-K7QD4M]',
  '--BOUNDARY--',
  ''
].join('\r\n');

function channelWith(mailbox, { smtpPort = 1 } = {}) {
  const Imap = imapDouble(mailbox);
  const transport = createImapSmtpTransport({
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: '' },
    imap: { host: '127.0.0.1', port: 993, user: 'kl@example.com' },
    getPassword: (which) => `${which}-secret`,
    ImapFlow: Imap
  });
  const email = new EmailChannel({ transport, getConfig: () => CONFIG });
  const calls = [];
  email.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, answer, meta }); return { ok: meta.ownerProven, outcome: 'recorded', ackText: null }; });
  return { email, calls, transport, Imap };
}

describe('Authentication-Results', () => {
  it('only the topmost header counts, with the trusted authserv-id', () => {
    const lines = [
      { key: 'authentication-results', line: 'Authentication-Results: mx.example.com;\r\n spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com' },
      { key: 'authentication-results', line: 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com' }
    ];
    const top = topAuthResults(lines);
    assert.strictEqual(top, 'mx.example.com; spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com');
    assert.strictEqual(authResultsPass(top, { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), false);
    assert.strictEqual(authResultsPass('mx.example.com; dmarc=pass header.from=example.com', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), true);
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=bounce@mail.example.com', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), true, 'aligned SPF');
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=other.example.org', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), false, 'unaligned SPF');
    assert.strictEqual(authResultsPass('evil.example.org; dmarc=pass', { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' }), false, 'untrusted authserv-id');
  });

  it('a forged lower header is ignored: a reply without the token and a failing top header is not owner-proven', async () => {
    const mailbox = [{ uid: 1, seen: false, source: rawReply({ auth: ['mx.example.com; dmarc=fail header.from=example.com', 'mx.example.com; dmarc=pass header.from=example.com'] }) }];
    const { email, calls } = channelWith(mailbox);
    const seenDuring = [];
    email.onContactReply(async (correlationId, answer, meta) => { seenDuring.push(mailbox[0].seen); calls.push({ correlationId, answer, meta }); return { ok: false, outcome: 'refused: not-owner', ackText: null }; });
    await email.pollOnce();
    assert.strictEqual(calls[0].correlationId, 'd-ABC123', 'the thread names the delivery');
    assert.strictEqual(calls[0].meta.ownerProven, false);
    assert.deepStrictEqual(seenDuring, [false], 'still unseen while it is handled');
    assert.strictEqual(mailbox[0].seen, true, 'marked seen after handling');
  });

  it('a passing top header proves the owner without the token', async () => {
    const mailbox = [{ uid: 2, seen: false, source: rawReply({ auth: ['mx.example.com; dmarc=pass header.from=example.com'] }) }];
    const { email, calls, Imap } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, true);
    assert.deepStrictEqual(calls[0].answer, { text: 'a' });
    assert.strictEqual(Imap.options.logger, false, 'imapflow is constructed with logger: false');
    assert.deepStrictEqual(Imap.options.auth, { user: 'kl@example.com', pass: 'imap-secret' });
    assert.strictEqual(Imap.locked, 'INBOX');
  });
});

describe('token fallback and quoted history', () => {
  it('an unauthenticated reply from the owner counts when the [KL-…] token is in the subject', async () => {
    const mailbox = [{ uid: 3, seen: false, source: rawReply({ subject: 'Re: King Louie: 1 question [KL-K7QD4M]' }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, true);
  });

  it('a stranger with the token is not the owner', async () => {
    const mailbox = [{ uid: 4, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', from: 'someone@example.org' }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, false);
  });

  it('strips quoted history before the answer is read', async () => {
    const body = '#K7QD4M 1 a\r\n\r\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\r\n> #K7QD4M 2 b\r\n> 1. Lakeside lot';
    const mailbox = [{ uid: 5, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', body }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.deepStrictEqual(calls[0].answer, { text: '#K7QD4M 1 a' });
  });

  it('a reply naming no batch is dropped', async () => {
    const mailbox = [{ uid: 6, seen: false, source: rawReply({ subject: 'hello', inReplyTo: null }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.deepStrictEqual(calls, []);
  });
});

describe('DSN → bounce', () => {
  it('a delivery-status report fails the original delivery', async () => {
    const mailbox = [{ uid: 7, seen: false, source: DSN }];
    const { email } = channelWith(mailbox);
    const statuses = [];
    email.onContactStatus((s) => statuses.push(s));
    assert.deepStrictEqual(await email.pollOnce(), { replies: 0, bounces: 1 });
    assert.deepStrictEqual(statuses, [{ externalRef: '<kl-d-ABC123@example.com>', status: 'bounced', error: 'smtp; 550 5.1.1 mailbox unavailable' }]);
  });
});

describe('sending', () => {
  it('imap-smtp: nodemailer sends the batch with the token in the subject and a kl- Message-ID', async () => {
    const smtp = await startFakeSmtp();
    try {
      const { email } = channelWith([], { smtpPort: smtp.port });
      const sent = await email.sendContact(MESSAGE, META);
      assert.deepStrictEqual(sent, { deliveryId: 'd-ABC123', externalRef: '<kl-d-ABC123@example.com>', relayId: null });
      assert.strictEqual(smtp.messages.length, 1);
      const raw = smtp.messages[0].raw;
      assert.match(raw, /Subject: King Louie: 1 question \[KL-K7QD4M\]/);
      assert.match(raw, /Message-ID: <kl-d-ABC123@example\.com>/i);
      assert.match(smtp.messages[0].to[0], /owner@example\.com/);
      await assert.rejects(email.send('someone@example.org', 'hi'), /not the owner/);
      await email.shutdown();
    } finally {
      await smtp.close();
    }
  });

  it('relay: the email body carries the Message-ID header and the delivery id as Idempotency-Key', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: client }), getConfig: () => CONFIG });
      assert.strictEqual(email.contactCapabilities().idempotentSend, true);
      const sent = await email.sendContact(MESSAGE, META);
      assert.strictEqual(sent.relayId, 'msg-1');
      const req = relay.sent()[0];
      assert.strictEqual(req.headers['idempotency-key'], 'd-ABC123');
      assert.strictEqual(req.body.channel, 'email');
      assert.strictEqual(req.body.to, 'owner@example.com');
      assert.strictEqual(req.body.headers['Message-ID'], '<kl-d-ABC123@example.com>');
    } finally {
      await relay.close();
    }
  });
});

// ---- Task 8 hardening: owner proof, bounces, credentials, relay routing. ----

const PASS = { trustedAuthServId: 'mx.example.com', fromDomain: 'example.com' };

function captureLog() {
  const lines = [];
  const at = (level) => (msg, meta) => lines.push(`${level} ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  return { lines, trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal') };
}

describe('Authentication-Results: spoofing', () => {
  it('another authserv-id on top wins over a trusted pass lower down', async () => {
    const mailbox = [{ uid: 10, seen: false, source: rawReply({ auth: ['evil.example.org; dmarc=pass header.from=example.com', 'mx.example.com; dmarc=pass header.from=example.com'] }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, false);
  });

  it('a pass for another From domain does not prove the owner', async () => {
    assert.strictEqual(authResultsPass('mx.example.com; dmarc=pass header.from=example.org', PASS), false);
    assert.strictEqual(authResultsPass('mx.example.com; dmarc=pass header.from=mail.example.com', PASS), false, 'DMARC names the From domain exactly');
    assert.strictEqual(authResultsPass('mx.example.com; dmarc=pass', PASS), false, 'DMARC without header.from');
    const mailbox = [{ uid: 11, seen: false, source: rawReply({ auth: ['mx.example.com; dmarc=pass header.from=example.org'] }) }];
    const { email, calls } = channelWith(mailbox);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, false);
  });

  it('sender text inside a comment or a quoted string never reads as a result', () => {
    assert.strictEqual(authResultsPass('mx.example.com; spf=fail (domain of a;dmarc=pass header.from=example.com does not designate) smtp.mailfrom=evil.example.org', PASS), false);
    assert.strictEqual(authResultsPass('mx.example.com; spf=fail smtp.mailfrom="x;dmarc=pass header.from=example.com x"@evil.example.org', PASS), false);
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass (mx.example.com: sender ok) smtp.mailfrom=bounce@example.com', PASS), true, 'a comment is only dropped');
  });

  it('SPF and DKIM must align with the From domain; a bare suffix never aligns', () => {
    assert.strictEqual(authResultsPass('mx.example.com; dkim=pass header.d=example.com', PASS), true);
    assert.strictEqual(authResultsPass('mx.example.com; dkim=pass header.d=example.org', PASS), false);
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=com', PASS), false);
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=example.com', { trustedAuthServId: 'mx.example.com', fromDomain: 'mail.example.com' }), true, 'relaxed: parent domain');
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=example.com', { trustedAuthServId: '', fromDomain: 'example.com' }), false, 'no trusted id configured');
  });

  it('a message with two From addresses has no owner', async () => {
    const source = rawReply({ auth: ['mx.example.com; dmarc=pass header.from=example.com'] }).replace('From: Owner <owner@example.com>', 'From: Owner <owner@example.com>, Other <other@example.org>');
    const { email, calls } = channelWith([{ uid: 12, seen: false, source }]);
    await email.pollOnce();
    assert.strictEqual(calls[0].meta.ownerProven, false);
  });
});

describe('token binding', () => {
  it('an unauthenticated token must be the thread\'s own; another token names its own batch', async () => {
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: client }), getConfig: () => CONFIG });
      const calls = [];
      email.onContactReply(async (correlationId, answer, meta) => { calls.push({ correlationId, meta }); return { ok: true, outcome: 'recorded', ackText: null }; });
      await email.sendContact(MESSAGE, META);
      const inReplyTo = '<kl-d-ABC123@example.com>';
      await email.ingestRelayEvent({ id: 'e1', type: 'inbound', from: 'owner@example.com', subject: 'Re: [KL-K7QD4M]', text: 'a', inReplyTo });
      await email.ingestRelayEvent({ id: 'e2', type: 'inbound', from: 'owner@example.com', subject: 'Re: [KL-ZZZZZZ]', text: 'a', inReplyTo });
      await email.ingestRelayEvent({ id: 'e3', type: 'inbound', from: 'owner@example.com', subject: 'Re: [KL-ZZZZZZ]', text: 'a', inReplyTo, auth: { verified: true, method: 'dmarc' } });
      assert.deepStrictEqual(calls.map((c) => [c.correlationId, c.meta.ownerProven]), [['d-ABC123', true], ['ZZZZZZ', true], ['d-ABC123', true]]);
      // Review T10 I1: the router resolves deliveryRef first, so it is set only
      // when the thread is the correlation; a token that names another batch
      // must not be overridden by the thread it was sent in.
      assert.deepStrictEqual(calls.map((c) => c.meta.deliveryRef), [inReplyTo, null, inReplyTo]);
    } finally {
      await relay.close();
    }
  });
});

describe('bounces and automatic mail are never answers', () => {
  const AUTO_REPLY = rawReply({ auth: ['mx.example.com; dmarc=pass header.from=example.com'], subject: 'Automatic reply: King Louie: 1 question [KL-K7QD4M]', body: 'I am out of the office.' })
    .replace('Content-Type:', 'Auto-Submitted: auto-replied\r\nContent-Type:');
  const DELAYED = DSN.replace('Action: failed', 'Action: delayed').replace('Status: 5.1.1', 'Status: 4.4.7');
  const DAEMON = rawReply({ subject: 'Delivery failure [KL-K7QD4M]', from: 'MAILER-DAEMON@mx.example.com', body: 'a' });
  const RECEIPT = DSN.replace('report-type=delivery-status', 'report-type=disposition-notification');

  for (const [name, source] of [['an auto-reply from the owner', AUTO_REPLY], ['a delay notice', DELAYED], ['a non-standard daemon bounce', DAEMON], ['a read receipt', RECEIPT]]) {
    it(`${name} reaches neither the reply nor the status handler`, async () => {
      const mailbox = [{ uid: 20, seen: false, source }];
      const { email, calls } = channelWith(mailbox);
      const statuses = [];
      email.onContactStatus((s) => statuses.push(s));
      assert.deepStrictEqual(await email.pollOnce(), { replies: 0, bounces: 0 });
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(statuses, []);
      assert.strictEqual(mailbox[0].seen, true);
    });
  }

  it('a relay inbound from a mail daemon or flagged automatic is not an answer', async () => {
    const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: { name: 'main', send: async () => ({ id: 'x' }) } }), getConfig: () => CONFIG });
    const calls = [];
    email.onContactReply(async (...a) => { calls.push(a); return { ok: true }; });
    await email.ingestRelayEvent({ id: 'e1', type: 'inbound', from: 'mailer-daemon@example.com', subject: '[KL-K7QD4M]', text: 'a', inReplyTo: '<kl-d-ABC123@example.com>' });
    await email.ingestRelayEvent({ id: 'e2', type: 'inbound', from: 'owner@example.com', subject: '[KL-K7QD4M]', text: 'a', autoSubmitted: true });
    assert.deepStrictEqual(calls, []);
  });
});

describe('credentials', () => {
  it('an SMTP failure echoing the password is redacted', async () => {
    const nodemailer = {
      createTransport: (opts) => ({
        opts,
        sendMail: async () => { const e = new Error(`Invalid login: 535 bad credentials for ${opts.auth.pass}`); e.responseCode = 535; e.code = 'EAUTH'; throw e; },
        close() {}
      })
    };
    const transport = createImapSmtpTransport({
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'kl@example.com' },
      imap: { host: 'imap.example.com', port: 993, user: 'kl@example.com' },
      getPassword: (which) => `${which}-hunter2`,
      nodemailer,
      ImapFlow: imapDouble([])
    });
    const email = new EmailChannel({ transport, getConfig: () => CONFIG });
    await assert.rejects(email.sendContact(MESSAGE, META), (err) => err instanceof ContactDeliveryError && err.code === 'not-configured'
      && !err.message.includes('smtp-hunter2') && err.message.includes('[redacted]'));
  });

  it('an IMAP failure echoing the password is redacted in the error and the log', async () => {
    const log = captureLog();
    class FailingImap {
      constructor(options) { this.options = options; this.handlers = {}; }
      on(ev, fn) { this.handlers[ev] = fn; }
      async connect() { this.handlers.error?.(new Error(`socket closed after LOGIN ${this.options.auth.pass}`)); throw new Error(`LOGIN failed for ${this.options.auth.pass}`); }
      close() {}
      async logout() {}
    }
    const transport = createImapSmtpTransport({
      smtp: { host: 'smtp.example.com', port: 587, user: '' },
      imap: { host: 'imap.example.com', port: 993, user: 'kl@example.com' },
      getPassword: (which) => `${which}-hunter2`,
      ImapFlow: FailingImap,
      log
    });
    await assert.rejects(transport.poll(async () => {}), (err) => !err.message.includes('imap-hunter2') && /^IMAP: LOGIN failed for \[redacted\]$/.test(err.message));
    assert.ok(log.lines.length > 0);
    assert.ok(log.lines.every((l) => !l.includes('hunter2')), log.lines.join('\n'));
  });
});

describe('relay routing and notices', () => {
  it('the relay transport exposes its client as email.relay; IMAP/SMTP has none', () => {
    const client = new ContactRelayClient({ name: 'main', baseUrl: 'https://relay.example.com', getToken: () => 't' });
    assert.strictEqual(new EmailChannel({ transport: createRelayEmailTransport({ relay: client }), getConfig: () => CONFIG }).relay.name, 'main');
    assert.strictEqual(channelWith([]).email.relay, null);
  });

  it('an app-only item goes out as a notice: no options, no reply hint', async () => {
    const { renderBatch } = require('../src/cases/contact-format');
    const record = { id: 'q-0001', kind: 'approval', text: 'Sign the offer?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], urgency: 'normal', createdAt: '2026-09-25T14:00:00Z' };
    const message = renderBatch([{ caseId: 'c-1', caseTitle: 'Lakeside lot', token: '7QD4KM', record }], { batchToken: 'K7QD4M', authenticated: false });
    const relay = await startFakeRelay();
    try {
      const client = new ContactRelayClient({ name: 'main', baseUrl: relay.baseUrl, getToken: () => relay.token });
      const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: client }), getConfig: () => CONFIG });
      await email.sendContact(message, META);
      const text = relay.sent()[0].body.text;
      assert.match(text, /Answer this in the app: Sign the offer\?/);
      assert.doesNotMatch(text, /approve\) Approve|Reply "#/);
    } finally {
      await relay.close();
    }
  });
});

// ---- Task 8 fix round 1 ----

function channelLogged(mailbox, { simpleParser } = {}) {
  const log = captureLog();
  const transport = createImapSmtpTransport({
    smtp: { host: '127.0.0.1', port: 1, secure: false, user: '' },
    imap: { host: '127.0.0.1', port: 993, user: 'kl@example.com' },
    getPassword: (which) => `${which}-secret`,
    ImapFlow: imapDouble(mailbox),
    ...(simpleParser ? { simpleParser } : {}),
    log
  });
  const email = new EmailChannel({ transport, getConfig: () => CONFIG, log });
  return { email, log };
}

describe('IMAP: seen only after handling', () => {
  it('a failing item stays unseen and is retried; the rest are handled; after 3 failures it is marked seen and logged', async () => {
    const mailbox = [
      { uid: 30, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', body: 'poison' }) },
      { uid: 31, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', body: 'b' }) }
    ];
    const { email, log } = channelLogged(mailbox);
    const answers = [];
    email.onContactReply(async (c, answer) => {
      if (answer.text === 'poison') throw new Error('handler exploded');
      answers.push(answer.text);
      return { ok: true, outcome: 'recorded', ackText: null };
    });
    await email.pollOnce();
    assert.deepStrictEqual(answers, ['b'], 'the item after the failing one is still handled');
    assert.deepStrictEqual(mailbox.map((m) => m.seen), [false, true]);
    await email.pollOnce();
    assert.strictEqual(mailbox[0].seen, false, 'two failures: still unseen');
    await email.pollOnce();
    assert.strictEqual(mailbox[0].seen, true, 'three failures: given up');
    assert.deepStrictEqual(answers, ['b'], 'never handled twice');
    assert.ok(log.lines.some((l) => /^warn .*handler exploded/.test(l)), log.lines.join('\n'));
    assert.ok(log.lines.some((l) => /^warn .*message 30 .*3 attempts/.test(l)), log.lines.join('\n'));
  });

  it('a throwing status handler does not lose the reply after the bounce', async () => {
    const mailbox = [{ uid: 32, seen: false, source: DSN }, { uid: 33, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]' }) }];
    const { email } = channelLogged(mailbox);
    email.onContactStatus(async () => { throw new Error('status store down'); });
    const calls = [];
    email.onContactReply(async (...a) => { calls.push(a); return { ok: true }; });
    await email.pollOnce();
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(mailbox.map((m) => m.seen), [false, true]);
  });

  it('oversized and unparseable messages are marked seen at once', async () => {
    const big = rawReply({ subject: 'Re: [KL-K7QD4M]', body: 'x'.repeat(2 * 1024 * 1024 + 10) });
    const mailbox = [{ uid: 34, seen: false, source: big }, { uid: 35, seen: false, source: 'garbage' }];
    const { email, log } = channelLogged(mailbox, { simpleParser: async (src) => { if (String(src) === 'garbage') throw new Error('bad mime'); return require('mailparser').simpleParser(src); } });
    const calls = [];
    email.onContactReply(async (...a) => { calls.push(a); return { ok: true }; });
    await email.pollOnce();
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(mailbox.map((m) => m.seen), [true, true]);
    assert.ok(log.lines.some((l) => /message 34 is over/.test(l)));
    assert.ok(log.lines.some((l) => /could not parse message 35/.test(l)));
  });

  it('an HTML reply with no readable text is dropped with a warning naming its Message-ID, not its content', async () => {
    const source = rawReply({ subject: 'Re: [KL-K7QD4M]', body: '<html><head><style>.SECRET-CONTENT{color:red}</style></head><body><p> </p></body></html>' })
      .replace('Content-Type: text/plain; charset=utf-8', 'Content-Type: text/html; charset=utf-8');
    const mailbox = [{ uid: 36, seen: false, source }];
    const { email, log } = channelLogged(mailbox);
    const calls = [];
    email.onContactReply(async (...a) => { calls.push(a); return { ok: true }; });
    await email.pollOnce();
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(mailbox[0].seen, true);
    const line = log.lines.find((l) => l.includes('<reply-1@example.com>'));
    assert.ok(line && line.startsWith('warn '), log.lines.join('\n'));
    assert.ok(log.lines.every((l) => !l.includes('SECRET-CONTENT')));
  });
});

describe('relay From must be one bare address', () => {
  for (const from of ['"<owner@example.com>" <attacker@example.org>', 'Owner <owner@example.com>', 'owner@example.com, other@example.org', '<owner@example.com>', 'owner@example.com (Owner)']) {
    it(`${from} is not the owner`, async () => {
      const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: { name: 'main', send: async () => ({ id: 'x' }) } }), getConfig: () => CONFIG });
      const calls = [];
      email.onContactReply(async (c, a, meta) => { calls.push(meta); return { ok: false }; });
      await email.ingestRelayEvent({ id: 'e1', type: 'inbound', from, subject: 'Re: [KL-K7QD4M]', text: 'a', auth: { verified: true } });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].ownerProven, false);
    });
  }

  it('a bare owner address (any case) is the owner', async () => {
    const email = new EmailChannel({ transport: createRelayEmailTransport({ relay: { name: 'main', send: async () => ({ id: 'x' }) } }), getConfig: () => CONFIG });
    const calls = [];
    email.onContactReply(async (c, a, meta) => { calls.push(meta); return { ok: true }; });
    await email.ingestRelayEvent({ id: 'e1', type: 'inbound', from: ' Owner@Example.com ', subject: 'Re: [KL-K7QD4M]', text: 'a', auth: { verified: true } });
    assert.strictEqual(calls[0].ownerProven, true);
  });
});

describe('Authentication-Results: repeated properties', () => {
  it('the first value of a repeated property wins', () => {
    assert.strictEqual(authResultsPass('mx.example.com; dmarc=pass header.from=example.org header.from=example.com', PASS), false);
    assert.strictEqual(authResultsPass('mx.example.com; spf=pass smtp.mailfrom=evil.example.org smtp.mailfrom=example.com', PASS), false);
    assert.strictEqual(authResultsPass('mx.example.com; dmarc=pass header.from=example.com header.from=example.org', PASS), true);
  });
});

// ---- Task 8 fix round 2 ----

describe('IMAP: a stuck handler times out', () => {
  const { holdEventLoop } = require('./helpers/hold-event-loop');

  it('a handler that never settles fails the attempt; the poll finishes and the next one runs', async () => {
    const release = holdEventLoop();
    try {
      const mailbox = [
        { uid: 40, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', body: 'stuck' }) },
        { uid: 41, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', body: 'b' }) }
      ];
      const log = captureLog();
      const transport = createImapSmtpTransport({
        smtp: { host: '127.0.0.1', port: 1, secure: false, user: '' },
        imap: { host: '127.0.0.1', port: 993, user: 'kl@example.com' },
        ImapFlow: imapDouble(mailbox),
        handleTimeoutMs: 50,
        log
      });
      const email = new EmailChannel({ transport, getConfig: () => CONFIG, log });
      const seen = [];
      email.onContactReply(async (c, answer) => {
        seen.push(answer.text);
        if (answer.text === 'stuck') return new Promise(() => {});
        return { ok: true, outcome: 'recorded', ackText: null };
      });
      assert.deepStrictEqual(await email.pollOnce(), { replies: 1, bounces: 0 });
      assert.deepStrictEqual(mailbox.map((m) => m.seen), [false, true], 'the stuck message stays unseen');
      assert.ok(log.lines.some((l) => /^warn message 40 left unseen .*timed out after 50 ms/.test(l)), log.lines.join('\n'));
      await email.pollOnce();
      assert.deepStrictEqual(seen, ['stuck', 'b', 'stuck'], 'the next poll ran');
    } finally {
      release();
    }
  });
});

describe('IMAP: attempts are keyed by UIDVALIDITY and UID', () => {
  it('a new UIDVALIDITY starts the count again', async () => {
    const mailbox = [{ uid: 50, seen: false, source: rawReply({ subject: 'Re: [KL-K7QD4M]', body: 'poison' }) }];
    const Base = imapDouble(mailbox);
    let uidValidity = 1n;
    class Imap extends Base {
      get mailbox() { return { path: 'INBOX', uidValidity }; }
    }
    const transport = createImapSmtpTransport({
      smtp: { host: '127.0.0.1', port: 1, secure: false, user: '' },
      imap: { host: '127.0.0.1', port: 993, user: 'kl@example.com' },
      ImapFlow: Imap,
      log: captureLog()
    });
    const email = new EmailChannel({ transport, getConfig: () => CONFIG, log: captureLog() });
    email.onContactReply(async () => { throw new Error('boom'); });
    await email.pollOnce();
    await email.pollOnce();
    uidValidity = 2n; // the mailbox was recreated: uid 50 is another message now
    await email.pollOnce();
    assert.strictEqual(mailbox[0].seen, false, 'one failure under the new UIDVALIDITY, not the third');
    await email.pollOnce();
    await email.pollOnce();
    assert.strictEqual(mailbox[0].seen, true);
  });
});
