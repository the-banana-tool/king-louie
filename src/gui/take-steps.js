'use strict';

// Take.run_steps' runner (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md
// §10): an ordered list of browser steps run with no model between them. Each step that drives
// the browser is the browser call it makes, `{ action, ...params }`, and is held to what a model's
// own call is held to, in ToolExecutor's order (§7.2): the node's deny rules and `denied` tier
// first (`checkDenied`, which the executor hands the Take call), then the take's policy
// (`decide('Browser', …)`), so a refusal carries the same code from the same place. Then it runs
// through the browser tool's own action, in a context pinned to the take's browser key (a `take:`
// key never falls back to the owner's browser). PreToolUse hooks are not run for steps in D1.
// A guard timer that fires ends the wait for a step, not the Playwright call itself, so a step
// that timed out always stops the run, whatever `continue_on_error` says. No model, no shell.

const fs = require('fs');
const path = require('path');
const { plainLineProblem } = require('../cases/hidden-chars');
const { BROWSER_ACTIONS } = require('./take-policy');

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
const DECIDE_MS = 5000;
const ERROR_MAX = 300;
const WAIT_STATES = Object.freeze(['attached', 'detached', 'visible', 'hidden']);
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// The runner's own capture names: a named still never overwrites one.
const RESERVED_NAME_RE = /^step-\d+(-failed)?$/;
// The selector keywords the browser tool's resolveLocator hands whole to getByLabel and the
// like (src/tools/builtin/browser-tool.js): `<keyword>... >> text=` cannot be chained onto them.
// CSS, `role=`, `text=` and `xpath=` are Playwright selectors and chain.
const KEYWORD_SELECTOR_PREFIXES = Object.freeze(['label=', 'placeholder=', 'testid=', 'alt=', 'title=']);

// Which split browser tool an action belongs to: a deny rule may be written for it or for Browser.
const SPLIT_TOOL = new Map([
  ...BROWSER_ACTIONS.page.map((a) => [a, 'BrowserPage']),
  ...BROWSER_ACTIONS.session.map((a) => [a, 'BrowserSession']),
  ...BROWSER_ACTIONS.extract.map((a) => [a, 'BrowserExtract'])
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => Array.from(s).length;
const cut = (s, max) => (chars(s) > max ? `${Array.from(s).slice(0, max - 1).join('')}…` : s);

// A field's check: null when it holds, else what it must be (the field name is the table's own).
const str = (min, max) => (v) => (typeof v === 'string' && chars(v) >= min && chars(v) <= max ? null : `must be a string of ${min}–${max} characters`);
const int = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number from ${min} to ${max}`);
const oneOf = (list) => (v) => (list.includes(v) ? null : `must be one of ${list.join(', ')}`);
const plain = (max) => (v) => (typeof v === 'string' && v.length > 0 && chars(v) <= max && plainLineProblem(v) === null ? null : `must be one plain line of 1–${max} characters`);
const name = (v) => {
  if (typeof v !== 'string' || !NAME_RE.test(v)) return 'must be 1–64 characters of A-Z, a-z, 0-9, _ and -';
  return RESERVED_NAME_RE.test(v) ? 'must not be a name the runner gives its own stills (step-N, step-N-failed)' : null;
};

// A snapshot ref (`ref=e12`, spec 2026-10-28-browser-runner C-7) names an element of the last
// snapshot, and a script is written before any snapshot exists: refused in every step.
const SELECTOR = (v) => str(1, SELECTOR_MAX)(v)
  || (/^\s*ref=/.test(v) ? 'cannot be a ref= selector: a script is written before any snapshot exists; use a CSS, role= or text= selector' : null);
const TIMEOUT = int(1, WAIT_MAX_MS);
const DELTA = int(-SCROLL_MAX, SCROLL_MAX);
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
  select_option: { selector: req(SELECTOR), value: req(str(0, SELECTOR_MAX)) },
  // dx and dy without a selector; with one, the tool scrolls it into view and takes no delta.
  scroll: { selector: opt(SELECTOR), dx: opt(DELTA), dy: opt(DELTA) },
  wait_for: { selector: req(SELECTOR), state: opt(oneOf(WAIT_STATES)), timeout_ms: opt(TIMEOUT) },
  wait_for_url: { url: req(str(1, URL_MAX)), timeout_ms: opt(TIMEOUT) },
  wait_for_text: { selector: req(SELECTOR), text: req(str(1, SELECTOR_MAX)), timeout_ms: opt(TIMEOUT) },
  pause: { ms: req(int(1, PAUSE_MAX_MS)) },
  screenshot: { name: opt(name) },
  note: { text: req(plain(NOTE_MAX)) }
});
const STEP_KINDS = Object.freeze(Object.keys(STEPS));

const refused = (message) => ({ ok: false, error: { code: 'invalid_params', message } });

// The checks that span fields of one step: null, or the problem.
function crossFieldProblem(s) {
  if (s.step === 'scroll') {
    if (s.selector !== undefined && (s.dx !== undefined || s.dy !== undefined)) return 'takes a "selector" or "dx" and "dy", not both';
    if (s.selector === undefined && (s.dx === undefined || s.dy === undefined)) return '"dx" and "dy" are required without a "selector"';
  }
  if (s.step === 'wait_for_text' && KEYWORD_SELECTOR_PREFIXES.some((p) => s.selector.startsWith(p))) {
    return `"selector" cannot be a ${KEYWORD_SELECTOR_PREFIXES.join(', ')} selector here; use a CSS or role= selector`;
  }
  return null;
}

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
    const across = crossFieldProblem(s);
    if (across) return refused(`step ${i} (${s.step}): ${across}`);
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
  return { code, message: cut(line, ERROR_MAX) || code };
}

// The browser call a step makes: { action, params } for browserTool.actions and the checks.
function browserCall(s) {
  switch (s.step) {
    case 'navigate': return { action: 'navigate', params: { url: s.url } };
    case 'fill':
    case 'type': return { action: s.step, params: { selector: s.selector, text: s.text } };
    case 'press': return { action: 'press', params: s.selector === undefined ? { key: s.key } : { key: s.key, selector: s.selector } };
    case 'select_option': return { action: 'select_option', params: { selector: s.selector, value: s.value } };
    case 'scroll': return { action: 'scroll', params: s.selector === undefined ? { delta_x: s.dx, delta_y: s.dy } : { selector: s.selector } };
    case 'wait_for': return { action: 'wait_for', params: { selector: s.selector, state: s.state || 'visible', timeout: s.timeout_ms ?? WAIT_DEFAULT_MS } };
    case 'wait_for_url': return { action: 'wait_for_url', params: { url: s.url, timeout: s.timeout_ms ?? WAIT_DEFAULT_MS } };
    // What getByText builds: an escaped, case-insensitive substring, so `>>`, quotes or a /regex/
    // in the text are only text.
    case 'wait_for_text': return {
      action: 'wait_for',
      params: { selector: `${s.selector} >> internal:text=${JSON.stringify(s.text)}i`, state: 'visible', timeout: s.timeout_ms ?? WAIT_DEFAULT_MS }
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

// Moves a screenshot the browser tool saved into the take's directory; the temp file never stays.
function place(savedTo, target) {
  try {
    // Made on first use, private like the take store it sits in.
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      fs.renameSync(savedTo, target);
    } catch {
      fs.copyFileSync(savedTo, target);
    }
    return target;
  } finally {
    try { fs.unlinkSync(savedTo); } catch { /* moved, or already gone */ }
  }
}

// → { results: [{ index, step, action, ok, ms, url, error?, screenshot?, note? }], stopped_at }.
// `step` and `action` are the same name: `action` is the take record's and §5.2's field.
async function runSteps({ steps, from = 0, continueOnError = false } = {}, {
  actions, context, policy, checkDenied, takeDir, clock = Date.now, timers = { setTimeout, clearTimeout },
  onNote = null, isLive = () => true, signal = null
} = {}) {
  const valid = validateSteps(steps, { from });
  if (!valid.ok) throw new StepError('invalid_params', valid.error.message);
  if (!policy || typeof policy.decide !== 'function') throw new StepError('invalid_params', 'a take step needs the take\'s policy');
  if (typeof checkDenied !== 'function') throw new StepError('invalid_params', 'a take step needs the node\'s rules');

  // Bounds a promise by a ref'd timer, and ends it when the turn is stopped: a step that hangs is
  // that step's failure.
  const guarded = (promise, ms) => {
    let timer = null;
    let onAbort = null;
    const bound = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new StepError('op_timeout', `the step took longer than ${Math.round(ms / 1000)} s`)), ms);
      if (signal) {
        onAbort = () => reject(new StepError('cancelled', 'the turn was stopped'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return Promise.race([Promise.resolve(promise), bound]).finally(() => {
      timers.clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
  };

  // A pause is a ref'd timer; a stopped turn ends it early.
  const sleep = (ms) => guarded(new Promise(() => {}), ms).catch((err) => {
    if (err.code !== 'op_timeout') throw err;
  });

  // The node's deny rules and tier, the take's policy, then the browser tool's action.
  async function browse(call, ms) {
    const asCall = { action: call.action, ...call.params };
    for (const toolName of new Set(['Browser', SPLIT_TOOL.get(call.action) || 'Browser'])) {
      const denied = await checkDenied(toolName, asCall);
      if (denied) throw new StepError(typeof denied.code === 'string' ? denied.code : 'denied_by_policy', denied.message || 'denied by the node\'s policy');
    }
    let d;
    try {
      d = await guarded(policy.decide('Browser', asCall), DECIDE_MS);
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
      return st && typeof st.currentUrl === 'string' ? cut(st.currentUrl, URL_MAX) : null;
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
      : (!isLive() ? { code: 'take_ended', message: 'the take has ended' } : null);
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
    // Nothing more is read once the take has ended: its browser is gone, and nothing falls back.
    const live = isLive();
    if (live) row.url = await pageUrl();
    if (!row.ok && live && row.error.code !== 'cancelled') {
      // Best effort: a capture that fails never masks the step's own error.
      try {
        row.screenshot = await screenshotTo(`step-${index}-failed.png`);
      } catch {
        delete row.screenshot;
      }
    }
    results.push(row);
    // A timeout (the Playwright call may still be running), a stopped turn and an ended take stop
    // the run whatever continue_on_error says; a step that passed as the take ended stops it at
    // the next step's check.
    if (!row.ok && (!continueOnError || !live || row.error.code === 'op_timeout' || row.error.code === 'cancelled')) {
      stoppedAt = index;
      break;
    }
  }
  return { results, stopped_at: stoppedAt };
}

module.exports = {
  validateSteps, runSteps, STEP_KINDS, MAX_STEPS, MAX_BYTES, WAIT_MAX_MS, PAUSE_MAX_MS, PAUSE_TOTAL_MS, KEYWORD_SELECTOR_PREFIXES
};
