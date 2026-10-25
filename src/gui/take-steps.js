'use strict';

// Take.run_steps' runner (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md
// §10): an ordered list of browser steps run with no model between them. Every step that drives
// the browser is first put to the take's policy as the browser call it makes, exactly as
// ToolExecutor puts a model's own call (`decide('Browser', { action, ...params })`), so a step is
// held to the same rules (§7.2) and a refusal carries the same code. Then the step runs through
// the browser tool's own action, with the context the Take call came with (the holder's
// `browserKey` resolves the take's browser). No model, no shell, no evaluate.

const fs = require('fs');
const path = require('path');
const { plainLineProblem } = require('../cases/hidden-chars');

const MAX_STEPS = 200;
const MAX_BYTES = 64 * 1024;
const WAIT_DEFAULT_MS = 30000;
const WAIT_MAX_MS = 120000;
const PAUSE_MAX_MS = 10000;
const PAUSE_TOTAL_MS = 60000;
const NOTE_MAX = 500;
const SELECTOR_MAX = 1024;
const URL_MAX = 2048;
const TEXT_MAX = 8192;
const SCROLL_MAX = 100000;
// What a step may take beyond its own bound before it is that step's failure, not a hang: the
// browser tool clamps an action at 15 s and navigates within 30 s.
const GUARD_GRACE_MS = 5000;
const ACT_GUARD_MS = 20000;
const NAVIGATE_GUARD_MS = 35000;
// `type` presses one key every 50 ms.
const TYPE_MS_PER_CHAR = 60;
const URL_READ_MS = 5000;
const ERROR_MAX = 300;
const WAIT_STATES = Object.freeze(['attached', 'detached', 'visible', 'hidden']);
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => Array.from(s).length;

// A field's check: null when it holds, else what it must be (the field name is the table's own).
const str = (min, max) => (v) => (typeof v === 'string' && chars(v) >= min && chars(v) <= max ? null : `must be a string of ${min}–${max} characters`);
const int = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number from ${min} to ${max}`);
const oneOf = (list) => (v) => (list.includes(v) ? null : `must be one of ${list.join(', ')}`);
const plain = (max) => (v) => (typeof v === 'string' && v.length > 0 && chars(v) <= max && plainLineProblem(v) === null ? null : `must be one plain line of 1–${max} characters`);
const name = (v) => (typeof v === 'string' && NAME_RE.test(v) ? null : 'must be 1–64 characters of A-Z, a-z, 0-9, _ and -');

const SELECTOR = str(1, SELECTOR_MAX);
const TIMEOUT = int(1, WAIT_MAX_MS);
const req = (check) => ({ check, required: true });
const opt = (check) => ({ check, required: false });
const ON_SELECTOR = { selector: req(SELECTOR) };

// §10's table: every step and exactly its fields.
const STEPS = Object.freeze({
  navigate: { url: req(str(1, URL_MAX)) },
  click: ON_SELECTOR,
  dblclick: ON_SELECTOR,
  hover: ON_SELECTOR,
  focus: ON_SELECTOR,
  check: ON_SELECTOR,
  uncheck: ON_SELECTOR,
  clear: ON_SELECTOR,
  fill: { selector: req(SELECTOR), text: req(str(0, TEXT_MAX)) },
  type: { selector: req(SELECTOR), text: req(str(1, TEXT_MAX)) },
  press: { key: req(str(1, 64)), selector: opt(SELECTOR) },
  select_option: { selector: req(SELECTOR), value: req(str(1, SELECTOR_MAX)) },
  scroll: { selector: opt(SELECTOR), dx: req(int(-SCROLL_MAX, SCROLL_MAX)), dy: req(int(-SCROLL_MAX, SCROLL_MAX)) },
  wait_for: { selector: req(SELECTOR), state: opt(oneOf(WAIT_STATES)), timeout_ms: opt(TIMEOUT) },
  wait_for_url: { url: req(str(1, URL_MAX)), timeout_ms: opt(TIMEOUT) },
  wait_for_text: { selector: req(SELECTOR), text: req(str(1, SELECTOR_MAX)), timeout_ms: opt(TIMEOUT) },
  pause: { ms: req(int(1, PAUSE_MAX_MS)) },
  screenshot: { name: opt(name) },
  note: { text: req(plain(NOTE_MAX)) }
});
const STEP_KINDS = Object.freeze(Object.keys(STEPS));

const refused = (message) => ({ ok: false, error: { code: 'invalid_params', message } });

// → { ok: true, steps } | { ok: false, error: { code: 'invalid_params', message } }. The message
// is one plain line naming the index and the problem; it repeats only names from the table.
function validateSteps(steps, { from = 0 } = {}) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) return refused(`"steps" must be a list of 1–${MAX_STEPS} steps`);
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(steps), 'utf8');
  } catch {
    return refused('"steps" must be plain JSON');
  }
  if (bytes > MAX_BYTES) return refused('"steps" must be at most 64 KiB of JSON');
  let pauses = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!isPlainObject(s)) return refused(`step ${i}: must be an object with a "step"`);
    if (typeof s.step !== 'string' || !Object.hasOwn(STEPS, s.step)) return refused(`step ${i}: "step" must be one of ${STEP_KINDS.join(', ')}`);
    const fields = STEPS[s.step];
    for (const key of Object.keys(s)) {
      if (key !== 'step' && !Object.hasOwn(fields, key)) return refused(`step ${i} (${s.step}) has a field this step does not take`);
    }
    for (const [key, { check, required }] of Object.entries(fields)) {
      if (s[key] === undefined) {
        if (required) return refused(`step ${i} (${s.step}): "${key}" is required`);
        continue;
      }
      const problem = check(s[key]);
      if (problem) return refused(`step ${i} (${s.step}): "${key}" ${problem}`);
    }
    if (s.step === 'pause') pauses += s.ms;
  }
  // §10: a script cannot be a sleep.
  if (pauses > PAUSE_TOTAL_MS) return refused(`the pauses add up to more than ${PAUSE_TOTAL_MS / 1000} s`);
  if (!Number.isInteger(from) || from < 0 || from >= steps.length) return refused(`"from" must be an index in the list (0–${steps.length - 1})`);
  return { ok: true, steps };
}

class StepError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// One line of an error, for the result: Playwright's errors carry a call log after the first.
function errorOf(err) {
  const code = err && typeof err.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(err.code) ? err.code : 'step_failed';
  const raw = err && err.message ? String(err.message) : String(err);
  const line = raw.split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const message = chars(line) > ERROR_MAX ? `${Array.from(line).slice(0, ERROR_MAX - 1).join('')}…` : line;
  return { code, message: message || code };
}

// The browser call a step makes: { action, params } for browserTool.actions and the policy.
function browserCall(s) {
  switch (s.step) {
    case 'navigate': return { action: 'navigate', params: { url: s.url } };
    case 'fill':
    case 'type': return { action: s.step, params: { selector: s.selector, text: s.text } };
    case 'press': return { action: 'press', params: s.selector === undefined ? { key: s.key } : { key: s.key, selector: s.selector } };
    case 'select_option': return { action: 'select_option', params: { selector: s.selector, value: s.value } };
    case 'scroll': return { action: 'scroll', params: { ...(s.selector === undefined ? {} : { selector: s.selector }), delta_x: s.dx, delta_y: s.dy } };
    case 'wait_for': return { action: 'wait_for', params: { selector: s.selector, state: s.state || 'visible', timeout: s.timeout_ms ?? WAIT_DEFAULT_MS } };
    case 'wait_for_url': return { action: 'wait_for_url', params: { url: s.url, timeout: s.timeout_ms ?? WAIT_DEFAULT_MS } };
    case 'wait_for_text': return {
      action: 'wait_for',
      params: { selector: `${s.selector} >> text=${s.text}`, state: 'visible', timeout: s.timeout_ms ?? WAIT_DEFAULT_MS }
    };
    case 'screenshot': return { action: 'screenshot', params: {} };
    default: return { action: s.step, params: { selector: s.selector } };
  }
}

function guardMs(s, call) {
  if (call.params.timeout !== undefined) return call.params.timeout + GUARD_GRACE_MS;
  if (s.step === 'navigate') return NAVIGATE_GUARD_MS;
  if (s.step === 'type') return ACT_GUARD_MS + TYPE_MS_PER_CHAR * chars(s.text);
  return ACT_GUARD_MS;
}

// Moves a screenshot the browser tool saved into the take's directory.
function place(savedTo, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(savedTo, target);
  } catch {
    fs.copyFileSync(savedTo, target);
    try { fs.unlinkSync(savedTo); } catch { /* the copy is what counts */ }
  }
  return target;
}

// → { results: [{ index, step, action, ok, ms, url, error?, screenshot?, note? }], stopped_at }.
// `step` and `action` are the same name: `action` is the take record's and §5.2's field.
async function runSteps({ steps, from = 0, continueOnError = false } = {}, {
  actions, context, policy, takeDir, clock = Date.now, timers = { setTimeout, clearTimeout },
  onNote = null, isLive = () => true, signal = null
} = {}) {
  const valid = validateSteps(steps, { from });
  if (!valid.ok) throw new StepError('invalid_params', valid.error.message);
  if (!policy || typeof policy.decide !== 'function') throw new StepError('invalid_params', 'a take step needs the take\'s policy');

  // Bounds a promise by a ref'd timer: a step that hangs is that step's failure.
  const guarded = (promise, ms) => {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new StepError('op_timeout', `the step took longer than ${Math.round(ms / 1000)} s`)), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => timers.clearTimeout(timer));
  };

  const sleep = (ms) => new Promise((resolve) => { timers.setTimeout(resolve, ms); });

  // The policy first, then the browser tool's action.
  async function browse(call, ms) {
    let d;
    try {
      d = await policy.decide('Browser', { action: call.action, ...call.params });
    } catch (err) {
      throw new StepError(errorOf(err).code, errorOf(err).message);
    }
    if (!d || d.allow === false) {
      throw new StepError(d && typeof d.code === 'string' ? d.code : 'take_action_not_allowed', (d && (d.error || d.message)) || `${call.action} is outside what this take approved`);
    }
    const handler = actions && actions[call.action];
    if (typeof handler !== 'function') throw new StepError('capability_unavailable', `the browser has no ${call.action}`);
    const out = await guarded(handler(call.params, context), ms);
    if (out && out.ok === false) throw new StepError('step_failed', out.error ? String(out.error) : `${call.action} failed`);
    return out;
  }

  async function screenshotTo(fileName) {
    if (!takeDir) throw new StepError('invalid_params', 'the take has no directory for a screenshot');
    const out = await browse({ action: 'screenshot', params: {} }, ACT_GUARD_MS);
    if (!out || typeof out.savedTo !== 'string') throw new StepError('step_failed', 'the browser saved no screenshot');
    return place(out.savedTo, path.join(takeDir, fileName));
  }

  async function pageUrl() {
    if (!actions || typeof actions.status !== 'function') return null;
    try {
      const st = await guarded(actions.status({}, context), URL_READ_MS);
      return st && typeof st.currentUrl === 'string' ? st.currentUrl : null;
    } catch {
      return null;
    }
  }

  async function runOne(s, index) {
    if (s.step === 'note') {
      if (onNote) await onNote(s.text);
      return { note: s.text };
    }
    if (s.step === 'pause') {
      await sleep(s.ms);
      return {};
    }
    if (s.step === 'screenshot') return { screenshot: await screenshotTo(`${s.name || `step-${index}`}.png`) };
    const call = browserCall(s);
    await browse(call, guardMs(s, call));
    return {};
  }

  const results = [];
  let stoppedAt = null;
  for (let index = from; index < steps.length; index++) {
    const s = steps[index];
    const row = { index, step: s.step, action: s.step, ok: false, ms: 0, url: null };
    // A take that ended, or a turn that was stopped, ends the run here.
    const halt = signal && signal.aborted ? { code: 'cancelled', message: 'the turn was stopped' }
      : (!isLive() ? { code: 'lease_required', message: 'the take has ended' } : null);
    if (halt) {
      row.error = halt;
      results.push(row);
      stoppedAt = index;
      break;
    }
    const started = clock();
    try {
      Object.assign(row, await runOne(s, index));
      row.ok = true;
    } catch (err) {
      row.error = errorOf(err);
    }
    row.ms = Math.max(0, clock() - started);
    row.url = await pageUrl();
    if (!row.ok) {
      // Best effort: a capture that fails never masks the step's own error.
      try {
        row.screenshot = await screenshotTo(`step-${index}-failed.png`);
      } catch {
        delete row.screenshot;
      }
    }
    results.push(row);
    if (!row.ok && !continueOnError) {
      stoppedAt = index;
      break;
    }
  }
  return { results, stopped_at: stoppedAt };
}

module.exports = { validateSteps, runSteps, STEP_KINDS, MAX_STEPS, MAX_BYTES, WAIT_MAX_MS, PAUSE_MAX_MS, PAUSE_TOTAL_MS };
