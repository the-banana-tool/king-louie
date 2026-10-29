const { EventEmitter } = require('events');
const { toolRegistry } = require('../tools');
const { getRuntimeEnvironment } = require('./runtime-environment');
const { evaluateRules, describeRule } = require('../tools/permission-rules');
const { BROWSER_TOOLS, isActingBrowserCall, ownerQuoteInTurn } = require('../tools/browser-acting');
const path = require('path');
const { caseWriteRefusal, CASE_BLOCKED_TOOL_NAMES, CASE_BLOCKED_TOOL_ERROR } = require('../cases/chat-integration');
const { UNVERIFIABLE_PATH_ERROR } = require('../cases/safe-path');
const { caseToolGuard, caseBrowserProfileGuard, WAKEUP_BROWSER_ACTING_REFUSAL } = require('../cases/executors/case-guard');
const { markLocalRequester } = require('../core/origin');
const { refuseUnsafeGate, REFUSE_UNSAFE_MESSAGE } = require('../approvals/executor-options');
const { createLogger } = require('../logging');
const { detachImages } = require('./tool-images');
const { normalizePolicy } = require('../models/egress');
const { runAsSkillCaller } = require('../skills/skill-models');
const { privateRefusal } = require('../tools/private-refusals');

const log = createLogger('tool-executor');

// Tools that write a file named by file_path (MultiEdit: per edit). In case
// mode, the paths isProtectedCasePath names (facts.jsonl, brief.md,
// case.yaml, .gitmodules, .gitattributes, playbooks/, .kl/, .git/) are
// written only through the case tools (.git/ never). Bash is not covered.
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
// A requiresOwnerTurn tool on a run with no owner message (see execute).
const OWNER_TURN_REQUIRED_MESSAGE = "not_owner: this tool acts only on the owner's own message in King Louie's chat, and this run has none. Nothing ran.";

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

const TAKE_NO_MID_TAKE_APPROVAL = 'take_no_mid_take_approval';

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
    // The owner's own message that started this turn (the local chat send
    // path only). A browser action that changes something runs unasked when
    // the model's ownerQuote is found in it (src/tools/browser-acting.js).
    this.ownerTurnText = typeof options.ownerTurnText === 'string' ? options.ownerTurnText : null;
    // Cases stage 2: a wake-up turn may run only these tools, whatever the
    // model names. null means no restriction (every other caller).
    if (options.allowedToolNames instanceof Set) {
      this.allowedToolNames = new Set(options.allowedToolNames);
    } else if (Array.isArray(options.allowedToolNames)) {
      this.allowedToolNames = new Set(options.allowedToolNames);
    } else {
      this.allowedToolNames = null;
    }
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
    // The parent turn's frozen TurnModels (spec 2026-09-27 §6.6): carried on
    // the rethreaded requester so a SpawnAgent or BackgroundTask child of a
    // chat turn resolves against the chat's profile and main override as of
    // turn launch. Null for runs with no parent turn (headless callers).
    this.turnModels = options.turnModels || null;
    // The run's egress policy when it has no snapshot to read it from (local
    // inference spec 2026-10-13 §7.1): the host's word for the run's chat.
    // The snapshot's own policy comes first; see _egressPolicy.
    this.egress = options.egress ?? null;
    // Where a sub-agent run's model calls go (models spec §10): the chat
    // turn that owns this run rolls them into its reply. Carried on the
    // rethreaded requester like turnModels, so grandchildren report too.
    this.onSubagentLlm = typeof options.onSubagentLlm === 'function' ? options.onSubagentLlm : null;
    // Fleet stage 4 §3.8: this run (a delegate turn without fleet:unsafe)
    // refuses unsafe calls; carried on the re-threaded requester so the
    // run's sub-agents refuse them too.
    this.refuseUnsafe = options.refuseUnsafe === true;
    // The roots the fleet default classifier allows paths under (a delegate
    // turn's own cwd); only read with refuseUnsafe, and carried to sub-agents
    // with it. Unset, that classifier allows no path.
    this.allowedRoots = Array.isArray(options.allowedRoots) ? Object.freeze([...options.allowedRoots]) : null;
    // Fail closed in every approval mode: with the gate on, every call is
    // classified (by the fleet default when the run has no node policy), an
    // unsafe one is refused in the tier branch, and nothing below ever asks
    // a person (see _refuseUnsafeResult).
    if (this.refuseUnsafe) this.classifyCall = refuseUnsafeGate(this.classifyCall, this.allowedRoots);
    // A delegate session's background-task view, handed on to sub-agents so
    // their BackgroundTask/TaskStatus calls stay inside the session.
    this.scopedBackgroundTasks = options.scopedBackgroundTasks || null;
    // A delegate session's take holder (demo takes spec §7.2): while it holds
    // a policy, the policy's decision replaces the approval prompt, and
    // nothing asks a person mid-take. Carried to sub-agents.
    this.takePolicy = options.takePolicy || null;
    // Whether the run's origin is one this node started itself (the desktop,
    // the service's own chat, a stdio session); a take needs one.
    this.nodeLocalOrigin = options.nodeLocalOrigin !== false;
  }

  // The live take policy, or null.
  // What a tool's prepareParams is given: the call's options and this run's
  // take, so a browser tool reads the browser the call will be decided on.
  _prepareContext(options = {}) {
    const take = this._liveTake();
    return {
      ...this.extraToolOptions,
      ...options,
      takePolicy: this.takePolicy,
      browserKey: take && typeof take.browserKey === 'string' && take.browserKey ? take.browserKey : null
    };
  }

  _liveTake() {
    return this.takePolicy && this.takePolicy.current ? this.takePolicy.current : null;
  }

  // Inside a take nothing is sent to the phone: a call that would ask is refused.
  _noMidTakeApprovalResult(toolName, parameters) {
    const refused = {
      success: false,
      error: `this take did not ask for ${toolName}; nothing was sent to the phone`,
      code: TAKE_NO_MID_TAKE_APPROVAL
    };
    this.emit('approvalDenied', { toolName, parameters, deniedBy: 'take', code: TAKE_NO_MID_TAKE_APPROVAL });
    this.emit('postExecute', { toolName, parameters, result: refused });
    return refused;
  }

  // The same refusal for a tool that asks through the requester it was handed:
  // `false`, with the take's code where the tool can read it.
  _midTakeRequesterRefusal(toolName, parameters, metadata) {
    if (metadata && typeof metadata === 'object') {
      metadata.refusal = {
        error: `this take did not ask for ${toolName}; nothing was sent to the phone`,
        code: TAKE_NO_MID_TAKE_APPROVAL,
        deniedBy: 'take'
      };
    }
    this.emit('approvalDenied', { toolName, parameters, deniedBy: 'take', code: TAKE_NO_MID_TAKE_APPROVAL });
    return false;
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

  // The policy this run's model calls are under, or null: the turn
  // snapshot's, else the host's. A value that is not a policy restricts.
  _egressPolicy() {
    return normalizePolicy((this.turnModels && this.turnModels.egress) ?? null) || normalizePolicy(this.egress);
  }

  /**
   * The refusal for a tool that may not run in a private chat
   * (src/tools/private-refusals.js), or null. Only under an egress policy.
   */
  privateRefusalFor(toolName, parameters = {}) {
    if (!this._egressPolicy()) return null;
    const refusal = privateRefusal(toolName, parameters);
    return refusal ? { success: false, error: refusal.message, code: refusal.code, deniedBy: 'policy' } : null;
  }

  async execute(toolName, parameters = {}, options = {}) {
    if (this.allowedToolNames && !this.allowedToolNames.has(toolName)) {
      const refused = { success: false, error: `Tool "${toolName}" is not available in this turn.` };
      this.emit('postExecute', { toolName, parameters, result: refused });
      return refused;
    }

    // A private chat (spec 2026-10-13 §7.5, §8.5): a tool that would hand
    // the chat's text to a model somewhere else is refused by name, before
    // the registry is asked and before any hook, rule or approval prompt.
    const privately = this.privateRefusalFor(toolName, parameters);
    if (privately) {
      this.emit('postExecute', { toolName, parameters, result: privately });
      return privately;
    }

    const tool = toolRegistry.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // A tool that needs the owner's own words this turn is refused before
    // any hook, rule or approval prompt when the run has none (the same
    // condition under which tool.execute gets ownerTurnText: null), so a
    // gateway, cron or remote run never asks anyone (a phone on a service
    // node) to approve a call that would then fail not_owner.
    if (tool.requiresOwnerTurn && (this.denyAutoApproval || typeof this.ownerTurnText !== 'string' || !this.ownerTurnText.trim())) {
      const refused = { success: false, error: OWNER_TURN_REQUIRED_MESSAGE, code: 'not_owner', deniedBy: 'policy' };
      this.emit('postExecute', { toolName, parameters, result: refused });
      return refused;
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
    // The tool's own preparation (prepareParams), once, after the hooks have
    // had their say and before anyone is asked: a hook's confirm prompt, the
    // rules, the tier and the approval gate all see what it returns. → null
    // or the refusal to return.
    let prepared = false;
    const prepare = () => {
      prepared = true;
      if (!tool.prepareParams) return null;
      let out;
      try {
        out = tool.prepareParams(effectiveParameters, this._prepareContext(options));
      } catch (err) {
        out = { error: err.message || String(err), code: err.code };
      }
      if (out && out.params && typeof out.params === 'object') {
        effectiveParameters = out.params;
        return null;
      }
      const refused = { success: false, error: out?.error || `${toolName} refused its parameters`, ...(out?.code ? { code: out.code } : {}) };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refused });
      return refused;
    };

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

      const refusedByTool = prepare();
      if (refusedByTool) return refusedByTool;

      if (action === 'confirm') {
        if (this.refuseUnsafe) return this._refuseUnsafeResult(toolName, effectiveParameters);
        if (this._liveTake()) return this._noMidTakeApprovalResult(toolName, effectiveParameters);
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

    if (!prepared) {
      const refusedByTool = prepare();
      if (refusedByTool) return refusedByTool;
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
      const reasons = targets.map((p) => caseWriteRefusal(caseContext.dir, path.resolve(base, p)));
      if (reasons.some(Boolean)) {
        const refused = {
          success: false,
          // A path that cannot be placed is refused too, in its own words.
          error: !reasons.includes('protected') ? UNVERIFIABLE_PATH_ERROR : 'facts.jsonl, brief.md, case.yaml, .gitmodules, .gitattributes, playbooks/ and .kl/ are written only through the case tools, and .git/ is never written directly. Use the Ledger tool for facts and the Brief tool for the brief (or Decide, Recommend), and Playbook propose for a playbook change, instead.'
        };
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refused });
        return refused;
      }
    }

    // Cases stage 3: browser allow-list, web tools gated in query mode, no
    // writes into ops memory or the executors folder, for case turns and for
    // child runs that carry a guardContext.
    const guardContext = this.extraToolOptions.guardContext || null;
    if (caseContext || guardContext) {
      const refusedByGuard = caseToolGuard(toolName, effectiveParameters, {
        caseContext, guardContext, workingDirectory: options.workingDirectory || this.workingDirectory
      });
      if (refusedByGuard) {
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refusedByGuard });
        return refusedByGuard;
      }
      // A browser the owner opened in their own profile is not used by a case run.
      const refusedByProfile = await caseBrowserProfileGuard(toolName, effectiveParameters, { caseContext, guardContext });
      if (refusedByProfile) {
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refusedByProfile });
        return refusedByProfile;
      }
    }

    // A wake-up's browser only looks (owner ruling 2026-10-20, spec
    // docs/superpowers/specs/2026-10-20-outreach-wakeup-browser.md). A wake-up
    // runs under denyAutoApproval with no owner to ask, so an acting action is
    // refused by policy here, before any approver (a service node's phone is
    // never asked), and a look-only one (caseToolGuard has already held it to
    // BROWSER_ALLOWED) skips the approval gate below. A deny rule and an
    // `unsafe` tier still apply to it, except a node policy's
    // `tool_requires_approval` (see the tier block).
    const wakeupBrowser = caseContext?.source === 'wakeup' && BROWSER_TOOLS.has(toolName);
    if (wakeupBrowser && isActingBrowserCall(toolName, effectiveParameters)) {
      const refused = { success: false, error: WAKEUP_BROWSER_ACTING_REFUSAL, deniedBy: 'policy', code: 'wakeup_browser_acting' };
      this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refused });
      return refused;
    }
    const wakeupLookOnly = wakeupBrowser; // the acting ones were refused above

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
    const { refused: refusedByRuleOrTier, ruleMatch, tierUnsafe, tierReason } = this._rulesAndTier(tool, toolName, effectiveParameters, options, { wakeupLookOnly });
    if (refusedByRuleOrTier) return refusedByRuleOrTier;
    let approvalSource = null;

    // A live take (demo takes spec §7.2), after the deny rules and the tier,
    // so a `denied` tier has already refused: the policy refuses at once, or
    // allows without asking, or leaves the call to the logic below
    // (`passthrough`), which then refuses where it would have asked. A path
    // outside the allowed roots is never lifted by the take's allow.
    let takeAllowed = false;
    // The browser key the call was decided under: a call the take let through
    // runs on the take's browser even if the take ends before it runs (the
    // registry then refuses it, take_browser_unavailable), never on the
    // owner's default browser.
    let decidedBrowserKey = null;
    const take = this._liveTake();
    if (take) {
      const d = await take.decide(toolName, effectiveParameters);
      if (d.allow === false) {
        const refused = { success: false, error: d.error, code: d.code, ...(d.allowed ? { allowed: d.allowed } : {}) };
        this.emit('approvalDenied', { toolName, parameters: effectiveParameters, deniedBy: 'take', code: d.code });
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: refused });
        return refused;
      }
      if (typeof take.browserKey === 'string' && take.browserKey) decidedBrowserKey = take.browserKey;
      if (d.allow === true && !d.passthrough && !(tierUnsafe && tierReason === 'path_outside_allowed_roots')) {
        takeAllowed = true;
        approvalSource = { type: 'take' };
        this.emit('approvalAutoGranted', { toolName, parameters: effectiveParameters, source: approvalSource });
      }
    }

    const ruleSaysAsk = ruleMatch.matched && ruleMatch.action === 'ask';
    // What this tool would face with no rule written for it at all.
    const toolWouldGate = tool.requiresApproval && this.requireApproval && !wakeupLookOnly;
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

    if (ruleSaysAllow && !takeAllowed) {
      approvalSource = { type: 'rule', rule: describeRule(ruleMatch.rule) };
      this.emit('approvalAutoGranted', {
        toolName,
        parameters: effectiveParameters,
        source: approvalSource
      });
    }

    if (needsApprovalGate && !ruleSaysAllow && !takeAllowed) {
      if (this.refuseUnsafe) return this._refuseUnsafeResult(toolName, effectiveParameters);
      // An `ask` rule is the user saying "always check with me for this one",
      // so it outranks both auto-approve paths — which is what the comment
      // above evaluateRules has always claimed and the code did not do. Agent
      // mode's hard-coded list used to win here, leaving the whole `ask` tier
      // inert for Bash, Edit, Write and Git.
      // A browser action that changes something is not covered by either
      // auto-approve list: only an allow rule for the action (above) or the
      // owner's own words this turn lift the prompt.
      const actingBrowser = isActingBrowserCall(toolName, effectiveParameters);
      const autoApproved = this.denyAutoApproval || ruleSaysAsk || tierUnsafe || actingBrowser
        ? false
        : await this.shouldAutoApprove(toolName, effectiveParameters);
      const agentAutoApproved = !this.denyAutoApproval
        && !ruleSaysAsk
        && !tierUnsafe
        && !actingBrowser
        && Array.isArray(options.autoApproveTools)
        && options.autoApproveTools.includes(toolName);
      const ownerQuoted = actingBrowser
        && !this.denyAutoApproval
        && !ruleSaysAsk
        && !tierUnsafe
        && ownerQuoteInTurn(effectiveParameters?.ownerQuote, this.ownerTurnText);

      if (autoApproved || agentAutoApproved || ownerQuoted) {
        approvalSource = ownerQuoted
          ? { type: 'owner-quote', quote: effectiveParameters.ownerQuote }
          : { type: agentAutoApproved ? 'agent-config' : 'global-auto-approve' };
        this.emit('approvalAutoGranted', {
          toolName,
          parameters: effectiveParameters,
          source: approvalSource
        });
      }

      if (!autoApproved && !agentAutoApproved && !ownerQuoted) {
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

        if (this._liveTake()) return this._noMidTakeApprovalResult(toolName, effectiveParameters);

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

      // Fleet stage 5: `_images` never reach postExecute listeners (chat
      // storage, audit, the renderer); only an emitsImages tool keeps them,
      // off-JSON, for the agent loop to lift.
      // A tool runs as a skill caller with this run's policy when the run
      // has one to read (its snapshot or its own egress), so a skill tool's
      // model call is held to it (src/skills/skill-models.js).
      const callerPolicy = this.turnModels || this.egress ? { egress: this._egressPolicy() } : {};
      const executeContext = {
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
        approvalRequester: this._rethreadedRequester(),
        // The owner's own message for this turn, from this executor's own
        // field only (the local chat send path sets it): last, so no call
        // option or extra tool option can supply it, and never under
        // denyAutoApproval. answer_question checks its quote against it.
        ownerTurnText: this.denyAutoApproval ? null : this.ownerTurnText,
        // This run's take holder and origin locality, from this executor's
        // own fields (the Take tool reads them).
        takePolicy: this.takePolicy,
        nodeLocalOrigin: this.nodeLocalOrigin,
        // The deny rules and the node tier for a call a tool makes itself
        // (Take.run_steps' steps); from this executor, never from options.
        checkDenied: (name, params) => this._checkDenied(name, params, options)
      };
      // Set here only, and not writable: no option or tool changes which
      // browser this call was approved for (src/tools/builtin/browser-registry.js).
      Object.defineProperty(executeContext, 'browserKey', { value: decidedBrowserKey, writable: false, enumerable: true, configurable: false });
      const result = detachImages(tool, await runAsSkillCaller({ channel: 'tool', ...callerPolicy }, () => tool.execute(effectiveParameters, executeContext)));

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
          // A hook can pass the tool's result on, but it cannot add images.
          const replaced = detachImages(null, postHookResult.context.result);
          this.emit('postExecute', {
            toolName,
            parameters: effectiveParameters,
            result: replaced
          });
          return replaced;
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

  // The permission rules' deny and the node policy's tier for one call, in that
  // order, with the events the audit hangs off (postExecute for a refusal,
  // tierDecision for every classification). Shared by execute() and by
  // checkDenied (a take's run_steps holds each step to the same two checks).
  _rulesAndTier(tool, toolName, effectiveParameters, options = {}, { wakeupLookOnly = false } = {}) {
    const ruleMatch = evaluateRules(this.permissionRules, toolName, effectiveParameters);
    if (ruleMatch.matched) {
      if (ruleMatch.action === 'deny') {
        const denied = {
          success: false,
          error: `Blocked by rule: ${describeRule(ruleMatch.rule)}`,
          deniedBy: 'rule',
          rule: { tool: ruleMatch.rule.tool, pattern: ruleMatch.rule.pattern, source: ruleMatch.rule.source }
        };
        this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
        return { refused: denied, ruleMatch, tierUnsafe: false, tierReason: null };
      }
      // 'ask' falls through to the regular approval flow below.
    }

    // Node policy tier, after the permission rules and before the gate. A
    // classifyCall that throws, or returns anything other than null or a
    // well-formed { tier: read|routine|unsafe|denied, reason? } object,
    // fails closed: treated as `denied` rather than let the call run
    // unclassified.
    let tierUnsafe = false;
    let tierReason = null;
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

        // A tool that says how its parameters may be audited (Type, Key) is
        // audited in that form. A redactor that fails gives nothing of the
        // parameters, never the parameters themselves.
        let auditParameters;
        if (tool && typeof tool.auditParameters === 'function') {
          try {
            auditParameters = tool.auditParameters(effectiveParameters);
          } catch {
            auditParameters = { redacted: true };
          }
          if (auditParameters === null || typeof auditParameters !== 'object') auditParameters = { redacted: true };
        }
        this.emit('tierDecision', {
          toolName,
          parameters: effectiveParameters,
          ...(auditParameters === undefined ? {} : { auditParameters }),
          tier: safeDecision.tier,
          reason: safeDecision.reason || null
        });
        if (safeDecision.tier === 'denied') {
          const denied = {
            success: false,
            error: typeof safeDecision.message === 'string' && safeDecision.message ? safeDecision.message : 'Denied by node policy.',
            deniedBy: 'policy'
          };
          this.emit('postExecute', { toolName, parameters: effectiveParameters, result: denied });
          return { refused: denied, ruleMatch, tierUnsafe: false, tierReason: null };
        }
        // A service node's classifier calls every requiresApproval tool
        // `unsafe` / `tool_requires_approval`, the per-tool flag in another
        // form. For a wake-up's look-only browser call the guards above have
        // already made that judgment (a look-only action, the kl-cases
        // profile), so that one verdict does not send it to a phone nobody is
        // watching (spec docs/superpowers/specs/2026-10-20-outreach-wakeup-browser.md,
        // review of 2026-10-20). Every other verdict stands: `denied` above,
        // and `unsafe` for an always_confirm match, a dangerous operation, a
        // path outside allowed_roots or any other reason still gates it. The
        // tierDecision event above keeps the classifier's own verdict.
        const requiresApprovalOnly = safeDecision.tier === 'unsafe' && safeDecision.reason === 'tool_requires_approval';
        tierUnsafe = safeDecision.tier === 'unsafe' && !(wakeupLookOnly && requiresApprovalOnly);
        tierReason = safeDecision.reason || null;
      }
    }
    return { refused: null, ruleMatch, tierUnsafe, tierReason };
  }

  // For a tool that drives another tool's calls itself (Take.run_steps): the
  // node's deny rules and `denied` tier for that call, as execute() applies
  // them, → null or { code, message }. PreToolUse hooks are not run.
  _checkDenied(toolName, parameters, options = {}) {
    const params = parameters && typeof parameters === 'object' ? parameters : {};
    const { refused } = this._rulesAndTier(toolRegistry.get(toolName) || null, toolName, params, options);
    if (!refused) return null;
    return { code: refused.deniedBy === 'rule' ? 'denied_by_rule' : 'denied_by_policy', message: refused.error };
  }

  // A refuseUnsafe run never asks anyone: a call that would need a person's
  // approval (a hook's confirm, an `ask` rule) is refused like an unsafe one.
  _refuseUnsafeResult(toolName, parameters) {
    const refused = { success: false, error: REFUSE_UNSAFE_MESSAGE, deniedBy: 'policy' };
    this.emit('postExecute', { toolName, parameters, result: refused });
    return refused;
  }

  // The approval channel handed to tools (BackgroundTask, SpawnAgent,
  // workflow runners) so their children ask the same place this executor
  // asks. For a local-desktop run it is marked local (program §4.21).
  _rethreadedRequester() {
    // A refuseUnsafe run never asks anyone, and neither do its children.
    // Inside a live take nobody is asked either (demo takes spec §7.2, R-D1-5):
    // a tool that asks itself (an unsafe LaunchApp) gets `false` at once, and
    // the take's code in metadata.refusal, never a phone prompt.
    const requester = this.refuseUnsafe
      ? async () => false
      : async (toolName, parameters, metadata) => {
        if (this._liveTake()) return this._midTakeRequesterRefusal(toolName, parameters, metadata);
        return this.requestApproval(toolName, parameters, metadata);
      };
    // Carried as a plain property (not a WeakMap mark) so create-core's
    // agentExecutorAdapter.execute can read it straight off
    // options.approvalRequester and forward it to the child's origin, the
    // same way the tool already forwards this same function unchanged.
    requester.origin = this.origin;
    requester.refuseUnsafe = this.refuseUnsafe;
    if (this.refuseUnsafe && this.allowedRoots) requester.allowedRoots = this.allowedRoots;
    if (this.scopedBackgroundTasks) requester.scopedBackgroundTasks = this.scopedBackgroundTasks;
    if (this.turnModels) requester.turnModels = this.turnModels;
    // A run with a policy and no snapshot hands the policy on by itself.
    const egress = this._egressPolicy();
    if (egress) requester.egress = egress;
    if (this.onSubagentLlm) requester.onSubagentLlm = this.onSubagentLlm;
    // A child never gets a tool this run may not use (a case wake-up's list,
    // a delegate turn's T11-sessions limit); childRuntimeOptions intersects.
    if (this.allowedToolNames) requester.allowedToolNames = Object.freeze([...this.allowedToolNames]);
    // A child of a take's run is held to the same take, and to its origin.
    if (this.takePolicy) requester.takePolicy = this.takePolicy;
    requester.nodeLocalOrigin = this.nodeLocalOrigin;
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
module.exports.OWNER_TURN_REQUIRED_MESSAGE = OWNER_TURN_REQUIRED_MESSAGE;
