'use strict';

// The plain values a task is made of (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md
// §4.3, §4.4): what a client may read of a record, which tools a turn gets, the chat's title and
// what a failure and a charge come to. No state and nothing sent.

const { plainLineProblem } = require('../cases/hidden-chars');
const { approvalOrigin } = require('../fleet/fleet-tools');
const { MCP_TOOLS } = require('../fleet/tool-definitions');
const { GUI_TOOL_NAMES } = require('../gui/errors');

const TITLE_MAX = 60;
// What a task runs on with no press: nobody was shown more.
const DEFAULT_MINUTES = 30;
const FINAL_STATES = Object.freeze(['done', 'failed', 'cancelled']);
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACTING_GUI = new Set(GUI_TOOL_NAMES.filter((name) => name !== 'ListApps' && name !== 'Screenshot'));
// Each starts or reads a run that outlives the turn, which would escape the task's spend cap
// and its ending (stage 1).
const DETACHED_TOOLS = ['BackgroundTask', 'TaskStatus', 'Cron', 'RemoteDispatch'];
const EXCLUDED_TOOLS = new Set(['message', ...DETACHED_TOOLS, ...MCP_TOOLS.map((t) => t.name)]);
const PUBLIC_KEYS = Object.freeze(['task_id', 'chat_id', 'node', 'text', 'state', 'seq', 'proposal', 'grant', 'placement', 'spend',
  'answer', 'reason', 'deadline_at', 'ended', 'interrupted_at', 'created_at', 'updated_at']);

const PRIVATE_KEPT = Object.freeze(['task_id', 'chat_id', 'node', 'state', 'seq', 'reason', 'ended', 'created_at', 'updated_at']);

// A client reads this, by scope alone, about a task another client may have started (Q25). So the
// client is its kind and name. The name is what that client chose for itself: one plain line, or
// null when it cannot be one. `text` is a client's words and `answer` a page's: the caller wraps
// both as untrusted output on the way out.
function publicView(record) {
  const view = {};
  for (const key of PUBLIC_KEYS) view[key] = record[key] === undefined ? null : record[key];
  const client = record.client || {};
  view.client = { kind: client.kind || null, name: plainCut(String(client.client_name || '')) || null };
  return view;
}

// What a client reads of a task whose chat is private: that it is, which task and what state it is
// in. Every other public key is there with nothing in it, so a reader's shape holds; `client` is
// left out, since it says who asked.
function privateView(record) {
  const view = {};
  for (const key of PUBLIC_KEYS) view[key] = PRIVATE_KEPT.includes(key) && record[key] !== undefined ? record[key] : null;
  return { ...view, private: true };
}

// Every registered tool but the fleet, task, session and detached ones and the acting GUI ones (spec §4.3),
// read at each turn so a tool registered after start is included. Case tools stay.
function taskToolNames(registry) {
  return new Set(registry.list().map((tool) => tool.name)
    .filter((name) => !name.startsWith('sessions_') && !EXCLUDED_TOOLS.has(name) && !ACTING_GUI.has(name)));
}

// One plain line of at most 60 code points, or '' when nothing is left.
function plainCut(text) {
  const line = text.replace(/[\p{Cc}\p{Cf}\p{Z}]+/gu, ' ').trim();
  const cut = [...line].slice(0, TITLE_MAX).join('').trim();
  return cut && !plainLineProblem(cut) ? cut : '';
}

function taskTitle(text) {
  return plainCut(text) || 'Task';
}

function clientOf(origin) {
  if (origin && origin.kind === 'frontdoor') {
    return { kind: 'frontdoor', client_id: origin.client_id || null, client_name: approvalOrigin(origin).client, grant_id: origin.grant_id || null };
  }
  return { kind: (origin && origin.kind) || 'stdio' };
}

// Never an error's message: it can name a path, and the record goes to clients.
function failureCode(err) {
  return err && typeof err.code === 'string' && SAFE_CODE_RE.test(err.code) ? err.code : 'turn_failed';
}

// A number when the event is priced, else null. The tracker's event says `cost`, a call's metrics
// `costUsd`.
function pricedAt(event) {
  const cost = event && (event.cost !== undefined ? event.cost : event.costUsd);
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}

// A cap that is not a number caps nothing: a record from before one was set.
function overCap(spend) {
  return Boolean(spend) && typeof spend.cap_usd === 'number' && spend.usd >= spend.cap_usd;
}

module.exports = { DEFAULT_MINUTES, FINAL_STATES, publicView, privateView, taskToolNames, plainCut, taskTitle, clientOf, failureCode, pricedAt, overCap };
