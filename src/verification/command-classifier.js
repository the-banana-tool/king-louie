/**
 * Classify a shell command as verification evidence — or not.
 *
 * Pure. Given a command string and its exit code, decides whether running
 * it proved anything about the code, and if so what kind of thing and how
 * much of the codebase it covered.
 *
 * Hermes gates this on a per-project `verifyCommands` list supplied by its
 * coding-context module. King Louie has no equivalent, so recognition is
 * pattern-based over the commands people actually run, extensible through
 * `extraPatterns`. The tradeoff is deliberate: a generic matcher
 * occasionally misses a bespoke script, which costs one unnecessary nudge,
 * whereas requiring configuration would mean the feature does nothing at
 * all until someone sets it up.
 */

/** Split a compound command into its individually-runnable segments. */
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;

/**
 * Prefixes that wrap a real command without changing what it proves.
 * `sudo npm test` is still `npm test`.
 */
const TRANSPARENT_PREFIXES = new Set([
  'sudo', 'time', 'nice', 'env', 'npx', 'pnpx', 'bunx', 'poetry', 'pipenv',
  'uv', 'rye', 'pdm', 'nix-shell', 'docker-compose', 'winpty'
]);

/**
 * Verification command patterns, checked in order. `kind` answers "what
 * did this prove?" — the distinction matters because a passing linter is
 * not evidence that the tests pass.
 */
const VERIFY_PATTERNS = [
  // ── Test runners ────────────────────────────────────────────────────
  { re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/, kind: 'test' },
  { re: /^(?:jest|vitest|mocha|ava|tap|jasmine|karma|cypress|playwright)\b/, kind: 'test' },
  { re: /^node\s+--test\b/, kind: 'test' },
  { re: /^(?:pytest|py\.test)\b/, kind: 'test' },
  { re: /^python[3]?\s+-m\s+(?:pytest|unittest)\b/, kind: 'test' },
  { re: /^(?:tox|nox)\b/, kind: 'test' },
  { re: /^cargo\s+(?:test|nextest)\b/, kind: 'test' },
  { re: /^go\s+test\b/, kind: 'test' },
  { re: /^(?:mvn|gradle|\.\/gradlew)\s+.*\btest\b/, kind: 'test' },
  { re: /^dotnet\s+test\b/, kind: 'test' },
  { re: /^(?:rspec|bundle\s+exec\s+rspec|rake\s+test)\b/, kind: 'test' },
  { re: /^(?:phpunit|vendor\/bin\/phpunit)\b/, kind: 'test' },
  { re: /^ctest\b/, kind: 'test' },

  // ── Type checking ───────────────────────────────────────────────────
  { re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|tsc)\b/, kind: 'typecheck' },
  { re: /^tsc\b/, kind: 'typecheck' },
  { re: /^(?:mypy|pyright|pyre)\b/, kind: 'typecheck' },
  { re: /^flow\s+check\b/, kind: 'typecheck' },

  // ── Linting ─────────────────────────────────────────────────────────
  { re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/, kind: 'lint' },
  { re: /^(?:eslint|biome|oxlint|standard|xo)\b/, kind: 'lint' },
  { re: /^(?:ruff|flake8|pylint|bandit)\b/, kind: 'lint' },
  { re: /^cargo\s+clippy\b/, kind: 'lint' },
  { re: /^go\s+vet\b/, kind: 'lint' },
  { re: /^shellcheck\b/, kind: 'lint' },

  // ── Formatting ──────────────────────────────────────────────────────
  { re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:fmt|format)\b/, kind: 'format' },
  { re: /^(?:prettier|black|gofmt|rustfmt)\b/, kind: 'format' },
  { re: /^cargo\s+fmt\b/, kind: 'format' },

  // ── Builds ──────────────────────────────────────────────────────────
  { re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/, kind: 'build' },
  { re: /^cargo\s+(?:build|check)\b/, kind: 'build' },
  { re: /^go\s+build\b/, kind: 'build' },
  { re: /^(?:make|cmake|ninja|bazel)\b/, kind: 'build' },
  { re: /^dotnet\s+build\b/, kind: 'build' },

  // ── Generic check scripts ───────────────────────────────────────────
  { re: /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|validate|ci)\b/, kind: 'check' }
];

/**
 * Argument shapes that mean "I ran part of the suite, not all of it".
 * Getting this wrong in the permissive direction is the dangerous one:
 * treating `npm test -- foo.test.js` as a full pass would let the agent
 * claim the repo is green on the strength of one file.
 */
const TARGET_HINTS = [
  /[/\\]/,                                   // a path
  /::/,                                      // pytest / rust node selector
  /\.(?:js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|rb|php|cs|swift|kt)$/i,
  /^(?:test_|tests?$|spec$|__tests__)/i
];

/** Flags that name a subset of tests. */
const TARGET_FLAGS = new Set([
  '-k', '-t', '--test', '--grep', '--filter', '--testNamePattern',
  '--test-name-pattern', '--only', '--file', '--spec', '-run', '--run'
]);

const MAX_OUTPUT_SUMMARY_CHARS = 2000;

/** Tokenize a command, respecting simple quoting. */
function tokenize(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/** Strip wrapper prefixes and inline VAR=value assignments. */
function stripPrefixes(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (TRANSPARENT_PREFIXES.has(token)) { index += 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
    break;
  }
  return tokens.slice(index);
}

/**
 * Tokens that name the whole tree rather than a slice of it. `./...` is
 * Go's "everything, recursively" — it contains a slash, so a naive path
 * heuristic reads it as a target and reports the exact opposite of what
 * the command did.
 */
const WHOLE_TREE_TOKENS = new Set(['.', './', './...', '...', 'all', '*']);

function looksLikeTarget(arg) {
  if (!arg || arg.startsWith('-') || arg.includes('=')) return false;
  if (WHOLE_TREE_TOKENS.has(arg)) return false;
  return TARGET_HINTS.some((hint) => hint.test(arg));
}

/**
 * Decide whether a command covered everything it could, or only a slice.
 *
 * `full` here means "the whole of what this command runs" — `npm test`
 * with no arguments. It is NOT a claim that the repo is green; that
 * conflation is exactly what the ledger refuses to make.
 */
function scopeForArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (TARGET_FLAGS.has(arg)) return 'targeted';
    // `--grep=foo` style
    const [flag] = arg.split('=');
    if (arg.includes('=') && TARGET_FLAGS.has(flag)) return 'targeted';
    if (looksLikeTarget(arg)) return 'targeted';
  }
  return 'full';
}

function summarizeOutput(output) {
  const text = String(output || '');
  if (text.length <= MAX_OUTPUT_SUMMARY_CHARS) return text;

  // Keep both ends: the head usually names what ran, the tail carries the
  // pass/fail summary.
  const half = Math.floor(MAX_OUTPUT_SUMMARY_CHARS / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

/**
 * Classify one command segment. Returns null when it proves nothing.
 */
function classifySegment(segment, patterns) {
  const tokens = stripPrefixes(tokenize(segment));
  if (tokens.length === 0) return null;

  const normalized = tokens.join(' ');

  for (const { re, kind } of patterns) {
    const match = normalized.match(re);
    if (!match) continue;

    const consumed = tokenize(match[0]).length;
    const args = tokens.slice(consumed);

    return {
      canonicalCommand: match[0].trim(),
      kind,
      // A formatter rewrites files; it never proves behavior. Recording it
      // as evidence would let "I ran prettier" stand in for "I ran tests".
      provesBehavior: kind === 'test',
      scope: scopeForArgs(args)
    };
  }

  return null;
}

/**
 * Classify a full command line, which may chain several commands.
 *
 * When a chain contains more than one verification command, the strongest
 * wins: `npm run lint && npm test` proves what the tests prove.
 */
function classifyCommand(command, options = {}) {
  if (!command || typeof command !== 'string') return null;

  const patterns = Array.isArray(options.extraPatterns)
    ? [...options.extraPatterns, ...VERIFY_PATTERNS]
    : VERIFY_PATTERNS;

  const segments = command.split(SEGMENT_SPLIT).filter(Boolean);
  const matches = segments
    .map((segment) => classifySegment(segment, patterns))
    .filter(Boolean);

  if (matches.length === 0) return null;

  const best = matches.find((m) => m.provesBehavior) || matches[0];
  const exitCode = Number.isFinite(options.exitCode) ? Number(options.exitCode) : 0;

  return {
    command: command.trim(),
    canonicalCommand: best.canonicalCommand,
    kind: best.kind,
    scope: best.scope,
    provesBehavior: best.provesBehavior,
    // A chain reports one exit code for the whole thing, so a failure
    // anywhere marks the whole chain failed. That is the correct reading:
    // `lint && test` exiting non-zero means something in there is broken.
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    cwd: options.cwd ? String(options.cwd) : '',
    outputSummary: summarizeOutput(options.output)
  };
}

module.exports = {
  classifyCommand,
  classifySegment,
  scopeForArgs,
  looksLikeTarget,
  summarizeOutput,
  tokenize,
  stripPrefixes,
  VERIFY_PATTERNS,
  MAX_OUTPUT_SUMMARY_CHARS
};
