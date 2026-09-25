// tests/contact-format.test.js — cases stage 4 §3.5, §4.1, §4.4 (pure parts).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  validatePolicy, resolveSteps, defaultPolicy, effectivePolicy, newToken, TOKEN_RE, normalizeAddress,
  renderBatch, parseReply, optionOrText, stripQuoted, formatShort, SLACK_ERROR, assertRelayBaseUrl
} = require('../src/cases/contact-format');

const NOW = new Date('2026-09-25T14:00:00Z');

describe('validatePolicy', () => {
  it('accepts the default policy unchanged', () => {
    const r = validatePolicy(defaultPolicy(), { now: NOW });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.policy.ladders.high.map((s) => [s.channel, s.afterMin]), [['present', 0], ['sms', 15], ['voice', 30]]);
    assert.deepStrictEqual(r.policy.ladders.low[2], { channel: 'email', afterMin: 0, digest: true });
  });

  it('names slack and unknown channels', () => {
    const p = defaultPolicy();
    p.ladders.normal = [{ channel: 'slack' }];
    assert.deepStrictEqual(validatePolicy(p), { ok: false, error: SLACK_ERROR });
    p.ladders.normal = [{ channel: 'pager' }];
    assert.deepStrictEqual(validatePolicy(p), { ok: false, error: 'unknown contact channel "pager"' });
  });

  it('refuses decreasing afterMin, a digest before the last step, equal quiet hours and bad away', () => {
    const p = defaultPolicy();
    p.ladders.normal = [{ channel: 'present' }, { channel: 'telegram', afterMin: 30 }, { channel: 'email', afterMin: 10 }];
    assert.match(validatePolicy(p).error, /must not be smaller/);
    const q = defaultPolicy();
    q.ladders.low = [{ channel: 'email', digest: true }, { channel: 'journal' }];
    assert.match(validatePolicy(q).error, /only the last step/);
    assert.match(validatePolicy({ quietHours: { start: '22:00', end: '22:00' } }).error, /must differ/);
    assert.match(validatePolicy({ away: { mode: 'email-only' } }).error, /RFC3339/);
    assert.match(validatePolicy({ away: { mode: 'sms-only', until: '2026-09-26T00:00:00Z' } }).error, /away.mode/);
    assert.match(validatePolicy({ surprise: 1 }).error, /contactPolicy.surprise is not a known key/);
  });

  it('defaults breakthrough to high and clears a past away', () => {
    const r = validatePolicy({ quietHours: { start: '22:00', end: '07:00' }, away: { mode: 'email-only', until: '2026-09-24T00:00:00Z' } }, { now: NOW });
    assert.deepStrictEqual(r.policy.quietHours, { start: '22:00', end: '07:00', breakthrough: ['high'] });
    assert.strictEqual(r.policy.away, null);
    const future = validatePolicy({ away: { mode: 'in-app-only', until: '2026-09-26T00:00:00Z' } }, { now: NOW });
    assert.deepStrictEqual(future.policy.away, { mode: 'in-app-only', until: '2026-09-26T00:00:00Z' });
  });

  it('effectivePolicy fills what a stored policy leaves out', () => {
    const p = effectivePolicy({ batchDelaySec: 5 });
    assert.strictEqual(p.batchDelaySec, 5);
    assert.strictEqual(p.digest.channel, 'email');
    assert.strictEqual(p.presence.desktopIdleMin, 5);
  });
});

describe('resolveSteps and case.yaml overrides (§4.4)', () => {
  const policy = validatePolicy(defaultPolicy()).policy;

  it('uses the owner ladder by urgency', () => {
    assert.deepStrictEqual(resolveSteps(policy, 'normal').map((s) => `${s.channel}@${s.afterMin}`), ['present@0', 'telegram@30', 'email@240']);
  });

  it('a bare name takes the owner afterMin at its position, past the end last + 30; call means voice', () => {
    const steps = resolveSteps(policy, 'high', { high: ['present', 'sms', { channel: 'call', afterMin: 20 }, 'email'] });
    assert.deepStrictEqual(steps.map((s) => `${s.channel}@${s.afterMin}`), ['present@0', 'sms@15', 'voice@20', 'email@60']);
  });

  it('accepts the dotted urgency.<u> alias and drops channels the host cannot use', () => {
    const steps = resolveSteps(policy, 'normal', { 'urgency.normal': ['present', 'slack', 'email'] });
    assert.deepStrictEqual(steps.map((s) => s.channel), ['present', 'email']);
  });
});

describe('tokens and addresses', () => {
  it('makes 6-character Crockford tokens', () => {
    for (let i = 0; i < 200; i += 1) assert.match(newToken(), TOKEN_RE);
    assert.strictEqual(newToken(() => Buffer.from([0, 0, 0, 0])), '000000');
    assert.strictEqual(newToken(() => Buffer.from([255, 255, 255, 255])), 'ZZZZZZ');
  });

  it('normalizes phone numbers to E.164 and email to lowercase', () => {
    assert.strictEqual(normalizeAddress('sms', '+1 (555) 010-0'), '+15550100');
    assert.strictEqual(normalizeAddress('voice', '0015550100'), '+15550100');
    assert.strictEqual(normalizeAddress('sms', '5550100'), null);
    assert.strictEqual(normalizeAddress('email', 'Owner <Owner@Example.COM>'), 'owner@example.com');
    assert.strictEqual(normalizeAddress('email', 'not an address'), null);
    assert.strictEqual(normalizeAddress('telegram', ' 123 '), '123');
  });

  it('a relay baseUrl is https:, or http: to loopback only', () => {
    assert.strictEqual(assertRelayBaseUrl('https://relay.example.com/'), 'https://relay.example.com');
    assert.strictEqual(assertRelayBaseUrl('http://[::1]:8080'), 'http://[::1]:8080');
    assert.throws(() => assertRelayBaseUrl('http://relay.example.com'), /https:, or http: to loopback/);
    assert.throws(() => assertRelayBaseUrl('not a url'), /is not a URL/);
  });
});

describe('renderBatch', () => {
  const lot = { caseId: 'c-1', caseTitle: 'Sell the lakeside lot', token: '7QD4KM', record: { id: 'q-0012', kind: 'question', urgency: 'high', createdAt: '2026-09-25T13:00:00Z', expiresAt: '2026-09-25T23:00:00Z', text: 'Is seller financing ever acceptable?', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] } };
  const kitchen = { caseId: 'c-2', caseTitle: 'Kitchen quotes', token: 'M2P8RT', record: { id: 'q-0003', kind: 'question', urgency: 'normal', createdAt: '2026-09-25T12:00:00Z', expiresAt: null, text: 'Which week suits the site visit?', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] } };

  it('renders the spec example: high first, numbered, one batch token, expiries in the owner zone', () => {
    const m = renderBatch([kitchen, lot], { batchToken: 'K7QD4M', timeZone: 'UTC' });
    assert.strictEqual(m.subject, 'King Louie: 2 questions (1 high)');
    assert.strictEqual(m.text, [
      'King Louie: 2 questions (1 high)',
      '',
      '1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?',
      '   a) No   b) Yes, up to 20 %',
      '2. Kitchen quotes — Which week suits the site visit?',
      '   a) Oct 5   b) Oct 12',
      '',
      'Reply "#K7QD4M 1 a" / "#K7QD4M 2 a". Start a free-text answer with #K7QD4M. Expires: 1) Sep 25 23:00.'
    ].join('\n'));
    assert.deepStrictEqual(m.items.map((i) => [i.n, i.token, i.questionId, i.caseId]), [[1, '7QD4KM', 'q-0012', 'c-1'], [2, 'M2P8RT', 'q-0003', 'c-2']]);
  });

  it('announces an approval without options on an unauthenticated channel', () => {
    const approval = { caseId: 'c-3', caseTitle: 'Lakeside lot', token: 'A1B2C3', record: { id: 'q-0020', kind: 'approval', urgency: 'normal', createdAt: '2026-09-25T13:00:00Z', text: 'Send the offer letter to the buyer?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] } };
    const m = renderBatch([approval], { batchToken: 'K7QD4M', authenticated: false, firstAuthenticated: 'telegram' });
    assert.strictEqual(m.items[0].answerable, false);
    assert.deepStrictEqual(m.items[0].options, []);
    assert.match(m.text, /Approval needed in Lakeside lot: Send the offer letter to the buyer\? Answer in King Louie or telegram\./);
    assert.doesNotMatch(m.text, /Reply "#/);
  });

  it('cuts long items to 280 characters when the message is over maxChars', () => {
    const long = { ...kitchen, record: { ...kitchen.record, text: 'x'.repeat(900) } };
    const m = renderBatch([long], { batchToken: 'K7QD4M', maxChars: 600 });
    assert.match(m.text, /x{280} \(open King Louie for the full text\)/);
    assert.strictEqual(m.tooLarge, false);
  });

  it('formatShort uses the zone', () => {
    assert.strictEqual(formatShort('2026-09-25T23:00:00Z', 'America/Chicago'), 'Sep 25 18:00');
  });
});

describe('parseReply', () => {
  const batch = {
    batchToken: 'K7QD4M',
    items: [
      { n: 1, token: '7QD4KM', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] },
      { n: 2, token: 'M2P8RT', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] }
    ]
  };

  it('reads "#<batch> <n> <rest>" lines, one answer per line', () => {
    const r = parseReply(batch, '#K7QD4M 1 a\n#k7qd4m 2 Oct 12.');
    assert.deepStrictEqual(r.answers.map((a) => [a.item.n, a.answer]), [[1, { optionId: 'a' }], [2, { optionId: 'b' }]]);
    assert.strictEqual(r.ack, null);
  });

  it('reads "#<questionToken> <answer>" and free text', () => {
    const r = parseReply(batch, '#M2P8RT the week after, please');
    assert.deepStrictEqual(r.answers.map((a) => [a.item.n, a.answer]), [[2, { text: 'the week after, please' }]]);
  });

  it('a single-item batch takes "#<batch> <rest>"; a threaded reply may omit the token', () => {
    const one = { batchToken: 'K7QD4M', items: [batch.items[0]] };
    assert.deepStrictEqual(parseReply(one, '#K7QD4M no!').answers[0].answer, { optionId: 'a' });
    assert.deepStrictEqual(parseReply(one, 'yes, up to 20 %', { threaded: true }).answers[0].answer, { optionId: 'b' });
    assert.deepStrictEqual(parseReply(batch, '2 b', { threaded: true }).answers[0].item.n, 2);
  });

  it('anything else is not parsed and asks which question', () => {
    const r = parseReply(batch, 'sounds good');
    assert.deepStrictEqual(r.answers, []);
    assert.strictEqual(r.ack, 'Which question? Reply "#K7QD4M <n> <answer>".');
    assert.strictEqual(parseReply(batch, '#K7QD4M maybe').answers.length, 0, 'a two-item batch needs the number');
  });

  it('optionOrText matches id or label case-insensitively', () => {
    assert.deepStrictEqual(optionOrText([{ id: 'keep', label: 'Keep "No"' }], ' KEEP. '), { optionId: 'keep' });
    assert.deepStrictEqual(optionOrText([{ id: 'a', label: 'No' }], 'not sure'), { text: 'not sure' });
  });
});

describe('stripQuoted', () => {
  it('drops quoted lines and the history after "On … wrote:"', () => {
    const body = '#K7QD4M 1 a\nthanks\n\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\n> King Louie: 1 question\n> 1. Lakeside lot';
    assert.strictEqual(stripQuoted(body), '#K7QD4M 1 a\nthanks');
    assert.strictEqual(stripQuoted('> quoted only\nreal line'), 'real line');
  });
});

// Trust boundary: inbound SMS, email and voice text become owner answers.

describe('tokens are unguessable and TOKEN_RE admits only a whole token', () => {
  it('newToken draws from crypto.randomBytes by default', () => {
    const crypto = require('crypto');
    const real = crypto.randomBytes;
    const calls = [];
    crypto.randomBytes = (n) => { calls.push(n); return real(n); };
    try {
      assert.match(newToken(), TOKEN_RE);
    } finally {
      crypto.randomBytes = real;
    }
    assert.deepStrictEqual(calls, [4]);
  });

  it('uses all 30 random bits: every Crockford character shows up at every position', () => {
    const seen = Array.from({ length: 6 }, () => new Set());
    for (let i = 0; i < 3000; i += 1) [...newToken()].forEach((c, pos) => seen[pos].add(c));
    for (const s of seen) assert.strictEqual(s.size, 32);
    // bit layout: the low 2 bits of the 4 bytes are dropped, the rest map 5 bits per character
    assert.strictEqual(newToken(() => Buffer.from([0x08, 0, 0, 0])), '100000');
    assert.strictEqual(newToken(() => Buffer.from([0, 0, 0, 0x04])), '000001');
    assert.strictEqual(newToken(() => Buffer.from([0, 0, 0, 0x03])), '000000');
  });

  it('refuses partial, embedded, padded, lowercase and non-Crockford tokens', () => {
    assert.match('K7QD4M', TOKEN_RE);
    for (const bad of ['K7QD4', 'K7QD4MX', 'xK7QD4M', ' K7QD4M', 'K7QD4M ', 'K7QD4M\n', '\nK7QD4M', '#K7QD4M',
      'k7qd4m', 'K7QD4I', 'K7QD4L', 'K7QD4O', 'K7QD4U', 'K7QD4M\nK7QD4M', '']) {
      assert.doesNotMatch(bad, TOKEN_RE, JSON.stringify(bad));
    }
    assert.strictEqual(TOKEN_RE.global || TOKEN_RE.sticky || TOKEN_RE.multiline, false, 'stateless, whole-string');
  });
});

describe('parseReply picks an option only by an exact, unambiguous match', () => {
  const batch = {
    batchToken: 'K7QD4M',
    items: [
      { n: 1, token: '7QD4KM', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] },
      { n: 2, token: 'M2P8RT', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] }
    ]
  };
  const one = { batchToken: 'K7QD4M', items: [batch.items[0]] };

  it('never falls back to the first option', () => {
    for (const rest of ['yes', 'n', 'no way', 'a b', 'ab', 'Yes up to 20 %', 'option a', '?', 'Oct']) {
      const r = parseReply(batch, `#K7QD4M 1 ${rest}`);
      assert.deepStrictEqual(r.answers.map((a) => a.answer), [{ text: rest }], rest);
    }
    assert.deepStrictEqual(parseReply(one, '#K7QD4M ok').answers[0].answer, { text: 'ok' });
  });

  it('an option id that is also another option label is ambiguous: no option', () => {
    const crossed = [{ id: 'a', label: 'b' }, { id: 'b', label: 'a' }];
    assert.deepStrictEqual(optionOrText(crossed, 'a'), { text: 'a' });
    assert.deepStrictEqual(optionOrText([{ id: 'x', label: 'Yes' }, { id: 'y', label: 'yes.' }], 'YES'), { text: 'YES' });
    assert.deepStrictEqual(optionOrText([{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], 'approve'), { optionId: 'approve' });
  });

  it('an empty or punctuation-only reply is never an option', () => {
    assert.deepStrictEqual(optionOrText([{ id: 'a', label: '' }], '...'), { text: '...' });
    assert.deepStrictEqual(optionOrText([{ id: 'a', label: 'No' }], ''), { text: '' });
    assert.deepStrictEqual(parseReply(one, '#K7QD4M').answers, []);
    assert.deepStrictEqual(parseReply(batch, '#K7QD4M 1').answers, []);
  });

  it('labels are compared the same way as the reply (trailing punctuation dropped on both)', () => {
    assert.deepStrictEqual(optionOrText([{ id: 'b', label: 'Oct 12.' }], 'oct 12'), { optionId: 'b' });
    assert.deepStrictEqual(optionOrText([{ id: 7, label: 'Seven' }], '7'), { optionId: 7 });
  });

  it('two different answers to one item in one reply are ambiguous: neither applies', () => {
    const r = parseReply(batch, '#K7QD4M 1 a\n#K7QD4M 1 b\n#K7QD4M 2 a');
    assert.deepStrictEqual(r.answers.map((a) => [a.item.n, a.answer]), [[2, { optionId: 'a' }]]);
    const same = parseReply(batch, '#K7QD4M 1 a\n#7QD4KM No');
    assert.deepStrictEqual(same.answers.map((a) => [a.item.n, a.answer]), [[1, { optionId: 'a' }]]);
    // multi-item thread; a single-item thread is one joined answer (ruling T2-join)
    const threaded = parseReply(batch, '1 a\n1 b', { threaded: true });
    assert.deepStrictEqual(threaded.answers, []);
    assert.strictEqual(threaded.ack, 'Which question? Reply "#K7QD4M <n> <answer>".');
  });

  it('ignores tokens that are embedded, partial, too long, of another batch, or not at the line start', () => {
    for (const text of ['Please see #K7QD4M 1 a', '##K7QD4M 1 a', '#K7QD4M1 a', '#K7QD4MX 1 a', '#K7QD4 1 a',
      '#ZZZZZZ 1 a', '#K7QD4M 3 a', '#K7QD4M 0 a', '> #K7QD4M 1 a', '#K7QD4M:1 a']) {
      assert.deepStrictEqual(parseReply(batch, text).answers, [], text);
    }
  });

  it('without a thread an untokened line never answers, even on a single-item batch', () => {
    assert.deepStrictEqual(parseReply(one, 'no').answers, []);
    assert.deepStrictEqual(parseReply(batch, '1 a').answers, []);
  });

  it('a threaded reply ignores ">" quoted lines', () => {
    assert.deepStrictEqual(parseReply(one, '> No', { threaded: true }).answers, []);
  });
});

describe('stripQuoted: a top-posted reply that quotes the original batch', () => {
  const batch = {
    batchToken: 'K7QD4M',
    items: [
      { n: 1, token: '7QD4KM', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] },
      { n: 2, token: 'M2P8RT', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] }
    ]
  };
  const original = [
    'King Louie: 2 questions (1 high)',
    '',
    '1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?',
    '   a) No   b) Yes, up to 20 %',
    '2. Kitchen quotes — Which week suits the site visit?',
    '   a) Oct 5   b) Oct 12',
    '',
    'Reply "#K7QD4M 1 a" / "#K7QD4M 2 a". Start a free-text answer with #K7QD4M. Expires: 1) Sep 25 23:00.'
  ];
  const quoted = original.map((l) => (l ? `> ${l}` : '>')).join('\n');
  const parsed = (body) => parseReply(batch, stripQuoted(body), { threaded: true }).answers.map((a) => [a.item.n, a.answer]);

  it('Gmail/Apple: "On … wrote:" then ">" lines', () => {
    const body = `2 b\n\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\n\n${quoted}\n`;
    assert.strictEqual(stripQuoted(body), '2 b');
    assert.deepStrictEqual(parsed(body), [[2, { optionId: 'b' }]]);
  });

  it('Gmail with the "On … wrote:" header wrapped over two lines', () => {
    const body = `#K7QD4M 1 b\n\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <\nkl@example.com> wrote:\n${quoted}`;
    assert.strictEqual(stripQuoted(body), '#K7QD4M 1 b');
  });

  it('Outlook: a separator and a From:/Sent:/To:/Subject: block, the original not ">"-quoted', () => {
    const body = ['1 a', '', '________________________________', 'From: King Louie <kl@example.com>',
      'Sent: Friday, September 25, 2026 9:00 AM', 'To: owner@example.com',
      'Subject: King Louie: 2 questions (1 high) [KL-K7QD4M]', '', ...original].join('\r\n');
    assert.strictEqual(stripQuoted(body), '1 a');
    assert.deepStrictEqual(parsed(body), [[1, { optionId: 'a' }]]);
  });

  it('Outlook desktop: "-----Original Message-----"; Android: "-------- Original message --------"', () => {
    for (const sep of ['-----Original Message-----', '-------- Original message --------']) {
      const body = ['2 a', '', sep, 'From: King Louie <kl@example.com>', 'Date: 9/25/26 9:00 AM', '', ...original].join('\n');
      assert.strictEqual(stripQuoted(body), '2 a', sep);
    }
  });

  it('a From: header block without a separator', () => {
    const body = ['1 b', '', 'From: King Louie <kl@example.com>', 'Date: Friday, September 25, 2026', 'Subject: King Louie: 2 questions', '', ...original].join('\n');
    assert.strictEqual(stripQuoted(body), '1 b');
  });

  it('the original pasted back with no header at all is cut at its own first line', () => {
    const body = ['2 b', '', ...original].join('\n');
    assert.strictEqual(stripQuoted(body), '2 b');
    assert.deepStrictEqual(parsed(body), [[2, { optionId: 'b' }]]);
  });

  it('even without stripping, the unquoted original is not an answer (tokenless free text is ignored)', () => {
    const body = ['2 b', '', ...original].join('\n');
    assert.deepStrictEqual(parseReply(batch, body, { threaded: true }).answers.map((a) => [a.item.n, a.answer]), [[2, { optionId: 'b' }]]);
  });

  it('cuts at a "-- " signature delimiter', () => {
    assert.strictEqual(stripQuoted('1 a\n-- \nOwner\nexample.com'), '1 a');
  });

  it('keeps an owner line that merely starts with "On" or "From"', () => {
    assert.strictEqual(stripQuoted('On reflection, 1 b\nFrom now on ask me by text'), 'On reflection, 1 b\nFrom now on ask me by text');
  });

  it('a reply that is only quoted history is empty and parses to nothing', () => {
    const body = `On Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\n${quoted}`;
    assert.strictEqual(stripQuoted(body), '');
    assert.deepStrictEqual(parsed(body), []);
  });
});

describe('validatePolicy rejects bad values', () => {
  const withLadder = (normal) => { const p = defaultPolicy(); p.ladders.normal = normal; return p; };

  it('bad and non-string channels, in ladders and the digest', () => {
    assert.match(validatePolicy(withLadder([{ channel: 7 }])).error, /needs a channel/);
    assert.match(validatePolicy(withLadder([{}])).error, /needs a channel/);
    assert.match(validatePolicy(withLadder(['present'])).error, /needs a channel/);
    assert.match(validatePolicy(withLadder([])).error, /non-empty/);
    assert.match(validatePolicy(withLadder([{ channel: 'Email' }])).error, /unknown contact channel "Email"/);
    assert.match(validatePolicy({ ladders: { urgent: [{ channel: 'present' }] } }).error, /not an urgency/);
    assert.deepStrictEqual(validatePolicy({ digest: { channel: 'slack', at: '08:00' } }), { ok: false, error: SLACK_ERROR });
    assert.match(validatePolicy({ digest: { channel: 'pager', at: '08:00' } }).error, /unknown contact channel "pager"/);
    assert.match(validatePolicy({ digest: { channel: 'journal', at: '08:00' } }).error, /digest.channel must be a contact channel/);
  });

  it('negative, fractional, non-numeric and huge delays', () => {
    for (const afterMin of [-1, 1.5, '15', Infinity, NaN, 10081, 1e12]) {
      assert.strictEqual(validatePolicy(withLadder([{ channel: 'present' }, { channel: 'email', afterMin }])).ok, false, String(afterMin));
    }
    assert.strictEqual(validatePolicy(withLadder([{ channel: 'present' }, { channel: 'email', afterMin: 10080 }])).ok, true);
    for (const batchDelaySec of [-1, 0.5, '60', 3601, 1e12]) {
      assert.match(validatePolicy({ batchDelaySec }).error, /batchDelaySec/, String(batchDelaySec));
    }
    assert.strictEqual(validatePolicy({ batchDelaySec: 3600 }).ok, true);
    assert.strictEqual(validatePolicy({ batchDelaySec: 0 }).ok, true);
    for (const v of [0, -5, 1441, 2.5]) {
      assert.match(validatePolicy({ presence: { desktopIdleMin: v } }).error, /presence.desktopIdleMin/, String(v));
    }
  });

  it('a stored policy with a huge or negative batchDelaySec falls back to the default', () => {
    assert.strictEqual(effectivePolicy({ batchDelaySec: 1e12 }).batchDelaySec, 60);
    assert.strictEqual(effectivePolicy({ batchDelaySec: -3 }).batchDelaySec, 60);
  });

  it('bad times and dates', () => {
    for (const start of ['7:00', '24:00', '22:60', '22-00', 2200]) {
      assert.match(validatePolicy({ quietHours: { start, end: '07:00' } }).error, /HH:MM/, String(start));
    }
    assert.match(validatePolicy({ quietHours: { start: '22:00', end: '07:00', breakthrough: ['urgent'] } }).error, /breakthrough/);
    assert.match(validatePolicy({ digest: { channel: 'email', at: '8am' } }).error, /digest.at/);
    for (const until of ['2026-02-30T00:00:00Z', '2026-09-26T24:00:00Z', '2026-09-26T10:00:00+25:00', '2026-09-26', 'tomorrow', 1790467200000]) {
      assert.match(validatePolicy({ away: { mode: 'email-only', until } }, { now: NOW }).error, /RFC3339/, String(until));
    }
    assert.strictEqual(validatePolicy({ away: { mode: 'email-only', until: '2026-09-26T09:00:00-05:00' } }, { now: NOW }).ok, true);
  });

  it('the time zone is not a policy key (it is settings.cases.timeZone); a bad zone falls back to the host zone', () => {
    assert.match(validatePolicy({ timeZone: 'Mars/Olympus' }).error, /contactPolicy.timeZone is not a known key/);
    assert.strictEqual(formatShort('2026-09-25T23:00:00Z', 'Mars/Olympus'), formatShort('2026-09-25T23:00:00Z', ''));
  });

  it('non-object input', () => {
    for (const input of [null, [], 'x', 3]) assert.strictEqual(validatePolicy(input).ok, false);
  });
});

// Fix round 1 (review T2): a `{ text }` answer becomes a `user` fact, so
// text must never be misassigned to the owner.

describe('fix round 1: threaded replies without a token (ruling T2-reply)', () => {
  const batch = {
    batchToken: 'K7QD4M',
    items: [
      { n: 1, token: '7QD4KM', caseTitle: 'Sell the lakeside lot', urgency: 'high', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] },
      { n: 2, token: 'M2P8RT', caseTitle: 'Kitchen quotes', urgency: 'normal', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] }
    ]
  };
  const one = { batchToken: 'K7QD4M', items: [batch.items[0]] };
  const T = { threaded: true };
  const pairs = (r) => r.answers.map((a) => [a.item.n, a.answer]);

  it('an inline-quoted item line is not an answer', () => {
    assert.deepStrictEqual(pairs(parseReply(batch, '2. Kitchen quotes — Which week suits the site visit?\n2 b', T)), [[2, { optionId: 'b' }]]);
    assert.deepStrictEqual(pairs(parseReply(batch, '1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?', T)), []);
    // even behind the batch token the rendered header is never an answer
    assert.deepStrictEqual(pairs(parseReply(batch, '#K7QD4M 2. Kitchen quotes — Which week suits the site visit?')), []);
  });

  it('a signature address is not an answer', () => {
    assert.deepStrictEqual(pairs(parseReply(batch, stripQuoted('2 b\n\nJane Owner\n1 Main Street\nSpringfield'), T)), [[2, { optionId: 'b' }]]);
  });

  it('a French quote header followed by a quoted item line is not an answer', () => {
    const body = '2 b\n\nLe ven. 25 sept. 2026 à 09:00, King Louie <kl@example.com> a écrit :\n1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?\n   a) No   b) Yes, up to 20 %';
    assert.deepStrictEqual(pairs(parseReply(batch, stripQuoted(body), T)), [[2, { optionId: 'b' }]]);
  });

  it('numbered free text without a token is not an answer', () => {
    const r = parseReply(batch, '2 weeks from now works', T);
    assert.deepStrictEqual(r.answers, []);
    assert.strictEqual(r.ack, 'Which question? Reply "#K7QD4M <n> <answer>".');
    // ruling T2-join: a trailing "Sent from my …" line is dropped
    assert.deepStrictEqual(pairs(parseReply(one, 'No\n\nSent from my iPhone', T)), [[1, { optionId: 'a' }]]);
    // with the token the same text is an answer
    assert.deepStrictEqual(pairs(parseReply(batch, '#K7QD4M 2 weeks from now works')), [[2, { text: 'weeks from now works' }]]);
  });

  it('a tokenless option pick by exact match still works', () => {
    assert.deepStrictEqual(pairs(parseReply(batch, '1 yes, up to 20 %\n2 Oct 5', T)), [[1, { optionId: 'b' }], [2, { optionId: 'a' }]]);
    assert.deepStrictEqual(pairs(parseReply(one, 'no.', T)), [[1, { optionId: 'a' }]]);
  });

  it('ruling T2-single: a single-item thread takes free text; only the owner text survives the quoted history', () => {
    const original = [
      'King Louie: 1 question (1 high)',
      '',
      '1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?',
      '   a) No   b) Yes, up to 20 %',
      '',
      'Reply "#K7QD4M a". Start a free-text answer with #K7QD4M. Expires: 1) Sep 25 23:00.'
    ];
    const gmail = `Only if the buyer puts 30 % down\n\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\n${original.map((l) => `> ${l}`).join('\n')}`;
    const outlook = ['Only if the buyer puts 30 % down', '', ...original].join('\n');
    for (const body of [gmail, outlook]) {
      assert.deepStrictEqual(pairs(parseReply(one, stripQuoted(body), T)), [[1, { text: 'Only if the buyer puts 30 % down' }]]);
    }
  });

  it('the reply hint says free text needs the code', () => {
    const m = renderBatch([{ caseId: 'c-2', caseTitle: 'Kitchen quotes', token: 'M2P8RT', record: { id: 'q-3', kind: 'question', urgency: 'normal', createdAt: 'x', text: 'Which week?', options: [] } }], { batchToken: 'K7QD4M' });
    assert.match(m.text, /Reply "#K7QD4M <answer>"\. Start a free-text answer with #K7QD4M\.$/);
  });
});

describe('fix round 1: swapped tokens', () => {
  const batch = {
    batchToken: 'K7QD4M',
    items: [
      { n: 1, token: '7QD4KM', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] },
      { n: 2, token: 'M2P8RT', options: [{ id: 'a', label: 'Oct 5' }, { id: 'b', label: 'Oct 12' }] }
    ]
  };

  it('an answer that only fits another item of the batch is dropped', () => {
    const r = parseReply(batch, '#7QD4KM Oct 12');
    assert.deepStrictEqual(r.answers, []);
    assert.strictEqual(r.ack, 'Which question? Reply "#K7QD4M <n> <answer>".');
    assert.deepStrictEqual(parseReply(batch, '#7QD4KM Oct 12\n#M2P8RT No').answers, []);
    assert.deepStrictEqual(parseReply(batch, '#K7QD4M 1 Oct 12').answers, []);
    // text that fits no option anywhere is still free text
    assert.deepStrictEqual(parseReply(batch, '#7QD4KM maybe later').answers.map((a) => a.answer), [{ text: 'maybe later' }]);
    assert.deepStrictEqual(parseReply(batch, '#7QD4KM b').answers.map((a) => a.answer), [{ optionId: 'b' }]);
  });
});

describe('fix round 1: resolveSteps never returns an empty ladder', () => {
  const policy = validatePolicy(defaultPolicy()).policy;
  const chans = (steps) => steps.map((s) => `${s.channel}@${s.afterMin}${s.digest ? '+d' : ''}`);

  it('non-empty for every override that filters to nothing', () => {
    for (const bad of [['slack', 'pager'], [], [null, {}], [{ channel: 'call-me' }], 'present', [7]]) {
      const steps = resolveSteps(policy, 'high', { high: bad });
      assert.deepStrictEqual(chans(steps), ['present@0', 'sms@15', 'voice@30'], JSON.stringify(bad));
    }
  });

  it('an empty or unusable owner ladder falls back to normal, then to the default', () => {
    assert.deepStrictEqual(chans(resolveSteps({ ladders: { high: [], normal: [{ channel: 'present' }] } }, 'high')), ['present@0']);
    assert.deepStrictEqual(chans(resolveSteps(policy, 'urgent')), ['present@0', 'telegram@30', 'email@240']);
    assert.deepStrictEqual(chans(resolveSteps({ ladders: { high: [{ channel: 'pager' }] } }, 'high')), ['present@0', 'sms@15', 'voice@30']);
    assert.deepStrictEqual(chans(resolveSteps({}, 'low')), ['in-app@0', 'journal@0', 'email@0+d']);
    assert.deepStrictEqual(chans(resolveSteps({ ladders: { high: [], normal: [] } }, 'high', { high: ['slack'] })), ['present@0', 'sms@15', 'voice@30']);
  });

  it('an override afterMin out of range is unset: the positional default applies', () => {
    for (const afterMin of [1e308, -1, 10081, 2.5, '15']) {
      assert.deepStrictEqual(chans(resolveSteps(policy, 'high', { high: ['present', { channel: 'sms', afterMin }] })), ['present@0', 'sms@15'], String(afterMin));
    }
    assert.deepStrictEqual(chans(resolveSteps(policy, 'high', { high: ['present', { channel: 'sms', afterMin: 10080 }] })), ['present@0', 'sms@10080']);
  });

  it('digest only on the last step', () => {
    assert.deepStrictEqual(chans(resolveSteps(policy, 'low', { low: [{ channel: 'email', digest: true }, 'sms'] })), ['email@0', 'sms@0']);
    assert.deepStrictEqual(chans(resolveSteps(policy, 'low', { low: ['in-app', { channel: 'email', digest: true }, 'slack'] })), ['in-app@0', 'email@0+d']);
  });
});

describe('fix round 1: validatePolicy nested shapes', () => {
  it('ladders and presence must be objects', () => {
    for (const ladders of ['x', null, [[{ channel: 'present' }]], 3]) {
      assert.match(validatePolicy({ ladders }).error, /^contactPolicy.ladders must be an object/, JSON.stringify(ladders));
    }
    for (const presence of ['x', null, [5]]) {
      assert.match(validatePolicy({ presence }).error, /^contactPolicy.presence must be an object/, JSON.stringify(presence));
    }
  });

  it('refuses unknown nested keys, naming the path', () => {
    assert.strictEqual(validatePolicy({ presence: { desktopIdleMin: 5, bogus: 1 } }).error, 'contactPolicy.presence.bogus is not a known key');
    assert.strictEqual(validatePolicy({ quietHours: { start: '22:00', end: '07:00', extra: 1 } }).error, 'contactPolicy.quietHours.extra is not a known key');
    assert.strictEqual(validatePolicy({ away: { mode: 'email-only', until: '2026-09-26T00:00:00Z', why: 'x' } }, { now: NOW }).error, 'contactPolicy.away.why is not a known key');
    assert.strictEqual(validatePolicy({ digest: { channel: 'email', at: '08:00', to: 'x' } }).error, 'contactPolicy.digest.to is not a known key');
    assert.strictEqual(validatePolicy({ ladders: { normal: [{ channel: 'present', afterMin: 0, foo: 1 }] } }).error, 'contactPolicy.ladders.normal[0].foo is not a known key');
  });

  it('refuses a digest step on journal or present', () => {
    assert.match(validatePolicy({ ladders: { low: [{ channel: 'journal', digest: true }] } }).error, /ladders.low\[0\]: a digest step must be a contact channel/);
    assert.match(validatePolicy({ ladders: { low: [{ channel: 'in-app' }, { channel: 'present', digest: true }] } }).error, /a digest step must be a contact channel/);
    assert.strictEqual(validatePolicy({ ladders: { low: [{ channel: 'journal' }, { channel: 'email', digest: true }] } }).ok, true);
  });
});

describe('ruling T2-join: a single-item threaded reply is one answer', () => {
  const one = { batchToken: 'K7QD4M', items: [{ n: 1, token: '7QD4KM', caseTitle: 'Sell the lakeside lot', urgency: 'high', options: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes, up to 20 %' }] }] };
  const T = { threaded: true };
  const pairs = (r) => r.answers.map((a) => [a.item.n, a.answer]);

  it('a two-line free-text answer is one text answer', () => {
    assert.deepStrictEqual(pairs(parseReply(one, 'Only if the buyer puts 30 % down.\n\nAnd only for 5 years.', T)),
      [[1, { text: 'Only if the buyer puts 30 % down.\nAnd only for 5 years.' }]]);
  });

  it('an answer plus a "-- " signature keeps only the answer', () => {
    assert.deepStrictEqual(pairs(parseReply(one, 'Only if the buyer puts 30 % down\n-- \nJane Owner\n1 Main Street', T)),
      [[1, { text: 'Only if the buyer puts 30 % down' }]]);
  });

  it('an answer plus "Sent from my iPhone" keeps only the answer', () => {
    assert.deepStrictEqual(pairs(parseReply(one, 'Only if the buyer puts 30 % down\n\nSent from my iPhone', T)),
      [[1, { text: 'Only if the buyer puts 30 % down' }]]);
  });

  it('an exact option with a signature is that option', () => {
    assert.deepStrictEqual(pairs(parseReply(one, 'Yes, up to 20 %.\n-- \nJane Owner', T)), [[1, { optionId: 'b' }]]);
    assert.deepStrictEqual(pairs(parseReply(one, 'b\n\nSent from my Android phone', T)), [[1, { optionId: 'b' }]]);
  });

  it('quoted history is stripped first; nothing left means no answer', () => {
    const body = 'No\n\nOn Fri, Sep 25, 2026 at 9:00 AM King Louie <kl@example.com> wrote:\n> 1. [HIGH] Sell the lakeside lot — Is seller financing ever acceptable?';
    assert.deepStrictEqual(pairs(parseReply(one, body, T)), [[1, { optionId: 'a' }]]);
    const empty = parseReply(one, '\n-- \nJane Owner\n', T);
    assert.deepStrictEqual(empty.answers, []);
    assert.strictEqual(empty.ack, 'Which question? Reply "#K7QD4M <n> <answer>".');
  });

  it('with a #token line only the tokened lines count', () => {
    assert.deepStrictEqual(pairs(parseReply(one, '#K7QD4M b\nthanks', T)), [[1, { optionId: 'b' }]]);
  });
});
