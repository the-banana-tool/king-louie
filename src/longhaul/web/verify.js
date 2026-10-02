'use strict';
// The LongHaul verify page. Session text is untrusted: every string from the
// API is set with textContent, never parsed as markup. The API token comes
// from the URL fragment (never sent to the server by the browser) and goes
// out only in the Authorization header of same-origin requests.
(() => {
  const KINDS = ['user-said', 'tool-observed', 'decision', 'superseded', 'multi-hop', 'abstain'];
  const STATUS_TEXT = { pending: 'Pending', accepted: 'Accepted', edited: 'Edited, not accepted', rejected: 'Rejected', skipped: 'Skipped' };
  const token = location.hash.slice(1);
  const $ = (id) => document.getElementById(id);

  let state = null;
  let currentId = null;
  let view = null;
  let editing = false;
  let busy = false;
  let ended = false;
  let contextAround = null;
  let contextBefore = 5;
  let quitArmed = null;

  // ---- helpers -----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function fmtNum(n) {
    return Number(n).toLocaleString();
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts || '');
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  let flashTimer = null;
  function flash(text, kind) {
    const node = $('flash');
    node.textContent = text || '';
    node.className = `flash${kind ? ` ${kind}` : ''}`;
    node.title = text || '';
    clearTimeout(flashTimer);
    if (text && kind !== 'error') flashTimer = setTimeout(() => { node.textContent = ''; }, 6000);
  }

  function notice(title, body) {
    const node = clear($('notice'));
    if (!title) { node.hidden = true; return; }
    node.appendChild(el('h2', null, title));
    if (body) node.appendChild(el('p', null, body));
    node.hidden = false;
  }

  async function api(path, body) {
    const opts = { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      const err = new Error('The review server is not answering. Is `longhaul verify --web` still running?');
      err.status = 0;
      throw err;
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((json && json.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.errors = (json && json.errors) || [];
      throw err;
    }
    return json;
  }

  function fail(err) {
    if (err.status === 401) notice('Missing or wrong token', 'Open the full address printed in the terminal; it ends with #<token>.');
    flash(err.message, 'error');
  }

  // ---- rail --------------------------------------------------------------

  function renderState() {
    $('session-title').textContent = state.title === state.sessionId ? state.sessionId : `${state.title} (${state.sessionId})`;
    document.title = `Verify ${state.sessionId}`;
    const total = state.queue.length;
    const decided = state.queue.filter((q) => q.status === 'accepted' || q.status === 'rejected').length;
    const progress = clear($('progress-text'));
    progress.appendChild(el('strong', null, `${decided} / ${total}`));
    progress.appendChild(document.createTextNode(' decided this review'));
    $('progress-bar').style.width = total ? `${Math.round((decided / total) * 100)}%` : '0%';

    const targets = clear($('targets'));
    const row = (label, value, target) => {
      targets.appendChild(el('dt', null, label));
      const dd = el('dd', null, `${value} / ${target}`);
      if (target && value >= target) dd.classList.add('met');
      targets.appendChild(dd);
    };
    row('Verified in session', state.verified.total, state.targets.total);
    row('abstain', state.verified.byKind.abstain || 0, state.targets.abstain);
    row('superseded', state.verified.byKind.superseded || 0, state.targets.superseded);
    const minor = KINDS.filter((k) => k !== 'abstain' && k !== 'superseded').map((k) => `${k} ${state.verified.byKind[k] || 0}`);
    minor.push(`unverified ${state.unverified}`);
    targets.appendChild(el('div', 'target-minor', minor.join(' · ')));

    const list = clear($('queue'));
    for (const q of state.queue) {
      const li = el('li');
      const b = el('button');
      b.type = 'button';
      b.dataset.id = q.id;
      b.title = `${q.id} - ${q.kind} - ${STATUS_TEXT[q.status]}`;
      if (q.id === currentId) b.classList.add('current');
      b.appendChild(el('i', `dot ${q.status}`));
      const mid = el('span');
      mid.appendChild(el('div', 'q-name', q.id));
      mid.appendChild(el('div', 'q-kind', q.kind));
      b.appendChild(mid);
      b.appendChild(el('span', 'q-at', `#${q.askAtSeq}`));
      b.addEventListener('click', () => { if (!ended) show(q.id); });
      li.appendChild(b);
      list.appendChild(li);
    }
    const cur = list.querySelector('button.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // ---- message cards -----------------------------------------------------

  function fitClamp(card) {
    const text = card.querySelector('.msg-text');
    const more = card.querySelector('.show-all');
    if (!text || !more || !card.open || text.dataset.expanded === '1') return;
    text.classList.add('clamped');
    const overflowing = text.scrollHeight > text.clientHeight + 4;
    if (!overflowing) text.classList.remove('clamped');
    more.hidden = !overflowing;
  }

  function messageCard(m, { open = true, role = null, tags = [], focus = false } = {}) {
    const card = el('details', 'msg');
    if (role) card.classList.add(`is-${role}`);
    if (focus) card.classList.add('focus');
    card.open = open;
    const summary = el('summary');
    summary.appendChild(el('span', 'seq', `#${m.seq}`));
    if (m.missing) {
      summary.appendChild(el('span', 'sender', 'not in the session'));
      card.appendChild(summary);
      card.appendChild(el('div', 'missing', `Message #${m.seq} is not in this session.`));
      return card;
    }
    const tool = m.sender === 'toolUse' || m.sender === 'toolResult';
    summary.appendChild(el('span', `sender${m.sender === 'user' ? ' user' : ''}${tool ? ' tool' : ''}`, m.label || m.sender));
    summary.appendChild(el('span', 'when', fmtTime(m.timestamp)));
    summary.appendChild(el('span', 'chars', `${fmtNum(m.chars)} chars`));
    for (const t of tags) summary.appendChild(el('span', 'tag', t));
    summary.appendChild(el('span', 'grow'));
    const ctx = el('button', 'link-btn', 'context');
    ctx.type = 'button';
    ctx.title = `Show the messages around #${m.seq}`;
    ctx.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); loadContext(m.seq, 5); });
    summary.appendChild(ctx);
    card.appendChild(summary);

    const body = el('div', 'msg-body');
    const text = el('pre', `msg-text${tool ? ' mono' : ''}`, m.text);
    body.appendChild(text);
    const more = el('div', 'more');
    const all = el('button', 'link-btn show-all', 'Show all');
    all.type = 'button';
    all.hidden = true;
    all.addEventListener('click', () => {
      const expanded = text.dataset.expanded === '1';
      text.dataset.expanded = expanded ? '' : '1';
      text.classList.toggle('clamped', expanded);
      all.textContent = expanded ? 'Show all' : 'Show less';
    });
    more.appendChild(all);
    if (m.truncated) more.appendChild(el('span', null, `Showing the first ${fmtNum(m.text.length)} of ${fmtNum(m.chars)} characters.`));
    body.appendChild(more);
    card.appendChild(body);
    card.addEventListener('toggle', () => fitClamp(card));
    return card;
  }

  function fitAll(root) {
    requestAnimationFrame(() => { for (const c of root.querySelectorAll('details.msg')) fitClamp(c); });
  }

  // ---- question ----------------------------------------------------------

  function renderQuestion() {
    const q = view.question;
    $('head-card').hidden = false;
    const kind = $('q-kind');
    kind.textContent = q.kind;
    kind.className = `badge ${q.kind}`;
    $('q-at').textContent = `asked at #${q.askAtSeq}`;
    $('q-distance').textContent = view.distance
      ? `${fmtNum(view.distance.messages)} messages / ~${fmtNum(view.distance.estTokens)} tokens back · ${view.bucket}`
      : 'no evidence distance';
    const pos = state.queue.findIndex((x) => x.id === q.id);
    $('q-id').textContent = `${q.id} · ${pos + 1} of ${state.queue.length}`;
    const st = $('q-status');
    st.textContent = STATUS_TEXT[view.status] || '';
    st.className = `meta status-text ${view.status}`;

    const banner = $('abstain-banner');
    banner.hidden = q.kind !== 'abstain';
    banner.textContent = `Check the fact is never stated before #${q.askAtSeq} — the author saw only ~20 messages.`;

    $('q-question').textContent = q.question;
    $('q-answer').textContent = q.answer;

    const extras = clear($('q-extras'));
    const addExtra = (label, build) => {
      extras.appendChild(el('dt', null, label));
      const dd = el('dd');
      build(dd);
      extras.appendChild(dd);
    };
    if (Array.isArray(q.acceptableAnswers) && q.acceptableAnswers.length) {
      addExtra('Also accept', (dd) => { for (const a of q.acceptableAnswers) dd.appendChild(el('span', 'chip', a)); });
    }
    addExtra('Evidence', (dd) => { dd.textContent = Array.isArray(q.evidenceSeqs) && q.evidenceSeqs.length ? q.evidenceSeqs.map((s) => `#${s}`).join(', ') : 'none'; });
    if (q.supersededBy !== null && q.supersededBy !== undefined) addExtra('Superseded by', (dd) => { dd.textContent = `#${q.supersededBy}`; });
    if (q.notes) addExtra('Notes', (dd) => { dd.textContent = q.notes; });
    if (view.status === 'rejected' && q.rejectReason) addExtra('Reject reason', (dd) => { dd.textContent = q.rejectReason; });

    renderErrors($('q-errors'), view.errors, 'Cannot be accepted as it is:');

    const ev = clear($('evidence'));
    $('evidence-section').hidden = false;
    if (!view.evidence.length) ev.appendChild(el('p', 'context-hint', q.kind === 'abstain' ? 'An abstain question has no evidence: the answer is not in the session before the ask.' : 'No evidence seqs.'));
    for (const m of view.evidence) ev.appendChild(messageCard(m, { open: true, role: 'evidence' }));

    const at = clear($('askat'));
    $('askat-section').hidden = false;
    at.appendChild(messageCard(view.askAt, { open: false, role: 'askat', tags: ['the question replaces this message'] }));

    $('context-section').hidden = true;
    clear($('context'));
    contextAround = null;
    fitAll($('main'));
    updateButtons();
  }

  function renderErrors(node, errors, title) {
    clear(node);
    if (!errors || !errors.length) { node.hidden = true; return; }
    node.appendChild(el('strong', null, title));
    const ul = el('ul');
    for (const e of errors) ul.appendChild(el('li', null, e));
    node.appendChild(ul);
    node.hidden = false;
  }

  async function show(id, { keepFlash = false } = {}) {
    if (editing) closeEdit();
    closeReject();
    try {
      view = await api(`/api/question/${encodeURIComponent(id)}`);
    } catch (err) { fail(err); return; }
    currentId = id;
    if (!keepFlash) flash('');
    renderQuestion();
    renderState();
    $('main').scrollTop = 0;
  }

  // ---- context -----------------------------------------------------------

  async function loadContext(seq, before) {
    contextAround = seq;
    contextBefore = before;
    let res;
    try { res = await api(`/api/context?around=${seq}&before=${before}&after=2`); } catch (err) { fail(err); return; }
    const q = view.question;
    const evidence = new Set(q.evidenceSeqs || []);
    const box = clear($('context'));
    $('context-title').textContent = `Surrounding messages around #${seq}`;
    if (res.messages.length && res.messages[0].seq > 1 && before < 50) {
      const earlier = el('button', 'btn', 'Load 5 earlier');
      earlier.type = 'button';
      earlier.addEventListener('click', () => loadContext(seq, Math.min(50, contextBefore + 5)));
      const p = el('p', 'context-hint');
      p.appendChild(earlier);
      box.appendChild(p);
    }
    for (const m of res.messages) {
      const tags = [];
      if (evidence.has(m.seq)) tags.push('evidence');
      if (m.seq === q.askAtSeq) tags.push('asked here');
      if (m.seq > q.askAtSeq) tags.push('after the ask');
      box.appendChild(messageCard(m, { open: true, focus: m.seq === seq, tags, role: evidence.has(m.seq) ? 'evidence' : (m.seq === q.askAtSeq ? 'askat' : null) }));
    }
    const section = $('context-section');
    section.hidden = false;
    $('context-details').open = true;
    fitAll(box);
    requestAnimationFrame(() => {
      // Land the focused message just below the sticky header card.
      const main = $('main');
      const focus = box.querySelector('.msg.focus') || section;
      const offset = focus.getBoundingClientRect().top - main.getBoundingClientRect().top;
      main.scrollTo({ top: main.scrollTop + offset - $('head-card').offsetHeight - 16, behavior: 'smooth' });
    });
  }

  // ---- decisions ---------------------------------------------------------

  function queueIndex() {
    return state.queue.findIndex((q) => q.id === currentId);
  }

  function nextOpen() {
    const i = queueIndex();
    const n = state.queue.length;
    for (const wanted of [['pending'], ['edited', 'skipped']]) {
      for (let k = 1; k <= n; k++) {
        const q = state.queue[(i + k) % n];
        if (wanted.includes(q.status) && q.id !== currentId) return q.id;
      }
    }
    return null;
  }

  async function afterDecision(message) {
    const next = nextOpen();
    if (next) {
      await show(next, { keepFlash: true });
      flash(message, 'ok');
    } else {
      await show(currentId, { keepFlash: true });
      flash(message, 'ok');
      notice('Every question has a decision', 'Quit to end the review and print the summary in the terminal.');
    }
  }

  async function run(fn) {
    if (busy || ended || !currentId) return;
    busy = true;
    updateButtons();
    try { await fn(); } finally { busy = false; updateButtons(); }
  }

  function accept() {
    if (editing) { flash('Save or cancel the edit first.', 'error'); return; }
    run(async () => {
      try {
        const res = await api('/api/accept', { id: currentId });
        state = res.state;
        await afterDecision(`Accepted ${currentId}.`);
      } catch (err) {
        if (err.status === 422) {
          view.errors = err.errors;
          renderErrors($('q-errors'), err.errors, 'Cannot accept:');
          flash('Cannot accept: fix it with Edit, or reject it.', 'error');
        } else fail(err);
      }
    });
  }

  function skip() {
    if (editing) closeEdit();
    run(async () => {
      try {
        const res = await api('/api/skip', { id: currentId });
        state = res.state;
        await afterDecision(`Skipped ${currentId}.`);
      } catch (err) { fail(err); }
    });
  }

  function openReject() {
    if (ended || !currentId || view.status === 'rejected') return;
    if (editing) closeEdit();
    $('reject-form').hidden = false;
    for (const id of ['btn-accept', 'btn-edit', 'btn-reject', 'btn-skip', 'btn-context']) $(id).hidden = true;
    $('reject-reason').value = '';
    $('reject-reason').focus();
  }

  function closeReject() {
    $('reject-form').hidden = true;
    for (const id of ['btn-accept', 'btn-edit', 'btn-reject', 'btn-skip', 'btn-context']) $(id).hidden = false;
  }

  function reject() {
    const reason = $('reject-reason').value.trim();
    run(async () => {
      try {
        const res = await api('/api/reject', { id: currentId, reason });
        state = res.state;
        closeReject();
        await afterDecision(`Rejected ${currentId}.`);
      } catch (err) { fail(err); }
    });
  }

  // ---- edit --------------------------------------------------------------

  function openEdit() {
    if (ended || !currentId || view.status === 'rejected') return;
    closeReject();
    const q = view.question;
    $('f-question').value = q.question || '';
    $('f-answer').value = q.answer || '';
    $('f-acceptable').value = (q.acceptableAnswers || []).join('\n');
    $('f-evidence').value = (q.evidenceSeqs || []).join(', ');
    $('f-askat').value = String(q.askAtSeq ?? '');
    const kind = clear($('f-kind'));
    for (const k of KINDS) {
      const o = el('option', null, k);
      o.value = k;
      kind.appendChild(o);
    }
    kind.value = q.kind;
    $('f-superseded').value = q.supersededBy === null || q.supersededBy === undefined ? '' : String(q.supersededBy);
    renderErrors($('edit-errors'), [], '');
    editing = true;
    $('main').classList.add('editing');
    $('edit-card').hidden = false;
    $('edit-card').scrollIntoView({ block: 'start' });
    $('f-question').focus();
    updateButtons();
  }

  function closeEdit() {
    editing = false;
    $('main').classList.remove('editing');
    $('edit-card').hidden = true;
    updateButtons();
  }

  function readForm() {
    const errors = [];
    const whole = (raw, name, { optional = false } = {}) => {
      const s = raw.trim();
      if (s === '' && optional) return null;
      if (!/^-?\d+$/.test(s)) { errors.push(`${name}: a whole number${optional ? ', or empty' : ''}`); return null; }
      return Number(s);
    };
    const ev = $('f-evidence').value.split(/[\s,]+/).filter(Boolean);
    const evidenceSeqs = [];
    for (const s of ev) {
      if (/^-?\d+$/.test(s)) evidenceSeqs.push(Number(s));
      else { errors.push('evidenceSeqs: whole numbers separated by commas'); break; }
    }
    const fields = {
      question: $('f-question').value.trim(),
      answer: $('f-answer').value.trim(),
      acceptableAnswers: $('f-acceptable').value.split('\n').map((s) => s.trim()).filter(Boolean),
      evidenceSeqs,
      askAtSeq: whole($('f-askat').value, 'askAtSeq'),
      kind: $('f-kind').value,
      supersededBy: whole($('f-superseded').value, 'supersededBy', { optional: true })
    };
    return { fields, errors };
  }

  function saveEdit() {
    const { fields, errors } = readForm();
    if (errors.length) { renderErrors($('edit-errors'), errors, 'Not saved:'); return; }
    run(async () => {
      try {
        const res = await api('/api/edit', { id: currentId, fields });
        state = res.state;
        closeEdit();
        await show(currentId, { keepFlash: true });
        flash('Edit saved. It is not verified until you Accept.', 'ok');
      } catch (err) {
        if (err.status === 422) renderErrors($('edit-errors'), err.errors, 'Not valid yet (not saved):');
        else fail(err);
      }
    });
  }

  // ---- navigation, quit --------------------------------------------------

  function step(delta) {
    if (ended || !state) return;
    const i = queueIndex() + delta;
    if (i >= 0 && i < state.queue.length) show(state.queue[i].id);
  }

  function quit() {
    if (ended) return;
    const btn = $('btn-quit');
    if (!quitArmed) {
      btn.textContent = 'Really quit?';
      quitArmed = setTimeout(() => { quitArmed = null; btn.textContent = 'Quit'; }, 3000);
      return;
    }
    clearTimeout(quitArmed);
    quitArmed = null;
    run(async () => {
      try {
        const res = await api('/api/quit', {});
        ended = true;
        const c = res.counts;
        notice('Review ended', `${c.accepted} accepted, ${c.edited} edited, ${c.rejected} rejected, ${c.skipped} skipped. The summary is in the terminal; you can close this tab.`);
        $('main').scrollTop = 0;
        btn.textContent = 'Ended';
        flash('');
      } catch (err) { fail(err); }
    });
  }

  function updateButtons() {
    const none = ended || busy || !currentId;
    const rejected = view && view.status === 'rejected';
    const i = state ? queueIndex() : -1;
    $('btn-accept').disabled = none || rejected || (view && view.status === 'accepted');
    $('btn-edit').disabled = none || rejected || editing;
    $('btn-reject').disabled = none || rejected;
    $('btn-skip').disabled = none || rejected;
    $('btn-context').disabled = none;
    $('btn-prev').disabled = ended || i <= 0;
    $('btn-next').disabled = ended || !state || i >= state.queue.length - 1;
    $('btn-quit').disabled = ended || busy;
  }

  function typing(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('reject-form').hidden) { closeReject(); e.preventDefault(); return; }
      if (editing) { closeEdit(); e.preventDefault(); return; }
    }
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || ended) return;
    const actions = {
      a: accept,
      e: openEdit,
      r: openReject,
      s: skip,
      j: () => step(1),
      k: () => step(-1),
      c: () => { if (view) loadContext(view.question.askAtSeq, 5); }
    };
    const fn = actions[e.key];
    if (!fn) return;
    e.preventDefault();
    const b = { a: 'btn-accept', r: 'btn-reject', s: 'btn-skip', e: 'btn-edit' }[e.key];
    if (b && $(b).disabled) return;
    fn();
  });

  $('btn-accept').addEventListener('click', accept);
  $('btn-edit').addEventListener('click', openEdit);
  $('btn-reject').addEventListener('click', openReject);
  $('btn-skip').addEventListener('click', skip);
  $('btn-next').addEventListener('click', () => step(1));
  $('btn-prev').addEventListener('click', () => step(-1));
  $('btn-context').addEventListener('click', () => { if (view) loadContext(view.question.askAtSeq, 5); });
  $('btn-quit').addEventListener('click', quit);
  $('reject-cancel').addEventListener('click', closeReject);
  $('reject-form').addEventListener('submit', (e) => { e.preventDefault(); reject(); });
  $('edit-form').addEventListener('submit', (e) => { e.preventDefault(); saveEdit(); });
  $('edit-cancel').addEventListener('click', closeEdit);
  window.addEventListener('resize', () => fitAll($('main')));

  // ---- start -------------------------------------------------------------

  async function start() {
    updateButtons();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      notice('Missing token', 'Open the full address printed in the terminal; it ends with #<token>.');
      return;
    }
    try {
      state = await api('/api/state');
    } catch (err) { fail(err); return; }
    renderState();
    const first = state.queue.find((q) => q.status === 'pending') || state.queue[0];
    if (!first) { notice('Nothing to verify', 'Every question in this session is already verified.'); return; }
    await show(first.id);
  }

  start();
})();
