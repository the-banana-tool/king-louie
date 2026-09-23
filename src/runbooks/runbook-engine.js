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

/**
 * Checks for path traversal and dangerous Unicode lookalike characters.
 */
function isSanitisedParamValue(value) {
  if (typeof value !== 'string') return true;
  // Look for Unicode slash/backslash lookalikes or null bytes
  if (/[\u0000\u2215\u2216\uFF0F\uFF3C]/.test(value)) {
    return false;
  }
  return true;
}

/**
 * Validates parameter value against runbook schema.
 */
function validateParam(paramDef, value, allowedRoots = []) {
  if (value === undefined || value === null) {
    if (paramDef.default !== undefined) return paramDef.default;
    throw new Error(`Missing required parameter`);
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
    const num = Number(value);
    if (!Number.isInteger(num)) {
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
 */
function substituteArgv(argv, validatedParams) {
  return argv.map((arg) => {
    let result = String(arg);
    for (const [key, val] of Object.entries(validatedParams)) {
      const placeholder = `{{${key}}}`;
      if (result.includes(placeholder)) {
        result = result.replaceAll(placeholder, String(val));
      }
    }
    return result;
  });
}

class RunbookEngine {
  constructor(options = {}) {
    this.runbooksDir = options.runbooksDir;
    this.allowedRoots = options.allowedRoots || [];
    this.geteuid = options.geteuid || (() => (typeof process.geteuid === 'function' ? process.geteuid() : -1));
    this.adminUid = options.adminUid !== undefined ? options.adminUid : 0;
    this.evidenceLedger = options.evidenceLedger || new EvidenceLedger();
    this.runbooks = new Map();
    this.executionHistory = new Map(); // rate-limiting tracker
  }

  loadRunbooks() {
    this.runbooks.clear();
    if (!this.runbooksDir || !fs.existsSync(this.runbooksDir)) {
      return this.runbooks;
    }

    assertAdminOwned(this.runbooksDir, this.geteuid, this.adminUid);

    const entries = fs.readdirSync(this.runbooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        const filePath = path.join(this.runbooksDir, entry.name);
        assertAdminOwned(filePath, this.geteuid, this.adminUid);

        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = parseYaml(raw);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error(`Invalid runbook in ${filePath}: expected YAML object`);
        }

        if (!parsed.name || typeof parsed.name !== 'string') {
          throw new Error(`Invalid runbook in ${filePath}: missing "name" field`);
        }

        const tier = parsed.tier || 'unsafe';
        if (!['read', 'routine', 'unsafe'].includes(tier)) {
          throw new Error(`Invalid runbook in ${filePath}: unknown tier "${tier}"`);
        }

        this.runbooks.set(parsed.name, {
          name: parsed.name,
          description: parsed.description || '',
          tier,
          params: parsed.params || {},
          steps: Array.isArray(parsed.steps) ? parsed.steps : [],
          timeout_s: Number.isInteger(parsed.timeout_s) ? parsed.timeout_s : 300,
          rate_limit: parsed.rate_limit || null,
          filePath
        });
      }
    }
    return this.runbooks;
  }

  getRunbook(name) {
    return this.runbooks.get(name) || null;
  }

  checkRateLimit(runbookName) {
    const runbook = this.getRunbook(runbookName);
    if (!runbook || !runbook.rate_limit) return { allowed: true };

    const { max, per } = runbook.rate_limit;
    if (!max || !per) return { allowed: true };

    let windowMs = 3600 * 1000;
    if (per.endsWith('m')) windowMs = parseInt(per, 10) * 60 * 1000;
    else if (per.endsWith('h')) windowMs = parseInt(per, 10) * 3600 * 1000;
    else if (per.endsWith('s')) windowMs = parseInt(per, 10) * 1000;

    const now = Date.now();
    const history = (this.executionHistory.get(runbookName) || []).filter((t) => now - t < windowMs);
    this.executionHistory.set(runbookName, history);

    if (history.length >= max) {
      const oldest = history[0];
      const retryAfterMs = oldest + windowMs - now;
      return { allowed: false, retryAfters: Math.ceil(retryAfterMs / 1000) };
    }

    return { allowed: true };
  }

  recordExecution(runbookName) {
    const history = this.executionHistory.get(runbookName) || [];
    history.push(Date.now());
    this.executionHistory.set(runbookName, history);
  }

  validateParameters(runbookName, params = {}) {
    const runbook = this.getRunbook(runbookName);
    if (!runbook) throw new Error(`Runbook not found: ${runbookName}`);

    const validated = {};
    for (const [pName, pDef] of Object.entries(runbook.params)) {
      validated[pName] = validateParam(pDef, params[pName], this.allowedRoots);
    }
    return validated;
  }

  async executeRunbook(runbookName, rawParams = {}, options = {}) {
    const runbook = this.getRunbook(runbookName);
    if (!runbook) {
      throw new Error(`Runbook not found: ${runbookName}`);
    }

    const rateCheck = this.checkRateLimit(runbookName);
    if (!rateCheck.allowed) {
      throw new Error(`Rate limit exceeded for runbook "${runbookName}". Retry after ${rateCheck.retryAfters}s`);
    }

    const validatedParams = this.validateParameters(runbookName, rawParams);
    this.recordExecution(runbookName);

    const logs = [];
    const timeoutMs = (runbook.timeout_s || 300) * 1000;

    for (let i = 0; i < runbook.steps.length; i++) {
      const step = runbook.steps[i];

      if (step.run) {
        if (!Array.isArray(step.run) || step.run.length === 0) {
          throw new Error(`Step ${i + 1} run command must be a non-empty argv array`);
        }

        const substitutedArgv = substituteArgv(step.run, validatedParams);
        const [cmd, ...args] = substitutedArgv;

        logs.push(`Executing step ${i + 1}: ${substitutedArgv.join(' ')}`);

        const stepResult = await new Promise((resolve) => {
          let timer;
          let processExited = false;

          // Execute directly without shell (shell: false)
          const child = spawn(cmd, args, {
            shell: false,
            cwd: options.cwd || process.cwd(),
            env: { ...process.env, ...options.env }
          });

          let stdout = '';
          let stderr = '';

          if (timeoutMs > 0) {
            timer = setTimeout(() => {
              if (!processExited) {
                child.kill('SIGTERM');
                resolve({ success: false, error: `Step ${i + 1} timed out after ${runbook.timeout_s}s` });
              }
            }, timeoutMs);
          }

          child.stdout?.on('data', (d) => { stdout += d.toString(); });
          child.stderr?.on('data', (d) => { stderr += d.toString(); });

          child.on('error', (err) => {
            processExited = true;
            if (timer) clearTimeout(timer);
            resolve({ success: false, error: err.message, stdout, stderr });
          });

          child.on('close', (code) => {
            processExited = true;
            if (timer) clearTimeout(timer);
            if (code === 0) {
              resolve({ success: true, code, stdout, stderr });
            } else {
              resolve({ success: false, error: `Step ${i + 1} exited with status ${code}`, code, stdout, stderr });
            }
          });
        });

        if (stepResult.stdout) logs.push(stepResult.stdout.trim());
        if (stepResult.stderr) logs.push(stepResult.stderr.trim());

        if (!stepResult.success) {
          return { success: false, error: stepResult.error, logs, stepIndex: i };
        }
      } else if (step.check) {
        logs.push(`Running check step ${i + 1}...`);
        const checkResult = await this.executeCheckStep(step.check);
        logs.push(`Check step ${i + 1} result: ${checkResult.success ? 'PASSED' : 'FAILED'}`);

        this.evidenceLedger.record(options.cwd || process.cwd(), {
          tool: `runbook:${runbookName}`,
          command: JSON.stringify(step.check),
          status: checkResult.success ? 'passed' : 'failed',
          provesBehavior: true,
          scope: 'targeted'
        });

        if (!checkResult.success) {
          return { success: false, error: `Check step ${i + 1} failed`, logs, stepIndex: i };
        }
      }
    }

    return { success: true, logs };
  }

  async executeCheckStep(checkDef) {
    if (checkDef.http_get) {
      const url = checkDef.http_get;
      const expectStatus = checkDef.expect_status || 200;
      const retries = checkDef.retries || 1;

      for (let attempt = 1; attempt <= retries; attempt++) {
        const ok = await new Promise((resolve) => {
          const client = url.startsWith('https') ? https : http;
          const req = client.get(url, (res) => {
            resolve(res.statusCode === expectStatus);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(5000, () => {
            req.destroy();
            resolve(false);
          });
        });

        if (ok) return { success: true };
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      return { success: false, reason: `HTTP GET ${url} did not return ${expectStatus}` };
    }
    return { success: true };
  }
}

/**
 * In-memory Job Manager for runbook and delegation jobs.
 */
class JobManager {
  // maxConcurrentJobs is node policy (node.yaml policy.max_concurrent_jobs).
  // Jobs awaiting approval run nothing, so only queued and running ones count.
  constructor({ maxConcurrentJobs = Infinity } = {}) {
    this.jobs = new Map();
    this.maxConcurrentJobs = maxConcurrentJobs;
  }

  activeJobCount() {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') n += 1;
    }
    return n;
  }

  createJob({ machine, runbook, params = {}, tier = 'routine' }) {
    if (tier !== 'unsafe' && this.activeJobCount() >= this.maxConcurrentJobs) {
      throw new Error(`max_concurrent_jobs: this node already has ${this.maxConcurrentJobs} job(s) running; try again when one finishes`);
    }
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      job_id: jobId,
      machine,
      runbook,
      params,
      tier,
      status: tier === 'unsafe' ? 'awaiting_approval' : 'queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      logs: [],
      result: null
    };
    this.jobs.set(jobId, job);
    return job;
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  updateJob(jobId, updates = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    Object.assign(job, updates, { updated_at: new Date().toISOString() });
    return job;
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (['succeeded', 'failed', 'cancelled', 'denied'].includes(job.status)) return false;
    this.updateJob(jobId, { status: 'cancelled' });
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
