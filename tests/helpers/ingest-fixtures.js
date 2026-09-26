// tests/helpers/ingest-fixtures.js
// Invented documents for the cases stage 7 tests, generated in memory with
// pdf-lib: no real names, addresses or scans are checked in.
const { PDFDocument, StandardFonts, PDFName, PDFNumber } = require('pdf-lib');

// A baseline JPEG header (SOI, SOF0 for a 1×1 grey image, EOI). pdf-lib only
// reads the frame header, and the vision model is always a test double.
const tinyJpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const pngBytes = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const webpBytes = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const gifBytes = () => Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');

// Tokens without vowels or digits: what a broken CMap text layer looks like.
const GARBAGE = 'Qxz# Zkp@ Wrt%$ Bcd&f Hjk*l Mnp^q Rst~v Xzq# Pkt@ Wrd%';

// pages: [{ text } | { lines: [] } | { scan: true }]; rotateRoot sets an
// inherited /Rotate on the page tree; encrypt adds an /Encrypt trailer entry.
async function makePdf({ pages = [{ text: 'Hello from an invented document page.' }], rotateRoot = 0, encrypt = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let jpeg = null;
  for (const spec of pages) {
    const page = doc.addPage([420, 300]);
    if (spec.scan) {
      jpeg = jpeg || (await doc.embedJpg(tinyJpeg()));
      page.drawImage(jpeg, { x: 0, y: 0, width: 420, height: 300 });
      continue;
    }
    const lines = spec.lines || [spec.text || ''];
    lines.forEach((line, i) => page.drawText(line, { x: 20, y: 260 - i * 16, size: 10, font }));
  }
  if (rotateRoot) doc.catalog.Pages().set(PDFName.of('Rotate'), PDFNumber.of(rotateRoot));
  if (encrypt) doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: 'o', U: 'u', P: -4 });
  return Buffer.from(await doc.save());
}

const PAYOFF_LINES = [
  'Example Bank - Payoff statement',
  'Loan No. 0042-7781',
  'Total payoff amount: $182,340.17',
  'Good through 2026-10-15.'
];
const payoffLetterPdf = () => makePdf({ pages: [{ lines: PAYOFF_LINES }] });

module.exports = { tinyJpeg, pngBytes, webpBytes, gifBytes, GARBAGE, makePdf, payoffLetterPdf, PAYOFF_LINES };
