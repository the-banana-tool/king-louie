'use strict';

// The Take tool (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md §5.2):
// start, run_steps, status, note and stop one screen-recorded browser demo. requiresApproval is
// false: the take grant on the phone is the approval. Built with the GUI tools' own wrapper (src/gui/tools.js
// passes it in), so a run that refuses unsafe calls is refused before anything here is read.

const path = require('path');
const { GuiError, isGuiError, toToolResult, TAKE_TOOL_NAME } = require('./errors');
const { validateSteps, runSteps, STEP_KINDS, MAX_STEPS } = require('./take-steps');
const { TAKE_MAX_MINUTES } = require('./lease-protocol');

const ACTIONS = Object.freeze(['start', 'run_steps', 'status', 'note', 'stop']);
const SIZE = {
  type: 'object',
  properties: { width: { type: 'integer', minimum: 2, maximum: 7680 }, height: { type: 'integer', minimum: 2, maximum: 7680 } },
  required: ['width', 'height'], additionalProperties: false
};
const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ACTIONS] },
    // start
    name: { type: 'string', minLength: 1, maxLength: 60, description: 'start: the take\'s name, one plain line (the phone shows it)' },
    sites: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 253 }, description: 'start: the hosts the take may act on, "example.com" or "*.example.com"' },
    browser: {
      anyOf: [{ type: 'boolean' }, { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 64 } }],
      description: 'start: true (drive the browser on the sites: no scripts, no network changes, no uploads), or a list of browser actions that narrows it'
    },
    apps: { type: 'array', maxItems: 7, items: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9-]{0,31}$' }, description: 'start: gui.apps ids the take may also use' },
    credentials: { type: 'boolean', description: 'start: allow filling logins from the vault on the sites' },
    minutes: { type: 'integer', minimum: 1, maximum: TAKE_MAX_MINUTES, description: 'start: how long the take may run' },
    profile: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'start: the browser profile (kept between takes, so a login survives)' },
    record: {
      anyOf: [{ type: 'boolean' }, {
        type: 'object',
        properties: { dir: { type: 'string', minLength: 1, maxLength: 1024 }, fps: { type: 'integer', minimum: 1, maximum: 60 }, size: SIZE },
        additionalProperties: false
      }],
      description: 'start: record the screen (default true); { dir } is a folder under the session\'s working folder'
    },
    stop_when_done: { type: 'boolean', description: 'start: stop the take when the last step passes' },
    // run_steps: each step is checked whole by src/gui/take-steps.js (spec §10's table).
    steps: {
      type: 'array', minItems: 1, maxItems: MAX_STEPS,
      items: { type: 'object', properties: { step: { type: 'string', enum: [...STEP_KINDS] } }, required: ['step'], additionalProperties: true },
      description: 'run_steps: the script, in order; each { step, ...its fields }: navigate {url}; click, dblclick, hover, focus, check, '
        + 'uncheck, clear {selector}; fill, type {selector, text}; press {key, selector?}; select_option {selector, value}; '
        + 'scroll {selector?, dx, dy}; wait_for {selector, state?, timeout_ms?}; wait_for_url {url, timeout_ms?}; '
        + 'wait_for_text {selector, text, timeout_ms?}; pause {ms} (pacing only, 10 s each, 60 s a run); screenshot {name?}; note {text}'
    },
    from: { type: 'integer', minimum: 0, maximum: MAX_STEPS - 1, description: 'run_steps: the index to start at (resume after a failure)' },
    continue_on_error: { type: 'boolean', description: 'run_steps: run the rest after a step fails' },
    // note
    text: { type: 'string', minLength: 1, maxLength: 500, description: 'note: one line for the take\'s log (what you changed)' },
    // stop (and start's request reason)
    keep_browser: { type: 'boolean', description: 'stop: leave the take\'s browser open' },
    reason: { type: 'string', minLength: 1, maxLength: 280, description: 'start: why, shown on the phone; stop: a closing line for the log' }
  },
  required: ['action'],
  additionalProperties: false
};

const START_KEYS = ['name', 'sites', 'browser', 'apps', 'credentials', 'minutes', 'profile', 'record', 'stop_when_done', 'reason'];

const refusal = (err) => ({ ...toToolResult(err), ...(isGuiError(err) ? { code: err.code } : {}) });

// The browser tool's actions, required on first use: nothing that loads src/gui/ for its config
// or errors should load Playwright.
const defaultBrowserActions = () => require('../tools/builtin/browser-tool').actions;

function buildTakeTool({ takes, tool, jobIdOf, browserActions = defaultBrowserActions }) {
  return tool({
    name: TAKE_TOOL_NAME,
    description: 'Run one screen-recorded browser demo (a take). start asks the owner\'s phone once for the whole take '
      + '(sites, browser, apps, minutes); then drive its browser with the browser tools (the take\'s checks answer every '
      + 'approval), status shows where it is, note logs what you changed, stop ends it and returns the recording. '
      + 'run_steps runs a script of browser steps with no model between them and returns every step\'s outcome; '
      + 'to wait, use wait_for, wait_for_url or wait_for_text; never a shell.',
    parameters: PARAMETERS
  }, async (params, options) => {
    try {
      if (!takes) throw new GuiError('capability_unavailable', 'takes are not set up on this node');
      // A take is never run from a case turn (C-2, spec §5.2).
      if (options && (options.caseContext || options.guardContext)) throw new GuiError('take_tool_not_allowed', 'a take is not started from a case');
      const jobId = jobIdOf(options);
      if (!jobId) throw new GuiError('job_required', 'this run has no job to bind a take to');
      const action = params.action;
      if (action === 'start') {
        const startParams = {};
        for (const key of START_KEYS) if (params[key] !== undefined) startParams[key] = params[key];
        const out = await takes.start({
          jobId, origin: options.origin || null, nodeLocalOrigin: options.nodeLocalOrigin === true, holder: options.takePolicy,
          params: startParams, workingDirectory: options.workingDirectory || null, signal: options.signal || null
        });
        return { ok: true, ...out };
      }
      const record = takes.forJob(jobId);
      if (!record) throw new GuiError('invalid_params', 'this session has no take; start one first');
      if (action === 'run_steps') return await runTakeSteps(takes, record, params, options, browserActions);
      if (action === 'status') return { ok: true, untrusted_output: true, ...(await takes.status(record.take_id)) };
      if (action === 'note') {
        if (params.text === undefined) throw new GuiError('invalid_params', '"text" is required');
        takes.note(record.take_id, params.text);
        return { ok: true };
      }
      // stop
      return { ok: true, ...(await takes.stop(record.take_id, { keepBrowser: params.keep_browser === true, reason: params.reason ?? null })) };
    } catch (err) {
      return refusal(err);
    }
  });
}

// Take.run_steps (spec §10): validates, runs the steps on the take's browser under the take's
// policy, keeps the results on the record, and stops the take when it asked to stop when done.
async function runTakeSteps(takes, record, params, options, browserActions) {
  const takeId = record.take_id;
  const live = takes.context(takeId);
  if (!live) throw new GuiError('invalid_params', 'the take has ended');
  const from = params.from ?? 0;
  const valid = validateSteps(params.steps, { from });
  if (!valid.ok) throw new GuiError('invalid_params', valid.error.message);
  // Stills and failure captures go in the take's own folder under the store, never the
  // recording's: the service runs as LOCAL SERVICE and cannot write the user's paths.
  const takeDir = path.join(takes.store.dir, takeId);
  const out = await runSteps({ steps: valid.steps, from, continueOnError: params.continue_on_error === true }, {
    actions: browserActions(),
    // The Take call's own context: its holder's browserKey resolves the take's browser.
    context: options,
    policy: live.policy,
    takeDir,
    clock: takes.clock,
    timers: takes.timers,
    onNote: (text) => takes.note(takeId, text),
    isLive: () => takes.context(takeId) !== null,
    signal: options.signal || null
  });
  // A resumed run replaces what it ran again; the steps before `from` keep their outcome.
  const earlier = (Array.isArray(record.steps) ? record.steps : []).filter((s) => s && s.index < from);
  takes.recordSteps(takeId, [...earlier, ...out.results]);
  const result = { ok: true, untrusted_output: true, results: out.results, stopped_at: out.stopped_at, take_dir: takeDir };
  const last = out.results.at(-1);
  if (live.stopWhenDone && last && last.index === valid.steps.length - 1 && out.results.every((r) => r.ok) && takes.context(takeId)) {
    result.stopped = await takes.stop(takeId, {});
  }
  return result;
}

module.exports = { buildTakeTool, TAKE_ACTIONS: ACTIONS };
