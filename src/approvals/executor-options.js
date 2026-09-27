// The approval seam createCore applies to every ToolExecutor it builds
// (program §4.21, spec §3.7): which requester answers, whether pre-gate
// auto-approval is shut, and — in phone mode — node-policy tiers and audit.
//
// A run is local when its IPC event is marked (the desktop window) or when
// the requester it was handed is marked (a child of a local run). Local runs
// keep the on-screen dialog and never reach the phone; remote runs in phone
// mode only ever get the phone.
const { createLogger } = require('../logging');
const { canonicalize, sha256b64url } = require('../platform/jcs');
const originHelpers = require('../core/origin');

const log = createLogger('approvals/executor-options');
const PHONE_GRACE_MS = 15000;

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

function paramsSha256(params) {
  try {
    return sha256b64url(canonicalize(params === undefined || params === null ? {} : params));
  } catch {
    return null;
  }
}

function runOrigin({ executorOptions, event, local, helpers }) {
  if (executorOptions.origin) return executorOptions.origin;
  const session = executorOptions.chatId || null;
  if (local) return { client: 'desktop', deviceId: helpers.localDesktopDeviceId(event), session, job_id: null };
  return { client: 'king-louie', session, job_id: null };
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
      metadata.origin = origin;
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
    executor.on('tierDecision', ({ toolName, parameters, tier, reason }) => {
      append('tier.decision', { tool: toolName, tier, reason, params_sha256: paramsSha256(parameters), origin });
    });
    // 'executeStart' fires only after every gate (hooks, rules, node-policy
    // tier, the approval gate, the abort check) has passed, immediately
    // before the tool's execute — unlike 'preExecute', which also fires for
    // calls later denied. exec.start means "the tool is about to run".
    executor.on('executeStart', ({ toolName }) => {
      append('exec.start', { kind: 'tool', name: toolName, request_id: null, job_id: origin.job_id || null, origin });
    });
    executor.on('postExecute', ({ toolName, result }) => {
      const ok = Boolean(result) && result.success !== false && result.ok !== false;
      append('exec.result', {
        kind: 'tool', name: toolName, request_id: null, job_id: origin.job_id || null, origin,
        ok, exit_status: null, error: ok ? null : String((result && result.error) || 'failed')
      });
    });
  };
  return { options, attach };
}

// → { toolExecutorOptions, attach(executor), local, origin }
function approvalSeam({ remoteApprovals, event = null, approvalRequester = null, executorOptions = {}, phoneApprover = null,
  auditLedger = null, nodePolicy = null, helpers = originHelpers }) {
  const local = helpers.isLocalDesktopEvent(event) || helpers.isLocalRequester(approvalRequester);
  const origin = runOrigin({ executorOptions, event, local, helpers });
  const denyAutoApproval = (remoteApprovals !== 'allow' && !local) || executorOptions.denyAutoApproval === true;
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
    const phone = phoneExecutorOptions({ phoneApprover, auditLedger, nodePolicy, origin, local, approvalRequester: localRequester });
    const toolExecutorOptions = { ...phone.options, denyAutoApproval };
    if (refuseUnsafe) {
      toolExecutorOptions.classifyCall = refuseUnsafeClassifier(phone.options.classifyCall || null);
      Object.assign(toolExecutorOptions, gate);
    }
    return { toolExecutorOptions, attach: phone.attach, local, origin };
  }

  let requester;
  if (remoteApprovals === 'allow') requester = approvalRequester;
  else requester = local && helpers.isLocalRequester(approvalRequester) ? approvalRequester : null;
  return {
    toolExecutorOptions: { approvalRequester: requester, denyAutoApproval, localOrigin: local, origin, ...gate },
    attach: () => {},
    local,
    origin
  };
}

module.exports = { approvalSeam, phoneExecutorOptions, paramsSha256, refuseUnsafeClassifier, refuseUnsafeGate, PHONE_GRACE_MS, REFUSE_UNSAFE_MESSAGE };
