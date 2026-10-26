// A textual edit of node.yaml (personal node spec §8 step 5): `pair` under
// `hosting: personal` sets approvers.relay itself. The file is edited as
// text, never parsed and serialised again, so the owner's comments, key order
// and line endings stay exactly as they were outside the one line written.
const fs = require('fs');
const { plainLineProblem } = require('../cases/hidden-chars');

const APPROVERS_HEADER = /^approvers:[ \t]*(?:#.*)?$/;
const APPROVERS_ANY = /^approvers:/;
const RELAY_LINE = /^([ \t]+)relay:[ \t]*(.*)$/;

// The value of a `relay:` line: a trailing comment and quotes taken off.
function relayValue(rest) {
  let v = rest.replace(/(^|[ \t])#.*$/, '').trim();
  if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
  else if (/^".*"$/.test(v)) v = v.slice(1, -1);
  return v || null;
}

// → { previous: string|null }. Throws, writing nothing, on a url that is not
// one plain line and on an approvers mapping it cannot edit by text.
function setNodeYamlRelay(file, url) {
  const problem = plainLineProblem(url);
  if (problem) throw new Error(`the relay url is not one plain line: ${problem}`);
  if (!url || /\s/.test(url) || url.includes('#')) throw new Error('the relay url is not one plain line: it is empty or holds a space or a #');

  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // Split keeping each line's own ending.
  const lines = text.split(/(?<=\n)/);
  const body = (l) => l.replace(/\r?\n$/, '');
  const ending = (l) => l.slice(body(l).length);

  let previous = null;
  let out;
  const header = lines.findIndex((l) => APPROVERS_ANY.test(body(l)));
  if (header === -1) {
    const sep = text === '' || text.endsWith('\n') ? '' : eol;
    out = `${text}${sep}approvers:${eol}  relay: ${url}${eol}`;
  } else {
    if (!APPROVERS_HEADER.test(body(lines[header]))) {
      throw new Error('approvers in node.yaml is not a block mapping; set approvers.relay there by hand');
    }
    // The block: the lines after the header that are indented or blank.
    let end = header + 1;
    while (end < lines.length && (/^[ \t]/.test(body(lines[end])) || body(lines[end]).trim() === '')) end += 1;
    const children = lines.slice(header + 1, end).filter((l) => /^[ \t]+[^ \t#]/.test(body(l)));
    const indent = children.length ? /^[ \t]+/.exec(body(children[0]))[0] : '  ';
    const at = lines.findIndex((l, i) => i > header && i < end && RELAY_LINE.test(body(l)) && RELAY_LINE.exec(body(l))[1] === indent);
    out = lines.slice();
    if (at !== -1) {
      previous = relayValue(RELAY_LINE.exec(body(lines[at]))[2]);
      if (previous === url) return { previous };
      out[at] = `${indent}relay: ${url}${ending(lines[at])}`;
    } else {
      // A header with no line ending (the file's last line) gets one first.
      if (!ending(out[header])) out[header] = `${out[header]}${eol}`;
      out.splice(header + 1, 0, `${indent}relay: ${url}${eol}`);
    }
    out = out.join('');
  }

  const tmp = `${file}.new`;
  try {
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return { previous };
}

module.exports = { setNodeYamlRelay };
