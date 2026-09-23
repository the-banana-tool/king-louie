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

function parseYaml(yamlString) {
  if (typeof yamlString !== 'string') {
    throw new TypeError('parseYaml expects a string');
  }
  // yaml.load throws a YAMLException (with line and column) on any syntax
  // error or duplicate key; it is left to propagate so the caller can name
  // the file it came from.
  return yaml.load(yamlString, { schema: yaml.CORE_SCHEMA, json: false });
}

module.exports = { parseYaml };
