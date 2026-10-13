'use strict';
// Streams a JSONL file line by line, splitting on '\n' only. node:readline is
// not used: it also breaks lines at U+2028 and U+2029, which JSON.stringify
// leaves unescaped inside strings, so one record would arrive as fragments.
// Lines are sliced by index, never by repeatedly slicing the buffer's front,
// so a 1 MB chunk of short lines is not copied once per line.
//
// maxLineChars: a line longer than this is refused (IMPORT_LINE_TOO_LONG)
// as soon as that much of it has been read, so the buffer never holds more
// than the limit and one read chunk. With no limit given a line may be any
// length, which is how LongHaul reads its own sessions.
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

async function* readJsonlLines(filePath, { highWaterMark = 1 << 20, maxLineChars = Infinity } = {}) {
  const decoder = new StringDecoder('utf8');
  const limit = Number.isFinite(maxLineChars) && maxLineChars > 0 ? maxLineChars : Infinity;
  const tooLong = (n) => {
    const err = new Error(`Line ${n} of this file is longer than an import allows (${limit} characters).`);
    err.code = 'IMPORT_LINE_TOO_LONG';
    return err;
  };
  let buf = '';
  let lineNo = 0;
  let first = true;
  const clean = (raw) => {
    lineNo += 1;
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (first) {
      first = false;
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    }
    return line;
  };
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark })) {
    buf += decoder.write(chunk);
    let start = 0;
    let nl;
    while ((nl = buf.indexOf('\n', start)) !== -1) {
      if (nl - start > limit) throw tooLong(lineNo + 1);
      const line = clean(buf.slice(start, nl));
      start = nl + 1;
      if (line.trim()) yield { line, lineNo };
    }
    buf = buf.slice(start);
    // The line still open: refused here, not read to its end.
    if (buf.length > limit) throw tooLong(lineNo + 1);
  }
  buf += decoder.end();
  if (buf.length) {
    if (buf.length > limit) throw tooLong(lineNo + 1);
    const line = clean(buf);
    if (line.trim()) yield { line, lineNo };
  }
}

module.exports = { readJsonlLines };
