const { EventEmitter } = require('events');
const { toolRegistry } = require('../tools');
const { getRuntimeEnvironment } = require('./runtime-environment');
const { evaluateRules, describeRule } = require('../tools/permission-rules');
const path = require('path');
const { isProtectedCasePath, CASE_BLOCKED_TOOL_NAMES, CASE_BLOCKED_TOOL_ERROR } = require('../cases/chat-integration');
const { markLocalRequester } = require('../core/origin');
const { createLogger } = require('../logging');

const log = createLogger('tool-executor');

// Tools that write a file named by file_path (MultiEdit: per edit). In case
// mode, facts.jsonl and .kl/ are written only through the case tools.
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// Extract a stable, telemetry-safe error code from an Error. Raw
// error.message leaks local file paths and may contain
// bundler-mangled class names; a code like ENOENT survives both.
function extractErrorCode(error) {
  if (!error) return 'UNKNOWN';
  if (typeof error.code === 'string') return error.code;
  const msg = String(error.message || '').toLowerCase();
  if (msg.includes('enoent')) return 'ENOENT';
  if (msg.includes('eacces') || msg.includes('eperm')) return 'EACCES';
  if (msg.includes('etimedout') || msg.includes('timeout')) return 'ETIMEDOUT';
  if (msg.includes('econnrefused')) return 'ECONNREFUSED';
  if (msg.includes('econnreset')) return 'ECONNRESET';
  if (msg.includes('abort')) return 'ABORT';
  if (msg.includes('not found')) return 'NOT_FOUND';
  if (msg.includes('rate limit') || msg.includes('429')) return 'RATE_LIMIT';
  if (msg.includes('overloaded') || msg.includes('529')) return 'OVERLOADED';
  return 'TOOL_ERROR';
}

const DEFAULT_UNAVAILABLE_REFUSAL = 'Phone approval unavailable: no enrolled device or no relay link on this node. Nothing ran.';

// The one place a requester's answer becomes "run" or a refusal. Requesters
// return true | false | 'timeout' | 'unavailable' (program §3) and only
// `true` runs; a truthy string never does. `penalize` says whether the
// denial tracker should count it (only a person's plain "no").
function mapApprovalResult(result, metadata = {}, { timeoutMs = 0 } = {}) {
  if (result === true) return { approved: true, penalize: false, refusal: null };
  if (result === false) {
    if (metadata.signal && metadata.signal.aborted) {
      return { approved: false, penalize: false, refusal: { error: 'Approval withdrawn: the call was cancelled.', deniedBy: 'withdrawn' } };
    }
    return { approved: false, penalize: true, refusal: { error: 'User denied permission', deniedBy: 'user' } };
  }
  if (result === 'timeout') {
    // Inattention, not denial: a distinct error so the agent can recover or
    // explain instead of treating it as a hard "no".
    return {
      approved: false,
      penalize: false,
      refusal: {
        error: `Approval timed out after ${Math.round(timeoutMs / 1000)}s — no user response. Try again when someone is watching, or ask the user to pre-approve this tool.`,
        deniedBy: 'timeout'
      }
    };
  }
  if (result === 'unavailable') {
    const r = metadata.refusal;
    return {
      approved: false,
      penalize: false,
      refusal: r && typeof r.error === 'string'
        ? { error: r.error, deniedBy: r.deniedBy || 'unavailable' }
        : { error: DEFAULT_UNAVAILABLE_REFUSAL, deniedBy: 'unavailable' }
    };
  }
  return { approved: false, penalize: false, refusal: { error: 'Approval failed: unexpected requester result.', deniedBy: 'requester' } };
}

class ToolExecutor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.allowedDirectories = options.allowedDirectories || [];
    this.requireApproval = options.requireApproval !== false;
    this.approvalRequester =
      typeof options.approvalRequester === 'function'
        ? options.approvalRequester
        : null;
    this.shouldAutoApprove =
      typeof options.shouldAutoApprove === 'function'
        ? options.shouldAutoApprove
        : async () => false;
    // Hosts that refuse remote approvals (createCore's remoteApprovals:
    // 'deny') null the approvalRequester so the gate denies. That is only
    // airtight if nothing grants approval *before* the gate, so this also
    // shuts the three pre-gate grant paths: the persisted "always approve"
    // list (shouldAutoApprove), an agent config's autoApproveTools, and an
    // `allow` permission rule — which is downgraded to `ask`. `deny` rules
    // are untouched, and tools that don't require approval still run.
    this.denyAutoApproval = options.denyAutoApproval === true;
    this.runtimeEnvironmentPromise =
      options.runtimeEnvironment
        ? Promise.resolve(options.runtimeEnvironment)
        : getRuntimeEnvironment({ workingDirectory: this.workingDirectory });
    this.hookExecutor = options.hookExecutor || null;
    this.useSandbox = options.useSandbox !== false;
    // Extra options passed to every tool execution (e.g., agentExecutorAdapter for SpawnAgent)
    this.extraToolOptions = options.extraToolOptions || {};
    // Pattern-based permission rules. First-match-wins; falls back to the
    // tool's `requiresApproval` flag when nothing matches. See
    // src/tools/permission-rules.js.
    //
    // Can be supplied as a static array OR a callback. The callback form
    // lets the executor pick up rules that were persisted mid-session
    // (e.g. the user clicks "Always allow 'git *'" in an approval dialog
    // and the rule lands in electron-store) without reconstructing the
    // executor.
    if (typeof options.getPermissionRules === 'function') {
      this._getPermissionRules = options.getPermissionRules;
    } else if (Array.isArray(options.permissionRules)) {
      this._staticPermissionRules = options.permissionRules;
      this._getPermissionRules = () => this._staticPermissionRules;
    } else {
      this._staticPermissionRules = [];
      this._getPermissionRules = () => this._staticPermissionRules;
    }

    // Optional denial tracker. Counts consecutive user denials for a
    // (tool, pattern) key; after a threshold the executor stops asking
    // and auto-denies. See src/tools/denial-tracker.js.
    this.denialTracker = options.denialTracker || null;

    // Optional checkpoint manager. Transparent infrastructure — it takes a
    // filesystem snapshot before the first mutating tool of each turn so the
    // user can roll the turn back. The model never sees it.
    this.checkpointManager = options.checkpointManager || null;

    // Approval prompts that sit unanswered forever block the agent loop
    // (we observed a single Vault.store call hang for 7m21s when the user
    // wasn't watching). Default to 5 min; override via constructor or
    // per-call. 0 disables the timeout entirely.
    this.approvalTimeoutMs =
      typeof options.approvalTimeoutMs === 'number' ? options.approvalTimeoutMs : 5 * 60 * 1000;

    // Node policy tiers (fleet parent §5.3), wired by the phone approval mode:
    // (toolName, params, { cwd }) → { tier, reason } | null. `denied` refuses,
    // `unsafe` forces the approval gate even past an `allow` rule.
    this.classifyCall = typeof options.classifyCall === 'function' ? options.classifyCall : null;
    // A run that started at the local desktop: the approval requester handed
    // to tools (and so to child agents) is marked local, so children keep the
    // on-screen dialog instead of going to the phone (program §4.21).
    this.localOrigin = options.localOrigin === true;
    // This run's audit origin (program §4.21), set by approvalSeam in every
    // mode (null only if the caller never supplied one). Carried on the
    // rethreaded requester so a child executor built from it
    // (SpawnAgent, BackgroundTask, workflow runners) inherits the exact same
    // origin instead of recomputing a fresh, poorer one that has lost the
    // parent's deviceId/session.
    this.origin = options.origin || null;
  }

  get permissionRules() {
    return this._getPermissionRules() || [];
  }

  setPermissionRules(rules) {
    this._staticPermissionRules = Array.isArray(rules) ? rules : [];
    this._getPermissionRules = () => this._staticPermissionRules;
  }

  addPermissionRule(rule) {
    if (!rule || !rule.tool) return;
    if (!this._staticPermissionRules) {
      // Wrapping a callback-backed rule list: we can't mutate the caller's
      // store. Ignore (the caller should use their own add path).
      return;
    }
    this._staticPermissionRules.push(rule);
  }

  async getRuntimeEnvironment() {
    return this.runtimeEnvironmentPromise;
  }

  async execute(toolName, parameters = {}, options = {}) {
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // There is exactly one parameter set, and it is both judged and executed.
    //
    // This used to be two: a hook-decorated copy for the permission rules, the
    // approval dialog, the denial tracker and the pre/post events, and the
    // originals for tool.execute() and tool.isDangerous(). A PreToolUse hook
    // returning { action: 'modify', parameters } drove them apart — the
    // sanitised command was what the `deny Bash 'curl *'` rule was tested
    // against and what the human saw on the approval card, while the raw
    // command was what ran. A prompt-injected agent on a host with the
    // documented sanitising hook installed got its `curl … | sh` executed with
    // the rule never firing.
    //
    // So: a hook's rewrite is taken wholesale or not at all. `modified` says a
    // hook explicitly asked to rewrite; without it, context.parameters is
    // ignored entirely rather than half-applied, which keeps the "backfill"
    // property that a hook cannot sneak fields into the transcript by
    // decorating the context.
    let effectiveParameters = parameters;
    let preHookResult = null;

    if (this.hookExecutor && typeof this.hookExecutor.run === 'function') {
      preHookResult = await this.hookExecutor.run('PreToolUse', {
        toolName,
        parameters,
        options,
        workingDirectory: options.workingDirectory || this.workingDirectory
      });

      const action = String(preHookResult?.action || 'allow').toLowerCase();

      // Adopt the rewrite first, so everything below — the hook's own confirm
      // prompt included — is about the parameters that will actually run.
      // A hook with action='modify' explicitly opts in to changing what the
      // tool receives (fixing a path, normalising a command). HookExecutor
      // reports that as `modified`, separately from its allow/confirm/deny
      // decision, so a later hook escalating to `confirm` cannot silently drop
      // the rewrite. `action === 'modify'` is still honoured for a
      // caller-supplied hookExecutor that predates `modified`.
      const rewrote = preHookResult?.modified === true || action === 'modify';
      if (rewrote && preHookResult?.context?.parameters) {
        effectiveParameters = preHookResult.context.parameters;
      }

      if (action === 'deny') {
        const denied = {
          success: false,
          error: preHookResult?.message || `Tool execution blocked by policy: ${toolName}`,
          blockedByHook: true,
          hookResults: preHookResult?.results || []
        };
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
        return denied;
      }

      if (action === 'confirm') {
        const hookMetadata = {
          reason: preHookResult?.message || 'Hook policy requires explicit confirmation.',
          signal: options.signal || null,
          workingDirectory: options.workingDirectory || this.workingDirectory
        };
        const approved = await this.requestApproval(toolName, effectiveParameters, hookMetadata);
        const mapped = mapApprovalResult(approved, hookMetadata, { timeoutMs: this.approvalTimeoutMs });

        if (!mapped.approved) {
          const denied = {
            success: false,
            error: mapped.refusal.error,
            deniedBy: mapped.refusal.deniedBy,
            blockedByHook: true,
            hookResults: preHookResult?.results || []
          };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
      }
    }

    this.emit('preExecute', { toolName, parameters: effectiveParameters });

    try {
      tool.validateParameters(effectiveParameters);
    } catch (validationError) {
      const errorResult = { success: false, error: validationError.message };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: errorResult });
      return errorResult;
    }

    const caseContext = this.extraToolOptions.caseContext;
    if (caseContext && CASE_BLOCKED_TOOL_NAMES.includes(toolName)) {
      const refused = { success: false, error: CASE_BLOCKED_TOOL_ERROR };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refused });
      return refused;
    }
    if (caseContext && FILE_WRITE_TOOLS.has(toolName)) {
      const base = options.workingDirectory || this.workingDirectory;
      const targets = [
        effectiveParameters.file_path,
        ...(Array.isArray(effectiveParameters.edits) ? effectiveParameters.edits.map((e) => e?.file_path) : [])
      ].filter((p) => typeof p === 'string' && p);
      if (targets.some((p) => isProtectedCasePath(caseContext.dir, path.resolve(base, p)))) {
        const refused = {
          success: false,
          error: 'facts.jsonl, brief.md, case.yaml and .kl/ are written only through the case tools. Use the Ledger tool for facts and the Brief tool for the brief (or Decide, Recommend) instead.'
        };
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refused });
        return refused;
      }
    }

    if (tool.isDangerous(effectiveParameters) && !options.bypassSafety) {
      throw new Error(`Dangerous operation detected: ${toolName}`);
    }

    // Pattern-based rules take precedence over the per-tool flag and the
    // global auto-approve list. A matched rule short-circuits the rest of
    // the approval pipeline. The rule's source travels with the decision
    // for telemetry / audit.
    // Rule evaluation uses the hook-decorated parameters so a hook that
    // normalises a command (e.g. resolving aliases) feeds the same key
    // the user saw in the approval dialog.
    const ruleMatch = evaluateRules(this.permissionRules, toolName, effectiveParameters);
    let approvalSource = null;

    if (ruleMatch.matched) {
      if (ruleMatch.action === 'deny') {
        const denied = {
          success: false,
          error: `Blocked by rule: ${describeRule(ruleMatch.rule)}`,
          deniedBy: 'rule',
          rule: { tool: ruleMatch.rule.tool, pattern: ruleMatch.rule.pattern, source: ruleMatch.rule.source }
        };
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
        return denied;
      }
      // 'ask' falls through to the regular approval flow below.
    }

    // Node policy tier, after the permission rules and before the gate. A
    // classifyCall that throws, or returns anything other than null or a
    // well-formed { tier: read|routine|unsafe|denied, reason? } object,
    // fails closed: treated as `denied` rather than let the call run
    // unclassified.
    let tierUnsafe = false;
    if (this.classifyCall) {
      let raw;
      try {
        raw = this.classifyCall(toolName, effectiveParameters, {
          cwd: options.workingDirectory || this.workingDirectory
        });
      } catch (classifyError) {
        log.warn('classifyCall threw', { toolName, error: classifyError?.message ?? String(classifyError) });
        raw = { tier: 'denied', reason: 'invalid_classification' };
      }
      // Only null/undefined means "no opinion" and falls through to the
      // ordinary rule/gate flow. Every other value — including a falsy one
      // like 0, '' or false — is not a valid decision and must be denied
      // below, not silently treated as unclassified.
      const decision = raw === null || raw === undefined ? null : raw;
      if (decision !== null) {
        const validTiers = ['read', 'routine', 'unsafe', 'denied'];
        const wellFormed = typeof decision === 'object'
          && !Array.isArray(decision)
          && validTiers.includes(decision.tier);
        const safeDecision = wellFormed ? decision : { tier: 'denied', reason: 'invalid_classification' };

        this.emit('tierDecision', {
          toolName,
          parameters: effectiveParameters,
          tier: safeDecision.tier,
          reason: safeDecision.reason || null
        });
        if (safeDecision.tier === 'denied') {
          const denied = { success: false, error: 'Denied by node policy.', deniedBy: 'policy' };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
        tierUnsafe = safeDecision.tier === 'unsafe';
      }
    }

    const ruleSaysAsk = ruleMatch.matched && ruleMatch.action === 'ask';
    // What this tool would face with no rule written for it at all.
    const toolWouldGate = tool.requiresApproval && this.requireApproval;
    // Under denyAutoApproval an `allow` rule is demoted to `ask`: it neither
    // announces an auto-grant nor skips the gate, so it cannot be used to
    // pre-approve an unsafe tool for a remote origin. Only for a tool the gate
    // would have caught anyway — demoting the rule on a tool whose
    // requiresApproval is false would deny it, making an `allow` rule *more*
    // restrictive than no rule, which is not a security property, just a bug.
    const allowRuleDemoted = ruleMatch.matched && ruleMatch.action === 'allow'
      && this.denyAutoApproval && toolWouldGate;
    // An `unsafe` tier cancels an `allow` rule: `allow Bash(git *)` must not
    // skip the gate for `always_confirm Bash(git push*)`.
    const ruleSaysAllow = ruleMatch.matched && ruleMatch.action === 'allow' && !allowRuleDemoted && !tierUnsafe;
    const needsApprovalGate = tierUnsafe || ruleSaysAsk || allowRuleDemoted
      || (!ruleMatch.matched && toolWouldGate);

    if (ruleSaysAllow) {
      approvalSource = { type: 'rule', rule: describeRule(ruleMatch.rule) };
      this.emit('approvalAutoGranted', {
        toolName,
        parameters: effectiveParameters,
        source: approvalSource
      });
    }

    if (needsApprovalGate && !ruleSaysAllow) {
      // An `ask` rule is the user saying "always check with me for this one",
      // so it outranks both auto-approve paths — which is what the comment
      // above evaluateRules has always claimed and the code did not do. Agent
      // mode's hard-coded list used to win here, leaving the whole `ask` tier
      // inert for Bash, Edit, Write and Git.
      const autoApproved = this.denyAutoApproval || ruleSaysAsk || tierUnsafe
        ? false
        : await this.shouldAutoApprove(toolName, effectiveParameters);
      const agentAutoApproved = !this.denyAutoApproval
        && !ruleSaysAsk
        && !tierUnsafe
        && Array.isArray(options.autoApproveTools)
        && options.autoApproveTools.includes(toolName);

      if (autoApproved || agentAutoApproved) {
        approvalSource = { type: agentAutoApproved ? 'agent-config' : 'global-auto-approve' };
        this.emit('approvalAutoGranted', {
          toolName,
          parameters: effectiveParameters,
          source: approvalSource
        });
      }

      if (!autoApproved && !agentAutoApproved) {
        if (this.denialTracker) {
          const check = this.denialTracker.check(toolName, effectiveParameters);
          if (check.tripped) {
            const denied = {
              success: false,
              error: `Auto-denied after ${check.count} consecutive user denials. Pick a different approach.`,
              deniedBy: 'denial-tracker',
              denialCount: check.count
            };
            this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
            return denied;
          }
        }

        const gateMetadata = {
          ruleHint: ruleSaysAsk || allowRuleDemoted ? describeRule(ruleMatch.rule) : null,
          signal: options.signal || null,
          workingDirectory: options.workingDirectory || this.workingDirectory
        };
        const approved = await this.requestApproval(toolName, effectiveParameters, gateMetadata);
        // Only `true` runs. A timeout, a withdrawal, an unavailable phone or
        // anything unexpected is not a user's "no", so only a plain `false`
        // counts against the denial tracker.
        const mapped = mapApprovalResult(approved, gateMetadata, { timeoutMs: this.approvalTimeoutMs });
        if (!mapped.approved) {
          if (mapped.penalize && this.denialTracker) this.denialTracker.recordDenial(toolName, effectiveParameters);
          const denied = { success: false, error: mapped.refusal.error, deniedBy: mapped.refusal.deniedBy };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return denied;
        }
        if (this.denialTracker) this.denialTracker.recordGrant(toolName, effectiveParameters);
        approvalSource = { type: 'user' };
      }
    }

    // Pre-execution abort check: a turn cancelled while we were awaiting
    // an approval prompt should not then run the tool.
    if (options.signal?.aborted) {
      const cancelled = { success: false, error: 'Cancelled before execution', cancelled: true };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: cancelled });
      return cancelled;
    }

    // Checkpoint immediately before the tool runs — after every approval
    // gate and the abort check, so a denied, auto-denied, or cancelled call
    // never leaves a snapshot behind. maybeSnapshot is a no-op for
    // non-mutating tools and for turns already snapshotted, and it swallows
    // its own failures: a broken checkpoint store must not stop the work.
    if (this.checkpointManager) {
      try {
        await this.checkpointManager.maybeSnapshot({
          toolName,
          workdir: options.workingDirectory || this.workingDirectory,
          turnId: options.turnId,
          label: `before ${toolName}`
        });
      } catch (checkpointError) {
        // CheckpointManager already contains its own failures; this guard
        // means a third-party or misconfigured manager can't take the
        // user's turn down with it either.
        this.emit('checkpointFailed', { toolName, error: checkpointError });
      }
    }

    try {
      const runtimeEnvironment = await this.getRuntimeEnvironment();
      // Build the onProgress callback that tools can call to emit
      // intermediate updates (bytes downloaded, stdout lines, match
      // counts, etc.). Emitted as 'toolProgress' events so listeners
      // (chat-handlers → IPC → renderer) can display inline progress.
      const onProgress = (progressEvent) => {
        this.emit('toolProgress', {
          toolName,
          parameters: effectiveParameters,
          progress: progressEvent
        });
      };

      // Every gate (hooks, rules, node-policy tier, the approval gate, the
      // abort check) has passed by here: the tool is actually about to run.
      // Distinct from 'preExecute', which fires before those gates and so
      // also fires for calls later denied — audit's exec.start listens here
      // instead, so it means "the tool is about to run", not "was asked for".
      this.emit('executeStart', { toolName, parameters: effectiveParameters });

      const result = await tool.execute(effectiveParameters, {
        ...this.extraToolOptions,
        ...options,
        workingDirectory: options.workingDirectory || this.workingDirectory,
        allowedDirectories: options.allowedDirectories || this.allowedDirectories,
        runtimeEnvironment,
        useSandbox: typeof options.useSandbox === 'boolean' ? options.useSandbox : this.useSandbox,
        signal: options.signal || null,
        onProgress,
        // Expose this executor's approval channel so meta-tools (BackgroundTask,
        // SpawnAgent, workflow runners) can route their child agents' approval
        // prompts back to the originating chat UI instead of silently auto-denying.
        approvalRequester: this._rethreadedRequester()
      });

      if (this.hookExecutor && typeof this.hookExecutor.run === 'function') {
        const postHookResult = await this.hookExecutor.run('PostToolUse', {
          toolName,
          parameters: effectiveParameters,
          result,
          options,
          workingDirectory: options.workingDirectory || this.workingDirectory,
          preHookResult
        });

        if (postHookResult?.context?.result) {
          this.emit('postExecute', {
            toolName,
            parameters: effectiveParameters,
            result: postHookResult.context.result
          });
          return postHookResult.context.result;
        }
      }

      this.emit('postExecute', { toolName, parameters: effectiveParameters, result });
      return result;
    } catch (error) {
      const errorCode = extractErrorCode(error);
      const errorResult = { success: false, error: error.message, errorCode };
      if (this.listenerCount('toolError') > 0) {
        this.emit('toolError', { toolName, parameters: effectiveParameters, error, errorCode });
      }
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: errorResult });
      return errorResult;
    }
  }

  // The approval channel handed to tools (BackgroundTask, SpawnAgent,
  // workflow runners) so their children ask the same place this executor
  // asks. For a local-desktop run it is marked local (program §4.21).
  _rethreadedRequester() {
    const requester = (toolName, parameters, metadata) => this.requestApproval(toolName, parameters, metadata);
    // Carried as a plain property (not a WeakMap mark) so create-core's
    // agentExecutorAdapter.execute can read it straight off
    // options.approvalRequester and forward it to the child's origin, the
    // same way the tool already forwards this same function unchanged.
    requester.origin = this.origin;
    return this.localOrigin ? markLocalRequester(requester) : requester;
  }

  async requestApproval(toolName, parameters, metadata = {}) {
    const inner = this.approvalRequester
      ? this.approvalRequester(toolName, parameters, metadata)
      : (this.listenerCount('approvalRequired') === 0
          ? Promise.resolve(false)
          : new Promise((resolve) => {
              this.emit('approvalRequired', { toolName, parameters, metadata, resolve });
            }));

    if (!this.approvalTimeoutMs || this.approvalTimeoutMs <= 0) {
      return inner;
    }

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        this.emit('approvalTimedOut', { toolName, parameters, metadata, timeoutMs: this.approvalTimeoutMs });
        resolve('timeout');
      }, this.approvalTimeoutMs);
      timer.unref?.();
    });

    return Promise.race([inner, timeout]).finally(() => clearTimeout(timer));
  }
}

module.exports = ToolExecutor;
module.exports.mapApprovalResult = mapApprovalResult;
