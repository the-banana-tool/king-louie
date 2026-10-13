// tests/history-importer-markdown.test.js
// The markdown-transcript importer (recall spec §10.2, stage H4): a Markdown
// file whose headings name the speakers, read with a heading pattern the
// owner can change.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const importer = require('../src/history/importers/markdown-transcript');
const { IMPORTERS, detectImporter } = require('../src/history/importers');
const { validateMessages } = require('../src/longhaul/session-format');
const { scanForPersonalValues } = require('./helpers/example-denylist');
const { tmpDir } = require('./helpers/longhaul-helpers');
const cc = require('./helpers/claude-code-fixture');

const FIXTURE = path.join(__dirname, 'fixtures', 'history', 'markdown-transcript.md');
const KL_FIXTURE = path.join(__dirname, 'fixtures', 'history', 'king-louie-chat.json');

function write(text, name = 'talk.md') {
  const file = path.join(tmpDir(), name);
  fs.writeFileSync(file, text);
  return file;
}
const lines = (...list) => `${list.join('\n')}\n`;
const turns = (messages) => messages.map((m) => [m.sender, m.text]);
const codeOf = async (fn) => {
  try { await fn(); } catch (err) { return err.code; }
  return null;
};

describe('markdown-transcript fixture', () => {
  it('holds invented values only', () => {
    assert.deepStrictEqual(scanForPersonalValues(fs.readFileSync(FIXTURE, 'utf8')), []);
  });

  it('is ten turns, read by the first pattern', async () => {
    assert.strictEqual(await importer.detect(FIXTURE), true);
    const { chat, messages, compactions, stats } = await importer.parse(FIXTURE);
    assert.strictEqual(chat.id, 'md-markdown-transcript');
    assert.strictEqual(chat.title, 'Lakeside lot planning');
    assert.strictEqual(chat.source, 'markdown-transcript');
    assert.strictEqual(chat.createdAt, messages[0].timestamp);
    assert.strictEqual(chat.updatedAt, messages.at(-1).timestamp);
    assert.deepStrictEqual(Object.keys(chat).sort(), ['createdAt', 'id', 'source', 'title', 'updatedAt']);
    assert.deepStrictEqual(compactions, []);
    assert.strictEqual(messages.length, 20);
    assert.deepStrictEqual(messages.map((m) => m.sender), Array.from({ length: 20 }, (_, i) => (i % 2 ? 'assistant' : 'user')));
    assert.deepStrictEqual(messages.map((m) => m.seq), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepStrictEqual(validateMessages(messages), []);
    for (const m of messages) assert.deepStrictEqual(Object.keys(m).sort(), ['id', 'sender', 'seq', 'text', 'timestamp']);
    assert.strictEqual(messages[2].text, 'The side gate code at the Lakeside lot is 4417. Keep that for the site visit.');
    assert.deepStrictEqual(stats, { unmapped: 0, badLines: 0, duplicates: 0, skipped: { preamble: 1 } });
  });

  it('keeps a heading inside a code fence, and deeper headings, in the reply they belong to', async () => {
    const { messages } = await importer.parse(FIXTURE);
    const culvert = messages.find((m) => m.text.includes('## Culvert'));
    assert.strictEqual(culvert.sender, 'assistant');
    assert.match(culvert.text, /```markdown\n## Culvert\n\n- depth: 60 cm/);
    assert.match(culvert.text, /not a new speaker\.$/);
    const list = messages.find((m) => m.text.includes('### February'));
    assert.strictEqual(list.sender, 'assistant');
    assert.match(list.text, /### This month\n\n- survey the north fence line/);
  });

  it('previews it: title, turns, a sample, the pattern and the first five roles', async () => {
    const p = await importer.preview(FIXTURE);
    assert.strictEqual(p.title, 'Lakeside lot planning');
    assert.strictEqual(p.turns, 10);
    assert.strictEqual(p.pattern, 'user-assistant-h2');
    assert.deepStrictEqual(p.patterns, [{ id: 'user-assistant-h2', label: '## User / ## Assistant', turns: 10 }]);
    assert.deepStrictEqual(p.roles, [
      { heading: '## User', role: 'user' },
      { heading: '## Assistant', role: 'assistant' },
      { heading: '## User', role: 'user' },
      { heading: '## Assistant', role: 'assistant' },
      { heading: '## User', role: 'user' }
    ]);
    assert.strictEqual(p.sample.length, 5);
    assert.deepStrictEqual(p.sample[0], { seq: 1, sender: 'user', text: 'We need to get the Lakeside lot ready before the spring opening. Where do we start?' });
    assert.ok(p.sample.every((s) => s.text.length <= 200));
  });

  it('gives the same ids and timestamps on every parse of one file', async () => {
    const a = await importer.parse(FIXTURE);
    const b = await importer.parse(FIXTURE);
    assert.deepStrictEqual(a, b);
    const text = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/);
    for (const m of a.messages) {
      const n = Number(/^line-(\d+)$/.exec(m.id)[1]);
      assert.match(text[n - 1], /^## (User|Assistant)$/, m.id);
    }
    const first = Date.parse(a.messages[0].timestamp);
    assert.strictEqual(first, Math.floor(fs.statSync(FIXTURE).mtimeMs));
    a.messages.forEach((m, i) => assert.strictEqual(Date.parse(m.timestamp), first + i * 1000));
  });
});

describe('markdown-transcript patterns', () => {
  it('lists its patterns in the order detect tries them', () => {
    assert.strictEqual(importer.kind, 'markdown-transcript');
    assert.strictEqual(importer.version, 1);
    assert.strictEqual(importer.MAX_BYTES, 32 * 1024 * 1024);
    assert.deepStrictEqual(importer.PATTERNS.map((p) => p.id), ['user-assistant-h2', 'user-assistant-h3', 'turn-n', 'message-n', 'name-assistant']);
    assert.ok(importer.PATTERNS.every((p) => typeof p.label === 'string' && p.label));
  });

  it('user-assistant-h2: any case, a trailing colon, CRLF line ends', async () => {
    const file = write(['## user', '', 'Where is the Lakeside lot gate?', '', '## ASSISTANT:', '', 'On the north side.', ''].join('\r\n'));
    assert.strictEqual(await importer.detect(file), true);
    const { chat, messages } = await importer.parse(file);
    assert.deepStrictEqual(turns(messages), [['user', 'Where is the Lakeside lot gate?'], ['assistant', 'On the north side.']]);
    assert.deepStrictEqual(messages.map((m) => m.id), ['line-1', 'line-5']);
    assert.strictEqual(chat.title, 'talk');
    assert.strictEqual(chat.id, 'md-talk');
  });

  it('user-assistant-h3', async () => {
    const file = write(lines('# Lot notes', '', '### User', 'Is the fence up?', '### Assistant', 'Forty metres of it.', '### User', 'Good.'));
    const { chat, messages } = await importer.parse(file);
    assert.strictEqual(chat.title, 'Lot notes');
    assert.deepStrictEqual(turns(messages), [['user', 'Is the fence up?'], ['assistant', 'Forty metres of it.'], ['user', 'Good.']]);
    assert.strictEqual((await importer.preview(file)).pattern, 'user-assistant-h3');
  });

  it('turn-n: the first-line marker names the role and is taken off the text', async () => {
    const file = write(lines(
      '## Turn 1', '', '**User:** Is the culvert clear?', '',
      '## Turn 2', 'Assistant: It was cleared on Monday.', 'Nothing else is blocked.', '',
      '## Turn 3', '**Assistant:**', 'One more note: the pipe is ordered.', '',
      '## Turn 4', '**User**: Thanks.'
    ));
    const { messages } = await importer.parse(file);
    assert.deepStrictEqual(turns(messages), [
      ['user', 'Is the culvert clear?'],
      ['assistant', 'It was cleared on Monday.\nNothing else is blocked.'],
      ['assistant', 'One more note: the pipe is ordered.'],
      ['user', 'Thanks.']
    ]);
    assert.strictEqual((await importer.preview(file)).pattern, 'turn-n');
  });

  it('turn-n and message-n: without a marker the sections alternate from user', async () => {
    const file = write(lines('## Message 1', 'Is the gate code still 4417?', '## Message 2', 'Yes.', '## Message 3', 'Good.', '## Message 4', 'Anything else?'));
    const { messages } = await importer.parse(file);
    assert.deepStrictEqual(turns(messages), [['user', 'Is the gate code still 4417?'], ['assistant', 'Yes.'], ['user', 'Good.'], ['assistant', 'Anything else?']]);
    const p = await importer.preview(file);
    assert.strictEqual(p.pattern, 'message-n');
    assert.deepStrictEqual(p.roles.map((r) => r.heading), ['## Message 1', '## Message 2', '## Message 3', '## Message 4']);

    // A marker in the middle sets the role; the next unmarked one alternates from it.
    const mixed = write(lines('## Turn 1', 'First.', '## Turn 2', 'User: Second, also mine.', '## Turn 3', 'Third.'));
    assert.deepStrictEqual((await importer.parse(mixed)).messages.map((m) => m.sender), ['user', 'user', 'assistant']);
  });

  it('name-assistant: two level-2 headings, one of them Assistant; the other is the user', async () => {
    const file = write(lines('## Owner', 'Is the Lakeside lot survey in?', '## Assistant', 'It came in today.', '## Owner', 'Read it to me.', '## assistant', 'Forty metres of fence.'));
    assert.strictEqual(await importer.detect(file), true);
    const { messages } = await importer.parse(file);
    assert.deepStrictEqual(messages.map((m) => m.sender), ['user', 'assistant', 'user', 'assistant']);
    const p = await importer.preview(file);
    assert.strictEqual(p.pattern, 'name-assistant');
    assert.deepStrictEqual(p.roles.slice(0, 2), [{ heading: '## Owner', role: 'user' }, { heading: '## Assistant', role: 'assistant' }]);

    const three = write(lines('## Owner', 'One.', '## Assistant', 'Two.', '## Guest', 'Three.'));
    assert.strictEqual(await importer.detect(three), false, 'three speakers is not this pattern');
  });

  it('a heading inside a ``` or ~~~ fence is not a heading', async () => {
    const file = write(lines(
      '## User', 'Show me the file.', '',
      '## Assistant', 'Here:', '', '```', '## User', 'not a turn', '```', '',
      '~~~~md', '## Assistant', '```', '## User', '~~~~', 'Done.', '',
      '## User', 'Thanks.'
    ));
    const { messages } = await importer.parse(file);
    assert.deepStrictEqual(messages.map((m) => m.sender), ['user', 'assistant', 'user']);
    assert.match(messages[1].text, /^Here:\n\n```\n## User\nnot a turn\n```\n\n~~~~md\n## Assistant\n```\n## User\n~~~~\nDone\.$/);
  });

  it('a heading indented four spaces, or with no space after the hashes, is not a heading', async () => {
    const file = write(lines('## User', 'Look:', '    ## Assistant', '##Assistant', '## Assistant', 'I see.'));
    const { messages } = await importer.parse(file);
    assert.deepStrictEqual(turns(messages), [['user', 'Look:\n    ## Assistant\n##Assistant'], ['assistant', 'I see.']]);
  });

  it('skips the text before the first turn and a section with no text, and counts both', async () => {
    const file = write(lines('# Lot notes', '', 'Saved on a Tuesday.', 'Second line.', '', '## User', '', '## Assistant', 'Hello.', '## User', 'Is the gate open?'));
    const { chat, messages, stats } = await importer.parse(file);
    assert.strictEqual(chat.title, 'Lot notes');
    assert.deepStrictEqual(turns(messages), [['assistant', 'Hello.'], ['user', 'Is the gate open?']]);
    assert.deepStrictEqual(messages.map((m) => [m.id, m.seq]), [['line-8', 1], ['line-10', 2]]);
    assert.deepStrictEqual(stats.skipped, { preamble: 2, empty: 1 });
  });

  it('preview and parse take a chosen pattern, and list every pattern that fits', async () => {
    // Fits two patterns: level-3 User/Assistant inside numbered level-2 turns.
    const file = write(lines(
      '## Turn 1', 'User: Is the fence up?', '### User', 'Is the fence up?', '### Assistant', 'Yes.',
      '## Turn 2', 'Assistant: Forty metres.', '### User', 'How long?', '### Assistant', 'Forty metres.'
    ));
    const auto = await importer.preview(file);
    assert.strictEqual(auto.pattern, 'user-assistant-h3');
    assert.strictEqual(auto.turns, 2);
    assert.deepStrictEqual(auto.patterns, [
      { id: 'user-assistant-h3', label: '### User / ### Assistant', turns: 2 },
      { id: 'turn-n', label: '## Turn N', turns: 1 }
    ]);
    const chosen = await importer.preview(file, { pattern: 'turn-n' });
    assert.strictEqual(chosen.pattern, 'turn-n');
    assert.strictEqual(chosen.turns, 1);
    assert.deepStrictEqual(chosen.patterns, auto.patterns);
    assert.deepStrictEqual(chosen.roles, [{ heading: '## Turn 1', role: 'user' }, { heading: '## Turn 2', role: 'assistant' }]);
    const { messages } = await importer.parse(file, { pattern: 'turn-n' });
    assert.deepStrictEqual(messages.map((m) => m.sender), ['user', 'assistant']);
    assert.match(messages[0].text, /^Is the fence up\?\n### User\n/);
  });

  it('refuses an unknown pattern, and a known one the file does not fit', async () => {
    assert.strictEqual(await codeOf(() => importer.parse(FIXTURE, { pattern: 'speaker-colon' })), 'UNKNOWN_PATTERN');
    assert.strictEqual(await codeOf(() => importer.preview(FIXTURE, { pattern: '__proto__' })), 'UNKNOWN_PATTERN');
    assert.strictEqual(await codeOf(() => importer.parse(FIXTURE, { pattern: 'turn-n' })), 'NOT_A_TRANSCRIPT');
  });
});

describe('markdown-transcript detect', () => {
  it('a Markdown file that is not a transcript is not claimed, and parse refuses it', async () => {
    const notes = write(lines('# Lakeside lot', '', '## Access', 'Side gate.', '', '## Drainage', 'Culvert at the north fence.'), 'notes.md');
    assert.strictEqual(await importer.detect(notes), false);
    assert.strictEqual(await codeOf(() => importer.parse(notes)), 'NOT_A_TRANSCRIPT');
    assert.strictEqual(await codeOf(() => importer.preview(notes)), 'NOT_A_TRANSCRIPT');
    assert.strictEqual(await detectImporter(notes), null);

    // One speaker only, or one section only, is not a conversation.
    assert.strictEqual(await importer.detect(write(lines('## User', 'One.', '## User', 'Two.'))), false);
    assert.strictEqual(await importer.detect(write(lines('## Assistant', 'Only me.'))), false);
    assert.strictEqual(await importer.detect(write('')), false);
  });

  it('claims .md and .markdown only, and never throws', async () => {
    const text = lines('## User', 'Hello.', '## Assistant', 'Hello.');
    assert.strictEqual(await importer.detect(write(text, 'talk.markdown')), true);
    assert.strictEqual(await importer.detect(write(text, 'TALK.MD')), true);
    for (const name of ['talk.txt', 'talk.json', 'talk.jsonl', 'talk']) {
      const file = write(text, name);
      assert.strictEqual(await importer.detect(file), false, name);
      assert.strictEqual(await codeOf(() => importer.parse(file)), 'NOT_A_TRANSCRIPT', name);
    }
    assert.strictEqual(await importer.detect(path.join(tmpDir(), 'missing.md')), false);
    assert.strictEqual(await importer.detect(tmpDir()), false);
    assert.strictEqual(await importer.detect(null), false);
  });

  it('refuses a file over the size cap', async () => {
    const file = write(lines('## User', 'Hello.', '## Assistant', 'Hello.'));
    const size = fs.statSync(file).size;
    assert.strictEqual(await importer.detect(file, { maxBytes: size }), true);
    assert.strictEqual(await importer.detect(file, { maxBytes: size - 1 }), false);
    assert.strictEqual(await codeOf(() => importer.parse(file, { maxBytes: size - 1 })), 'TRANSCRIPT_TOO_LARGE');
    assert.strictEqual(await codeOf(() => importer.preview(file, { maxBytes: size - 1 })), 'TRANSCRIPT_TOO_LARGE');
    assert.strictEqual((await importer.parse(file, { maxBytes: size })).messages.length, 2);
  });
});

describe('the importers together', () => {
  it('markdown-transcript is third, after the two that were there', () => {
    assert.deepStrictEqual(IMPORTERS.map((i) => i.kind), ['claude-code-jsonl', 'king-louie-json', 'markdown-transcript']);
  });

  it('each fixture is claimed by its own importer', async () => {
    const session = cc.writeClaudeCodeFixture(tmpDir(), 'session.jsonl');
    assert.strictEqual((await detectImporter(session)).kind, 'claude-code-jsonl');
    assert.strictEqual((await detectImporter(KL_FIXTURE)).kind, 'king-louie-json');
    assert.strictEqual((await detectImporter(FIXTURE)).kind, 'markdown-transcript');
    assert.strictEqual(await importer.detect(session), false);
    assert.strictEqual(await importer.detect(KL_FIXTURE), false);
  });
});
