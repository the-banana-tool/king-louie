// The approval seam createCore applies to every ToolExecutor it builds
// (program §4.21, spec §3.7): which requester answers, whether pre-gate
// auto-approval is shut, and — in phone mode — node-policy tiers and audit.
//
// A run is local when its IPC event is marked (the desktop window) or when
// the requester it was handed is marked (a child of a local run). Local runs
// keep the on-screen dialog and never reach the phone; remote runs in phone
// mode only ever get the phone.
const { createLogger } = require('../logging');
const { paramsHmac, auditOriginOf, auditError, errorByCode } = require('./audit-fields');
const originHelpers = require('../core/origin');

const log = createLogger('approvals/executor-options');
const PHONE_GRACE_MS = 15000;
const LOGGED_ERROR_MAX = 2000;

// The ledger holds a failure's code alone, so its words are logged here. A tool
// with an audit form of its parameters (Type, Key) may quote typed text, so it is
// logged by code too; so is one the registry does not know.
function logToolFailure(toolName, jobId, result) {
  // Required here, as in phoneExecutorOptions: only the agent profile loads the tool registry.
  const { toolRegistry } = require('../tools');
  const tool = toolRegistry.get(toolName);
  const words = !tool || typeof tool.auditParameters === 'function'
    ? errorByCode(result)
    : String((result && result.error) || 'failed').slice(0, LOGGED_ERROR_MAX);
  log.warn(`${toolName} failed (job ${jobId || 'none'}): ${words}`);
}

// Fleet stage 4 §3.8: a delegate session whose client was not granted
// fleet:unsafe refuses unsafe calls itself; the phone is never asked.
const REFUSE_UNSAFE_MESSAGE = 'This client may not request unsafe actions (fleet:unsafe not granted). Nothing ran.';

function refuseUnsafeClassifier(classifyCall) {
  return (toolName, params, ctx) => {
    const decision = classifyCall ? classifyCall(toolName, params, ctx) : null;
    if (decision && decision.tier === 'unsafe') return { tier: 'denied', reason: 'fleet_unsafe_not_granted', message: REFUSE_UNSAFE_MESSAGE };
    return decision;
  };
}

// The node-policy classifier with no pattern lists and `allowedRoots` as its
// allowed_roots (none when unset: every path-naming call is unsafe), for a
// refuseUnsafe run that has no node policy of its own ('allow'/'deny' mode,
// or phone mode without deps.nodePolicy). A delegate turn passes its own cwd
// (T11-roots). If it cannot be loaded, every call is unsafe: no tool
// declares itself read-only, so nothing can be let through.
function defaultFleetClassifier(allowedRoots = null) {
  const policy = Array.isArray(allowedRoots) && allowedRoots.length > 0 ? { allowed_roots: [...allowedRoots] } : {};
  try {
    const { classifyToolCall } = require('../execution/safety-policy');
    return (toolName, params, { cwd } = {}) => classifyToolCall(toolName, params, policy, { cwd });
  } catch (err) {
    log.error(`fleet classifier unavailable, refusing every call: ${err?.message ?? String(err)}`);
    return () => ({ tier: 'unsafe', reason: 'no_classifier' });
  }
}

// T10 ruling (fail closed in every mode): the classifier a refuseUnsafe
// ToolExecutor runs. The run's own classifyCall decides when it has an
// opinion; otherwise the fleet default does. Anything unsafe becomes the
// refusal, so only read/routine calls run.
function refuseUnsafeGate(classifyCall, allowedRoots = null) {
  const fallback = defaultFleetClassifier(allowedRoots);
  return refuseUnsafeClassifier((toolName, params, ctx) => {
    const decision = classifyCall ? classifyCall(toolName, params, ctx) : null;
    return decision === null || decision === undefined ? fallback(toolName, params, ctx) : decision;
  });
}

function runOrigin({ executorOptions, event, local, helpers }) {
  if (executorOptions.origin) return executorOptions.origin;
  const session = executorOptions.chatId || null;
  if (local) return { client: 'desktop', deviceId: helpers.localDesktopDeviceId(event), session, job_id: null };
  if (helpers.isRemoteWindowEvent(event)) return { client: 'remote-window', deviceId: helpers.remoteWindowDeviceId(event), session, job_id: null };
  return { client: 'king-louie', session, job_id: null };
}

// A task's run, and its children, may also work in the task's work dir (tasks
// spec §4.3); every other path and every other run keep the node's roots.
function policyForRun(nodePolicy, taskPolicy) {
  const workDir = taskPolicy && taskPolicy.workDir;
  if (!nodePolicy || typeof workDir !== 'string' || !workDir) return nodePolicy;
  return { ...nodePolicy, allowed_roots: [...(nodePolicy.allowed_roots || []), workDir] };
}

// Phone-mode options merged into the ToolExecutor, plus the audit listeners.
function phoneExecutorOptions({ phoneApprover, auditLedger = null, nodePolicy = null, origin, local, approvalRequester = null }) {
  // phoneApprover.ttlMs validity and the missing-nodePolicy/auditLedger
  // warnings are checked once, at createCore construction (next to
  // `remoteApprovals 'phone' needs deps.phoneApprover`), not here: this
  // function runs on every ToolExecutor build.
  const options = { localOrigin: local, origin };
  if (local) {
    options.approvalRequester = approvalRequester;
  } else {
    // The same metadata object goes on to the phone approver, so the refusal
    // it writes there reaches ToolExecutor's mapApprovalResult.
    options.approvalRequester = (toolName, parameters, metadata = {}) => {
      // What the phone is shown; the kind and the ids are the ledger's.
      const { kind, grant_id: grantId, client_id: clientId, ...phoneOrigin } = origin;
      metadata.origin = phoneOrigin;
      return phoneApprover.requestApproval(toolName, parameters, metadata);
    };
    // The phone's own expiry answers first ('timeout' from the approver).
    options.approvalTimeoutMs = phoneApprover.ttlMs + PHONE_GRACE_MS;
  }
  if (nodePolicy) {
    // Required here, not at the top: only the agent profile loads the tool registry.
    const { classifyToolCall } = require('../execution/safety-policy');
    options.classifyCall = (toolName, params, { cwd } = {}) => classifyToolCall(toolName, params, nodePolicy, { cwd });
  }

  const attach = (executor) => {
    if (!auditLedger) return;
    const append = (kind, data) => {
      Promise.resolve()
        .then(() => auditLedger.append({ kind, data }))
        .catch((err) => log.warn(`audit ${kind} failed: ${err?.message ?? String(err)}`));
    };
    // The ledger is served to the relay's mirror, so an entry holds the tool,
    // the tier and the ids (R-SP-7): the origin is its kind, an error its code
    // (audit-fields.js). The mark is of the parameters as called, except for a
    // tool that gives an audit form of them (Type and Key, R-F5-16), under a key
    // only this node holds: a plain hash of a short parameter is that parameter
    // to anyone with a dictionary. Null where this process holds no box key.
    // Nothing verifies it against a phone signature: what a phone signs for an
    // unsafe call is the request's action_hash, which is untouched.
    const identity = auditLedger.identity || (phoneApprover && phoneApprover.identity) || null;
    const auditOrigin = auditOriginOf(origin);
    executor.on('tierDecision', ({ toolName, parameters, auditParameters, tier, reason }) => {
      const hashed = auditParameters === undefined ? parameters : auditParameters;
      append('tier.decision', { tool: toolName, tier, reason, params_hmac: paramsHmac(hashed, identity), job_id: origin.job_id || null, origin: auditOrigin });
    });
    // 'executeStart' fires only after every gate (hooks, rules, node-policy
    // tier, the approval gate, the abort check) has passed, immediately
    // before the tool's execute — unlike 'preExecute', which also fires for
    // calls later denied. exec.start means "the tool is about to run".
    executor.on('executeStart', ({ toolName }) => {
      append('exec.start', { kind: 'tool', name: toolName, request_id: null, job_id: origin.job_id || null, origin: auditOrigin });
    });
    // Demo takes spec §7.2: every take refusal, by the tool's name and the
    // code only; never the parameters (a URL, typed text).
    // Tasks spec §4.8 likewise: a call a finished task may no longer make, and
    // the owner's no to one beyond its grant.
    executor.on('approvalDenied', ({ toolName, deniedBy, code }) => {
      if (deniedBy !== 'take' && deniedBy !== 'task') return;
      append(`${deniedBy}.refused`, { tool: toolName, code: typeof code === 'string' ? code : null, origin: auditOrigin });
    });
    executor.on('postExecute', ({ toolName, result }) => {
      const ok = Boolean(result) && result.success !== false && result.ok !== false;
      if (!ok) logToolFailure(toolName, origin.job_id, result);
      append('exec.result', {
        kind: 'tool', name: toolName, request_id: null, job_id: origin.job_id || null, origin: auditOrigin,
        ok, exit_status: null, error: ok ? null : auditError(result)
      });
    });
  };
  return { options, attach };
}

// → { toolExecutorOptions, attach(executor), local, origin }
function approvalSeam({ remoteApprovals, event = null, approvalRequester = null, executorOptions = {}, phoneApprover = null,
  auditLedger = null, nodePolicy = null, helpers = originHelpers }) {
  // A remote window's run is never local and never auto-approved, in any mode
  // and whatever requester it was handed (remote window plan R-RW-9).
  const remote = helpers.isRemoteWindowEvent(event);
  const local = !remote && (helpers.isLocalDesktopEvent(event) || helpers.isLocalRequester(approvalRequester));
  const origin = runOrigin({ executorOptions, event, local, helpers });
  const denyAutoApproval = remote || (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true;
  // Set by a delegate turn (executorOptions) or inherited through the
  // re-threaded requester of its sub-agents.
  const refuseUnsafe = executorOptions.refuseUnsafe === true || Boolean(approvalRequester && approvalRequester.refuseUnsafe === true);
  // A delegate turn's cwd, for the fleet default classifier (T11-roots).
  const rawRoots = executorOptions.allowedRoots || (approvalRequester && approvalRequester.allowedRoots);
  const gate = refuseUnsafe
    ? { refuseUnsafe: true, ...(Array.isArray(rawRoots) && rawRoots.length > 0 ? { allowedRoots: rawRoots } : {}) }
    : {};

  if (remoteApprovals === 'phone') {
    // A marked (local) requester is kept; an unmarked one from a local event
    // is dropped so the on-screen dialog answers (requester null).
    const localRequester = helpers.isLocalRequester(approvalRequester) ? approvalRequester : null;
    const taskPolicy = executorOptions.taskPolicy || (approvalRequester && approvalRequester.taskPolicy) || null;
    const phone = phoneExecutorOptions({ phoneApprover, auditLedger, nodePolicy: policyForRun(nodePolicy, taskPolicy), origin, local, approvalRequester: localRequester });
    const toolExecutorOptions = { ...phone.options, denyAutoApproval };
    if (refuseUnsafe) {
      toolExecutorOptions.classifyCall = refuseUnsafeClassifier(phone.options.classifyCall || null);
      Object.assign(toolExecutorOptions, gate);
    }
    return { toolExecutorOptions, attach: phone.attach, local, origin };
  }

  let requester;
  if (remoteApprovals === 'allow' && !remote) requester = approvalRequester;
  else requester = local && helpers.isLocalRequester(approvalRequester) ? approvalRequester : null;
  return {
    toolExecutorOptions: { approvalRequester: requester, denyAutoApproval, localOrigin: local, origin, ...gate },
    attach: () => {},
    local,
    origin
  };
}

module.exports = { approvalSeam, phoneExecutorOptions, refuseUnsafeClassifier, refuseUnsafeGate, PHONE_GRACE_MS, REFUSE_UNSAFE_MESSAGE };
