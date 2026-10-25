'use strict';

// The Take tool (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md §5.2):
// start, status, note and stop one screen-recorded browser demo. requiresApproval is false: the
// take grant on the phone is the approval. Built with the GUI tools' own wrapper (src/gui/tools.js
// passes it in), so a run that refuses unsafe calls is refused before anything here is read.

const { GuiError, isGuiError, toToolResult, TAKE_TOOL_NAME } = require('./errors');
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
    // run_steps (wired in the next change)
    steps: { type: 'array', maxItems: 200, items: { type: 'object', properties: { action: { type: 'string', minLength: 1, maxLength: 32 } }, required: ['action'], additionalProperties: true } },
    from: { type: 'integer', minimum: 0, maximum: 199 },
    continue_on_error: { type: 'boolean' },
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

function buildTakeTool({ takes, tool, jobIdOf }) {
  return tool({
    name: TAKE_TOOL_NAME,
    description: 'Run one screen-recorded browser demo (a take). start asks the owner\'s phone once for the whole take '
      + '(sites, browser, apps, minutes); then drive its browser with the browser tools (the take\'s checks answer every '
      + 'approval), status shows where it is, note logs what you changed, stop ends it and returns the recording. '
      + 'To wait, use wait_for or wait_for_url; never a shell.',
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
      if (action === 'run_steps') throw new GuiError('invalid_params', 'run_steps arrives in the next change');
      const record = takes.forJob(jobId);
      if (!record) throw new GuiError('invalid_params', 'this session has no take; start one first');
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

module.exports = { buildTakeTool, TAKE_ACTIONS: ACTIONS };
