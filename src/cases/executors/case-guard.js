// src/cases/executors/case-guard.js
// The case-turn guard (cases stage 3 spec §3.9). In a case turn, or a child
// run that carries a guardContext: browser tools only look and click (typing
// goes through Executor submit), web tools are gated in query mode, and no
// tool writes ops memory or the executors folder. Bash is not guarded (§8).
const path = require('path');
const { outboundGate } = require('../gates');

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
const FOLD = process.platform === 'win32' || process.platform === 'darwin';

let host = { getCaseRuntime: () => null, dataDir: null };

// createCore calls this once: a child's guardContext is only { caseId }.
function configureCaseGuard({ getCaseRuntime = null, dataDir = null } = {}) {
  host = { getCaseRuntime: typeof getCaseRuntime === 'function' ? getCaseRuntime : () => null, dataDir: dataDir || null };
}

const norm = (p) => (FOLD ? path.resolve(p).toLowerCase() : path.resolve(p));

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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

function caseToolGuard(toolName, params = {}, ctx = {}) {
  if (!ctx.caseContext && !ctx.guardContext) return null;
  const p = params || {};
  if (BROWSER_ALLOWED[toolName]) {
    if (!BROWSER_ALLOWED[toolName].includes(p.action)) return { success: false, error: BROWSER_REFUSAL };
    const field = URL_GATED[toolName]?.[p.action];
    if (field && p[field] !== undefined && p[field] !== null && p[field] !== '') return gateQuery(toolName, String(p[field]), ctx);
    return null;
  }
  if (WEB_GATED[toolName]) return gateQuery(toolName, String(p[WEB_GATED[toolName]] ?? ''), ctx);
  if (WRITE_TOOLS.has(toolName) && host.dataDir) {
    const base = ctx.workingDirectory || process.cwd();
    const targets = [p.file_path, ...(Array.isArray(p.edits) ? p.edits.map((e) => e?.file_path) : [])].filter((t) => typeof t === 'string' && t);
    const guarded = [path.join(host.dataDir, 'ops-memory.jsonl'), path.join(host.dataDir, 'executors')].map(norm);
    for (const t of targets) {
      const abs = norm(path.resolve(base, t));
      if (guarded.some((g) => within(abs, g))) {
        return { success: false, error: 'ops-memory.jsonl and the executors folder are written only by King Louie, not by tools in a case.' };
      }
    }
  }
  return null;
}

module.exports = { caseToolGuard, configureCaseGuard, BROWSER_ALLOWED, BROWSER_REFUSAL };
