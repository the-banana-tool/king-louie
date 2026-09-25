// src/cases/executors/case-guard.js
// The case-turn guard (cases stage 3 spec §3.9). In a case turn, or a child
// run that carries a guardContext: browser tools only look and click (typing
// goes through Executor submit), web tools are gated in query mode, and no
// tool writes ops memory, the executors folder or workflow files. Bash is
// not guarded (§8).
const path = require('path');
const { outboundGate } = require('../gates');
const { segmentsWithin } = require('../safe-path');
const { CASES_BROWSER_PROFILE } = require('./util');

const SESSION = ['start', 'stop', 'status', 'profile_list', 'profile_current', 'tabs', 'close_tab', 'switch_tab', 'open_tab'];
const PAGE = [
  'navigate', 'go_back', 'go_forward', 'reload', 'click', 'dblclick', 'check', 'uncheck', 'hover', 'focus', 'scroll', 'screenshot',
  'mouse_move', 'mouse_wheel', 'mouse_click', 'wait_for', 'wait_for_url', 'wait_for_load_state', 'wait_for_response'
];
const EXTRACT = ['content', 'title', 'get_text', 'get_attribute', 'get_value', 'is_visible', 'count', 'bounding_box', 'console', 'frames', 'click_in_frame', 'route_block', 'unroute'];
const BROWSER_ALLOWED = Object.freeze({
  BrowserSession: Object.freeze(SESSION),
  BrowserPage: Object.freeze(PAGE),
  BrowserExtract: Object.freeze(EXTRACT),
  Browser: Object.freeze([...SESSION, ...PAGE, ...EXTRACT])
});
const URL_GATED = Object.freeze({
  BrowserSession: { open_tab: 'url' },
  BrowserPage: { navigate: 'url' },
  Browser: { open_tab: 'url', navigate: 'url' }
});
const WEB_GATED = Object.freeze({ WebFetch: 'url', WebSearch: 'query' });
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const BROWSER_REFUSAL = 'In a case, anything typed into a page goes through Executor submit with executor "browser" so the outbound gate and envelope apply.';
const BROWSER_START_REFUSAL = `In a case, the browser starts only with profile "${CASES_BROWSER_PROFILE}" and never a user data path, so the owner's own cookies are never used.`;
// Top-level names under the data dir that only King Louie writes (compared
// case-folded where the file system is): ops memory, executor packages and
// state, and workflow files (they carry a child's guard context).
const DATA_DIR_GUARDED = new Set(['ops-memory.jsonl', 'executors', 'workflows']);
const DATA_DIR_REFUSAL = 'ops-memory.jsonl, the executors folder and workflow files are written only by King Louie, not by tools in a case.';

// Which profile the running browser uses: the browser tool's own state,
// read only when a case run uses a browser tool.
const readBrowserProfile = () => require('../../tools/builtin/browser-tool').actions.profile_current();
// Browser actions that never act on a page: they may run whatever profile is open.
const PROFILE_FREE = new Set(['start', 'stop', 'status', 'profile_list', 'profile_current']);

let host = { getCaseRuntime: () => null, dataDir: null, browserProfile: readBrowserProfile };

// createCore calls this once: a child's guardContext is only { caseId }.
// browserProfile: tests only.
function configureCaseGuard({ getCaseRuntime = null, dataDir = null, browserProfile = null } = {}) {
  host = {
    getCaseRuntime: typeof getCaseRuntime === 'function' ? getCaseRuntime : () => null,
    dataDir: dataDir || null,
    browserProfile: typeof browserProfile === 'function' ? browserProfile : readBrowserProfile
  };
}

function gateQuery(toolName, text, ctx) {
  const caseId = ctx.caseContext?.caseId || ctx.guardContext?.caseId || null;
  const runtime = ctx.caseContext?.runtime || host.getCaseRuntime();
  if (!caseId || !runtime) {
    return { success: false, error: `${toolName} is refused: the case for this run is not available to check what it would send.` };
  }
  let facts;
  let entitySpans = [];
  try {
    facts = runtime.ledger(caseId).view().facts;
    const index = typeof runtime.entityIndex === 'function' ? runtime.entityIndex() : null;
    if (index && typeof index.nonDisclosableSpans === 'function') entitySpans = index.nonDisclosableSpans(text, { caseId }) || [];
  } catch (err) {
    return { success: false, error: `${toolName} is refused: the case facts could not be checked (${err.message}).` };
  }
  const r = outboundGate({ payloadText: text, facts, mode: 'query', entitySpans });
  if (r.ok) return null;
  const what = r.blocked.map((b) => `"${b.span.text}" (${b.reason}${b.factId ? ` ${b.factId}` : ''})`).join(', ');
  return { success: false, error: `${toolName} would send case data that may not leave: ${what}. Search without it.` };
}

// A URL as a server reads it: '+' is a space in a query, and an escape may
// be encoded more than once. A malformed escape anywhere makes
// decodeURIComponent throw, so the fallback decodes the valid %XX one by one.
function decodedForms(text) {
  const forms = [];
  let current = text;
  for (let i = 0; i < 3; i++) {
    const spaced = current.replace(/\+/g, ' ');
    let next;
    try {
      next = decodeURIComponent(spaced);
    } catch {
      next = spaced.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

// The raw URL and every decoded form must pass.
function gateUrl(toolName, url, ctx) {
  for (const text of [url, ...decodedForms(url)]) {
    const refused = gateQuery(toolName, text, ctx);
    if (refused) return refused;
  }
  return null;
}

function caseToolGuard(toolName, params = {}, ctx = {}) {
  if (!ctx.caseContext && !ctx.guardContext) return null;
  const p = params || {};
  if (BROWSER_ALLOWED[toolName]) {
    if (!BROWSER_ALLOWED[toolName].includes(p.action)) return { success: false, error: BROWSER_REFUSAL };
    if (p.action === 'start' && (p.userDataPath !== undefined || p.profile !== CASES_BROWSER_PROFILE)) {
      return { success: false, error: BROWSER_START_REFUSAL };
    }
    const field = URL_GATED[toolName]?.[p.action];
    if (field && p[field] !== undefined && p[field] !== null && p[field] !== '') return gateUrl(toolName, String(p[field]), ctx);
    return null;
  }
  if (toolName === 'WebFetch') return gateUrl(toolName, String(p.url ?? ''), ctx);
  if (WEB_GATED[toolName]) return gateQuery(toolName, String(p[WEB_GATED[toolName]] ?? ''), ctx);
  if (WRITE_TOOLS.has(toolName) && host.dataDir) {
    const base = ctx.workingDirectory || process.cwd();
    const targets = [p.file_path, ...(Array.isArray(p.edits) ? p.edits.map((e) => e?.file_path) : [])].filter((t) => typeof t === 'string' && t);
    for (const t of targets) {
      const segments = segmentsWithin(host.dataDir, path.resolve(base, t));
      if (segments && segments.length && DATA_DIR_GUARDED.has(segments[0])) return { success: false, error: DATA_DIR_REFUSAL };
    }
  }
  return null;
}

// Ruling T11-always-profile for direct browser tools: in a case run a
// browser already open in another profile (the owner's cookies) is not
// used; only the cases profile is. Asynchronous, so it runs after
// caseToolGuard. Nothing running: the action fails on its own.
async function caseBrowserProfileGuard(toolName, params = {}, ctx = {}) {
  if (!ctx.caseContext && !ctx.guardContext) return null;
  if (!BROWSER_ALLOWED[toolName] || PROFILE_FREE.has(params?.action)) return null;
  let current;
  try {
    current = await host.browserProfile();
  } catch (err) {
    current = { error: err.message };
  }
  if (!current || typeof current !== 'object' || current.error || current.ok === false) {
    const why = current?.error ? ` (${current.error})` : '';
    return { success: false, error: `In a case, browser actions are refused: which profile the browser is open with could not be read${why}.` };
  }
  if (current.running !== true || current.active === CASES_BROWSER_PROFILE) return null;
  const open = current.active ? `profile "${current.active}"` : 'no named profile';
  return {
    success: false,
    error: `In a case, the browser is used only with profile "${CASES_BROWSER_PROFILE}", and it is open with ${open}. Stop it, then start it with profile "${CASES_BROWSER_PROFILE}".`
  };
}

module.exports = { caseToolGuard, caseBrowserProfileGuard, configureCaseGuard, BROWSER_ALLOWED, BROWSER_REFUSAL };
