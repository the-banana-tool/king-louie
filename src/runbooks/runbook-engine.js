const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { parseYaml } = require('../platform/yaml');
const { assertAdminOwned } = require('../service/node-config');
const { isPathUnderRoots, realResolve } = require('../platform/path-roots');
const { EvidenceLedger } = require('../verification/evidence-ledger');
const { createLogger } = require('../logging');

const log = createLogger('runbook-engine');

const PARAM_TYPES = ['string', 'integer', 'enum', 'boolean', 'path'];
const TIERS = ['read', 'routine', 'unsafe'];
// Check kinds the engine knows how to run. A check whose kind isn't listed
// here must never count as passed evidence, so it is refused at load and
// fails at run time.
const CHECK_KINDS = ['http_get'];
const CHECK_MODIFIERS = ['expect_status', 'retries'];
const RATE_PERIOD = /^(\d+)(s|m|h|d)$/;
const RATE_UNIT_MS = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 };
// Matches every {{name}} placeholder; the name is looked up exactly as
// written, so `{{ ref }}` is a different (undeclared) name from `{{ref}}`.
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

const DEFAULT_TIMEOUT_S = 300;
// How long a step gets to exit after SIGTERM before it is sent SIGKILL.
const DEFAULT_KILL_GRACE_MS = 5000;
// Per stream, per step. A chatty step keeps running; only what we hold is capped.
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Errors callers act on (the MCP server maps `code` onto its own error
 * responses), so the code is part of the contract, not decoration.
 */
function codedError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Checks for path traversal and dangerous Unicode lookalike characters.
 */
function isSanitisedParamValue(value) {
  if (typeof value !== 'string') return true;
  // Look for Unicode slash/backslash lookalikes or null bytes
  if (/[\u0000∕∖／＼]/.test(value)) {
    return false;
  }
  return true;
}

/**
 * Validates parameter value against runbook schema.
 */
function validateParam(paramDef, value, allowedRoots = []) {
  if (value === undefined || value === null) {
    if (paramDef.default === undefined) throw new Error(`Missing required parameter`);
    // The default goes through the same checks as a supplied value, so it
    // comes back in the same normalised form (a number, a realpath).
    value = paramDef.default;
  }

  if (!isSanitisedParamValue(value)) {
    throw new Error(`Parameter value contains invalid or lookalike characters`);
  }

  const type = paramDef.type || 'string';

  if (type === 'string') {
    const valStr = String(value);
    if (!paramDef.pattern) {
      throw new Error(`String parameter schema missing required "pattern" regex rule`);
    }
    const regex = new RegExp(paramDef.pattern);
    if (!regex.test(valStr)) {
      throw new Error(`Parameter value "${valStr}" does not match required pattern "${paramDef.pattern}"`);
    }
    if (valStr.includes('..')) {
      throw new Error(`Parameter value "${valStr}" contains invalid relative path traversal ".."`);
    }
    return valStr;
  }

  if (type === 'integer') {
    // Number() is far too forgiving here: '' is 0, true is 1, '0x10' is 16
    // and '1e3' is 1000. Only a real integer or plain decimal digits count.
    let num;
    if (typeof value === 'number') num = value;
    else if (typeof value === 'string' && /^-?\d+$/.test(value)) num = Number(value);
    if (!Number.isSafeInteger(num)) {
      throw new Error(`Parameter value "${value}" is not an integer`);
    }
    if (paramDef.min !== undefined && num < paramDef.min) {
      throw new Error(`Parameter value ${num} is below minimum ${paramDef.min}`);
    }
    if (paramDef.max !== undefined && num > paramDef.max) {
      throw new Error(`Parameter value ${num} exceeds maximum ${paramDef.max}`);
    }
    return num;
  }

  if (type === 'enum') {
    const values = paramDef.values || paramDef.options || [];
    if (!values.includes(value)) {
      throw new Error(`Parameter value "${value}" is not one of allowed enum values: ${values.join(', ')}`);
    }
    return value;
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new Error(`Parameter value "${value}" is not a valid boolean`);
  }

  if (type === 'path') {
    const valPath = String(value);
    if (valPath.includes('..')) {
      throw new Error(`Path parameter contains illegal relative parent traversal ".."`);
    }
    if (!isPathUnderRoots(valPath, allowedRoots)) {
      throw new Error(`Path parameter "${valPath}" is not under configured allowed_roots`);
    }
    return realResolve(valPath);
  }

  throw new Error(`Unknown parameter type "${type}"`);
}

/**
 * Replaces {{param}} template placeholders inside single argv element.
 *
 * One pass over the original text: a substituted value is never scanned
 * again, so a value that itself contains `{{other}}` stays literal instead of
 * pulling in another parameter. A placeholder with no matching parameter is
 * left as written (load-time validation makes that impossible for a real
 * runbook).
 */
function substituteArgv(argv, validatedParams) {
  return argv.map((arg) => String(arg).replace(PLACEHOLDER, (whole, name) => (
    Object.prototype.hasOwnProperty.call(validatedParams, name) ? String(validatedParams[name]) : whole
  )));
}

function parseRatePeriodMs(per) {
  const match = typeof per === 'string' ? RATE_PERIOD.exec(per) : null;
  if (!match || Number(match[1]) <= 0) return null;
  return Number(match[1]) * RATE_UNIT_MS[match[2]];
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function checkKindsOf(checkDef) {
  return Object.keys(checkDef).filter((key) => !CHECK_MODIFIERS.includes(key));
}

function validateParamDefs(params, allowedRoots) {
  if (params === undefined || params === null) return {};
  if (!isPlainObject(params)) throw new Error(`"params" must be a mapping of parameter name to definition`);

  for (const [pName, pDef] of Object.entries(params)) {
    const where = `param "${pName}"`;
    if (!isPlainObject(pDef)) throw new Error(`${where} must be a mapping`);
    if (!PARAM_TYPES.includes(pDef.type)) {
      throw new Error(`${where} has type "${pDef.type}"; it must be one of ${PARAM_TYPES.join(', ')}`);
    }
    if (pDef.type === 'string') {
      if (typeof pDef.pattern !== 'string' || pDef.pattern === '') {
        throw new Error(`${where} is a string, so it needs a "pattern" regex`);
      }
      try {
        new RegExp(pDef.pattern);
      } catch (err) {
        throw new Error(`${where} has a pattern that is not a valid regex: ${err.message}`);
      }
    }
    if (pDef.type === 'integer') {
      if (typeof pDef.min !== 'number' || typeof pDef.max !== 'number' || !Number.isFinite(pDef.min) || !Number.isFinite(pDef.max)) {
        throw new Error(`${where} is an integer, so it needs numeric "min" and "max"`);
      }
      if (pDef.min > pDef.max) throw new Error(`${where} has min ${pDef.min} greater than max ${pDef.max}`);
    }
    if (pDef.type === 'enum') {
      if (!Array.isArray(pDef.values) || pDef.values.length === 0) {
        throw new Error(`${where} is an enum, so it needs a non-empty "values" list`);
      }
      if (!pDef.values.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
        throw new Error(`${where} has enum values that are not plain strings, numbers or booleans`);
      }
    }
    if (pDef.default !== undefined) {
      try {
        validateParam(pDef, pDef.default, allowedRoots);
      } catch (err) {
        throw new Error(`${where} has a default that fails its own validation: ${err.message}`);
      }
    }
  }
  return params;
}

function validateRunStep(run, where, params) {
  if (!Array.isArray(run) || run.length === 0) {
    throw new Error(`${where} "run" must be a non-empty argv list`);
  }
  run.forEach((arg, j) => {
    if (typeof arg !== 'string') {
      // YAML reads an unquoted 1.10 as 1.1 and 0755 as 755, so a non-string
      // in argv is never reliably what the admin wrote.
      throw new Error(`${where} argv[${j}] is ${JSON.stringify(arg)} (a ${arg === null ? 'null' : typeof arg}), not a string; quote it in the YAML, e.g. '${arg}'`);
    }
    for (const match of arg.matchAll(PLACEHOLDER)) {
      if (!Object.prototype.hasOwnProperty.call(params, match[1])) {
        throw new Error(`${where} argv[${j}] uses {{${match[1]}}}, which is not a declared param`);
      }
    }
  });
  if (run[0] === '') throw new Error(`${where} has an empty command (argv[0])`);
}

function validateCheckStep(check, where) {
  if (!isPlainObject(check)) throw new Error(`${where} "check" must be a mapping`);
  const kinds = checkKindsOf(check);
  const unknown = kinds.filter((k) => !CHECK_KINDS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${where} has unknown check kind "${unknown[0]}"; known kinds: ${CHECK_KINDS.join(', ')}`);
  }
  if (kinds.length !== 1) {
    throw new Error(`${where} check must name exactly one kind (${CHECK_KINDS.join(', ')})`);
  }
  if (kinds[0] === 'http_get' && !isHttpUrl(check.http_get)) {
    throw new Error(`${where} http_get must be an http:// or https:// URL`);
  }
  if (check.expect_status !== undefined && !Number.isInteger(check.expect_status)) {
    throw new Error(`${where} expect_status must be an integer`);
  }
  if (check.retries !== undefined && !isPositiveInteger(check.retries)) {
    throw new Error(`${where} retries must be a positive integer`);
  }
}

function validateSteps(steps, params) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`"steps" must be a non-empty list`);
  }
  steps.forEach((step, i) => {
    const where = `step ${i + 1}`;
    if (!isPlainObject(step)) throw new Error(`${where} must be a mapping with "run" or "check"`);
    const hasRun = step.run !== undefined;
    const hasCheck = step.check !== undefined;
    if (hasRun === hasCheck) throw new Error(`${where} must have exactly one of "run" or "check"`);
    if (hasRun) validateRunStep(step.run, where, params);
    else validateCheckStep(step.check, where);
  });
  return steps;
}

/**
 * Checks a parsed runbook file against the §5.4 schema and returns the
 * normalised runbook. Everything is checked here, at load, so a bad file is
 * refused up front instead of failing (or quietly misbehaving) mid-run.
 */
function validateRunbookDefinition(parsed, allowedRoots) {
  if (!isPlainObject(parsed)) throw new Error(`expected YAML object`);
  if (!parsed.name || typeof parsed.name !== 'string') throw new Error(`missing "name" field`);

  const tier = parsed.tier || 'unsafe';
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);

  const params = validateParamDefs(parsed.params, allowedRoots);
  const steps = validateSteps(parsed.steps, params);

  if (parsed.timeout_s !== undefined && !isPositiveInteger(parsed.timeout_s)) {
    throw new Error(`timeout_s must be a positive integer number of seconds`);
  }

  let rateLimit = null;
  if (parsed.rate_limit !== undefined && parsed.rate_limit !== null) {
    const rl = parsed.rate_limit;
    if (!isPlainObject(rl)) throw new Error(`rate_limit must be a mapping with "max" and "per"`);
    if (!isPositiveInteger(rl.max)) throw new Error(`rate_limit.max must be a positive integer`);
    if (parseRatePeriodMs(rl.per) === null) {
      throw new Error(`rate_limit.per is ${JSON.stringify(rl.per)}; it must be a count and unit such as 30s, 10m, 1h or 1d`);
    }
    rateLimit = { max: rl.max, per: rl.per };
  }

  return {
    name: parsed.name,
    description: parsed.description || '',
    tier,
    params,
    steps,
    timeout_s: parsed.timeout_s !== undefined ? parsed.timeout_s : DEFAULT_TIMEOUT_S,
    rate_limit: rateLimit
  };
}

/**
 * Keeps at most `limit` bytes of a stream. The rest is read and dropped, so
 * the child never blocks on a full pipe.
 */
function createCapture(limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(data) {
      if (size >= limit) {
        truncated = true;
        return;
      }
      const room = limit - size;
      if (data.length > room) {
        chunks.push(data.subarray(0, room));
        size = limit;
        truncated = true;
      } else {
        chunks.push(data);
        size += data.length;
      }
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => truncated
  };
}

/**
 * Runs one argv step without a shell. On timeout or abort the child gets
 * SIGTERM, then SIGKILL after `killGraceMs`, and the promise settles only
 * once it has exited, so a stopped step can't live on behind a finished run.
 */
function runArgvStep(argv, { cwd, env, timeoutMs, timeoutLabel, signal, killGraceMs, maxOutputBytes }) {
  const [cmd, ...args] = argv;
  return new Promise((resolve) => {
    const stdout = createCapture(maxOutputBytes);
    const stderr = createCapture(maxOutputBytes);
    let settled = false;
    let stopReason = null;
    let exited = false;
    const timers = [];

    let child;
    const onAbort = () => stop('cancelled');

    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (stopReason && child) {
        // A grandchild can hold the pipes open after the step itself is gone.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({
        ...result,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated()
      });
    };

    const stoppedResult = () => (stopReason === 'cancelled'
      ? { success: false, cancelled: true, error: 'cancelled' }
      : { success: false, error: timeoutLabel });

    function stop(reason) {
      if (settled || stopReason) return;
      stopReason = reason;
      if (exited) {
        finish(stoppedResult());
        return;
      }
      child.kill('SIGTERM');
      timers.push(setTimeout(() => {
        if (exited) return;
        log.warn('runbook step ignored SIGTERM; sending SIGKILL', { pid: child.pid, cmd });
        child.kill('SIGKILL');
        timers.push(setTimeout(() => {
          log.error('runbook step still running after SIGKILL; giving up waiting', { pid: child.pid, cmd });
          finish(stoppedResult());
        }, killGraceMs));
      }, killGraceMs));
    }

    try {
      child = spawn(cmd, args, { shell: false, cwd, env, windowsHide: true });
    } catch (err) {
      finish({ success: false, error: err.message });
      return;
    }

    child.stdout?.on('data', (d) => stdout.push(d));
    child.stderr?.on('data', (d) => stderr.push(d));

    child.on('error', (err) => {
      if (stopReason) {
        log.warn('error while stopping runbook step', { cmd, error: err.message });
        return;
      }
      finish({ success: false, error: err.message });
    });

    // Once stopping, the step's own exit is what matters; 'close' could wait
    // on a grandchild that inherited the pipes.
    child.on('exit', () => {
      exited = true;
      if (stopReason) finish(stoppedResult());
    });

    child.on('close', (code) => {
      exited = true;
      if (stopReason) {
        finish(stoppedResult());
      } else if (code === 0) {
        finish({ success: true, code });
      } else {
        finish({ success: false, error: `exited with status ${code}`, code });
      }
    });

    if (timeoutMs > 0) timers.push(setTimeout(() => stop('timeout'), timeoutMs));
    if (signal) {
      if (signal.aborted) stop('cancelled');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

class RunbookEngine {
  constructor(options = {}) {
    this.runbooksDir = options.runbooksDir;
    this.allowedRoots = options.allowedRoots || [];
    this.geteuid = options.geteuid || (() => (typeof process.geteuid === 'function' ? process.geteuid() : -1));
    this.adminUid = options.adminUid !== undefined ? options.adminUid : 0;
    this.evidenceLedger = options.evidenceLedger || new EvidenceLedger();
    this.killGraceMs = options.killGraceMs !== undefined ? options.killGraceMs : DEFAULT_KILL_GRACE_MS;
    this.maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
    this.runbooks = new Map();
    this.executionHistory = new Map(); // rate-limiting tracker
  }

  loadRunbooks() {
    this.runbooks.clear();
    if (!this.runbooksDir || !fs.existsSync(this.runbooksDir)) {
      return this.runbooks;
    }

    assertAdminOwned(this.runbooksDir, this.geteuid, this.adminUid);

    // Load into a fresh map and swap it in only when every file is good, so
    // a bad file can't leave a half-loaded set behind.
    const loaded = new Map();
    const entries = fs.readdirSync(this.runbooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        const filePath = path.join(this.runbooksDir, entry.name);
        assertAdminOwned(filePath, this.geteuid, this.adminUid);

        let runbook;
        try {
          runbook = validateRunbookDefinition(parseYaml(fs.readFileSync(filePath, 'utf8')), this.allowedRoots);
        } catch (err) {
          throw new Error(`Invalid runbook in ${filePath}: ${err.message}`);
        }
        const clash = loaded.get(runbook.name);
        if (clash) {
          throw new Error(`Invalid runbook in ${filePath}: name "${runbook.name}" is already used by ${clash.filePath}`);
        }
        loaded.set(runbook.name, { ...runbook, filePath });
      }
    }
    for (const [name, runbook] of loaded) this.runbooks.set(name, runbook);
    return this.runbooks;
  }

  getRunbook(name) {
    return this.runbooks.get(name) || null;
  }

  checkRateLimit(runbookName) {
    const runbook = this.getRunbook(runbookName);
    if (!runbook || !runbook.rate_limit) return { allowed: true };

    const { max, per } = runbook.rate_limit;
    const windowMs = parseRatePeriodMs(per);
    // Loaded runbooks can't get here with a bad limit; one set up any other
    // way is refused rather than guessed at.
    if (!isPositiveInteger(max) || windowMs === null) {
      throw new Error(`Runbook "${runbookName}" has an invalid rate_limit`);
    }

    const now = Date.now();
    const history = (this.executionHistory.get(runbookName) || []).filter((t) => now - t < windowMs);
    this.executionHistory.set(runbookName, history);

    if (history.length >= max) {
      const oldest = history[0];
      const retryAfterMs = oldest + windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    return { allowed: true };
  }

  // Returns the timestamp it recorded, so a caller that reserved a run and
  // then never started it can hand that one entry back.
  recordExecution(runbookName) {
    const history = this.executionHistory.get(runbookName) || [];
    const stamp = Date.now();
    history.push(stamp);
    this.executionHistory.set(runbookName, history);
    return stamp;
  }

  // Undoes one recordExecution for a run that never started, such as a job
  // cancelled while still queued: it ran nothing, so it should not use up the
  // limit. An entry already aged out of the window is simply not there.
  releaseExecution(runbookName, stamp) {
    const history = this.executionHistory.get(runbookName);
    if (!history) return false;
    const i = history.indexOf(stamp);
    if (i === -1) return false;
    history.splice(i, 1);
    return true;
  }

  validateParameters(runbookName, params = {}) {
    const runbook = this.getRunbook(runbookName);
    if (!runbook) throw codedError('runbook_not_found', `Runbook not found: ${runbookName}`);
    if (params === null || params === undefined) params = {};
    if (!isPlainObject(params)) throw codedError('invalid_params', `Parameters must be an object of name to value`);

    const validated = {};
    for (const [pName, pDef] of Object.entries(runbook.params || {})) {
      try {
        validated[pName] = validateParam(pDef, params[pName], this.allowedRoots);
      } catch (err) {
        throw codedError('invalid_params', `Parameter "${pName}": ${err.message}`);
      }
    }
    return validated;
  }

  // `options.admitted` means the caller already checked the rate limit and
  // recorded this run when it accepted the request (the MCP server does, so
  // two requests arriving together cannot both pass a check that neither has
  // recorded yet). Checking again here would count the run twice.
  async executeRunbook(runbookName, rawParams = {}, options = {}) {
    const runbook = this.getRunbook(runbookName);
    if (!runbook) {
      throw codedError('runbook_not_found', `Runbook not found: ${runbookName}`);
    }

    const admitted = options.admitted === true;
    const rateCheck = admitted ? { allowed: true } : this.checkRateLimit(runbookName);
    if (!rateCheck.allowed) {
      throw codedError(
        'rate_limited',
        `Rate limit exceeded for runbook "${runbookName}". Retry after ${rateCheck.retryAfterSeconds}s`,
        { retryAfterSeconds: rateCheck.retryAfterSeconds }
      );
    }

    const validatedParams = this.validateParameters(runbookName, rawParams);
    if (!Array.isArray(runbook.steps) || runbook.steps.length === 0) {
      throw new Error(`Runbook "${runbookName}" has no steps`);
    }

    const { signal } = options;
    const logs = [];
    const cancelled = () => ({ success: false, error: 'cancelled', logs });
    if (signal?.aborted) return cancelled();

    if (!admitted) this.recordExecution(runbookName);

    const timeoutS = runbook.timeout_s || DEFAULT_TIMEOUT_S;
    const cwd = options.cwd || process.cwd();

    for (let i = 0; i < runbook.steps.length; i++) {
      if (signal?.aborted) return cancelled();
      const step = runbook.steps[i];

      if (step.run) {
        if (!Array.isArray(step.run) || step.run.length === 0) {
          throw new Error(`Step ${i + 1} run command must be a non-empty argv array`);
        }

        const substitutedArgv = substituteArgv(step.run, validatedParams);
        logs.push(`Executing step ${i + 1}: ${substitutedArgv.join(' ')}`);

        const stepResult = await runArgvStep(substitutedArgv, {
          cwd,
          env: { ...process.env, ...options.env },
          timeoutMs: timeoutS * 1000,
          timeoutLabel: `Step ${i + 1} timed out after ${timeoutS}s`,
          signal,
          killGraceMs: this.killGraceMs,
          maxOutputBytes: this.maxOutputBytes
        });

        if (stepResult.stdout) logs.push(stepResult.stdout.trim());
        if (stepResult.stdoutTruncated) logs.push(`[step ${i + 1} stdout truncated after ${this.maxOutputBytes} bytes]`);
        if (stepResult.stderr) logs.push(stepResult.stderr.trim());
        if (stepResult.stderrTruncated) logs.push(`[step ${i + 1} stderr truncated after ${this.maxOutputBytes} bytes]`);

        if (stepResult.cancelled) return cancelled();
        if (!stepResult.success) {
          const error = stepResult.code !== undefined ? `Step ${i + 1} ${stepResult.error}` : stepResult.error;
          return { success: false, error, logs, stepIndex: i };
        }
      } else if (step.check) {
        logs.push(`Running check step ${i + 1}...`);
        const checkResult = await this.executeCheckStep(step.check, { signal });
        // A check cut short by cancel proved nothing either way, so it
        // leaves no evidence.
        if (signal?.aborted) return cancelled();
        logs.push(`Check step ${i + 1} result: ${checkResult.success ? 'PASSED' : 'FAILED'}`);
        if (!checkResult.success && checkResult.reason) logs.push(checkResult.reason);

        this.evidenceLedger.record(cwd, {
          tool: `runbook:${runbookName}`,
          command: JSON.stringify(step.check),
          status: checkResult.success ? 'passed' : 'failed',
          provesBehavior: true,
          scope: 'targeted'
        });

        if (!checkResult.success) {
          return { success: false, error: `Check step ${i + 1} failed`, logs, stepIndex: i };
        }
      } else {
        // Load-time validation rules this out; a runbook that got here some
        // other way must not have a step silently skipped.
        throw new Error(`Step ${i + 1} of runbook "${runbookName}" has neither "run" nor "check"`);
      }
    }

    return { success: true, logs };
  }

  async executeCheckStep(checkDef, { signal } = {}) {
    const kinds = isPlainObject(checkDef) ? checkKindsOf(checkDef) : [];
    if (kinds.length !== 1 || !CHECK_KINDS.includes(kinds[0])) {
      // Passing an unrecognised check would record evidence for something
      // that was never checked.
      return { success: false, reason: `Unknown check kind: ${kinds.join(', ') || '(none)'}` };
    }

    const url = checkDef.http_get;
    if (!isHttpUrl(url)) {
      return { success: false, reason: `http_get URL must be http:// or https://: ${url}` };
    }
    const expectStatus = checkDef.expect_status !== undefined ? checkDef.expect_status : 200;
    const retries = checkDef.retries !== undefined ? checkDef.retries : 1;

    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal?.aborted) return { success: false, reason: 'cancelled' };
      const ok = await new Promise((resolve) => {
        const client = new URL(url).protocol === 'https:' ? https : http;
        const req = client.get(url, signal ? { signal } : {}, (res) => {
          // Only the status matters; drain the body so the socket is freed.
          res.resume();
          resolve(res.statusCode === expectStatus);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(5000, () => {
          req.destroy();
          resolve(false);
        });
      });

      if (ok) return { success: true };
      if (attempt < retries && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return { success: false, reason: `HTTP GET ${url} did not return ${expectStatus}` };
  }
}

// Statuses a job can be created in, and statuses it never leaves (§8.2).
const INITIAL_JOB_STATUSES = ['queued', 'awaiting_approval', 'denied'];
const TERMINAL_JOB_STATUSES = ['succeeded', 'failed', 'cancelled', 'denied', 'expired'];

/**
 * In-memory Job Manager for runbook and delegation jobs.
 */
class JobManager {
  // maxConcurrentJobs is node policy (node.yaml policy.max_concurrent_jobs).
  // Jobs awaiting approval run nothing, so only queued and running ones count.
  constructor({ maxConcurrentJobs = Infinity } = {}) {
    this.jobs = new Map();
    // Kept apart from the job records, which are handed back to clients.
    this.controllers = new Map();
    // Jobs whose execution has started and not yet settled. A cancelled job
    // shows "cancelled" at once, but its process may take a kill grace
    // period or two to exit, and until it does it still occupies the slot.
    this.executing = new Set();
    this.maxConcurrentJobs = maxConcurrentJobs;
  }

  activeJobCount() {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running' || this.executing.has(job.job_id)) n += 1;
    }
    return n;
  }

  // Called by whatever runs the job, around the execution itself: from just
  // before the work starts until it has fully settled.
  markExecuting(jobId) {
    if (this.jobs.has(jobId)) this.executing.add(jobId);
  }

  markSettled(jobId) {
    this.executing.delete(jobId);
  }

  isExecuting(jobId) {
    return this.executing.has(jobId);
  }

  // `status` lets a caller record a job that will never run, such as one
  // denied by policy, so it still shows up in get_job with its reason. Only a
  // queued job will run, so only a queued job takes a slot and gets an
  // AbortController.
  createJob({ machine, runbook, params = {}, tier = 'routine', status, reason = null }) {
    const initialStatus = status || (tier === 'unsafe' ? 'awaiting_approval' : 'queued');
    if (!INITIAL_JOB_STATUSES.includes(initialStatus)) {
      throw new Error(`A job cannot start in status "${initialStatus}"`);
    }
    if (initialStatus === 'queued' && this.activeJobCount() >= this.maxConcurrentJobs) {
      const err = new Error(`max_concurrent_jobs: this node already has ${this.maxConcurrentJobs} job(s) running; try again when one finishes`);
      err.code = 'max_concurrent_jobs';
      throw err;
    }
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const job = {
      job_id: jobId,
      machine,
      runbook,
      params,
      tier,
      status: initialStatus,
      reason,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: TERMINAL_JOB_STATUSES.includes(initialStatus) ? now : null,
      logs: [],
      result: null
    };
    this.jobs.set(jobId, job);
    if (initialStatus === 'queued') this.controllers.set(jobId, new AbortController());
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  // The signal a job's execution should watch; aborted by cancelJob.
  getSignal(jobId) {
    return this.controllers.get(jobId)?.signal || null;
  }

  // Timing follows the status, so no caller can forget to stamp it: the
  // first move to running sets started_at, and the first terminal status sets
  // finished_at. A terminal job's controller is no longer needed.
  updateJob(jobId, updates = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    Object.assign(job, updates, { updated_at: now });
    if (job.status === 'running' && !job.started_at) job.started_at = now;
    if (TERMINAL_JOB_STATUSES.includes(job.status)) {
      if (!job.finished_at) job.finished_at = now;
      this.controllers.delete(jobId);
    }
    return job;
  }

  isTerminal(jobId) {
    const job = this.jobs.get(jobId);
    return !!job && TERMINAL_JOB_STATUSES.includes(job.status);
  }

  // Best effort: the job is marked cancelled at once and its signal aborted;
  // whatever is running stops when the executor notices the abort. Its slot
  // stays taken until the executor calls markSettled.
  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return false;
    const controller = this.controllers.get(jobId);
    this.updateJob(jobId, { status: 'cancelled' });
    if (controller) controller.abort();
    return true;
  }
}

module.exports = {
  RunbookEngine,
  JobManager,
  validateParam,
  substituteArgv,
  isSanitisedParamValue
};
