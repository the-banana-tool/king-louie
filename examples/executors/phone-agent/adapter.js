'use strict';
// Reference King Louie executor adapter for a phone agent behind a generic
// HTTP errands API (openapi.yaml in this folder). It reaches the network only
// through host.fetch, which King Louie limits to this package's origins.

const JOB_STATES = Object.freeze({
  queued: 'submitted', running: 'running', waiting: 'waiting', done: 'done', failed: 'failed', cancelled: 'cancelled'
});
const STATUS_CODES = Object.freeze({ 401: 'auth', 403: 'auth', 404: 'not-found', 409: 'conflict', 422: 'invalid', 429: 'rate-limited' });
// Payload keys the node defines; anything else is a payloadSchema field.
const BASE_KEYS = new Set(['recipients', 'text', 'facts', 'attemptsPerContact', 'expect']);

class ErrandsError extends Error {
  constructor(code, message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ErrandsError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function codeFor(status) {
  if (STATUS_CODES[status]) return STATUS_CODES[status];
  return status >= 500 ? 'unavailable' : 'error';
}

function createAdapter(config, host) {
  const base = String(config.baseUrl).replace(/\/+$/, '');

  async function call(method, pathname, { body, headers = {}, query = {} } = {}) {
    const url = new URL(`${base}${pathname}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await host.fetch(url.toString(), {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${config.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (err) {
      throw new ErrandsError('unavailable', `errands API unreachable: ${err.message}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const retryAfterSeconds = res.status === 429 ? Number(res.headers.get('retry-after')) || null : null;
      throw new ErrandsError(codeFor(res.status), json?.error?.message || `errands API answered ${res.status}`, { status: res.status, retryAfterSeconds });
    }
    return json;
  }

  const contactsOf = (j) => (j?.contacts || []).map((c) => ({ id: c.id, address: c.address, normalizedAddress: c.normalizedAddress }));

  return {
    capabilities() {
      return { capabilities: ['call', 'voicemail'], cannot: ['web-form', 'email', 'sms'], constraints: {}, cost: {}, latency: 'async-hours', state: 'poll' };
    },

    // job.recipients are the node's normalized addresses, in payload order.
    async submit(job, envelope) {
      const p = job.payload || {};
      const extra = {};
      for (const k of Object.keys(p)) if (!BASE_KEYS.has(k)) extra[k] = p[k];
      const body = {
        externalRef: job.externalRef,
        intent: job.intent || envelope?.intent || '',
        text: p.text,
        recipients: (p.recipients || []).map((r, i) => ({ address: job.recipients[i], ...(r.name ? { name: r.name } : {}) })),
        facts: (job.facts || []).map((f) => ({ id: f.id, statement: f.stmt, value: f.value })),
        expect: (Array.isArray(p.expect) ? p.expect : []).map((e, i) => ({ key: `q${i + 1}`, question: e.question })),
        ...(job.maxCostUsd === null || job.maxCostUsd === undefined ? {} : { maxCostUsd: job.maxCostUsd }),
        maxAttemptsPerContact: p.attemptsPerContact || 1,
        window: job.window,
        ...(Object.keys(extra).length ? { extra } : {})
      };
      const j = await call('POST', '/jobs', { body, headers: { 'idempotency-key': job.idempotencyKey } });
      return { jobId: j.id, contacts: contactsOf(j) };
    },

    async findByExternalRef(ref) {
      const r = await call('GET', '/jobs', { query: { externalRef: ref } });
      const j = (r?.jobs || [])[0];
      return j ? { jobId: j.id, contacts: contactsOf(j) } : null;
    },

    async status(jobId) {
      const j = await call('GET', `/jobs/${encodeURIComponent(jobId)}`);
      return {
        state: JOB_STATES[j.state] || 'running',
        contacts: (j.contacts || []).map((c) => ({
          id: c.id, address: c.address, normalizedAddress: c.normalizedAddress, state: c.state,
          attempts: c.attempts || 0, lastAttemptAt: c.lastAttemptAt || null
        })),
        lastChange: j.updatedAt || null,
        ...(Number.isFinite(j.costUsd) ? { costUsd: j.costUsd } : {})
      };
    },

    async results(jobId, { after } = {}) {
      const r = await call('GET', `/jobs/${encodeURIComponent(jobId)}/results`, { query: { after } });
      return { records: r?.records || [], ...(r?.next ? { next: r.next } : {}) };
    },

    async cancel(jobId) {
      const j = await call('DELETE', `/jobs/${encodeURIComponent(jobId)}`);
      return { state: JOB_STATES[j?.state] || 'cancelled' };
    },

    briefRules() {
      return [
        'Say in the first sentence who you are calling for and why.',
        'Never agree to a price, date or commitment; say the owner will confirm.',
        'If asked for anything you were not given, say you will pass the question on.'
      ];
    },

    // The summary becomes one fact on the contact; each expected answer
    // becomes a fact on the subject and attribute the node asked about.
    recordToFacts(record, job) {
      const contact = (job.contacts || []).find((c) => c.id === record.contactId);
      const who = contact?.normalizedAddress || contact?.address || record.contactId;
      const facts = [{
        stmt: `${record.kind} ${who}: ${record.summary}`,
        subject: `contact:${record.contactId}`,
        attr: `${record.kind}-outcome`,
        value: record.outcome || record.summary
      }];
      const expect = Array.isArray(job.payload?.expect) ? job.payload.expect : [];
      for (const [key, field] of Object.entries(record.fields || {})) {
        const m = /^q(\d+)$/.exec(key);
        const e = m ? expect[Number(m[1]) - 1] : null;
        if (!e) continue;
        const f = field && typeof field === 'object' ? field : { value: field };
        facts.push({
          stmt: `${e.question} ${who} answered: ${f.value}${f.unit ? ` ${f.unit}` : ''}`,
          subject: e.subject,
          attr: e.attr,
          value: f.value,
          unit: f.unit || null,
          ...(f.type === 'money' ? { category: 'financial' } : {})
        });
      }
      return facts;
    }
  };
}

module.exports = { createAdapter, ErrandsError };
