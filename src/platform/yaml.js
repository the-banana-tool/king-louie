/**
 * YAML parsing for node.yaml and runbook files.
 *
 * These files decide what the node may do — which roots remote sessions can
 * touch, which commands need confirmation or are denied, what a runbook runs —
 * so a parser that guesses is worse than none: a misread line quietly becomes a
 * different policy. This wraps js-yaml rather than hand-rolling a subset, and
 * keeps it strict: the core schema only (plain strings, numbers, booleans,
 * null, lists and maps — no custom tags, no JS types), duplicate keys
 * rejected, and anything malformed throws instead of being skipped.
 */

const yaml = require('js-yaml');

// Anchors (&name) and aliases (*name) let one YAML node reference another;
// nested aliases can turn a few hundred bytes of source into gigabytes of
// structure once anything walks or stringifies it (the "billion laughs"
// attack). js-yaml has no option to disable them, and playbooks (cases
// stage 6) parse YAML straight from a third party, so this refuses the
// syntax outright with a coded error rather than resolving or capping it. A
// repo-wide scan of examples/, the runbooks and every test fixture found no
// anchor or alias in any shipped or tested file, so nothing here needs to
// keep working with them.
//
// YAML only treats "&" and "*" specially as the first character of a node's
// value — a plain (unquoted) scalar can never start with either (spec
// §5.3's indicator characters). This walks the raw text once, tracking
// quoted spans (so a quoted "*deploy*" is never mistaken for an alias),
// comments, tag properties and flow nesting, and reports the first "&"/"*"
// found in that position. A "&" or "*" anywhere else — the middle of
// "Fish & Chips", say, or "5 * 3" — is just a character in an ordinary plain
// scalar and is left alone.
function findAnchorOrAlias(text) {
  let inSingle = false;
  let inDouble = false;
  let inTag = false;
  let flowDepth = 0;
  let atValueStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inSingle) {
      if (c === "'") {
        if (text[i + 1] === "'") { i += 1; continue; }
        inSingle = false;
        atValueStart = false;
      }
      continue;
    }
    if (inDouble) {
      if (c === '\\') { i += 1; continue; }
      if (c === '"') { inDouble = false; atValueStart = false; }
      continue;
    }
    if (c === '\n') { atValueStart = true; inTag = false; continue; }
    if (c === ' ' || c === '\t' || c === '\r') {
      if (inTag) { inTag = false; atValueStart = true; }
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length - 1 : nl - 1;
      continue;
    }
    if (c === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      atValueStart = true;
      continue;
    }
    if (c === '-' && atValueStart && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      // A block-sequence dash at a node-start position; the node it
      // introduces starts right after it, so the state doesn't change.
      continue;
    }
    if (c === '[' || c === '{') {
      flowDepth += 1;
      atValueStart = true;
      continue;
    }
    if (c === ']' || c === '}') {
      if (flowDepth > 0) flowDepth -= 1;
      atValueStart = false;
      continue;
    }
    if (c === ',' && flowDepth > 0) {
      atValueStart = true;
      continue;
    }
    if (atValueStart) {
      if (c === '&' || c === '*') return c === '&' ? 'anchor' : 'alias';
      if (c === "'") { inSingle = true; continue; }
      if (c === '"') { inDouble = true; continue; }
      if (c === '!') {
        // A tag property (!tag or !!tag): the real node value still
        // follows it, so stay armed through the tag token itself.
        inTag = true;
        atValueStart = false;
        continue;
      }
      atValueStart = false;
    }
  }
  return null;
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parseYaml(yamlString) {
  if (typeof yamlString !== 'string') {
    throw new TypeError('parseYaml expects a string');
  }
  const found = findAnchorOrAlias(yamlString);
  if (found) {
    const indicator = found === 'anchor' ? '&' : '*';
    throw codedError(
      `YAML anchors and aliases are not allowed (found "${indicator}" starting a value).`,
      'YAML_ALIAS_NOT_ALLOWED'
    );
  }
  // yaml.load throws a YAMLException (with line and column) on any syntax
  // error or duplicate key; it is left to propagate so the caller can name
  // the file it came from.
  return yaml.load(yamlString, { schema: yaml.CORE_SCHEMA, json: false });
}

module.exports = { parseYaml, findAnchorOrAlias };
