'use strict';
// Streams a JSONL file line by line, splitting on '\n' only. node:readline is
// not used: it also breaks lines at U+2028 and U+2029, which JSON.stringify
// leaves unescaped inside strings, so one record would arrive as fragments.
// Lines are sliced by index, never by repeatedly slicing the buffer's front,
// so a 1 MB chunk of short lines is not copied once per line.
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

async function* readJsonlLines(filePath, { highWaterMark = 1 << 20 } = {}) {
  const decoder = new StringDecoder('utf8');
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
      const line = clean(buf.slice(start, nl));
      start = nl + 1;
      if (line.trim()) yield { line, lineNo };
    }
    buf = buf.slice(start);
  }
  buf += decoder.end();
  if (buf.length) {
    const line = clean(buf);
    if (line.trim()) yield { line, lineNo };
  }
}

module.exports = { readJsonlLines };
