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

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Anchors (&name) and aliases (*name) let one YAML node reference another;
// nested aliases can turn a few hundred bytes of source into gigabytes of
// structure once anything walks or stringifies it (the "billion laughs"
// attack). js-yaml has no documented option to disable them, and playbooks
// (cases stage 6) parse YAML straight from a third party, so this refuses
// the syntax outright with a coded error rather than resolving or capping
// it. A repo-wide scan of examples/, the runbooks and every test fixture
// found no anchor or alias in any shipped or tested file, so nothing here
// needs to keep working with them (ruling C6-alias).
//
// An earlier version of this scanned the raw source text for a bare "&"/"*"
// at what looked like a node-start position. That both missed real anchors
// (flow style — `{"a": &x [1,2]}` — and a document-level anchor before the
// first mapping/sequence, `--- &x [1,2]`) and refused ordinary content it
// had no business touching: a block scalar's own text (a runbook's
// `run: |` script with a cron "* * * * *" line, a playbook description
// with a markdown "* bullet" or "& co") looks exactly like a node-start
// position to a scanner that resets on every newline, even though none of
// it is YAML structure at all.
//
// js-yaml itself already knows the difference, so this listens to its own
// parse instead of re-deriving it. Every node it composes — block or flow,
// including the document root — fires a `listener('close', state)` right
// after that node finishes, and by then `state.anchor` holds the anchor
// name if this node had one (`&name`) or is null otherwise. That is checked
// on every node, so a flow-style or document-level anchor is caught exactly
// the same way a block-style one is, and a block scalar's body is never
// inspected as if it were structure — js-yaml parses it as one opaque
// string, one `close` event, `state.anchor` reflecting only whether *that
// scalar itself* had a leading `&name`.
//
// Blocking every anchor DEFINITION is enough to close the whole class: an
// alias (`*name`) can only ever reference an anchor defined earlier in the
// same document, so once no anchor is ever allowed to finish parsing, no
// alias can resolve either — confirmed against a flow-style map-alias bomb
// (8 anchors, each aliasing the previous one twice), refused in ~1ms.
function parseYaml(yamlString) {
  if (typeof yamlString !== 'string') {
    throw new TypeError('parseYaml expects a string');
  }
  const listener = (event, state) => {
    if (event === 'close' && state.anchor != null) {
      throw codedError('YAML anchors and aliases are not allowed.', 'YAML_ALIAS_NOT_ALLOWED');
    }
  };
  // yaml.load throws a YAMLException (with line and column) on any syntax
  // error or duplicate key; it is left to propagate so the caller can name
  // the file it came from. A throw from `listener` propagates the same way
  // — js-yaml does not wrap the parse in a try/catch of its own.
  return yaml.load(yamlString, { schema: yaml.CORE_SCHEMA, json: false, listener });
}

module.exports = { parseYaml };
