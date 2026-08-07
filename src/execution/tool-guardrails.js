/**
 * Tool-call loop guardrails.
 *
 * Detects the model spinning on itself within a turn — retrying an
 * identical failing call, re-reading a file that already gave its answer,
 * or "editing" a file in a way that changes nothing — and returns a
 * decision about it.
 *
 * This controller is deliberately **side-effect free**. It observes
 * `(toolName, argsHash, resultClass)` and returns decisions; it never
 * injects guidance, never writes a synthetic tool result, and never halts
 * anything itself. The runtime decides what a decision becomes. Keeping
 * policy separate from effect is what makes it testable without an agent,
 * a provider, or a filesystem.
 *
 * Companion to [denial-tracker.js](../tools/denial-tracker.js), which
 * implements this same shape for repeated *user* denials. This one is
 * aimed at the model.
 *
 * The split between the two entry points matters:
 *   - `recordResult()` runs after a call and can return a **warning** —
 *     the model has already paid for the call, so guidance is the only
 *     useful response.
 *   - `beforeCall()` runs before a call and can **block** it — the only
 *     point where refusing actually saves anything.
 *
 * Warnings are on by default; hard stops are opt-in, so an interactive
 * session gets a nudge rather than a closed door unless the user asks for
 * a circuit breaker. Loop caps are the exception: they are hard ceilings
 * on runaway-prone tools and apply either way.
 */

const crypto = require('crypto');

/**
 * Read-only tools. Repeating one is not dangerous, but repeating one with
 * identical arguments AND getting an identical result back means the turn
 * made no progress.
 */
const IDEMPOTENT_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'SessionsList',
  'SessionsHistory',
  'BrowserExtract',
  'BrowserPage'
]);

/**
 * Tools that change something. Repetition here is suspicious for a
 * different reason: either it keeps failing, or it "succeeds" without
 * actually doing anything.
 */
const MUTATING_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Git',
  'Canvas',
  'Cron',
  'Vault',
  'Message',
  'RemoteDispatch',
  'SpawnAgent',
  'BackgroundTask',
  'ImageGenerate'
]);

/** File-mutating tools whose results can prove the write actually landed. */
const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

const DEFAULT_CONFIG = Object.freeze({
  warningsEnabled: true,
  // Off by default: a hard stop in an interactive session is more likely to
  // frustrate than to help. Opt in for unattended or long-running work.
  hardStopEnabled: false,

  // Same tool, same arguments, failing.
  exactFailureWarnAfter: 2,
  exactFailureBlockAfter: 5,

  // Same tool failing regardless of arguments — flailing rather than looping.
  sameToolFailureWarnAfter: 3,
  sameToolFailureHaltAfter: 8,

  // Idempotent tool returning a byte-identical result for identical args.
  noProgressWarnAfter: 2,
  noProgressBlockAfter: 5,

  // Mutating tool reporting success while changing nothing.
  noopMutationWarnAfter: 2,
  noopMutationBlockAfter: 4,

  /**
   * Per-turn hard ceilings for tools that can run away. Enforced even when
   * hardStopEnabled is false, because these bound cost rather than
   * correcting behavior.
   */
  loopCaps: Object.freeze({
    WebSearch: 20,
    SpawnAgent: 10,
    BackgroundTask: 10,
    ImageGenerate: 10
  })
});

const ACTIONS = Object.freeze({
  ALLOW: 'allow',
  WARN: 'warn',
  BLOCK: 'block',
  HALT: 'halt'
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Stable JSON for tool arguments: keys sorted at every level, so
 * `{a:1,b:2}` and `{b:2,a:1}` are the same call. Non-serializable values
 * degrade to their string form rather than throwing.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function canonicalArgs(args) {
  try {
    return canonicalize(args || {});
  } catch {
    return String(args);
  }
}

/** Non-reversible identity for a call: tool name plus a hash of its args. */
function signatureOf(toolName, args) {
  return `${toolName}::${sha256(canonicalArgs(args))}`;
}

/**
 * Did this call fail?
 *
 * Cancellation and user denial are deliberately NOT failures here. The
 * model didn't cause them and shouldn't be lectured about them —
 * denial-tracker already owns the repeated-denial case.
 */
function isFailure(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.cancelled) return false;
  if (result.deniedBy || result.blockedByHook) return false;

  if (result.success === false) return true;
  if (result.ok === false) return true;
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return true;
  if (result.error) return true;

  return false;
}

/**
 * Did a file mutation actually change anything?
 *
 * This is the signal a naive repeat-detector misses: an Edit that reports
 * `success: true` with zero lines added and zero removed replaced text with
 * itself. The model reads "success" and moves on believing the file
 * changed, then loops when the behavior doesn't.
 *
 * Returns null for tools where the question doesn't apply.
 */
function mutationLanded(toolName, result) {
  if (!FILE_MUTATING_TOOLS.has(toolName)) return null;
  if (!result || typeof result !== 'object') return null;
  if (result.success !== true) return null;

  if (toolName === 'Write') {
    return Boolean(result.filePath);
  }

  if (toolName === 'Edit') {
    const added = Number(result.linesAdded || 0);
    const removed = Number(result.linesRemoved || 0);
    // A replacement that produced no line-level change is a no-op, even
    // though `replacements` is non-zero.
    return added + removed > 0;
  }

  if (toolName === 'MultiEdit') {
    return Number(result.succeeded || 0) > 0;
  }

  return null;
}

/** Stable hash of a result, for detecting "same call, same answer". */
function resultFingerprint(result) {
  try {
    return sha256(canonicalize(result ?? null));
  } catch {
    return sha256(String(result));
  }
}

function decision(action, code, message, extra = {}) {
  return {
    action,
    code,
    message,
    toolName: extra.toolName || '',
    count: extra.count || 0,
    signature: extra.signature || null,
    allowsExecution: action === ACTIONS.ALLOW || action === ACTIONS.WARN,
    shouldHalt: action === ACTIONS.BLOCK || action === ACTIONS.HALT
  };
}

function allowDecision(toolName, signature) {
  return decision(ACTIONS.ALLOW, 'allow', '', { toolName, signature });
}

class ToolGuardrails {
  constructor(options = {}) {
    const loopCaps = { ...DEFAULT_CONFIG.loopCaps, ...(options.loopCaps || {}) };
    this.config = { ...DEFAULT_CONFIG, ...options, loopCaps };

    this.idempotentTools = options.idempotentTools instanceof Set
      ? options.idempotentTools
      : IDEMPOTENT_TOOLS;
    this.mutatingTools = options.mutatingTools instanceof Set
      ? options.mutatingTools
      : MUTATING_TOOLS;

    this.resetForTurn();
  }

  /**
   * Clear all per-turn state. Counters bound a single turn — a file read
   * twice in yesterday's turn says nothing about this one.
   */
  resetForTurn() {
    this._exactFailures = new Map();   // signature -> count
    this._toolFailures = new Map();    // toolName  -> count
    this._noProgress = new Map();      // signature -> { fingerprint, count }
    this._noopMutations = new Map();   // signature -> count
    this._callCounts = new Map();      // toolName  -> count
    this._haltDecision = null;
  }

  get haltDecision() {
    return this._haltDecision;
  }

  isIdempotent(toolName) {
    return this.idempotentTools.has(toolName);
  }

  isMutating(toolName) {
    return this.mutatingTools.has(toolName);
  }

  /**
   * Consulted before a call runs. Returns a block/halt decision when the
   * call should not happen, otherwise allow.
   */
  beforeCall(toolName, args) {
    const signature = signatureOf(toolName, args);

    // Loop caps first, and regardless of hardStopEnabled: they bound cost,
    // not behavior, and a runaway search loop is expensive no matter how
    // gentle we want to be about correcting the model.
    const cap = this.config.loopCaps?.[toolName];
    const calls = this._callCounts.get(toolName) || 0;
    if (Number.isFinite(cap) && cap > 0 && calls >= cap) {
      const capped = decision(
        ACTIONS.BLOCK,
        'loop_cap_exceeded',
        `Blocked ${toolName}: already called ${calls} times this turn (cap ${cap}). `
        + 'Work with what you have or take a different approach.',
        { toolName, count: calls, signature }
      );
      this._haltDecision = capped;
      return capped;
    }

    if (!this.config.hardStopEnabled) {
      return allowDecision(toolName, signature);
    }

    const exact = this._exactFailures.get(signature) || 0;
    if (exact >= this.config.exactFailureBlockAfter) {
      return this._halt(decision(
        ACTIONS.BLOCK,
        'repeated_exact_failure_block',
        `Blocked ${toolName}: this exact call has failed ${exact} times. `
        + 'Retrying it unchanged will fail again — change the arguments, '
        + 'change the approach, or explain the blocker.',
        { toolName, count: exact, signature }
      ));
    }

    const stalled = this._noProgress.get(signature);
    if (stalled && stalled.count >= this.config.noProgressBlockAfter) {
      return this._halt(decision(
        ACTIONS.BLOCK,
        'idempotent_no_progress_block',
        `Blocked ${toolName}: this read-only call has returned the same result `
        + `${stalled.count} times. Use the result you already have, or ask a `
        + 'different question.',
        { toolName, count: stalled.count, signature }
      ));
    }

    const noop = this._noopMutations.get(signature) || 0;
    if (noop >= this.config.noopMutationBlockAfter) {
      return this._halt(decision(
        ACTIONS.BLOCK,
        'noop_mutation_block',
        `Blocked ${toolName}: this edit reported success ${noop} times without `
        + 'changing anything. The target text is probably not what you think it '
        + 'is — read the file before editing it again.',
        { toolName, count: noop, signature }
      ));
    }

    const toolFailures = this._toolFailures.get(toolName) || 0;
    if (toolFailures >= this.config.sameToolFailureHaltAfter) {
      return this._halt(decision(
        ACTIONS.HALT,
        'same_tool_failure_halt',
        `Halting: ${toolName} has failed ${toolFailures} times this turn with `
        + 'varying arguments. Something about the environment is wrong; stop and '
        + 'report what you have found.',
        { toolName, count: toolFailures, signature }
      ));
    }

    return allowDecision(toolName, signature);
  }

  _halt(halted) {
    this._haltDecision = halted;
    return halted;
  }

  /**
   * Record what a call actually did. Returns a warning decision when the
   * pattern is worth telling the model about, otherwise allow.
   *
   * Call this for every executed tool call, including successful ones —
   * the no-progress signal depends on seeing successes.
   */
  recordResult(toolName, args, result) {
    const signature = signatureOf(toolName, args);
    this._callCounts.set(toolName, (this._callCounts.get(toolName) || 0) + 1);

    const failed = isFailure(result);

    if (failed) {
      // A failure invalidates any no-progress streak: the call is no longer
      // "returning the same answer", it's erroring.
      this._noProgress.delete(signature);

      const exact = (this._exactFailures.get(signature) || 0) + 1;
      this._exactFailures.set(signature, exact);

      const toolTotal = (this._toolFailures.get(toolName) || 0) + 1;
      this._toolFailures.set(toolName, toolTotal);

      if (!this.config.warningsEnabled) return allowDecision(toolName, signature);

      if (exact >= this.config.exactFailureWarnAfter) {
        return decision(
          ACTIONS.WARN,
          'repeated_exact_failure',
          `${toolName} has now failed ${exact} times with identical arguments. `
          + 'Repeating it will not help — change something or explain the blocker.',
          { toolName, count: exact, signature }
        );
      }

      if (toolTotal >= this.config.sameToolFailureWarnAfter) {
        return decision(
          ACTIONS.WARN,
          'same_tool_failure',
          `${toolName} has failed ${toolTotal} times this turn with different `
          + 'arguments. Consider whether the tool or the environment is the problem.',
          { toolName, count: toolTotal, signature }
        );
      }

      return allowDecision(toolName, signature);
    }

    // ── Succeeded ────────────────────────────────────────────────────────
    // A success clears the exact-failure streak for this signature: whatever
    // was wrong is no longer wrong.
    this._exactFailures.delete(signature);

    // It also clears the same-tool streak. That warning claims the tool or
    // the environment is broken — a success is direct evidence against it,
    // and interleaved failures with occasional successes is just what
    // debugging looks like. Without this reset, a turn that runs a failing
    // test, fixes it, and runs it again gets lectured for making progress.
    this._toolFailures.delete(toolName);

    const landed = mutationLanded(toolName, result);
    if (landed === false) {
      const noop = (this._noopMutations.get(signature) || 0) + 1;
      this._noopMutations.set(signature, noop);

      if (this.config.warningsEnabled && noop >= this.config.noopMutationWarnAfter) {
        return decision(
          ACTIONS.WARN,
          'noop_mutation',
          `${toolName} reported success but changed nothing, ${noop} times in a row. `
          + 'Read the file and confirm the text you are matching actually exists.',
          { toolName, count: noop, signature }
        );
      }

      return allowDecision(toolName, signature);
    }

    if (landed === true) {
      this._noopMutations.delete(signature);
      return allowDecision(toolName, signature);
    }

    if (this.isIdempotent(toolName)) {
      const fingerprint = resultFingerprint(result);
      const previous = this._noProgress.get(signature);

      if (previous && previous.fingerprint === fingerprint) {
        const count = previous.count + 1;
        this._noProgress.set(signature, { fingerprint, count });

        if (this.config.warningsEnabled && count >= this.config.noProgressWarnAfter) {
          return decision(
            ACTIONS.WARN,
            'idempotent_no_progress',
            `${toolName} has returned the same result ${count} times for the same `
            + 'arguments. You already have this answer — move on to the next step.',
            { toolName, count, signature }
          );
        }
      } else {
        // A different result is genuine progress, so the streak restarts.
        this._noProgress.set(signature, { fingerprint, count: 1 });
      }
    }

    return allowDecision(toolName, signature);
  }

  /** Snapshot of the turn's counters, for logging and tests. */
  stats() {
    return {
      calls: Object.fromEntries(this._callCounts),
      exactFailures: Object.fromEntries(this._exactFailures),
      toolFailures: Object.fromEntries(this._toolFailures),
      noopMutations: Object.fromEntries(this._noopMutations),
      noProgress: Object.fromEntries(
        [...this._noProgress].map(([key, value]) => [key, value.count])
      )
    };
  }
}

module.exports = {
  ToolGuardrails,
  DEFAULT_CONFIG,
  ACTIONS,
  IDEMPOTENT_TOOLS,
  MUTATING_TOOLS,
  FILE_MUTATING_TOOLS,
  signatureOf,
  canonicalArgs,
  isFailure,
  mutationLanded,
  resultFingerprint
};
