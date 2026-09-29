// tests/renderer-export-chat.test.js
// Export as JSON leaves attachment bytes out: a chat with a few attached PDFs
// used to export at several MB of base64 nobody reads in a debugging export.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function block(start, end = '\nfunction ') {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

describe('renderer: chat export', () => {
  const omitAttachmentBytes = new Function(`${block('function omitAttachmentBytes(msg)', '\n}')}\n}\nreturn omitAttachmentBytes;`)();

  it('drops document and image base64, keeping what describes the file', () => {
    const msg = {
      id: 'm1', sender: 'user', text: 'see attached',
      documents: [{ name: 'offer.pdf', mimeType: 'application/pdf', sizeBytes: 446474, base64: 'JVBERi0x' }],
      images: [{ name: 'lot.png', mimeType: 'image/png', base64: 'iVBORw0K', previewUrl: 'data:image/png;base64,iVBORw0K' }]
    };
    const out = omitAttachmentBytes(msg);
    assert.deepStrictEqual(out.documents, [{ name: 'offer.pdf', mimeType: 'application/pdf', sizeBytes: 446474, base64Omitted: true }]);
    assert.deepStrictEqual(out.images, [{ name: 'lot.png', mimeType: 'image/png', base64Omitted: true }]);
    assert.strictEqual(out.text, 'see attached');
    assert.strictEqual(msg.documents[0].base64, 'JVBERi0x', 'the chat itself is not changed');
  });

  it('keeps a document\'s extracted text, which is what the model read', () => {
    const out = omitAttachmentBytes({ documents: [{ name: 'notes.md', base64: 'IyBu', textContent: '# notes' }] });
    assert.strictEqual(out.documents[0].textContent, '# notes');
    assert.strictEqual(out.documents[0].base64, undefined);
  });

  it('returns a message without attachments as is', () => {
    const msg = { id: 'm2', sender: 'assistant', text: 'hi' };
    assert.strictEqual(omitAttachmentBytes(msg), msg);
  });

  it('the export button uses it', () => {
    const i = src.indexOf("dom.exportChatBtn.addEventListener('click'");
    assert.ok(i >= 0);
    assert.match(src.slice(i, i + 1500), /chat\.messages\.map\(omitAttachmentBytes\)/);
  });
});
