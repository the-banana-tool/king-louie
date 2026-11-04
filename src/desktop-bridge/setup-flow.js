// The setup flow's state machine and words (attach stage 2 spec §6.3, §6.5,
// §6.8): what the owner sees from no node to a working one. Pure and
// Electron-free, like pane-model.js: the controller reads the facts, the
// renderer draws the answer with textContent, and neither holds a copy of a rule.
//
// describeSetup(status) reads the controller's status and, beside it, what the
// last press answered:
//   installPreview, installResult  nodeInstallPreview's and nodeInstall's answers
//   migrationPlan, migrationResult migrationPlan's and migrationApply's answers
//   setupError                     any other press's refusal ({ code, error })
//   setupProgress                  the line of a step under way (no press meanwhile)
//   elevated, userProfileDefault   facts; node.defaultDataDir: the CLI's default
//   setup: { completedAt, phoneSeen, phoneOffered, migrateSkipped }
//     phoneOffered: the phone step has been shown; migrateSkipped: this launch
//   profileDir: the app's own folder; node.serviceCli: the launcher the install wrote
//
// Every string from the node, the CLI, a path or the old profile goes through
// `shown`. A press that cannot help is not offered: a state with no way forward
// says what the owner can do, and Not now is only ever a press, never a fallback.
const {
  plain, describeServicePane, describeImportReport, disconnectedRow, refusalLine,
  nodeHosting, NODE_LINES, PERSONAL_PAIR_WARNING
} = require('./pane-model');

const SETUP_STEPS = Object.freeze(['install', 'pair', 'start', 'migrate', 'provider', 'profile', 'phone', 'done']);

const ELEVATED_LINE = 'This app is running as administrator. Close it and open it normally.';
const LATER = { id: 'setupLater', label: 'Not now: use the old standalone mode this time' };
const LATER_NOTICE = 'Standalone mode is going away. While it runs, cron jobs and the channels (Telegram, Discord and the like) are off.';
const CHECK_AGAIN = { id: 'retry', label: 'Check again' };
const SERVICE_SETTINGS = { id: 'openServiceSettings', label: 'Local service settings' };

// A task that keeps the window from going on, and what the owner can do about it.
const TASK_HELP = {
  disabled: {
    code: 'NODE_TASK_DISABLED',
    message: NODE_LINES.NODE_TASK_DISABLED,
    help: 'Open Task Scheduler from the Start menu, find that task, choose Enable, then press Check again.'
  },
  'other-account': {
    code: 'NODE_TASK_OTHER_ACCOUNT',
    message: NODE_LINES.NODE_TASK_OTHER_ACCOUNT,
    help: 'Sign in to that Windows account to use King Louie there, or ask whoever looks after this computer to delete the task in Task Scheduler, then press Check again.'
  },
  unknown: {
    code: 'NODE_TASK_UNREADABLE',
    message: 'Windows did not say whether King Louie Node\'s logon task is there, so this app cannot go on.',
    help: 'Press Check again. If this keeps happening, restart the computer.'
  }
};

const TASK_ERROR_CODES = new Set(['NODE_TASK_MISSING', 'NODE_TASK_DISABLED', 'NODE_TASK_OTHER_ACCOUNT', 'NODE_TASK_UNREADABLE']);

// The bridge codes waiting will not change (the client's FATAL set).
const BRIDGE_HELP = {
  DEVICE_UNPAIRED: { help: 'King Louie Node no longer knows this app. In Local service settings press Unpair, then Pair.' },
  SERVICE_KEY_CHANGED: { help: 'King Louie Node\'s identity changed after this app paired with it. If you reinstalled it, press Unpair in Local service settings, then Pair. If you did not, do not pair again until you know why.' },
  PROTOCOL_MISMATCH: { help: 'This app and King Louie Node are too far apart in version. Restart the node. If that does not help, install the same version of both.', action: { id: 'nodeRestart', label: 'Restart King Louie Node' } },
  ANOTHER_DEVICE: { help: 'Another desktop is attached to King Louie Node. Close it, then press Check again.' }
};

// The press after a refused move, by what can actually help. MIGRATION_BUSY and
// PROFILE_MIGRATED can only be looked at again: one waits, the other is over.
const MOVE_PRESS = {
  MIGRATION_SOURCE: 'Plan again',
  PLAN_EXPIRED: 'Plan again',
  MIGRATION_UNVERIFIED: 'Plan the move again'
};
const MOVE_ONLY_LOOK = new Set(['MIGRATION_BUSY', 'PROFILE_MIGRATED']);

const ACTION_WORDS = {
  new: 'new',
  update: 'updated',
  copy: 'copied',
  'skip-present': 'already on the node',
  'skip-excluded': 'stays behind',
  'needs-attention': 'needs attention',
  'needs-desktop': 'not readable here'
};
const CATEGORY_WORDS = { chat: 'Chats', case: 'Cases' };

// A code, an action or a task read from a node or a store is data: only a table's
// own key counts, so `constructor` is a word and not a function.
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

// Required here, as in pane-model: the preload loads this module.
function long(value) {
  const { shown } = require('../service/commands/io');
  return shown(value, 800);
}

const isCount = (n) => Number.isInteger(n) && n >= 0;
const list = (v) => (Array.isArray(v) ? v : []);
const counted = (n, word) => `${isCount(n) ? n : 0} ${word}${n === 1 ? '' : 's'}`;

function sizeOf(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function sameDir(a, b) {
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  return typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b);
}

const refusedElevated = (answer) => Boolean(answer && answer.code === 'PAIR_ELEVATED');

// What the rules read, from the controller's status. A pairing with no word on
// its hosting is the fleet's, as the controller reads it. status.service is null
// with no summary, so the pairing record answers there.
function setupFacts(status) {
  const s = status || {};
  const paired = Boolean(s.pairing && s.pairing.service);
  const svc = s.service || {};
  const record = paired ? s.pairing.service : {};
  const node = s.node ? {
    fresh: s.node.fresh === true,
    personal: s.node.personal === true || s.node.hosting === 'personal',
    task: s.node.task,
    running: s.node.running === true
  } : null;
  return {
    launch: s.launch || null,
    node,
    paired,
    pendingPair: Boolean(s.pendingPair),
    attached: s.mode === undefined ? undefined : s.mode === 'attached',
    connected: Boolean(s.connection && s.connection.status === 'connected'),
    service: {
      providersConfigured: svc.providersConfigured,
      // The record is what the pairing was made with; the node only speaks of itself.
      hosting: nodeHosting(record.hosting) || nodeHosting(svc.hosting) || (paired ? 'service' : null)
    },
    oldProfile: s.oldProfile || null,
    migration: s.migration || null,
    setup: s.setup || {},
    userProfileDefault: s.userProfileDefault === true,
    elevated: s.elevated === true
      || refusedElevated(s.pendingPair && s.pendingPair.error)
      || refusedElevated(s.installPreview)
      || refusedElevated(s.installResult)
      || refusedElevated(s.setupError)
  };
}

const setupOf = (facts) => facts.setup || {};
const hostingOf = (facts) => (facts.service && facts.service.hosting) || null;
const standaloneLaunch = (facts) => Boolean(facts.launch && facts.launch.host === 'standalone');
const isAttached = (facts) => Boolean(facts.paired) && facts.attached !== false;

// The one rule. A setup that finished stays finished only while there is a node
// to show: with no pairing, or a pairing detached, the window has nothing behind
// a chat, so it shows the way back (§6.2, §6.5).
function nextSetupStep(facts) {
  const f = facts || {};
  if (standaloneLaunch(f)) return 'done';
  if (isAttached(f) && (hostingOf(f) !== 'personal' || setupOf(f).completedAt || setupOf(f).finishedForNow)) return 'done';
  if (f.elevated) return 'install';
  if (f.pendingPair) return 'pair';
  if (!f.paired) {
    const n = f.node;
    return n && !n.fresh && n.personal && n.task === 'registered' ? 'pair' : 'install';
  }
  if (f.attached === false) return 'pair';
  // The phone step's first instruction stops the node, and its other commands are
  // still to run: once offered it stays until it is skipped or done.
  if (setupOf(f).phoneOffered && !setupOf(f).phoneSeen) return 'phone';
  if (!f.connected) return 'start';
  const old = f.oldProfile;
  if (old && old.found && !f.migration && !setupOf(f).migrateSkipped) return 'migrate';
  if (f.service && f.service.providersConfigured === false) return 'provider';
  if (f.userProfileDefault) return 'profile';
  if (!setupOf(f).phoneSeen) return 'phone';
  return 'done';
}

function refusalOf(answer) {
  return { code: answer.code || 'SETUP_REFUSED', message: long(answer.error || answer.message || answer.code || 'That did not work.') };
}

// ── install ─────────────────────────────────────────────────────────────────

function cliPre(answer) {
  const lines = list(answer.lines).map((l) => plain(l));
  return lines.length ? lines.join('\n') : null;
}

// The dry run, its one press and what the install answered, or null if neither
// has been asked for. Shared with the start step, whose task may have gone.
function installAnswer(s) {
  const result = s.installResult;
  if (result && !result.ok) {
    return { lines: [], pre: cliPre(result), error: refusalOf({ code: 'NODE_INSTALL_FAILED', ...result }), actions: [{ id: 'nodeInstallPreview', label: 'Check again' }] };
  }
  if (result) return { lines: ['The install finished, but its logon task is not there yet.'], pre: cliPre(result), actions: [CHECK_AGAIN] };
  const preview = s.installPreview;
  if (preview && !preview.ok) {
    return { lines: [], pre: cliPre(preview), error: refusalOf({ code: 'NODE_INSTALL_FAILED', ...preview }), actions: [{ id: 'nodeInstallPreview', label: 'Check again' }] };
  }
  if (preview) return { lines: ['This is what installing does. Nothing has changed yet.'], pre: cliPre(preview), actions: [{ id: 'nodeInstall', label: 'Install' }] };
  return null;
}

function installStep(s, f) {
  const n = f.node;
  if (!n || (!n.fresh && !n.personal)) {
    const b = s.bridge || {};
    const lines = [];
    if (b.ok) lines.push('A local King Louie service is installed on this computer.');
    else if (b.error) lines.push(long(b.error));
    lines.push('Local service settings shows what was found and how to connect this app to it.');
    return {
      lines,
      error: { code: 'NOT_PERSONAL', message: 'This computer already has a King Louie setup that this app cannot take over, so it does not install King Louie Node here.' },
      actions: [SERVICE_SETTINGS, CHECK_AGAIN]
    };
  }
  const help = !n.fresh && own(TASK_HELP, n.task);
  if (help) return { lines: [help.help], error: { code: help.code, message: help.message }, actions: [CHECK_AGAIN] };
  return installAnswer(s) || {
    lines: [
      'King Louie now runs as King Louie Node, a background program on this computer that runs as you. This window is how you reach it.',
      'Installing adds a logon task that starts it when you sign in. You see what it does before anything changes.'
    ],
    actions: [{ id: 'nodeInstallPreview', label: 'Install…' }]
  };
}

// ── pair ────────────────────────────────────────────────────────────────────

function pendingPairStep(s) {
  const pane = describeServicePane(s);
  const p = s.pendingPair;
  const actions = pane.actions.map((a) => (a.id === 'pair' ? { ...a, id: 'pairStart' } : a));
  const out = { lines: pane.lines.map(long), pre: pane.command ? long(pane.command) : null, actions, noLater: true };
  if (p.personal && p.error) {
    const message = refusalLine(p.error);
    out.lines = out.lines.filter((l) => l !== message);
    out.error = { code: p.error.code || 'PAIR_COMMAND_FAILED', message };
  }
  return out;
}

function pairStep(s, f) {
  if (f.pendingPair) return pendingPairStep(s);
  const name = (s.node && s.node.name) || (s.pairing && s.pairing.service && s.pairing.service.name);
  const called = name ? `King Louie Node "${plain(name)}"` : 'King Louie Node';
  if (f.paired) {
    return { lines: [`This app is paired with ${f.service.hosting === 'personal' ? called : 'the local King Louie service'} but not attached to it.`], actions: [{ id: 'attach', label: 'Attach' }] };
  }
  return {
    lines: [`${called} is installed on this computer and runs as you. Pairing connects this app to it and starts it.`, PERSONAL_PAIR_WARNING],
    actions: [{ id: 'pairStart', label: 'Pair' }]
  };
}

// ── start ───────────────────────────────────────────────────────────────────

function startStep(s) {
  // A start refused for its task is about the task as it was. The owner may have
  // fixed it since, as told, so the task as read now decides.
  const read = s.node || null;
  const n = read && read.startError && TASK_ERROR_CODES.has(read.startError.code) ? { ...read, startError: null } : read;
  const c = s.connection || {};
  if (s.view === 'attached-starting' || (n && n.starting)) return { lines: [NODE_LINES.STARTING], actions: [], noLater: true };
  const bridge = own(BRIDGE_HELP, c.code);
  if (bridge) {
    return {
      lines: [bridge.help],
      error: { code: c.code, message: long(c.error || c.code) },
      actions: [...(bridge.action ? [bridge.action] : []), CHECK_AGAIN, SERVICE_SETTINGS]
    };
  }
  if (n && n.task === 'missing') {
    const answer = installAnswer(s);
    if (answer) return answer;
  }
  const help = n && own(TASK_HELP, n.task);
  if (help) return { lines: [help.help], error: { code: help.code, message: help.message }, actions: [CHECK_AGAIN] };
  const row = n ? disconnectedRow(n, { install: { id: 'nodeInstallPreview', label: 'Install…' } }) : null;
  if (!row) return { lines: [c.error ? long(c.error) : 'King Louie Node is not reachable.'], actions: [CHECK_AGAIN, SERVICE_SETTINGS] };
  // A timeout has no press in the banner, whose client goes on retrying. Here it
  // would leave the owner with nothing to do.
  const press = row.action || { id: n.running ? 'nodeRestart' : 'nodeStart', label: n.running ? 'Restart King Louie Node' : 'Start King Louie Node' };
  const actions = [press, CHECK_AGAIN, SERVICE_SETTINGS];
  if (n.startError) return { lines: [], error: { code: n.startError.code || 'NODE_START_FAILED', message: row.line }, actions };
  return { lines: [row.line], actions };
}

// ── migrate ─────────────────────────────────────────────────────────────────

function leftBehindLines(left) {
  const l = left || {};
  return [
    ...list(l.needsAttention).map((a) => `Needs attention: ${plain(a.category)} ${plain(a.key)}${a.note ? `: ${long(a.note)}` : ''}`),
    ...list(l.secrets).map((a) => `Not moved, enter it again on the node: ${plain(a.category)} ${plain(a.key)}${a.note ? `: ${long(a.note)}` : ''}`)
  ];
}

const refusedFilesLine = (n) => `${counted(n, 'file')} inside your cases could not be read and ${n === 1 ? 'stays' : 'stay'} on this computer, listed below.`;

function countWords(counts) {
  return Object.entries(counts || {})
    .filter(([, n]) => n)
    .map(([action, n]) => `${isCount(n) ? n : 0} ${own(ACTION_WORDS, action) || plain(action)}`)
    .join(', ');
}

// Counts per category and action, as printPlan groups them (§6.5).
function categoryLines(items) {
  const byCategory = new Map();
  for (const item of list(items)) {
    if (!item || typeof item.category !== 'string') continue;
    const row = byCategory.get(item.category) || Object.create(null);
    row[item.action] = (row[item.action] || 0) + 1;
    byCategory.set(item.category, row);
  }
  return [...byCategory].map(([category, row]) => `${own(CATEGORY_WORDS, category) || plain(category)}: ${countWords(row)}`);
}

// What a planned item says that is on screen no other way: each different note
// once, with how many items it is about, and a long list cut saying so.
const NOTE_LINES = 20;
const NOTE_ELSEWHERE = new Set(['needs-attention', 'needs-desktop', 'skip-excluded']);
function itemNoteLines(items) {
  const counts = new Map();
  for (const item of list(items)) {
    if (!item || !item.note || NOTE_ELSEWHERE.has(item.action)) continue;
    const note = long(item.note);
    counts.set(note, (counts.get(note) || 0) + 1);
  }
  const lines = [...counts].slice(0, NOTE_LINES).map(([note, n]) => `Note: ${note}${n > 1 ? ` (${n} items)` : ''}`);
  if (counts.size > NOTE_LINES) lines.push(`Note: and ${counts.size - NOTE_LINES} more.`);
  return lines;
}

// Cases kept outside the profile are never carried, so the move cannot be pressed
// while the folder holds any, or while nobody can tell.
function customRootRefusal(source, pressWord, profileDir) {
  if (!source || !source.customCasesRoot || source.customCases === 0) return null;
  const root = long(source.customCasesRoot);
  if (source.customCasesMissing) {
    return {
      code: 'MIGRATION_SOURCE',
      message: `Your cases are kept in ${root}, and ${root} is not there, so the move cannot carry them. If it is on a drive that is not plugged in, plug it in and press ${pressWord}. If that folder is no longer used, make an empty folder at that path and press ${pressWord}.`
    };
  }
  const count = source.customCases;
  const said = isCount(count)
    ? `${counted(count, 'case')} ${count === 1 ? 'is' : 'are'} kept in ${root}, outside this app's own folder, and the move does not carry ${count === 1 ? 'it' : 'them'}.`
    : `Cases may be kept in ${root}, outside this app's own folder, but that folder could not be read, and the move does not carry them.`;
  const into = profileDir ? `${long(profileDir)}\\cases` : 'the "cases" folder inside this app\'s own folder';
  return {
    code: 'MIGRATION_SOURCE',
    message: `${said} Move those case folders into ${into}, or somewhere else if you no longer need them here, then press ${pressWord}. The old standalone mode keeps looking in the first folder, so it will not show them after that.`
  };
}

function moveFailure(answer) {
  const lines = [];
  if (answer.backupDir) lines.push(`The unfinished backup was left at ${long(answer.backupDir)} so you can look at it.`);
  for (const m of list(answer.verified && answer.verified.missing)) lines.push(`Not verified: ${plain(m.category)} ${plain(m.key)}: ${long(m.why)}`);
  if (answer.report) lines.push(...describeImportReport(answer.report).filter(Boolean).map(long));
  if (isCount(answer.refusedFiles) && answer.refusedFiles > 0) lines.push(refusedFilesLine(answer.refusedFiles));
  lines.push(...leftBehindLines(answer.leftBehind));
  const onlyLook = MOVE_ONLY_LOOK.has(answer.code);
  return {
    lines,
    error: refusalOf({ code: 'IMPORT_FAILED', ...answer }),
    actions: onlyLook ? [CHECK_AGAIN] : [{ id: 'migrationPlan', label: own(MOVE_PRESS, answer.code) || 'Try again' }],
    noLater: onlyLook
  };
}

function planScreen(answer, profileDir, old) {
  const lines = [];
  const b = answer.backup || {};
  const h = b.history || {};
  const size = sizeOf(b.bytes);
  lines.push(`A backup was made and checked at ${long(b.dest)}${size ? ` (${size}, ${counted(b.files, 'file')}; ${counted(h.chats, 'chat')}, ${counted(h.messages, 'message')})` : ''}.`);
  const plan = answer.plan || {};
  const all = countWords(plan.counts);
  if (all) lines.push(`What will happen: ${all}.`);
  lines.push(...categoryLines(plan.items));
  lines.push(...itemNoteLines(plan.items));
  if (plan.private && plan.private.note) lines.push(long(plan.private.note));
  for (const d of list(plan.dirtyCases)) lines.push(`Case ${plain(d.key)}: ${long(d.note)}`);
  if (isCount(answer.refusedFiles) && answer.refusedFiles > 0) lines.push(refusedFilesLine(answer.refusedFiles));
  lines.push(...leftBehindLines(answer.leftBehind));
  lines.push('Stays on this computer:', ...list(answer.staysBehind).map(long));
  const custom = customRootRefusal(b, 'Check again', profileDir) || customRootRefusal(old, 'Check again', profileDir);
  const held = list(answer.heldCases);
  for (const h2 of held) lines.push(`Held back: ${plain(h2.category)} ${plain(h2.key)}${h2.note ? `: ${long(h2.note)}` : ''}`);
  if (custom) return { lines, error: custom, actions: [{ id: 'migrationPlan', label: 'Check again' }] };
  if (held.length) {
    return {
      lines,
      error: {
        code: 'MIGRATION_SOURCE',
        message: `${held.length === 1 ? 'A case cannot be moved as it stands' : 'Some cases cannot be moved as they stand'}, so the move cannot start. Nothing was moved. Fix or remove ${held.length === 1 ? 'it' : 'them'} on this computer (the old standalone mode opens ${held.length === 1 ? 'it' : 'them'}), then press Plan again.`
      },
      actions: [{ id: 'migrationPlan', label: 'Plan again' }]
    };
  }
  lines.push('Nothing is removed from this computer.');
  return { lines, actions: [{ id: 'migrationApply', label: 'Move everything' }] };
}

function migrateStep(s, f) {
  const old = f.oldProfile;
  if (old.schemaProblem) {
    return {
      lines: ['Nothing was changed. Skip for now goes on without them; they stay in this app\'s folder, and Import in Local service settings can try again later.'],
      error: { code: 'MIGRATION_SOURCE', message: `Your old chats and cases could not be read, so they cannot move yet: ${long(old.schemaProblem)}` },
      actions: [{ id: 'retry', label: 'Retry' }, { id: 'skip', label: 'Skip for now' }]
    };
  }
  const result = s.migrationResult;
  if (result && !result.ok) return moveFailure(result);
  const plan = s.migrationPlan;
  if (plan && !plan.ok) return moveFailure(plan);
  if (plan) return planScreen(plan, s.profileDir, old);
  const custom = customRootRefusal(old, 'Check again', s.profileDir);
  const found = `Your earlier King Louie is on this computer: ${counted(old.chats, 'chat')}, ${counted(old.messages, 'message')}, ${counted(old.cases, 'case')}${sizeOf(old.bytes) ? ` (${sizeOf(old.bytes)})` : ''}.`;
  if (custom) return { lines: [found], error: custom, actions: [CHECK_AGAIN] };
  return {
    lines: [found, 'It can move into King Louie Node. A backup is made first, you see what will move before anything does, and nothing is removed from this computer.'],
    actions: [{ id: 'migrationPlan', label: 'See what will move' }]
  };
}

// ── after the move ──────────────────────────────────────────────────────────

// Anything left behind and any private note stays on screen up to Done, on the
// marker so it outlasts the plan and a relaunch.
function movedLines(s, f) {
  const m = f.migration;
  if (!m) return [];
  const date = m.at ? plain(String(m.at).slice(0, 10)) : null;
  const lines = [`Your earlier King Louie moved into King Louie Node${date ? ` on ${date}` : ''}. Its copy stays on this computer, and the backup is at ${long(m.backupDir)}.`];
  if (m.private && m.private.note) lines.push(long(m.private.note));
  lines.push(...leftBehindLines(m.leftBehind));
  // On the marker, so a relaunch before Done keeps them; the same note from this
  // launch's report shows once.
  const notes = [...list(m.notes), ...list(s.migrationResult && s.migrationResult.report && s.migrationResult.report.notes)];
  lines.push(...[...new Set(notes.map(long))]);
  const stays = list(m.staysBehind);
  if (stays.length) lines.push('Stays on this computer:', ...stays.map(long));
  return lines;
}

// ── phone ───────────────────────────────────────────────────────────────────

function phoneCommands(s) {
  // A window-installed node's launcher, whole and quoted; `pair` and the rest are
  // not on any PATH for that owner. A checkout install has the package's own name.
  const serviceCli = s.node && s.node.serviceCli;
  const cli = serviceCli ? `"${long(serviceCli)}"` : 'king-louie-service';
  const dataDir = (s.pairing && s.pairing.service && s.pairing.service.dataDir) || (s.node && s.node.dataDir) || null;
  const atDefault = s.node && s.node.defaultDataDir && sameDir(dataDir, s.node.defaultDataDir);
  const flag = dataDir && !atDefault ? ` --data-dir "${long(dataDir)}"` : '';
  return [
    `${cli} stop${flag}`,
    `${cli} pair wss://<relay>${flag}`,
    `${cli} pair https://mcp.<domain>${flag}`,
    `${cli} enroll-device${flag}`
  ].join('\n');
}

function phoneStep(s, f) {
  const n = s.node || null;
  const lines = [
    'A phone lets you approve what King Louie does while you are away from this window. It is optional, and this app runs nothing for it.',
    'To set one up, open Command Prompt and stop the node first, since pairing refuses while it runs. Then run one of the two pair commands (wss for a relay, https for a front door, with your own address in place of the part in angle brackets), then enroll-device.',
    'If you use a Telegram or Discord bot with King Louie: with no phone enrolled it still answers, but anything needing a phone\'s approval is refused.'
  ];
  const enrolled = list(s.approvals && s.approvals.devices).some((d) => d && d.active);
  const actions = [{ id: 'skip', label: enrolled ? 'Done' : 'Skip' }];
  if (!f.connected) {
    lines.push('King Louie Node is not connected to this app right now. pair starts it again when it finishes, and enroll-device needs it running.');
    if (n && !n.running && !n.starting) actions.unshift({ id: 'nodeStart', label: 'Start King Louie Node' });
  }
  return { lines, pre: phoneCommands(s), actions };
}

// ── the answer ──────────────────────────────────────────────────────────────

function bodyFor(step, s, f) {
  switch (step) {
    case 'install': return installStep(s, f);
    case 'pair': return pairStep(s, f);
    case 'start': return startStep(s);
    case 'migrate': return migrateStep(s, f);
    case 'provider':
      return { lines: ['King Louie needs a key from an AI provider before it can answer. Choose a provider and enter your key; it is kept by King Louie Node on this computer.'], actions: [] };
    case 'profile':
      return { lines: ['Tell King Louie your name and what you do.'], actions: [] };
    case 'phone': return phoneStep(s, f);
    default:
      return { lines: ['King Louie Node is ready.'], actions: [{ id: 'setupFinish', label: 'Open King Louie' }] };
  }
}

// `done` with no setup behind it: a standalone launch, a fleet pairing, a setup
// already finished. The chat is on screen; there is nothing to draw or press.
function nothingToDraw(step, f) {
  return step === 'done' && (standaloneLaunch(f) || hostingOf(f) !== 'personal' || Boolean(setupOf(f).completedAt) || Boolean(setupOf(f).finishedForNow));
}

function describeSetup(status) {
  const s = status || {};
  const f = setupFacts(s);
  const step = nextSetupStep(f);
  const answer = (parts) => ({ step, lines: [], actions: [], pre: null, error: null, canPostpone: false, ...parts });
  if (nothingToDraw(step, f)) return answer({});
  if (f.elevated) return answer({ error: { code: 'PAIR_ELEVATED', message: ELEVATED_LINE }, actions: [{ id: 'retry', label: 'Check again' }] });
  if (s.setupProgress) return answer({ lines: [long(s.setupProgress)] });

  const body = bodyFor(step, s, f);
  const lines = [...list(body.lines)];
  if (['provider', 'profile', 'phone', 'done'].includes(step)) lines.push(...movedLines(s, f));
  const actions = [...list(body.actions)];
  const old = f.oldProfile;
  const canPostpone = Boolean(old && old.found && !old.schemaProblem && !f.migration && !body.noLater && step !== 'done');
  if (canPostpone) {
    lines.push(LATER_NOTICE);
    actions.push({ ...LATER });
  }
  return answer({
    lines,
    actions,
    pre: body.pre || null,
    error: body.error || (s.setupError ? refusalOf(s.setupError) : null),
    canPostpone
  });
}

module.exports = { SETUP_STEPS, nextSetupStep, describeSetup, setupFacts };
