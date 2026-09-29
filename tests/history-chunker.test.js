// tests/history-chunker.test.js
// Every row of recall spec §4.3.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { chunkMessage, splitProse, toolUseSummary, renderToolResult, CHUNK_DEFAULTS } = require('../src/history/chunker');

// A synthetic "pasted article": 12 sections of 4 paragraphs, ~2.4K chars each.
function article() {
  const sections = [];
  for (let s = 1; s <= 12; s += 1) {
    const paras = [`## Section ${s}`];
    for (let p = 1; p <= 4; p += 1) {
      paras.push(`Paragraph ${p} of section ${s} describes the Lakeside lot survey, the drainage plan and the fence line in plain words. `.repeat(5).trim());
    }
    sections.push(paras.join('\n\n'));
  }
  sections[6] += '\n\nThe side gate code at the Lakeside lot is 4417, written here once so a search can find it.';
  return sections.join('\n\n');
}

describe('splitProse', () => {
  it('splits on blank lines and drops pieces under minChars', () => {
    const text = `${'a'.repeat(39)}\n\n${'b'.repeat(40)}\n\n${'c'.repeat(100)}`;
    assert.deepStrictEqual(splitProse(text, { targetChars: 1500, minChars: 40 }), ['b'.repeat(40), 'c'.repeat(100)]);
  });

  it('splits an oversized paragraph on lines, then hard-splits a wall of text', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} of a long paragraph with enough words in it to matter`).join('\n');
    for (const piece of splitProse(lines)) assert.ok(piece.length <= CHUNK_DEFAULTS.targetChars);
    const wall = 'x'.repeat(10000);
    const pieces = splitProse(wall);
    assert.strictEqual(pieces.length, 7);
    for (const piece of pieces) assert.ok(piece.length <= 1500);
    assert.strictEqual(pieces.join(''), wall);
  });

  it('keeps a text that yields a single piece, however short', () => {
    assert.deepStrictEqual(splitProse('the port is 8443'), ['the port is 8443']);
    assert.deepStrictEqual(splitProse('  ok  '), ['ok']);
    assert.deepStrictEqual(splitProse(`${'a'.repeat(10)}\n\n${'b'.repeat(10)}`, { targetChars: 1500, minChars: 40 }), [], 'short fragments of a split are dropped');
  });

  it('returns nothing for empty or whitespace text', () => {
    assert.deepStrictEqual(splitProse(''), []);
    assert.deepStrictEqual(splitProse('   \n\n  '), []);
    assert.deepStrictEqual(splitProse(undefined), []);
  });
});

describe('chunkMessage', () => {
  it('user and assistant prose: kind by sender, idx dense from 0', () => {
    const chunks = chunkMessage({ id: 'm1', sender: 'assistant', text: article() });
    assert.ok(chunks.length > 10, `got ${chunks.length}`);
    chunks.forEach((c, i) => {
      assert.strictEqual(c.idx, i);
      assert.strictEqual(c.kind, 'assistant');
      assert.ok(c.text.length >= 40 && c.text.length <= 2250);
    });
    assert.ok(chunks.some((c) => c.text.includes('4417')));
    assert.strictEqual(chunkMessage({ sender: 'user', text: 'A user paragraph that is long enough to be kept as a chunk.' })[0].kind, 'user');
  });

  it('a short message is one chunk, so it can be recalled and searched', () => {
    assert.deepStrictEqual(chunkMessage({ sender: 'user', text: 'the port is 8443' }), [{ idx: 0, kind: 'user', text: 'the port is 8443' }]);
    assert.deepStrictEqual(chunkMessage({ sender: 'assistant', text: 'Done.' }), [{ idx: 0, kind: 'assistant', text: 'Done.' }]);
  });

  it('honours targetChars and minChars options', () => {
    const small = chunkMessage({ sender: 'user', text: article() }, { targetChars: 300, minChars: 10 });
    const big = chunkMessage({ sender: 'user', text: article() });
    assert.ok(small.length > big.length);
    assert.strictEqual(chunkMessage({ sender: 'user', text: 'short one' }, { minChars: 5 }).length, 1);
    assert.strictEqual(chunkMessage({ sender: 'user', text: `tiny\n\n${'z'.repeat(20)}` }, { minChars: 5 }).length, 1);
    assert.strictEqual(chunkMessage({ sender: 'user', text: `tiny\n\n${'z'.repeat(20)}` }).length, 0);
  });

  it('toolUse: one summary chunk; the command, the path or the query', () => {
    assert.deepStrictEqual(chunkMessage({ sender: 'toolUse', toolName: 'Bash', parameters: { command: 'npm test\n  -- --watch' } }),
      [{ idx: 0, kind: 'tool_use', text: 'Bash: npm test -- --watch' }]);
    assert.strictEqual(toolUseSummary({ toolName: 'Read', parameters: { file_path: 'src/app.js' } }), 'Read: src/app.js');
    assert.strictEqual(toolUseSummary({ toolName: 'Grep', parameters: { pattern: 'gate_code', path: 'src' } }), 'Grep: src');
    assert.strictEqual(toolUseSummary({ toolName: 'WebSearch', parameters: { query: 'lakeside lot survey' } }), 'WebSearch: lakeside lot survey');
    assert.strictEqual(toolUseSummary({ toolName: 'MultiEdit', parameters: { edits: [{ file_path: 'a.js' }, { file_path: 'b.js' }, { file_path: 'a.js' }] } }), 'MultiEdit: a.js, b.js');
    const other = toolUseSummary({ toolName: 'Canvas', parameters: { action: 'render', title: 'x'.repeat(400) } });
    assert.ok(other.startsWith('Canvas: {"action":"render"'));
    assert.ok(other.length <= 'Canvas: '.length + 200);
    assert.strictEqual(toolUseSummary({ parameters: {} }), 'tool: {}');
  });

  it('Write, Edit and MultiEdit contents are chunked as prose after the summary', () => {
    const body = 'The fence line runs along the north edge of the Lakeside lot for forty meters.';
    const write = chunkMessage({ sender: 'toolUse', toolName: 'Write', parameters: { file_path: 'notes.md', content: `${body}\n\n${body}` } });
    assert.deepStrictEqual(write.map((c) => c.kind), ['tool_use', 'tool_use', 'tool_use']);
    assert.strictEqual(write[0].text, 'Write: notes.md');
    assert.strictEqual(write[1].text, body);
    const edit = chunkMessage({ sender: 'toolUse', toolName: 'Edit', parameters: { file_path: 'notes.md', old_string: 'old text that is long enough to count', new_string: body } });
    assert.deepStrictEqual(edit.map((c) => c.text), ['Edit: notes.md', body]);
    const multi = chunkMessage({ sender: 'toolUse', toolName: 'MultiEdit', parameters: { edits: [{ file_path: 'a.md', new_string: body }] } });
    assert.strictEqual(multi.length, 2);
    const bash = chunkMessage({ sender: 'toolUse', toolName: 'Bash', parameters: { command: 'echo hi', content: body } });
    assert.strictEqual(bash.length, 1, 'only Write, Edit and MultiEdit add content chunks');
  });

  it('toolResult: rendered and chunked as prose; a 60K-character result stays bounded', () => {
    const big = Array.from({ length: 600 }, (_, i) => `row ${i}: sensor reading for the Lakeside lot drainage pipe, value ${i * 3}`).join('\n');
    assert.ok(big.length > 40000);
    const chunks = chunkMessage({ sender: 'toolResult', toolName: 'Bash', result: { ok: true, stdout: `${big}\n\n${big.slice(0, 15000)}` } });
    assert.ok(chunks.length >= 40, `got ${chunks.length}`);
    for (const c of chunks) {
      assert.strictEqual(c.kind, 'tool_result');
      assert.ok(c.text.length <= 2250);
    }
    assert.strictEqual(chunkMessage({ sender: 'toolResult', toolName: 'Read', result: 'plain string result that is long enough to index' })[0].text,
      'plain string result that is long enough to index');
  });

  it('renderToolResult prints string fields raw so newlines and tokens survive', () => {
    const text = renderToolResult({ ok: true, stdout: 'first line of output here\nsecond line mentions src/app.js', exitCode: 0 });
    assert.strictEqual(text, 'ok: true\n\nstdout:\nfirst line of output here\nsecond line mentions src/app.js\n\nexitCode: 0');
    assert.strictEqual(renderToolResult('as is'), 'as is');
    assert.strictEqual(renderToolResult([1, 2]), '[\n  1,\n  2\n]');
    assert.strictEqual(renderToolResult(null), '');
  });

  it('document attachments: extracted text chunked as kind attachment, after the message text', () => {
    const doc = 'Survey notes for the Lakeside lot. The north fence is forty meters long.';
    const chunks = chunkMessage({ sender: 'user', text: 'Here is the survey, please read it and keep it in mind.', documents: [{ name: 'survey.pdf', textContent: doc }, { name: 'scan.pdf' }] });
    assert.deepStrictEqual(chunks.map((c) => [c.idx, c.kind]), [[0, 'user'], [1, 'attachment']]);
    assert.strictEqual(chunks[1].text, doc);
  });

  it('status: only a compaction summary is indexed, as kind summary; images and other statuses are not', () => {
    const summary = 'Summary of the earlier conversation: the owner chose the north fence line and the 4417 gate code.';
    assert.deepStrictEqual(chunkMessage({ sender: 'status', text: summary, meta: { compaction: true } }), [{ idx: 0, kind: 'summary', text: summary }]);
    assert.deepStrictEqual(chunkMessage({ sender: 'status', text: summary }), []);
    assert.deepStrictEqual(chunkMessage({ sender: 'status', text: summary, meta: { compaction: 'yes' } }), []);
    assert.deepStrictEqual(chunkMessage({ sender: 'user', text: '', images: [{ base64: 'AAAA', mimeType: 'image/png' }] }), []);
    assert.deepStrictEqual(chunkMessage(null), []);
  });
});
