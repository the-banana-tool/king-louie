/**
 * Verify-on-stop policy.
 *
 * Pure policy, no I/O. Reads a ledger status plus the turn's changed
 * paths and decides whether the agent should be nudged to verify before
 * declaring the work done.
 *
 * It never runs a check itself and never blocks completion. The most it
 * produces is one bounded follow-up message.
 *
 * The suppression list is not an optimization — it is what makes the
 * feature tolerable. Hermes shipped without it and demanded verification
 * scripts for README edits. A turn that touched only prose has nothing to
 * verify, and being told otherwise trains the user to ignore the nudge.
 */

const path = require('path');

const MAX_CHANGED_PATHS_IN_NUDGE = 8;

/**
 * Extensions whose edits carry no verifiable runtime behavior:
 * documentation, prose, and data no test or build exercises.
 */
const NON_CODE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx', '.rst', '.txt', '.text',
  '.adoc', '.asciidoc', '.org', '.log', '.csv', '.tsv'
]);

/** Files that are pure prose even without a recognized extension. */
const NON_CODE_FILENAMES = new Set([
  'license', 'licence', 'notice', 'authors', 'contributors',
  'copying', 'changelog', 'codeowners', '.gitignore', '.gitattributes',
  '.editorconfig', '.npmignore', '.dockerignore'
]);

function isNonCodePath(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) return true;

  const base = path.basename(raw).toLowerCase();
  if (NON_CODE_FILENAMES.has(base)) return true;

  const ext = path.extname(base);
  if (!ext) {
    // Extension-less files are usually scripts, Dockerfiles, or Makefiles —
    // all of which a build or test can exercise. Treat as code.
    return false;
  }

  return NON_CODE_EXTENSIONS.has(ext);
}

/** The subset of changed paths for which verification means anything. */
function filterVerifiablePaths(paths = []) {
  const list = Array.isArray(paths) ? paths : [paths];
  return [...new Set(list.map((p) => String(p || '')).filter((p) => p && !isNonCodePath(p)))];
}

function formatChangedPaths(paths) {
  const shown = paths.slice(0, MAX_CHANGED_PATHS_IN_NUDGE);
  const remainder = paths.length - shown.length;
  const rendered = shown.map((p) => `  - ${p}`).join('\n');
  return remainder > 0 ? `${rendered}\n  …and ${remainder} more` : rendered;
}

/**
 * Should this turn be nudged to verify?
 *
 * @param {object} input
 * @param {string[]} input.changedPaths  Files the turn wrote to.
 * @param {object}   input.status        `EvidenceLedger.status(root)` output.
 * @param {boolean}  input.alreadyNudged True if this turn was nudged once.
 * @param {boolean}  input.enabled       Master switch.
 * @returns {{nudge: boolean, reason: string, message?: string, paths?: string[]}}
 */
function evaluate(input = {}) {
  const {
    changedPaths = [],
    status = {},
    alreadyNudged = false,
    enabled = true
  } = input;

  if (!enabled) return { nudge: false, reason: 'disabled' };

  // Once per turn. A nudge the agent chose not to act on is a decision,
  // not an oversight — repeating it is nagging.
  if (alreadyNudged) return { nudge: false, reason: 'already_nudged' };

  const verifiable = filterVerifiablePaths(changedPaths);
  if (verifiable.length === 0) {
    return { nudge: false, reason: 'no_code_changes' };
  }

  // A fresh failure is not silence — the agent ran something and it broke.
  // It already knows; telling it to go verify would be absurd.
  if (status.hasFreshFailure) {
    return { nudge: false, reason: 'fresh_failure_already_visible' };
  }

  if (status.hasFullPass) {
    return { nudge: false, reason: 'full_pass' };
  }

  const pathList = formatChangedPaths(verifiable);

  // A targeted pass is real evidence but bounded. Say so precisely rather
  // than implying nothing was run — the agent that ran one test file and
  // gets told "you have not verified anything" will reasonably ignore it.
  if (status.hasTargetedPass) {
    return {
      nudge: true,
      reason: 'targeted_only',
      paths: verifiable,
      message:
        'Before finishing: the only verification run this turn was targeted, '
        + 'which proves the specific case you checked but not that the rest '
        + 'still passes. Consider running the full suite for:\n'
        + `${pathList}\n`
        + 'If a full run is not warranted here, say why and finish.'
    };
  }

  return {
    nudge: true,
    reason: 'no_evidence',
    paths: verifiable,
    message:
      'Before finishing: this turn changed code but nothing was run to check '
      + 'it:\n'
      + `${pathList}\n`
      + 'Run the tests, type check, or build for these changes and report what '
      + 'happened. If verification is not possible here, say why and finish.'
  };
}

module.exports = {
  evaluate,
  isNonCodePath,
  filterVerifiablePaths,
  formatChangedPaths,
  NON_CODE_EXTENSIONS,
  NON_CODE_FILENAMES,
  MAX_CHANGED_PATHS_IN_NUDGE
};
