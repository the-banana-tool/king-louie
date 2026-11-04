// src/migration/migration-verify.js
// Is the move really on the node (attach stage 2 spec §6.5)? Asked of the node
// over its proxied channels after the apply, because the mark this answers for
// stops the old profile being opened: a false yes is the worst outcome of the
// move, so whatever cannot be shown to be there is a no. Electron-free.
//
// What is checked: the report lists no failure; every chat planned new, update
// or copy is on the node under its target id with exactly the source's message
// count; every case planned so is in case:list and did not land incomplete.
// Chats and cases planned skip-present are checked too, because a retry plans
// what an interrupted try left as skip-present: a chat there with at least the
// source's messages (the node may have gone on), a case in the list. Items the
// plan says need attention were shown to the owner before the press and are
// not missing, except a case an earlier run landed incomplete.
const { shown } = require('../service/commands/io');

const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
const CHECKED_ACTIONS = new Set([...WRITE_ACTIONS, 'skip-present']);

const lastSegment = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const arr = (v) => (Array.isArray(v) ? v : []);
const reasonOf = (err) => (err && (err.message || err.code)) || 'no answer';

// The source's message count on each chat item: what the verification compares
// the node's with. Plans carry ids and keys only, so the desktop adds this.
function withSourceCounts(plan, source) {
  const counted = (item) => {
    if (item.category !== 'chat') return item;
    const chat = source.getValue('chat', item.key);
    return chat && Array.isArray(chat.messages) ? { ...item, messageCount: chat.messages.length } : item;
  };
  return { ...plan, items: arr(plan && plan.items).map(counted) };
}

function reportProblems(report, note) {
  if (!report || !Array.isArray(report.failures)) {
    note('import', 'report', 'the node sent no list of what failed');
    return;
  }
  for (const f of report.failures) note(f.category, f.key, f.error || 'failed on the node');
  for (const f of arr(report.sendFailures)) note(f.category, f.key, f.error || 'the node did not take it');
  for (const f of arr(report.skipped)) note(f.category, f.key, f.error || 'it was not sent');
  for (const f of arr(report.incomplete)) note(f.category, f.key, f.note || 'it landed incomplete');
  if (report.counts && report.counts.failed > report.failures.length) {
    note('import', 'report', `the node counts ${report.counts.failed} failed and lists ${report.failures.length}`);
  }
}

// A handler's answer, without wrapHandler's { ok, data } when it has one.
function unwrapped(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (answer.ok === false) return { error: answer.error || 'the node refused' };
  return Object.prototype.hasOwnProperty.call(answer, 'data') ? answer.data : answer;
}

async function checkChats(items, invoke, note) {
  let load;
  try {
    load = unwrapped(await invoke('chat:load', []));
  } catch (err) {
    note('chat', 'chat:load', `the node did not list its chats: ${reasonOf(err)}`);
    return;
  }
  if (!load || !Array.isArray(load.chats) || (load.history && load.history.available === false)) {
    note('chat', 'chat:load', (load && load.history && load.history.error) || (load && load.error) || 'the node has no chat list to read');
    return;
  }
  const byId = new Map(load.chats.filter(Boolean).map((c) => [c.id, c]));
  for (const item of items) {
    const onNode = byId.get(item.targetKey || item.key);
    if (!onNode) {
      note('chat', item.key, 'it is not on the node');
    } else if (!Number.isInteger(item.messageCount)) {
      note('chat', item.key, 'the desktop has no message count to compare');
    } else if (!Number.isInteger(onNode.messageCount)) {
      note('chat', item.key, 'the node did not say how many messages it holds');
    } else if (WRITE_ACTIONS.has(item.action) ? onNode.messageCount !== item.messageCount : onNode.messageCount < item.messageCount) {
      note('chat', item.key, `the node holds ${onNode.messageCount} messages where the desktop has ${item.messageCount}`);
    }
  }
}

async function checkCases(items, invoke, note) {
  let list;
  try {
    list = unwrapped(await invoke('case:list', []));
  } catch (err) {
    note('case', 'case:list', `the node did not list its cases: ${reasonOf(err)}`);
    return;
  }
  if (!list || !Array.isArray(list.cases)) {
    note('case', 'case:list', (list && list.error) || 'the node has no case list to read');
    return;
  }
  const dirs = new Set(list.cases.filter(Boolean).map((c) => lastSegment(c.dir)));
  for (const item of items) {
    if (!dirs.has(item.key)) note('case', item.key, 'it is not on the node');
  }
}

// { ok: true, checked: { chats, cases } } or { ok: false, code:
// 'MIGRATION_UNVERIFIED', missing: [{ category, key, why }] }, every string
// through shown. `plan`'s chat items carry messageCount (withSourceCounts).
// Never throws.
async function verifyMigration({ plan, report, invoke }) {
  const missing = [];
  const note = (category, key, why) => missing.push({ category: shown(category, 80), key: shown(key), why: shown(why, 400) });
  reportProblems(report, note);
  if (!plan || !Array.isArray(plan.items)) note('import', 'plan', 'there is no plan to check against');
  const items = arr(plan && plan.items);
  const checked = (category) => items.filter((i) => i.category === category && CHECKED_ACTIONS.has(i.action));
  const chats = checked('chat');
  const cases = checked('case');
  for (const item of items) {
    if (item.incomplete === true) note(item.category, item.key, item.note || 'an earlier import landed it incomplete');
  }
  if (chats.length) await checkChats(chats, invoke, note);
  if (cases.length) await checkCases(cases, invoke, note);
  if (missing.length) return { ok: false, code: 'MIGRATION_UNVERIFIED', missing };
  return { ok: true, checked: { chats: chats.length, cases: cases.length } };
}

module.exports = { verifyMigration, withSourceCounts };
