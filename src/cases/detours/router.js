// src/cases/detours/router.js
// Routes off-objective work instead of doing it inline (cases stage 5 spec
// §3.4): candidates from the cross-case index, a routing question to the
// owner, and on the answer a link to an existing case, a new case, or
// nothing. Case-file writes run under the case lock through systemAction;
// views carry titles and statuses, never another case's text.
const { DetourLog, FINAL_STATUSES } = require('./log');
const { findSimilarCases, jaccard, OPEN_CASE_STATUSES } = require('../gates');
const { tokenSet, tokenize } = require('../tokenize');
const { resolveCaseType } = require('../case-types');
const { createLogger } = require('../../logging');

const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_SIMILARITY = 0.8;
const CLOSED = Object.freeze(['done', 'abandoned']);

const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const label = (s) => oneLine(s, 150);

// The summary cut to 72 characters at a word boundary.
function cutTitle(summary) {
  const s = oneLine(summary, 300);
  if (s.length <= 72) return s;
  const cut = s.slice(0, 72);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '');
}

function busyError(title) {
  return { ok: false, error: `Case "${title}" is busy with another turn. Try again when it finishes.` };
}

class DetourRouter {
  constructor({ runtime, index = null, classifier = null, getSettings = null, log = null, now = null } = {}) {
    if (!runtime) throw new Error('DetourRouter needs the case runtime.');
    this.runtime = runtime;
    this._index = index;
    this.classifier = classifier;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => runtime.settings();
    this.log = log || createLogger('cases/detours/router');
    this.now = typeof now === 'function' ? now : () => runtime.now();
  }

  get index() {
    return this._index || this.runtime.index;
  }

  // ---- Propose ----

  async propose(caseId, { summary, source = 'detour-tool', serves = null, blocks = false, reason = '', turn = null, extraAttach = [] } = {}) {
    const rt = this.runtime;
    const text = oneLine(summary, 300);
    if (!text) return { ok: false, error: 'A detour needs a summary of the off-objective work.' };
    const meta = rt.getCase(caseId);
    const refused = rt.assertWritable(meta.id, 'Detour.propose');
    if (refused) return refused;
    try {
      return await rt.systemAction(meta.id, 'detour propose', () => this._propose(meta.id, {
        summary: text, source, serves: serves ? oneLine(serves, 200) : null, blocks: blocks === true, reason: oneLine(reason, 200), turn, extraAttach
      }));
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return busyError(meta.title);
      throw err;
    }
  }

  _duplicate(log, rows, summary) {
    const words = tokenSet(summary);
    const nowMs = this.now().getTime();
    for (const d of log.detours(rows).values()) {
      if (jaccard(words, tokenSet(d.proposal.summary)) < DUPLICATE_SIMILARITY) continue;
      if (['proposed', 'held', 'awaiting-mapping'].includes(d.status)) return { existing: d };
      if (d.status === 'declined' && nowMs - Date.parse(d.last.at) <= 30 * DAY_MS) {
        return {
          refusal: {
            ok: false,
            error: `The owner declined this on ${String(d.last.at).slice(0, 10)} (${d.questionId || d.id}). Do not do it in this case and do not propose it again.`
          }
        };
      }
    }
    return {};
  }

  // Open cases ranked for attach options, and recently closed ones as "See also".
  _candidates(meta, summary, reason) {
    const rt = this.runtime;
    const index = this.index;
    const cfg = this.getSettings().detours;
    const scores = new Map();
    const bump = (caseId, n) => {
      if (caseId === meta.id) return;
      scores.set(caseId, (scores.get(caseId) || 0) + n);
    };
    const rows = index.searchCases({ text: `${summary} ${reason}`, forCaseId: meta.id, excludeCaseId: meta.id, limit: 20 });
    const seeAlso = [];
    const recentMs = cfg.recentDays * DAY_MS;
    for (const r of rows) {
      if (OPEN_CASE_STATUSES.includes(r.status)) {
        bump(r.caseId, r.score);
      } else if (CLOSED.includes(r.status)) {
        const at = Date.parse(rt.store.get(r.caseId)?.statusReason?.at || '');
        if (Number.isFinite(at) && this.now().getTime() - at <= recentMs) seeAlso.push({ caseId: r.caseId, title: r.title, status: r.status });
      }
    }
    const words = new Set(tokenize(summary));
    const subjects = new Map();
    for (const hit of index.search({ text: summary, kinds: ['fact'], forCaseId: meta.id, excludeCaseId: meta.id, statuses: OPEN_CASE_STATUSES, limit: 50 })) {
      const toks = tokenize(hit.subject);
      if (!toks.length || !toks.every((t) => words.has(t))) continue;
      if (!subjects.has(hit.caseId)) subjects.set(hit.caseId, new Set());
      subjects.get(hit.caseId).add(String(hit.subject).toLowerCase());
    }
    for (const [caseId, set] of subjects) bump(caseId, set.size);
    if (meta.type === 'software-repo') {
      const type = resolveCaseType(meta.type);
      let brief = {};
      try {
        brief = rt.brief(meta.id).read().data || {};
      } catch {
        brief = {};
      }
      const keys = type.indexKeys({ brief, snapshot: rt.caseTypeSnapshot(meta.id) });
      const onRepo = new Set();
      for (const k of keys) for (const c of index.casesWithKey(k)) if (OPEN_CASE_STATUSES.includes(c.status)) onRepo.add(c.caseId);
      for (const caseId of onRepo) bump(caseId, 3);
    }
    let live = [];
    try {
      const registry = typeof rt.host?.getExecutorRegistry === 'function' ? rt.host.getExecutorRegistry() : null;
      live = registry && typeof registry.liveState === 'function' ? registry.liveState() || [] : [];
    } catch (err) {
      this.log.warn(`Reading live executor jobs failed: ${err.message}`);
    }
    const jobCases = new Set();
    for (const job of live) {
      if (!job || jobCases.has(job.caseId)) continue;
      const jobWords = new Set(tokenize(`${job.executorId || ''} ${job.intent || ''}`));
      if (![...words].some((t) => jobWords.has(t))) continue;
      const other = rt.store.get(job.caseId);
      if (!other || !OPEN_CASE_STATUSES.includes(other.status)) continue;
      jobCases.add(job.caseId);
      bump(job.caseId, 2);
    }
    const ranked = [...scores.entries()]
      .map(([caseId, score]) => ({ caseId, score: Math.round(score * 1000) / 1000, meta: rt.store.get(caseId) }))
      .filter((c) => c.meta && OPEN_CASE_STATUSES.includes(c.meta.status))
      .sort((a, b) => b.score - a.score || String(a.meta.created).localeCompare(String(b.meta.created)));
    return { ranked, seeAlso };
  }

  async _propose(caseId, { summary, source, serves, blocks, reason, turn, extraAttach }) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const rows = log.rows();
    const dup = this._duplicate(log, rows, summary);
    if (dup.refusal) return dup.refusal;
    if (dup.existing) return { ok: true, detour: this._view(meta, dup.existing), questionId: dup.existing.questionId, existing: true };

    const cfg = this.getSettings();
    const { ranked, seeAlso } = this._candidates(meta, summary, reason);
    let brief = {};
    try {
      brief = rt.brief(meta.id).read().data || {};
    } catch {
      brief = {};
    }
    const prefill = {
      title: cutTitle(summary),
      type: meta.type === 'software-repo' && brief.repo ? 'software-repo' : 'general',
      objective: summary,
      successCriteria: [summary],
      body: `Spawned from case "${meta.title}": ${reason || summary}`
    };
    const similar = findSimilarCases({
      title: prefill.title,
      objective: prefill.objective,
      candidates: this.index.openCaseHeads().filter((h) => h.caseId !== meta.id),
      threshold: cfg.duplicates.createSimilarity
    });
    const first = [...(Array.isArray(extraAttach) ? extraAttach : []), ...[...similar.exact, ...similar.similar].map((s) => s.caseId)];
    const attach = [];
    for (const caseId of first) {
      const m = rt.store.get(caseId);
      if (m && m.id !== meta.id && OPEN_CASE_STATUSES.includes(m.status) && !attach.some((a) => a.caseId === m.id)) {
        attach.push({ caseId: m.id, score: ranked.find((r) => r.caseId === m.id)?.score || 0, meta: m });
      }
    }
    const offerNew = attach.length === 0;
    for (const c of ranked) {
      if (attach.length >= cfg.detours.maxCandidates) break;
      if (!attach.some((a) => a.caseId === c.caseId)) attach.push(c);
    }
    const detourId = log.nextId(rows);
    const candidates = attach.map((c, i) => ({ caseId: c.caseId, score: c.score, optionId: `attach-${i + 1}` }));
    const newCase = offerNew ? prefill : null;
    const record = this._question(meta, detourId, { summary, reason, blocks, candidates, newCase });
    const created = rt.createQuestion(meta.id, record, { charge: !blocks });
    const held = Boolean(created && created.held);
    const questionId = held ? null : created.id;
    // Candidates are stored by case id and score only: no other case's title.
    const proposal = log.append({
      type: 'proposal',
      id: detourId,
      at: this.now().toISOString(),
      turnId: turn?.turnId || rt.turns?.get(meta.id)?.turnId || null,
      summary,
      source,
      serves,
      blocks,
      reason,
      questionId,
      held,
      candidates,
      newCase
    });
    rt.records(meta.id).writeJournal('detour', [
      `# Detour ${detourId}`,
      '',
      `Summary: ${summary}`,
      `Reason: ${reason || '—'}`,
      `Source: ${source}${serves ? ` (serves: ${serves})` : ''}`,
      `Blocks this case: ${blocks ? 'yes' : 'no'}`,
      `Options: ${record.options.map((o) => o.id).join(', ')}`,
      held ? 'Question held: the daily question allowance is spent.' : `Question: ${questionId}`
    ].join('\n'), this.now());
    if (blocks) rt.addRelation(meta.id, { id: `pending:${detourId}`, relation: 'blocked-by', note: summary, detour: detourId });
    rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
    const view = this._view(meta, { id: detourId, proposal, questionId, status: held ? 'held' : 'proposed', last: null });
    return { ok: true, detour: { ...view, seeAlso: seeAlso.map((s) => ({ title: s.title, status: s.status })) }, questionId, ...(held ? { held: true } : {}) };
  }

  // The routing question, built from the stored candidates and the current
  // titles and statuses of the cases they name.
  _question(meta, detourId, { summary, reason, blocks, candidates = [], newCase = null }) {
    const rt = this.runtime;
    const options = [];
    const targets = {};
    for (const c of candidates) {
      const m = rt.store.get(c.caseId);
      options.push({ id: c.optionId, label: `Attach to "${label(m ? m.title : c.caseId)}" (${m ? m.status : 'gone'})` });
      targets[c.optionId] = c.caseId;
    }
    if (newCase) {
      options.push({ id: 'new', label: `Start a new case: "${label(newCase.title)}"` });
      targets.new = null;
    }
    options.push({ id: 'decline', label: 'Drop it' });
    targets.decline = null;
    let objective = '';
    try {
      objective = rt.brief(meta.id).read().data?.objective || '';
    } catch {
      objective = '';
    }
    const text = `${blocks ? 'Blocker: ' : ''}Detour from "${meta.title}" (${detourId}): ${summary}. It does not serve "${oneLine(objective, 200) || meta.title}"${reason ? ` (${reason})` : ''}. Where should it go?`;
    return {
      kind: 'question',
      urgency: blocks ? 'high' : 'low',
      defaultOnSilence: 'hold',
      expiresAt: null,
      options,
      text,
      payload: {
        type: 'detour',
        detourId,
        blocks: Boolean(blocks),
        targets,
        about: { subject: 'detour', attr: detourId },
        disclosable: false,
        key: `detour:${detourId}`
      }
    };
  }

  // Held proposals get their question once the daily allowance allows.
  releaseHeld(caseId) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const released = [];
    for (const d of log.detours().values()) {
      if (d.status !== 'held') continue;
      const created = rt.createQuestion(meta.id, this._question(meta, d.id, d.proposal), { charge: true });
      if (created.held) break;
      log.append({ type: 'released', id: d.id, at: this.now().toISOString(), questionId: created.id });
      released.push(d.id);
    }
    if (released.length) rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
    return released;
  }

  // ---- Resolve ----

  // `force` skips the similar-case refusal when creating a new case. Only the
  // IPC `case:resolveDetour` path passes it, after the owner explicitly chose
  // to create a case despite a similar one. The router never sets it on its
  // own (spec §3.4), and the Detour tool's schema must not expose it.
  async resolve(caseId, detourId, { optionId, by = 'in-app', title = null, objective = null, force = false } = {}) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    try {
      return await rt.systemAction(meta.id, `detour ${detourId}: ${optionId}`, () => this._resolve(meta.id, detourId, { optionId, by, title, objective, force }));
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return busyError(meta.title);
      throw err;
    }
  }

  async _resolve(caseId, detourId, { optionId, by, title, objective, force }) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const d = log.detours().get(detourId);
    if (!d) return { ok: false, error: `There is no detour ${detourId} in this case.` };
    if (d.last && FINAL_STATUSES.includes(d.last.status)) {
      return { ok: true, detour: this._view(meta, d), linkedCaseId: d.last.targetCaseId || null, existing: true };
    }
    const p = d.proposal;
    // An answer in words that the model mapped: both cases journal the words.
    const words = d.status === 'awaiting-mapping' && d.last?.text ? `\nOwner's words (mapped by the model): "${oneLine(d.last.text, 500)}"` : '';
    const at = () => this.now().toISOString();
    const resolution = (status, extra = {}) => log.append({
      type: 'resolution', id: detourId, at: at(), optionId, by: String(by), status, targetCaseId: null, error: null, ...extra
    });
    const finish = (status, targetCaseId, extra = {}) => {
      rt.removeRelation(meta.id, { id: `pending:${detourId}` });
      resolution(status, { targetCaseId, ...extra });
      rt.records(meta.id).writeJournal('detour', `# Detour ${detourId} resolved\n\nOption: ${optionId} (${by})\nOutcome: ${status}${targetCaseId ? `\nCase: ${targetCaseId}` : ''}${words}`, this.now());
      rt._reindex(meta.id);
      rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
      return { ok: true, detour: this._view(meta, log.detours().get(detourId)), linkedCaseId: targetCaseId };
    };
    const retry = async (error, extraAttach = []) => {
      resolution('failed', { error });
      const again = await this._propose(meta.id, {
        summary: p.summary, source: p.source, serves: p.serves, blocks: p.blocks, reason: p.reason, turn: null, extraAttach
      });
      return { ok: false, error, retry: again };
    };

    if (optionId === 'decline') return finish('declined', null);

    if (/^attach-\d+$/.test(String(optionId))) {
      const cand = (p.candidates || []).find((c) => c.optionId === optionId);
      if (!cand) return { ok: false, error: `Option "${optionId}" is not one of ${detourId}'s options.` };
      const target = rt.store.get(cand.caseId);
      if (!target || !OPEN_CASE_STATUSES.includes(target.status)) {
        return retry(`Case "${target ? target.title : cand.caseId}" is ${target ? target.status : 'gone'}; pick another option.`);
      }
      try {
        await rt.systemAction(target.id, `detour ${detourId} from ${meta.slug}`, async () => {
          rt.addRelation(target.id, { id: meta.id, relation: p.blocks ? 'blocks' : 'related', note: p.summary, detour: detourId });
          new DetourLog(target.dir).append({
            type: 'incoming', id: detourId, at: at(), fromCaseId: meta.id, fromTitle: meta.title, summary: p.summary, reason: p.reason, blocks: p.blocks
          });
          rt.records(target.id).writeJournal('detour', `# Incoming detour ${detourId} from "${meta.title}"\n\nSummary: ${p.summary}\nReason: ${p.reason || '—'}\nBlocks "${meta.title}": ${p.blocks ? 'yes' : 'no'}${words}`, this.now());
          if (target.status === 'active') {
            rt.wakeups(target.id).register({
              kind: 'detours:incoming', at: at(), payload: { key: `incoming:${detourId}`, detourId, fromCaseId: meta.id }, createdBy: 'detours'
            });
          }
          rt._notify('case:changed', { caseId: target.id, what: 'detours' });
        });
      } catch (err) {
        if (err && err.code === 'CASE_BUSY') return busyError(target.title);
        throw err;
      }
      rt.addRelation(meta.id, { id: target.id, relation: p.blocks ? 'blocked-by' : 'related', note: p.summary, detour: detourId });
      return finish('attached', target.id);
    }

    if (optionId === 'new') {
      if (!p.newCase) return { ok: false, error: `Option "new" is not one of ${detourId}'s options.` };
      let created;
      try {
        created = await rt.createCase({
          title: title && String(title).trim() ? String(title).trim() : p.newCase.title,
          type: p.newCase.type,
          objective: objective && String(objective).trim() ? String(objective).trim() : p.newCase.objective,
          force: force === true
        });
      } catch (err) {
        if (err && err.code === 'SIMILAR_CASES') return retry(err.message, err.similar.map((s) => s.caseId));
        throw err;
      }
      await rt.systemAction(created.id, `detour ${detourId} from ${meta.slug}`, async () => {
        rt.brief(created.id).update('successCriteria', p.newCase.successCriteria, { provenance: 'model' });
        rt.brief(created.id).writeBody(p.newCase.body);
        rt.records(created.id).writeJournal('detour', `# Spawned by detour ${detourId} from "${meta.title}"\n\nSummary: ${p.summary}\nReason: ${p.reason || '—'}${words}`, this.now());
        rt.addRelation(created.id, { id: meta.id, relation: 'related', note: p.summary, detour: detourId });
        if (p.blocks) rt.addRelation(created.id, { id: meta.id, relation: 'blocks', note: p.summary, detour: detourId });
      }, { commitMessage: `spawned from ${meta.slug} (${detourId})` });
      rt.addRelation(meta.id, { id: created.id, relation: 'spawned', note: p.summary, detour: detourId });
      if (p.blocks) rt.addRelation(meta.id, { id: created.id, relation: 'blocked-by', note: p.summary, detour: detourId });
      rt._reindex(created.id);
      return finish('created', created.id);
    }

    return { ok: false, error: `Option "${optionId}" is not one of ${detourId}'s options.` };
  }

  // ---- Reconcile ----

  // Answered routing questions with no resolution: an option resolves; a
  // text-only answer waits for the model to map it (awaiting-mapping).
  // The case panel calls this on every render, so it first checks without
  // the case lock and takes the lock (and runs git) only when there is work.
  async reconcile(caseId) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    if (!this._hasAnsweredProposal(meta)) return { applied: [] };
    try {
      return await rt.systemAction(meta.id, 'detour reconcile', async () => {
        const applied = [];
        const log = new DetourLog(meta.dir);
        const questions = rt.questions(meta.id);
        for (const d of log.detours().values()) {
          if (d.status !== 'proposed' || !d.questionId) continue;
          const q = questions.get(d.questionId);
          if (!q) continue;
          if (q.closed) {
            const r = await this._resolve(meta.id, d.id, { optionId: 'decline', by: q.closed.by });
            if (r.ok) applied.push(d.id);
            continue;
          }
          if (!q.answer) continue;
          if (q.answer.optionId) {
            const r = await this._resolve(meta.id, d.id, { optionId: q.answer.optionId, by: q.answer.channel });
            if (r.ok || r.retry) applied.push(d.id);
          } else {
            log.append({
              type: 'resolution', id: d.id, at: this.now().toISOString(), optionId: null, by: q.answer.channel,
              status: 'awaiting-mapping', targetCaseId: null, error: null, text: oneLine(q.answer.text, 500)
            });
            applied.push(d.id);
          }
        }
        if (applied.length) rt._notify('case:changed', { caseId: meta.id, what: 'detours' });
        return { applied };
      });
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') return { applied: [], busy: true };
      throw err;
    }
  }

  // Lock-free read: a proposed detour whose routing question is answered or closed.
  _hasAnsweredProposal(meta) {
    const questions = this.runtime.questions(meta.id);
    for (const d of new DetourLog(meta.dir).detours().values()) {
      if (d.status !== 'proposed' || !d.questionId) continue;
      const q = questions.get(d.questionId);
      if (q && (q.answer || q.closed)) return true;
    }
    return false;
  }

  // ---- Views ----

  _view(meta, d) {
    let options = [];
    if (d.questionId) {
      const q = this.runtime.questions(meta.id).get(d.questionId);
      if (q) options = q.options.map((o) => ({ optionId: o.id, label: o.label }));
    } else {
      options = this._question(meta, d.id, d.proposal).options.map((o) => ({ optionId: o.id, label: o.label }));
    }
    return {
      id: d.id,
      summary: d.proposal.summary,
      reason: d.proposal.reason,
      blocks: Boolean(d.proposal.blocks),
      status: d.status,
      questionId: d.questionId || null,
      options,
      at: d.proposal.at
    };
  }

  list(caseId) {
    const rt = this.runtime;
    const meta = rt.getCase(caseId);
    const detours = [...new DetourLog(meta.dir).detours().values()].map((d) => this._view(meta, d));
    const related = (Array.isArray(meta.related) ? meta.related : [])
      .filter((r) => r && typeof r.id === 'string' && !r.id.startsWith('pending:'))
      .map((r) => {
        const other = rt.store.get(r.id);
        return {
          caseId: r.id,
          title: other ? other.title : null,
          status: other ? other.status : null,
          relation: r.relation,
          ...(r.detour ? { detour: r.detour } : {}),
          ...(other ? {} : { gone: true })
        };
      });
    return { detours, related };
  }

  // Orientation lines: open proposals, answers awaiting mapping, incoming detours.
  orientationLines(caseId) {
    const meta = this.runtime.getCase(caseId);
    const log = new DetourLog(meta.dir);
    const rows = log.rows();
    const lines = [];
    for (const d of log.detours(rows).values()) {
      if (d.status === 'proposed') lines.push(`${d.id} proposed${d.proposal.blocks ? ' (blocks this case)' : ''}: ${oneLine(d.proposal.summary, 160)} — routing question ${d.questionId} is waiting for the owner. Do not do this work here.`);
      if (d.status === 'held') lines.push(`${d.id} held: ${oneLine(d.proposal.summary, 160)} — the routing question goes out when the daily question allowance allows.`);
      if (d.status === 'awaiting-mapping') lines.push(`The owner answered routing question ${d.questionId} in words: "${oneLine(d.last.text, 300)}". Call Detour "resolve" with the option that matches, or ask.`);
    }
    for (const r of log.incoming(rows)) {
      lines.push(`Incoming detour ${r.id} from "${oneLine(r.fromTitle, 120)}": ${oneLine(r.summary, 160)}${r.reason ? ` (${oneLine(r.reason, 160)})` : ''}${r.blocks ? ' — it blocks that case' : ''}`);
    }
    return lines;
  }
}

module.exports = { DetourRouter, cutTitle };
