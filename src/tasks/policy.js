'use strict';

// The task policy (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.6, ADR 0004):
// consulted where the approval would ask. A call inside the live grant runs with no prompt, a
// call outside it takes the ordinary path to the phone, and nothing is refused until the task is
// over. So when in doubt the answer is passthrough, never allow: a new browser action, a page
// that cannot be read and a path that cannot be placed all ask.
//
// Two kinds of allow. { allow: true } is the owner's grant: it lifts an always_confirm match.
// { allow: true, look: true } is reading, which needs no grant: it lifts only the tool's default
// gate, so an always_confirm match or an ask rule still reaches the phone.

const path = require('path');
const { URL } = require('node:url');
const { hostAllowed, CREDENTIAL_ACTIONS, LOOK_ONLY_ACTIONS, TARGET_URL_ACTIONS, SHELL_TOOLS } = require('../gui/take-policy');
const { BROWSER_TOOLS, isActingBrowserCall } = require('../tools/browser-acting');
const { isPathUnderRoots } = require('../platform/path-roots');
const { createLogger } = require('../logging');

const log = createLogger('tasks/policy');

const ALLOW = Object.freeze({ allow: true });
const LOOK = Object.freeze({ allow: true, look: true });
const PASSTHROUGH = Object.freeze({ passthrough: true });

// Acting, but not what the card's "click and type" or "sign in with saved logins" says
// (spec §4.5): running code, uploading a file, filling a saved card. Each asks on its own.
const NOT_IN_ANY_CLASS = new Set(['evaluate', 'evaluate_in_frame', 'set_input_files', 'fill_payment']);

// Reading a page takes these as well as take-policy's look-only list; none changes what a site
// holds. Run in every state, on any page. Not `reload`, which can resubmit a form.
const LOOK_ACTIONS = new Set([
  ...LOOK_ONLY_ACTIONS.filter((a) => a !== 'reload'),
  'hover', 'focus', 'scroll', 'mouse_move', 'mouse_wheel', 'set_viewport',
]);

// What `start` may carry and still mean the task's own browser, the king-louie profile: its other
// parameters (profile, ephemeral, userDataPath) each open something else.
const PLAIN_START_KEYS = new Set(['action', 'headless']);

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

// The host of an http(s) URL, or null: no other scheme is a site.
function hostOf(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname || null : null;
  } catch {
    return null;
  }
}

// The paths a file-writing call names, or null when it names none it can be judged by.
function writtenPaths(toolName, p) {
  const paths = toolName === 'MultiEdit'
    ? (Array.isArray(p.edits) ? p.edits.map((e) => e && e.file_path) : [])
    : [p.file_path];
  return paths.length > 0 && paths.every((f) => typeof f === 'string' && f) ? paths : null;
}

function createTaskPolicy({ getState, currentUrl, workDir, waitForGrant }) {
  async function pageOnSites(sites) {
    let url = null;
    try {
      url = typeof currentUrl === 'function' ? await currentUrl() : null;
    } catch (err) {
      log.debug('no current page', { error: err.message });
    }
    const host = hostOf(url);
    return !!host && hostAllowed(host, sites);
  }

  // A url or host the call names is held to the sites as well as the page (login, signup).
  function namedTargetsOnSites(p, sites) {
    if (present(p.url)) {
      const host = hostOf(p.url);
      if (!host || !hostAllowed(host, sites)) return false;
    }
    if (present(p.host) && (typeof p.host !== 'string' || !hostAllowed(p.host, sites))) return false;
    return true;
  }

  function underWorkDir(toolName, p, cwd) {
    if (typeof workDir !== 'string' || !workDir) return false;
    const paths = writtenPaths(toolName, p);
    return !!paths && paths.every((f) => isPathUnderRoots(path.resolve(cwd || workDir, f), [workDir]));
  }

  // Navigation is reading, so it needs no class; what bounds it is the sites the owner granted,
  // or those of a proposal that acts (on a card out, or left by a grant that lapsed). Only a
  // look-only task, or one with no proposal, has no bound. It never waits for a card. Only a
  // grant's sites make it the owner's allow.
  function decideNavigation(state, p) {
    if (p.action === 'open_tab' && !present(p.url)) return LOOK; // a blank tab
    const host = hostOf(p.url);
    if (!host) return PASSTHROUGH;
    if (state.grant) return hostAllowed(host, state.grant.sites) ? ALLOW : PASSTHROUGH;
    const { proposal } = state;
    const lookOnly = !!proposal && (proposal.lookOnly === true || (Array.isArray(proposal.allows) && proposal.allows.length === 0));
    if (!state.awaiting && (!proposal || lookOnly)) return LOOK;
    return proposal && hostAllowed(host, proposal.sites) ? LOOK : PASSTHROUGH;
  }

  // What class a call needs and how its place in a scope is judged, 'look' for a reading browser
  // call, 'navigate' for navigation, or null for a call no class covers.
  function classify(toolName, p, cwd) {
    if (BROWSER_TOOLS.has(toolName)) {
      // The task's browser is the king-louie profile; any other is the phone's to allow.
      if (present(p.profile) || present(p.ephemeral)) return null;
      const action = p.action;
      if (LOOK_ACTIONS.has(action) || action === 'stop') return 'look';
      if (action === 'start') return Object.keys(p).every((k) => PLAIN_START_KEYS.has(k)) ? 'look' : null;
      if (TARGET_URL_ACTIONS.includes(action)) return 'navigate';
      if (NOT_IN_ANY_CLASS.has(action)) return null;
      const cls = CREDENTIAL_ACTIONS.includes(action) ? 'logins'
        : (isActingBrowserCall(toolName, p) || action === 'reload' ? 'browser-act' : null);
      if (!cls) return null;
      return { cls, inScope: async (sites) => namedTargetsOnSites(p, sites) && pageOnSites(sites) };
    }
    if (SHELL_TOOLS.includes(toolName)) return { cls: 'shell', inScope: async () => true };
    if (FILE_WRITE_TOOLS.has(toolName)) return { cls: 'files-write', inScope: async () => underWorkDir(toolName, p, cwd) };
    return null;
  }

  async function inScope(scope, call) {
    return !!scope && Array.isArray(scope.allows) && scope.allows.includes(call.cls) && call.inScope(scope.sites);
  }

  function ended() {
    return { allow: false, code: 'task_ended', error: 'this task has ended; nothing ran' };
  }

  // The wait for the press ends with it or with the call's own signal. → whether it was pressed.
  function pressed(signal) {
    if (!signal) return Promise.resolve(waitForGrant()).then(() => true);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const stop = () => resolve(false);
      signal.addEventListener('abort', stop, { once: true });
      Promise.resolve(waitForGrant()).then(() => {
        signal.removeEventListener('abort', stop);
        resolve(true);
      });
    });
  }

  // From the executor: `cwd`, where a relative path would land (a sub-agent's may not be workDir),
  // and `signal`, the call's own Stop.
  async function decide(toolName, params, { cwd, signal } = {}) {
    const p = params || {};
    const state = getState();
    if (state.ended) return ended();

    const call = classify(toolName, p, cwd);
    if (call === 'look') return LOOK;
    if (call === 'navigate') return decideNavigation(state, p);
    if (!call) return PASSTHROUGH;

    if (state.grant) return (await inScope(state.grant, call)) ? ALLOW : PASSTHROUGH;
    if (!state.awaiting || !(await inScope(state.proposal, call))) return PASSTHROUGH;

    // The card is out and would cover this call: wait for the press, then decide on what came
    // of it. waitForGrant never rejects. A call stopped meanwhile passes through, and the
    // executor reads the same signal and cancels it before anyone is asked.
    if (!(await pressed(signal))) return PASSTHROUGH;
    const after = getState();
    if (after.ended) return ended();
    return after.grant && (await inScope(after.grant, call)) ? ALLOW : PASSTHROUGH;
  }

  // workDir is for the approval seam: the classifier takes it as an allowed root for this run.
  return { decide, workDir };
}

module.exports = { createTaskPolicy };
