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
// not missing, except a case an earlier run landed incomplete or one on the node
// that does not match the source. What is private on the desktop must be private
// on the node, moved or already there: a mark lost would let a hosted model read it.
// Every vault entry planned to be there is asked for by its whole key.
// The moved chats' order is compared too, and only ever said: it refuses nothing.
const { shown } = require('../service/commands/io');

// Claims the order and no more: a chat that did not land is said apart, and may be here too.
const chatsOutOfOrder = (where) => `The chat list on the ${where} does not show the moved chats in the order they had here.`;
const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
const CHECKED_ACTIONS = new Set([...WRITE_ACTIONS, 'skip-present']);

const lastSegment = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const arr = (v) => (Array.isArray(v) ? v : []);
const reasonOf = (err) => (err && (err.message || err.code)) || 'no answer';

const counted = (n, word) => `${n} private ${word}${n === 1 ? '' : 's'}`;
function privateNote(chats, cases) {
  if (!chats && !cases) return null;
  const what = [chats ? counted(chats, 'chat') : null, cases ? counted(cases, 'case') : null].filter(Boolean).join(' and ');
  return `${what} move and stay private. They answer only on a model running on your own machines: until King Louie Node has one, they say "This needs a local model, and none in the profile can take it." Local servers are added in the localInference block of service.json, in the node's config folder.`;
}

// The time a chat list shows for a chat: its last user or assistant message, else
// its last message (LIST_SQL in history-store.js). Null when that has no time.
function lastMessageTime(messages) {
  const shown = messages.filter((m) => m && (m.sender === 'user' || m.sender === 'assistant'));
  const last = shown.length ? shown[shown.length - 1] : messages[messages.length - 1];
  return last && typeof last.timestamp === 'string' && last.timestamp ? last.timestamp : null;
}

const DIRTY_NOTE = 'it has changes not committed to its history. They move as they stand, and the node commits them the next time it sweeps the case, within about a minute.';

// What only the desktop knows, on each item the verification compares with the
// node: a chat's message count, last message time and private mark, a case's
// mark. A chat that cannot be read counts as private. plan.private and
// plan.dirtyCases are what the owner is told.
function withSourceFacts(plan, source) {
  const caseEntries = new Map(arr(source.inventory && source.inventory.cases).map((c) => [c && c.dir, c]));
  const facts = (item) => {
    if (item.category === 'chat') {
      const chat = source.getValue('chat', item.key);
      if (!chat) return { ...item, private: true };
      return {
        ...item,
        ...(Array.isArray(chat.messages) ? { messageCount: chat.messages.length } : {}),
        ...(Array.isArray(chat.messages) && lastMessageTime(chat.messages) ? { lastMessageAt: lastMessageTime(chat.messages) } : {}),
        ...(chat.private === true ? { private: true } : {})
      };
    }
    const entry = item.category === 'case' ? caseEntries.get(item.key) : null;
    return entry && entry.private === true ? { ...item, private: true } : item;
  };
  const items = arr(plan && plan.items).map(facts);
  const moving = (category) => items.filter((i) => i.category === category && i.private === true && CHECKED_ACTIONS.has(i.action)).length;
  const chats = moving('chat');
  const cases = moving('case');
  const dirtyCases = items
    .filter((i) => i.category === 'case' && CHECKED_ACTIONS.has(i.action) && caseEntries.get(i.key)?.clean === false)
    .map((i) => ({ key: i.key, note: DIRTY_NOTE }));
  return { ...plan, items, private: { chats, cases, note: privateNote(chats, cases) }, dirtyCases };
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

const sameTime = (a, b) => a === b || (Boolean(a) && Boolean(b) && Date.parse(a) === Date.parse(b));

// Over the moved chats only: the node's own may sit anywhere among them.
function outOfOrder(items, listed) {
  const rank = new Map(listed.map((c, i) => [c.id, i]));
  const ranks = items.map((item) => rank.get(item.targetKey || item.key)).filter((n) => n !== undefined);
  return ranks.some((n, i) => i > 0 && n < ranks[i - 1]);
}

async function checkChats(items, invoke, note, notes) {
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
  const listed = load.chats.filter(Boolean);
  if (outOfOrder(items, listed)) notes.push(chatsOutOfOrder('node'));
  const byId = new Map(listed.map((c) => [c.id, c]));
  for (const item of items) {
    const onNode = byId.get(item.targetKey || item.key);
    if (!onNode) {
      note('chat', item.key, 'it is not on the node');
    } else if (!Number.isInteger(item.messageCount)) {
      note('chat', item.key, 'the desktop has no message count to compare');
    } else if (!Number.isInteger(onNode.messageCount)) {
      note('chat', item.key, 'the node did not say how many messages it holds');
    } else if (WRITE_ACTIONS.has(item.action) ? onNode.messageCount !== item.messageCount : onNode.messageCount < item.messageCount) {
      note('chat', item.key, `the node holds ${onNode.messageCount} messages where the desktop has ${item.messageCount}, and trying again will not change a chat already there; compare the two on the node`);
    } else if (item.lastMessageAt && onNode.messageCount === item.messageCount && !sameTime(onNode.lastMessageAt, item.lastMessageAt)) {
      // The same count with another last message: the node's chat is not this one.
      note('chat', item.key, 'the last message on the node is not the desktop\'s, and trying again will not change a chat already there; compare the two on the node');
    } else if (item.private === true && onNode.private !== true) {
      note('chat', item.key, 'it is private on the desktop and not private on the node; mark it private on the node and try again');
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
  const dirs = new Map(list.cases.filter(Boolean).map((c) => [lastSegment(c.dir), c]));
  for (const item of items) {
    const onNode = dirs.get(item.key);
    if (!onNode) note('case', item.key, 'it is not on the node');
    else if (item.private === true && onNode.private !== true) note('case', item.key, 'it is private on the desktop and not private on the node; mark it private on the node and try again');
  }
}

async function checkVault(items, invoke, note) {
  let answer;
  try {
    answer = unwrapped(await invoke('settings:vaultHeld', [{ keys: items.map((i) => i.key) }]));
  } catch (err) {
    note('vault', 'settings:vaultHeld', `the node did not say which vault entries it holds: ${reasonOf(err)}`);
    return;
  }
  if (!answer || !Array.isArray(answer.held)) {
    note('vault', 'settings:vaultHeld', (answer && answer.error) || 'the node did not say which vault entries it holds');
    return;
  }
  const held = new Set(answer.held);
  for (const item of items) {
    if (!held.has(item.key)) note('vault', item.key, 'it is not in the node\'s vault');
  }
}

// { ok: true, checked: { chats, cases } } or { ok: false, code:
// 'MIGRATION_UNVERIFIED', missing: [{ category, key, why }] }, every string
// through shown. `plan`'s chat items carry messageCount (withSourceFacts).
// Never throws.
async function verifyMigration({ plan, report, invoke }) {
  const missing = [];
  const notes = [];
  const note = (category, key, why) => missing.push({ category: shown(category, 80), key: shown(key), why: shown(why, 1200) });
  reportProblems(report, note);
  if (!plan || !Array.isArray(plan.items)) note('import', 'plan', 'there is no plan to check against');
  const items = arr(plan && plan.items);
  const checked = (category) => items.filter((i) => i.category === category && CHECKED_ACTIONS.has(i.action));
  const chats = checked('chat');
  const cases = checked('case');
  const vault = checked('vault');
  for (const item of items) {
    if (item.incomplete === true) note(item.category, item.key, item.note || 'an earlier import landed it incomplete');
  }
  if (chats.length) await checkChats(chats, invoke, note, notes);
  if (cases.length) await checkCases(cases, invoke, note);
  if (vault.length) await checkVault(vault, invoke, note);
  const said = notes.length ? { notes } : {};
  if (missing.length) return { ok: false, code: 'MIGRATION_UNVERIFIED', missing, ...said };
  return { ok: true, checked: { chats: chats.length, cases: cases.length, ...(vault.length ? { vault: vault.length } : {}) }, ...said };
}

module.exports = { verifyMigration, withSourceFacts, chatsOutOfOrder };
