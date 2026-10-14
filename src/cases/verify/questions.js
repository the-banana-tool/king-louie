// src/cases/verify/questions.js
// Cases stage 8 (spec §6.4, §6.6, §6.7, §7.5): the text of the two questions
// the Progress tool asks and of the check command's approval, and what
// their answers do.
//
// - `scope-confirm` is spoken (owner ruling R-C8-2): the buttons, and an
//   answer in the owner's words through answer_question, both confirm or
//   drop exactly the entries the question showed. The objective is
//   confirmed only by a press or King Louie's chat (review finding 1,
//   2026-10-14). The one asked when create_case runs over MCP is pressed
//   (`mcpAnswerable: false`, R-C8-N7).
// - `close-proposal` is pressed: only "Mark done" pressed in the app or on
//   the paired phone closes the case. The model proposes; it never decides.
//
// - `check-approve` is pressed: only "Approve" pressed in the app or on the
//   paired phone lets the case run its check command, and only the command
//   and repository the card showed.
//
// A card is host-built: host lines first, then labelled text from the case.
// Text that is not one plain line is shown as hidden, never flattened, and
// a card that would be too long is refused, never cut.
const { QuestionStore, QuestionError } = require('../questions');
const { plainLineProblem } = require('../hidden-chars');
const { CHECK_TYPE, CheckError, currentCheck } = require('./check');
const { createLogger } = require('../../logging');

const log = createLogger('cases/verify/questions');

// A recorded answer's channel proves a press only for these (the detour
// router's PRESS_CHANNELS, contact.js's APP_ANSWER_CHANNELS). `in-app-chat`
// (a model relaying words) and every `mcp-*` channel are never one.
const PRESS_CHANNELS = Object.freeze(['in-app', 'mobile']);
// King Louie's chat: the management tool checks the quote in the owner's
// own message of the turn (ToolExecutor's ownerTurnText) before it records
// an answer on this channel.
const CHECKED_CHAT_CHANNEL = 'in-app-chat';

const SCOPE_TYPE = 'scope-confirm';
const CLOSE_TYPE = 'close-proposal';
const QUESTION_MAX_CHARS = 2000;
const NOTE_MAX_CHARS = 300;
const HIDDEN = '(text hidden: not one plain line)';
const CRITERION_ID = /^sc-\d{3,}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

const HOW_TO_ANSWER_SCOPE = 'Answer with "Confirm all" or "Drop all", or use the buttons beside each criterion in the case panel.';
const OBJECTIVE_STAYS = 'The objective is never dropped. Edit it in the case panel.';
const OBJECTIVE_HELD = 'The objective was not confirmed: an answer from outside the app confirms only the criteria. Confirm the objective in the case panel or on your phone.';
const NOT_A_PRESS = 'Not applied: a case is closed only by the button on this question in the app, or on the paired phone.';
const USE_THE_BUTTONS = 'Not applied: answer with "Mark done" or "Keep working".';
const CHECK_NOT_A_PRESS = 'Not applied: a check command is approved only by the button on this question in the app, or on the paired phone.';
const CHECK_USE_THE_BUTTONS = 'Not applied: answer with "Approve" or "Do not run".';
const CHECK_CHANGED = 'Not applied: the command or the repository changed after this was asked.';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// Text a case holds (a title, a criterion, an objective, a note), as a card
// may show it.
const shown = (text) => (typeof text === 'string' && text.trim() && !plainLineProblem(text.trim()) ? text.trim() : HIDDEN);

function whole(lines, what) {
  const text = lines.join('\n');
  if (text.length > QUESTION_MAX_CHARS) {
    throw new QuestionError('QUESTION_TOO_LONG', `${what} would be ${text.length} characters; the owner is shown at most ${QUESTION_MAX_CHARS}, and a question is never cut.`);
  }
  return text;
}

// What the owner is asked to confirm: every proposed criterion and, when it
// is proposed, the objective. `view` is ScopeStore.view().
function scopeQuestionText(meta, view) {
  const rows = (Array.isArray(view?.criteria) ? view.criteria : []).filter((r) => isObject(r) && r.state !== 'confirmed');
  const objective = isObject(view?.objective) && view.objective.state !== 'confirmed' ? view.objective : null;
  const lines = [`Case: ${shown(meta?.title)}`];
  if (rows.length) {
    lines.push(`Confirm these success criteria${objective ? ' and the objective' : ''}? They count for nothing until you confirm them.`);
  } else {
    lines.push('Confirm the objective? You have not confirmed it yet.');
  }
  if (objective) lines.push('"Drop all" leaves the objective as it is; edit it in the case panel.');
  rows.forEach((row, i) => {
    const id = typeof row.id === 'string' && CRITERION_ID.test(row.id) ? row.id : 'sc-???';
    lines.push(`${i + 1}. ${id}: ${shown(row.text)}`);
  });
  if (objective) lines.push(`Objective: ${shown(objective.text)}`);
  return whole(lines, 'The scope question');
}

// The scope question King Louie asks itself when create_case made the case
// over MCP (owner ruling R-C8-N7): the objective only, pressed, so the owner
// confirms it in the app or on the phone without waiting for the model to
// ask. Its key is its own, so the model's askScope is never refused for it.
const CREATED_OBJECTIVE_KEY = 'scope-confirm:created';
const CREATED_OBJECTIVE_OPTIONS = Object.freeze([Object.freeze({ id: 'all', label: 'Confirm' }), Object.freeze({ id: 'none', label: 'Not now' })]);

function createdObjectiveQuestionText(meta, objective) {
  return whole([
    `Case: ${shown(meta?.title)}`,
    'This case was created over MCP. Confirm its objective? It counts for nothing until you confirm it.',
    '"Not now" leaves it proposed; edit it in the case panel.',
    `Objective: ${shown(objective?.text)}`
  ], 'The objective question');
}

// → the question record for CaseRuntime.createQuestion, or null when the
// objective is not there or already confirmed.
function createdObjectiveQuestion(meta, view) {
  const objective = isObject(view?.objective) ? view.objective : null;
  if (!objective || objective.state === 'confirmed' || typeof objective.hash !== 'string' || !HASH.test(objective.hash)) return null;
  return {
    kind: 'question',
    urgency: 'normal',
    text: createdObjectiveQuestionText(meta, objective),
    options: CREATED_OBJECTIVE_OPTIONS.map((o) => ({ ...o })),
    defaultOnSilence: 'hold',
    payload: { type: SCOPE_TYPE, key: CREATED_OBJECTIVE_KEY, disclosable: false, mcpAnswerable: false, entries: [], objective: objective.hash }
  };
}

const isOpenItem = (item) => isObject(item) && item.state !== 'ok' && item.state !== 'n/a';

// The proposal to close: the title, the summary line, one fixed line per
// open item of the ready-to-close list, then the model's note, last and
// labelled. `progress` is CaseRuntime.progress().
function closeQuestionText(meta, progress, note = null) {
  const lines = [
    `Case: ${shown(meta?.title)}`,
    'The case proposes to close as done.',
    typeof progress?.summary === 'string' && progress.summary ? progress.summary : 'Its progress could not be summarised.'
  ];
  for (const item of (Array.isArray(progress?.readiness?.items) ? progress.readiness.items : []).filter(isOpenItem)) {
    // A fix line is fixed wording filled with ids and counts (readiness.js).
    lines.push(typeof item.fix === 'string' && item.fix ? item.fix : `${String(item.id)} is open.`);
  }
  if (typeof note === 'string' && note.trim()) {
    const text = shown(note);
    if (text !== HIDDEN && text.length > NOTE_MAX_CHARS) {
      throw new QuestionError('QUESTION_TOO_LONG', `"note" is one plain line of at most ${NOTE_MAX_CHARS} characters; this one is ${text.length}. A question is never cut.`);
    }
    lines.push(`Note from the case: ${text}`);
  }
  return whole(lines, 'The close proposal');
}

function note(runtime, caseId, questionId, text) {
  try {
    runtime.questions(caseId).note(questionId, text);
  } catch (err) {
    log.warn(`Could not note on ${questionId}: ${err.message}`);
  }
}

// The answer's fact names the question by id and kind, never by its text:
// the text holds criteria the model wrote.
const factOf = (what, subject) => (record, answer) => {
  const option = answer.optionId ? (record.options || []).find((o) => o.id === answer.optionId) : null;
  const value = option ? option.label : answer.text;
  return { stmt: `Owner answered ${record.id} (${what}): ${value}`, subject, attr: record.id, value };
};

// ---- scope-confirm ----

// Whether a recorded scope answer may confirm the objective (review finding
// 1, 2026-10-14): a press (`in-app`, `mobile`), or King Louie's chat with a
// quote on record (checked there in the owner's turn). An answer over MCP
// (quote recorded, not checked) or a contact channel confirms the criteria
// as R-C8-2 allows, and leaves the objective proposed.
function confirmsObjective(answer) {
  if (!isObject(answer)) return false;
  if (PRESS_CHANNELS.includes(answer.channel)) return true;
  return answer.channel === CHECKED_CHAT_CHANNEL && typeof answer.quote === 'string' && answer.quote.trim() !== '';
}

// Confirms, or drops, exactly the payload's entries whose words are still
// the ones shown. Runs inside answerQuestion's systemAction.
async function onScopeAnswered(record, fact, { runtime, caseId }) {
  const optionId = record.answer?.optionId;
  if (optionId !== 'all' && optionId !== 'none') {
    note(runtime, caseId, record.id, HOW_TO_ANSWER_SCOPE);
    return { applied: false, note: HOW_TO_ANSWER_SCOPE };
  }
  const payload = isObject(record.payload) ? record.payload : {};
  const entries = (Array.isArray(payload.entries) ? payload.entries : [])
    .filter((e) => isObject(e) && typeof e.id === 'string' && CRITERION_ID.test(e.id) && typeof e.hash === 'string' && HASH.test(e.hash));
  const action = optionId === 'all' ? 'confirm' : 'drop';
  const stamp = {
    by: 'question',
    channel: typeof record.answer.channel === 'string' ? record.answer.channel : null,
    quote: typeof record.answer.quote === 'string' ? record.answer.quote : null,
    factId: fact?.id ?? null
  };
  const view = runtime.scopeView(caseId);
  const rows = Array.isArray(view?.criteria) ? view.criteria : [];
  const confirmed = [];
  const dropped = [];
  const changed = [];
  const kept = [];
  const apply = async (target, hash) => {
    try {
      await runtime.applyScopeAction(caseId, { action, target, hash, ...stamp });
      return true;
    } catch (err) {
      log.warn(`${record.id}: ${action} of ${target} was not applied: ${err.message}`);
      return false;
    }
  };
  for (const entry of entries) {
    const row = rows.find((r) => r.id === entry.id);
    if (!row || row.hash !== entry.hash) {
      changed.push(entry.id);
    } else if (row.state === 'confirmed') {
      // Confirmed meanwhile, by a button: an "all" has nothing to add, and
      // a "none" never drops what the owner confirmed.
      if (action === 'drop') kept.push(entry.id);
    } else if (await apply(entry.id, entry.hash)) {
      (action === 'confirm' ? confirmed : dropped).push(entry.id);
    } else {
      changed.push(entry.id);
    }
  }
  let objectiveHeld = false;
  if (typeof payload.objective === 'string' && payload.objective) {
    const objective = isObject(view?.objective) ? view.objective : null;
    if (action === 'drop') {
      note(runtime, caseId, record.id, OBJECTIVE_STAYS);
    } else if (!confirmsObjective(record.answer)) {
      if (objective && objective.state !== 'confirmed') {
        objectiveHeld = true;
        log.info(`${record.id}: "all" from ${String(record.answer.channel)} leaves the objective proposed.`);
        note(runtime, caseId, record.id, OBJECTIVE_HELD);
      }
    } else if (!objective || objective.hash !== payload.objective) {
      changed.push('objective');
    } else if (objective.state !== 'confirmed') {
      if (await apply('objective', payload.objective)) confirmed.push('objective');
      else changed.push('objective');
    }
  }
  if (changed.length) {
    note(runtime, caseId, record.id, `Not applied to ${changed.join(', ')}: the words changed after this was asked. Confirm or drop what is there now in the case panel.`);
  }
  if (kept.length) note(runtime, caseId, record.id, `Not dropped: ${kept.join(', ')} ${kept.length === 1 ? 'was' : 'were'} confirmed after this was asked.`);
  return { applied: 'scope', confirmed, dropped, skipped: [...changed, ...kept], ...(objectiveHeld ? { objectiveHeld: true } : {}) };
}

QuestionStore.registerAnswerHandler(SCOPE_TYPE, { toFact: factOf('scope', 'scope'), onAnswered: onScopeAnswered });

// ---- close-proposal ----

// "criteria-met (sc-003), questions-answered (q-0012)" or "none": item ids
// and the ids the list itself gives, for the close's status note.
function openAtClose(runtime, caseId) {
  try {
    const open = runtime.closeReadiness(caseId).items.filter(isOpenItem);
    if (!open.length) return 'none';
    return open.map((i) => `${i.id}${Array.isArray(i.refs) && i.refs.length ? ` (${i.refs.join(', ')})` : ''}`).join(', ');
  } catch (err) {
    log.warn(`${caseId}: the ready-to-close list could not be read for the close: ${err.message}`);
    return 'not known';
  }
}

// `keep` records what the owner declined. `done` closes the case only when
// the recorded answer is a press; the owner's press is never refused for an
// open item (R-C8-1). Runs inside answerQuestion's systemAction.
function onCloseAnswered(record, fact, { runtime, caseId }) {
  const optionId = record.answer?.optionId;
  if (optionId === 'keep') {
    runtime.verification(caseId).setDeclinedClose(record.payload?.fingerprint);
    return { applied: 'declined' };
  }
  if (optionId !== 'done') {
    note(runtime, caseId, record.id, USE_THE_BUTTONS);
    return { applied: false, note: USE_THE_BUTTONS };
  }
  if (!PRESS_CHANNELS.includes(record.answer.channel)) {
    log.warn(`${record.id}: "done" from ${String(record.answer.channel)} is not a press; the case stays open.`);
    note(runtime, caseId, record.id, NOT_A_PRESS);
    return { applied: false, note: NOT_A_PRESS };
  }
  try {
    runtime.setStatus(caseId, 'done', {
      kind: 'owner',
      by: 'owner',
      ref: fact?.id || record.id,
      note: `close proposal ${record.id}; open at close: ${openAtClose(runtime, caseId)}`
    });
  } catch (err) {
    // A case that cannot go to done from where it is now (already closed).
    log.warn(`${record.id}: the case was not closed: ${err.message}`);
    const text = 'Not applied: the case could not be closed from its current status.';
    note(runtime, caseId, record.id, text);
    return { applied: false, note: text };
  }
  return { applied: 'done' };
}

QuestionStore.registerAnswerHandler(CLOSE_TYPE, { toFact: factOf('close proposal', 'close-proposal'), onAnswered: onCloseAnswered });

// ---- check-approve ----

// The approval card of a check command (spec §6.6). Host lines first: the
// program and its arguments on lines of their own (each word passed
// validateCheck, so none can end its line), where it runs, when, and what
// cannot be promised. The case's title is last. Never cut.
function checkQuestionText(meta, { argv, repo } = {}) {
  const words = Array.isArray(argv) ? argv : [];
  return whole([
    'Run a check command in this case\'s repository?',
    `Program: ${words[0] || ''}`,
    `Arguments: ${words.length > 1 ? words.slice(1).join(' ') : '(none)'}`,
    `Runs in: ${shown(repo)}`,
    'When: at the end of a turn you started, when the repository changed in that turn. Never while you are away.',
    'It runs with your account\'s access. It can do whatever the repository\'s own scripts do, including writing files and using the network. King Louie cannot make it read-only.',
    `Case: ${shown(meta?.title)}`
  ], 'The check question');
}

// `approve` records the approval only when the recorded answer is a press
// and the brief's command and repository are still the ones the card
// showed (the hash in the payload). A changed command is asked about
// again. `refuse` records nothing. Runs inside answerQuestion's systemAction.
function onCheckAnswered(record, fact, { runtime, caseId }) {
  const optionId = record.answer?.optionId;
  if (optionId === 'refuse') return { applied: 'refused' };
  if (optionId !== 'approve') {
    note(runtime, caseId, record.id, CHECK_USE_THE_BUTTONS);
    return { applied: false, note: CHECK_USE_THE_BUTTONS };
  }
  if (!PRESS_CHANNELS.includes(record.answer.channel)) {
    log.warn(`${record.id}: "approve" from ${String(record.answer.channel)} is not a press; the check is not approved.`);
    note(runtime, caseId, record.id, CHECK_NOT_A_PRESS);
    return { applied: false, note: CHECK_NOT_A_PRESS };
  }
  let current = null;
  try {
    current = currentCheck(runtime, caseId);
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
    log.warn(`${record.id}: the check is not approved: ${err.message}`);
  }
  if (!current || current.hash !== record.payload?.hash) {
    note(runtime, caseId, record.id, CHECK_CHANGED);
    if (current) {
      try {
        runtime.requestCheckApproval(caseId);
      } catch (err) {
        log.warn(`${record.id}: the changed check could not be asked about: ${err.message}`);
      }
    }
    return { applied: false, note: CHECK_CHANGED };
  }
  runtime.checks(caseId).approve({ argv: current.argv, repo: current.key, by: 'question', ref: record.id, channel: record.answer.channel });
  return { applied: 'approved' };
}

QuestionStore.registerAnswerHandler(CHECK_TYPE, { toFact: factOf('check command', 'check-approve'), onAnswered: onCheckAnswered });

module.exports = {
  scopeQuestionText, closeQuestionText, checkQuestionText, createdObjectiveQuestion, PRESS_CHANNELS, SCOPE_TYPE, CLOSE_TYPE, CHECK_TYPE,
  CREATED_OBJECTIVE_KEY, QUESTION_MAX_CHARS
};
