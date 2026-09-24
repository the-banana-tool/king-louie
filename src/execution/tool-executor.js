const { EventEmitter } = require('events');
const { toolRegistry } = require('../tools');
const { getRuntimeEnvironment } = require('./runtime-environment');
const { evaluateRules, describeRule } = require('../tools/permission-rules');
const path = require('path');
const { isProtectedCasePath, CASE_BLOCKED_TOOL_NAMES, CASE_BLOCKED_TOOL_ERROR } = require('../cases/chat-integration');

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
        const approved = await this.requestApproval(toolName, effectiveParameters, {
          reason: preHookResult?.message || 'Hook policy requires explicit confirmation.'
        });

        if (!approved) {
          const denied = {
            success: false,
            error: 'User denied permission',
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
    const ruleSaysAllow = ruleMatch.matched && ruleMatch.action === 'allow' && !allowRuleDemoted;
    const needsApprovalGate = ruleSaysAsk || allowRuleDemoted
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
      const autoApproved = this.denyAutoApproval || ruleSaysAsk
        ? false
        : await this.shouldAutoApprove(toolName, effectiveParameters);
      const agentAutoApproved = !this.denyAutoApproval
        && !ruleSaysAsk
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

        const approved = await this.requestApproval(toolName, effectiveParameters, {
          ruleHint: ruleSaysAsk || allowRuleDemoted ? describeRule(ruleMatch.rule) : null
        });
        if (approved === 'timeout') {
          // Inattention, not denial — don't penalize via denialTracker, and
          // surface a distinct error so the agent can recover or explain
          // instead of treating it as a hard "no".
          const timedOut = {
            success: false,
            error: `Approval timed out after ${Math.round(this.approvalTimeoutMs / 1000)}s — no user response. Try again when someone is watching, or ask the user to pre-approve this tool.`,
            deniedBy: 'timeout'
          };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: timedOut });
          return timedOut;
        }
        if (!approved) {
          if (this.denialTracker) this.denialTracker.recordDenial(toolName, effectiveParameters);
          const denied = { success: false, error: 'User denied permission', deniedBy: 'user' };
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
        approvalRequester: (toolName, parameters, metadata) =>
          this.requestApproval(toolName, parameters, metadata)
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
