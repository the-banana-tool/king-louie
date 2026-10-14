// src/models/local-servers.js
// The local server registry (spec 2026-10-13-local-inference-design.md §5.1,
// §5.3, §5.5, §6): the servers the owner (desktop) or the administrator
// (service) added and marked local, their pinned addresses, the one
// transport and one provider each of them gets, and what a probe found out
// about each of their models.
//
// Everything here fails closed. An entry whose shape is wrong, that has no
// mark, or whose pinned addresses no longer pass the address check is listed
// as unusable and is never dialled. Whether a target may carry the guarantee
// (a private chat, a local-only role) is read from the entry and from its
// transport's own grade (R-LI-30), never from the target, the model id, the
// provider name or a probe record. The built-in `ollama` provider is not a
// local server (R-LI-31).
//
// Probe records (<dataDir>/models/local-probes.json) are observations: they
// say what a model can do, and a forged one can make a weak model look
// capable. They never say that a server is local.
//
// Electron-free. Log lines carry server ids, model ids, addresses and codes,
// never request or reply text.
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logging');
const { LOCAL_PROVIDER, isOllamaCloudModelId } = require('./provider-ids');
const { parseBaseUrl, checkPinned, canonicalAddress, isTlsFingerprint } = require('./local-address');
const { createLocalTransport } = require('./local-transport');
const { localEntry } = require('./normalize');
const { discoverModels, probeModel, readRecord, emptyRecord, plainModelId, MAX_CONTEXT } = require('./local-probe');

const log = createLogger('models/local-servers');

const SERVER_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SERVER_KINDS = Object.freeze(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'openai-compatible']);
const DEFAULT_MAX_CONCURRENT = 2;
const MAX_CONCURRENT_LIMIT = 64;
const MAX_NAME = 80;
const PROBE_FILE_VERSION = 1;
const DEFAULT_PROBE_TIMEOUT_MS = 60000;
// A listing that failed is not asked for again, on a turn's behalf, for this long.
const LIST_FAILURE_WINDOW_MS = 60000;
// A name is shown in sentences and lists: one plain line.
const NOT_ONE_LINE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

class LocalServerError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'LocalServerError';
    this.code = code;
    if (details.references) this.references = details.references;
  }
}

/**
 * "<serverId>/<model>" → its two parts, split at the first slash (a model
 * id may hold slashes of its own). Null when there is no slash, the model is
 * empty or the first part is not a server id.
 */
function splitModel(id) {
  if (typeof id !== 'string') return null;
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  const serverId = id.slice(0, slash);
  if (!SERVER_ID_RE.test(serverId)) return null;
  return { serverId, model: id.slice(slash + 1) };
}

const shown = (value) => (typeof value === 'string' && !NOT_ONE_LINE.test(value) ? value.slice(0, MAX_NAME) : null);

/**
 * Read one stored entry. Returns the entry as it will be listed and, when it
 * may not be used, the sentence that says why. Nothing here opens a socket.
 */
function readEntry(raw) {
  if (!isPlainObject(raw)) {
    return { entry: { id: null, name: null, kind: null, baseUrl: null, tlsFingerprint: null, allowCgnat: false, maxConcurrent: DEFAULT_MAX_CONCURRENT, timeoutMs: null, pinned: null, markedLocalAt: null }, problem: 'This local server entry is not an object.' };
  }
  const id = typeof raw.id === 'string' ? raw.id : null;
  const validId = id !== null && SERVER_ID_RE.test(id);
  const entry = {
    id: validId ? id : shown(id),
    name: shown(raw.name) || (validId ? id : null),
    kind: SERVER_KINDS.includes(raw.kind) ? raw.kind : null,
    baseUrl: shown(raw.baseUrl),
    tlsFingerprint: isTlsFingerprint(raw.tlsFingerprint) ? raw.tlsFingerprint.toLowerCase() : null,
    allowCgnat: raw.allowCgnat === true,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    timeoutMs: null,
    pinned: null,
    markedLocalAt: typeof raw.markedLocalAt === 'string' && raw.markedLocalAt ? shown(raw.markedLocalAt) : null
  };
  const fail = (problem) => ({ entry, problem });

  if (!validId) return fail('A local server id is 2 to 40 lowercase letters, digits and dashes, starting with a letter.');
  if (raw.name !== undefined && raw.name !== null && (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > MAX_NAME || NOT_ONE_LINE.test(raw.name))) {
    return fail(`The name of the local server ${id} must be one line of at most ${MAX_NAME} characters.`);
  }
  if (entry.kind === null) return fail(`The local server ${id} needs a kind: ${SERVER_KINDS.join(', ')}.`);

  let url;
  try {
    url = parseBaseUrl(raw.baseUrl);
  } catch (err) {
    return fail(`The address of the local server ${id} is not usable: ${err.message}`);
  }
  entry.baseUrl = url.href;

  if (raw.tlsFingerprint !== null && raw.tlsFingerprint !== undefined && !isTlsFingerprint(raw.tlsFingerprint)) {
    return fail(`The certificate fingerprint of the local server ${id} must be 64 hex characters (SHA-256).`);
  }
  if (raw.allowCgnat !== undefined && raw.allowCgnat !== null && typeof raw.allowCgnat !== 'boolean') {
    return fail(`allowCgnat of the local server ${id} must be true or false.`);
  }
  if (raw.maxConcurrent !== undefined && raw.maxConcurrent !== null) {
    if (!Number.isInteger(raw.maxConcurrent) || raw.maxConcurrent < 1 || raw.maxConcurrent > MAX_CONCURRENT_LIMIT) {
      return fail(`maxConcurrent of the local server ${id} must be a whole number from 1 to ${MAX_CONCURRENT_LIMIT}.`);
    }
    entry.maxConcurrent = raw.maxConcurrent;
  }
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    if (!Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) return fail(`timeoutMs of the local server ${id} must be more than 0.`);
    entry.timeoutMs = raw.timeoutMs;
  }

  // The address check, again, on what is stored (§5.2): the pin must still
  // be a loopback or LAN address (100.64.0.0/10 only with this entry's own
  // opt-in, R-LI-29), and its stored class must be the one its addresses give.
  const pinCheck = checkPinned(raw.pinned, { allowCgnat: entry.allowCgnat });
  if (pinCheck !== true) return fail(`The local server ${id} failed its address check: ${pinCheck.message}`);
  let addresses;
  try {
    addresses = [...new Set(raw.pinned.addresses.map((a) => canonicalAddress(a)))];
  } catch {
    return fail(`The local server ${id} failed its address check: a pinned address is not an IP address.`);
  }
  // An IP address written in the URL is the address itself: a pin that
  // names another one does not belong to this server.
  if (url.isIpLiteral) {
    let written = null;
    try { written = canonicalAddress(url.hostname); } catch { /* refused below */ }
    if (written === null || addresses.length !== 1 || addresses[0] !== written) {
      return fail(`The local server ${id} failed its address check: its checked address is not the one in its URL. Check it again.`);
    }
  }
  entry.pinned = { addresses, class: raw.pinned.class, at: typeof raw.pinned.at === 'string' ? shown(raw.pinned.at) : null };

  // There is no unmarked local server (R-LI-4, R-LI-5): adding one is the mark.
  if (entry.markedLocalAt === null) return fail(`The local server ${id} was never marked local.`);
  return { entry, problem: null };
}

const transportSignature = (entry) => JSON.stringify([entry.baseUrl, entry.pinned.addresses, entry.tlsFingerprint, entry.maxConcurrent]);

// Ollama reads "name" and "name:latest" as one model.
const bareOllama = (id) => (id.endsWith(':latest') ? id.slice(0, -':latest'.length) : id);
const sameModel = (kind, a, b) => a === b || (kind === 'ollama' && bareOllama(a) === bareOllama(b));

class LocalServers {
  /**
   * @param {object} options
   * @param {Function} options.getEntries - the stored entries (an array)
   * @param {Function} [options.getToken] - `(serverId) => key | null`
   * @param {object|null} [options.catalog] - told which servers exist (so it prices their models at $0) and which models were probed
   * @param {string|null} [options.probeFile] - where probe records are kept; without one they last until restart
   * @param {number} [options.probeTimeoutMs] - per probe request
   * @param {Function} [options.createTransport]
   * @param {Function} [options.now]
   */
  constructor({ getEntries, getToken = () => null, catalog = null, probeFile = null, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS, createTransport = createLocalTransport, now = () => new Date() } = {}) {
    if (typeof getEntries !== 'function') throw new Error('LocalServers needs getEntries().');
    this.getEntries = getEntries;
    this.getToken = typeof getToken === 'function' ? getToken : () => null;
    this.catalog = catalog || null;
    this.probeFile = typeof probeFile === 'string' && probeFile ? probeFile : null;
    this.probeTimeoutMs = probeTimeoutMs;
    this.createTransport = createTransport;
    this.now = now;
    this._transports = new Map(); // id → { signature, transport }
    this._providers = new Map(); // id → { transport, key, kind, provider }
    this._memo = null; // { source, rows }
    this._entriesFailed = false;
    this._tokenFailed = new Set();
    this._closed = false;
    this._probes = new Map(); // "<serverId>/<model>" → record
    this._listed = new Map(); // id → { at, models: [{ id, cloud, context, digest }] }
    this._listFailedAt = new Map(); // id → ms
    this._refreshing = new Map(); // id → { key, promise }
    // What was last put into the catalog. An empty set at start is not news.
    this._catalogSignature = '[]';
    this._syncing = false;
    this._probeWriteFailed = false;
    this._priceCheck = (serverId) => this._usableRow(serverId) !== null;
    if (this.catalog && typeof this.catalog.setLocalServerCheck === 'function') this.catalog.setLocalServerCheck(this._priceCheck);
    // Start-up: the stored observations go into the catalog. No request is made.
    this._loadProbes();
    this.syncCatalog();
  }

  splitModel(id) {
    return splitModel(id);
  }

  _readEntries() {
    let raw;
    try {
      raw = this.getEntries();
    } catch (err) {
      if (!this._entriesFailed) log.warn(`Reading the local server list failed; no local server is usable: ${err.message}`);
      this._entriesFailed = true;
      return [];
    }
    this._entriesFailed = false;
    return Array.isArray(raw) ? raw : [];
  }

  _dropTransport(id) {
    const held = this._transports.get(id);
    if (!held) return;
    this._transports.delete(id);
    this._providers.delete(id);
    try { held.transport.close(); } catch { /* already closed */ }
  }

  // Every entry, checked, with the transport of each usable one in place.
  _rows() {
    if (this._closed) return [];
    const raw = this._readEntries();
    let source;
    try {
      source = JSON.stringify(raw);
    } catch {
      source = null;
    }
    if (source !== null && this._memo && this._memo.source === source) return this._memo.rows;

    const read = raw.map((item) => readEntry(item));
    const counts = new Map();
    for (const { entry } of read) if (entry.id !== null) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);

    const rows = [];
    const live = new Set();
    for (const { entry, problem: shapeProblem } of read) {
      let problem = shapeProblem;
      if (!problem && counts.get(entry.id) > 1) problem = `Two local servers share the id ${entry.id}; neither is used.`;
      let grade = 'cost-only';
      if (!problem) {
        const signature = transportSignature(entry);
        let held = this._transports.get(entry.id);
        if (held && held.signature !== signature) {
          this._dropTransport(entry.id);
          // What the old address listed says nothing about the new one.
          this._listed.delete(entry.id);
          this._listFailedAt.delete(entry.id);
          held = null;
        }
        if (!held) {
          try {
            const transport = this.createTransport({
              baseUrl: entry.baseUrl,
              addresses: entry.pinned.addresses,
              tlsFingerprint: entry.tlsFingerprint,
              maxConcurrent: entry.maxConcurrent
            });
            if (!transport || typeof transport.fetch !== 'function') throw new Error('no transport was built');
            held = { signature, transport };
            this._transports.set(entry.id, held);
          } catch (err) {
            problem = `The local server ${entry.id} could not be set up: ${err.message}`;
          }
        }
        if (held) {
          live.add(entry.id);
          // The transport's own reading of what it dials and how (R-LI-30).
          grade = held.transport.grade === 'guarantee' ? 'guarantee' : 'cost-only';
        }
      }
      rows.push(Object.freeze({ ...entry, pinned: entry.pinned ? Object.freeze({ ...entry.pinned, addresses: Object.freeze([...entry.pinned.addresses]) }) : null, grade, usable: !problem, problem: problem || null }));
    }
    for (const id of [...this._transports.keys()]) {
      if (live.has(id)) continue;
      this._dropTransport(id);
      this._listed.delete(id);
      this._listFailedAt.delete(id);
    }
    this._memo = source === null ? null : { source, rows };
    // The set of servers changed: so may the models the catalog should hold.
    if (this._probes.size > 0 && this._memo) this.syncCatalog();
    return rows;
  }

  /** @returns {object[]} `{ ...entry, grade, usable, problem }` for every stored entry */
  list() {
    return this._rows().map((row) => ({ ...row, pinned: row.pinned ? { ...row.pinned, addresses: [...row.pinned.addresses] } : null }));
  }

  _row(id) {
    if (typeof id !== 'string') return null;
    return this._rows().find((row) => row.id === id) || null;
  }

  _usableRow(id) {
    const row = this._row(id);
    return row && row.usable ? row : null;
  }

  get(id) {
    const row = this._row(id);
    return row ? { ...row, pinned: row.pinned ? { ...row.pinned, addresses: [...row.pinned.addresses] } : null } : null;
  }

  _require(id) {
    if (this._closed) throw new LocalServerError('LOCAL_SERVER_UNKNOWN', 'The local server registry is closed.');
    const row = this._row(id);
    if (!row) throw new LocalServerError('LOCAL_SERVER_UNKNOWN', `No local server "${shown(String(id)) || ''}" is configured.`);
    if (!row.usable) throw new LocalServerError('LOCAL_SERVER_UNUSABLE', row.problem);
    return row;
  }

  /** The server's API base: `<baseUrl>/v1`, for every kind (§5.1). */
  apiBase(entry) {
    return `${String(entry?.baseUrl || '').replace(/\/+$/, '')}/v1`;
  }

  /** One transport per server, rebuilt when the entry changes. Throws for a server that may not be dialled. */
  transportFor(id) {
    this._require(id);
    const held = this._transports.get(id);
    if (!held) throw new LocalServerError('LOCAL_SERVER_UNUSABLE', `The local server ${id} has no transport.`);
    return held.transport;
  }

  _key(id) {
    try {
      const key = this.getToken(id);
      this._tokenFailed.delete(id);
      return typeof key === 'string' && key.trim() ? key.trim() : null;
    } catch (err) {
      if (!this._tokenFailed.has(id)) log.warn(`Reading the key of the local server ${id} failed; calling it without one: ${err.message}`);
      this._tokenFailed.add(id);
      return null;
    }
  }

  /** One LocalServerProvider per server, rebuilt when its transport, key or kind changes. */
  providerFor(id) {
    const row = this._require(id);
    const transport = this.transportFor(id);
    const key = this._key(id);
    const held = this._providers.get(id);
    if (held && held.transport === transport && held.key === key && held.kind === row.kind) return held.provider;
    // Required here, not at the top: the provider module requires the models
    // index, so a top-level require would make a cycle of the two folders.
    const LocalServerProvider = require('../providers/local-server-provider');
    const provider = new LocalServerProvider(key, {
      baseUrl: this.apiBase(row),
      transport,
      serverId: id,
      addressClass: transport.addressClass,
      kind: row.kind,
      catalog: this.catalog
    });
    this._providers.set(id, { transport, key, kind: row.kind, provider });
    return provider;
  }

  /**
   * May a private chat or a local-only role use this target (R-LI-30)?
   * @returns {true|string} exactly `true`, or the sentence that says why not
   */
  isGuaranteeTarget(target) {
    const none = 'Only a model on a local server you added can take this call.';
    if (!isPlainObject(target) || target.provider !== LOCAL_PROVIDER) return none;
    const split = splitModel(target.model);
    if (!split) return none;
    const row = this._row(split.serverId);
    if (!row) return `No local server "${split.serverId}" is configured.`;
    if (!row.usable) return row.problem;
    if (row.kind === 'ollama' && isOllamaCloudModelId(split.model)) {
      return `${split.model} runs on Ollama's cloud, not on ${row.name}.`;
    }
    const held = this._transports.get(row.id);
    if (!held || held.transport.grade !== 'guarantee') {
      const over = held && held.transport.protocol === 'https:' ? 'https with no pinned certificate' : 'plain http on your network';
      return `${row.name} answers over ${over}; a private chat or a local-only role needs https with a pinned certificate.`;
    }
    return true;
  }

  // ---- Probe records (§6) ----

  _loadProbes() {
    if (!this.probeFile) return;
    let text;
    try {
      text = fs.readFileSync(this.probeFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Reading the local model probes failed; starting with none: ${err.code || err.message}`);
      return;
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      log.warn('The local model probe file is not JSON; starting with none.');
      return;
    }
    const models = isPlainObject(doc) && isPlainObject(doc.models) ? doc.models : {};
    for (const [key, raw] of Object.entries(models)) {
      const split = splitModel(key);
      if (!split || plainModelId(split.model) === null) continue;
      const record = readRecord(raw);
      if (record) this._probes.set(key, record);
    }
  }

  _saveProbes() {
    if (!this.probeFile) return;
    const doc = { version: PROBE_FILE_VERSION, models: Object.fromEntries(this._probes) };
    const tmp = `${this.probeFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.probeFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, this.probeFile);
      this._probeWriteFailed = false;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
      if (!this._probeWriteFailed) log.warn(`Writing the local model probes failed; they last until restart: ${err.code || err.message}`);
      this._probeWriteFailed = true;
    }
  }

  /**
   * Put the probed models of every usable server into the catalog as free
   * local models (§6.2). A record whose server is not configured, or is
   * unusable, stays on disk and out of the catalog. A cloud id never enters.
   */
  syncCatalog() {
    if (!this.catalog || typeof this.catalog.setLocalModels !== 'function' || this._syncing) return;
    this._syncing = true;
    try {
      const entries = [];
      for (const [key, record] of this._probes) {
        const split = splitModel(key);
        const row = split ? this._usableRow(split.serverId) : null;
        if (!row) continue;
        if (row.kind === 'ollama' && isOllamaCloudModelId(split.model)) continue;
        entries.push(localEntry(LOCAL_PROVIDER, {
          id: key,
          name: split.model,
          context: record.context,
          toolCall: record.toolCall === 'yes',
          imageInput: record.imageInput === 'yes'
        }));
      }
      const signature = JSON.stringify(entries.map((e) => [e.id, e.limits.context, e.toolCall, e.input]));
      if (signature === this._catalogSignature) return;
      this._catalogSignature = signature;
      this.catalog.setLocalModels(LOCAL_PROVIDER, entries);
    } finally {
      this._syncing = false;
    }
  }

  _store(key, record) {
    this._probes.set(key, record);
    this._saveProbes();
    this.syncCatalog();
  }

  /** What the probe (or the owner) recorded about one model, or null. */
  probeRecord(id, model) {
    const record = this._probes.get(`${id}/${model}`);
    return record ? { ...record, adapters: [...record.adapters] } : null;
  }

  /**
   * A server's models: what it last listed in this process (a cloud id is
   * marked `cloud: true`), then any model with a record that the list did
   * not hold. Each carries its record, or null.
   */
  models(id) {
    const listed = this._listed.get(id) || null;
    const out = [];
    const seen = new Set();
    for (const m of listed ? listed.models : []) {
      seen.add(m.id);
      out.push({ id: m.id, cloud: m.cloud === true, listed: true, record: m.cloud ? null : this.probeRecord(id, m.id) });
    }
    const prefix = `${id}/`;
    for (const key of this._probes.keys()) {
      if (!key.startsWith(prefix)) continue;
      const model = key.slice(prefix.length);
      if (seen.has(model)) continue;
      out.push({ id: model, cloud: false, listed: listed ? false : null, record: this.probeRecord(id, model) });
    }
    return { id, listedAt: listed ? listed.at : null, models: out };
  }

  // A fresh probe replaces a record, except for what the owner entered.
  _merge(fresh, existing) {
    const record = { ...fresh };
    if (existing && existing.contextSource === 'owner' && existing.context !== null) {
      record.context = existing.context;
      record.contextSource = 'owner';
    }
    if (existing && existing.imageInputSource === 'owner') {
      record.imageInput = existing.imageInput;
      record.imageInputSource = 'owner';
    }
    return readRecord(record);
  }

  async _list(id, row, signal) {
    const transport = this.transportFor(id);
    const provider = this.providerFor(id);
    let found;
    try {
      found = await discoverModels({ id, kind: row.kind, baseUrl: row.baseUrl }, { fetch: transport.fetch, headers: provider.getHeaders(), signal });
    } catch (err) {
      this._listFailedAt.set(id, Date.now());
      throw err;
    }
    this._listFailedAt.delete(id);
    // The entry changed or the registry closed while the server answered.
    if (!this._closed && this._transports.get(id)?.transport === transport) {
      this._listed.set(id, { at: this.now().toISOString(), models: found });
    }
    return { found, transport, provider };
  }

  async _probeOne(id, row, model, listedInfo, { transport, provider, signal }) {
    const key = `${id}/${model}`;
    const fresh = await probeModel({ id, kind: row.kind, baseUrl: row.baseUrl }, model, {
      provider,
      fetch: transport.fetch,
      timeoutMs: this.probeTimeoutMs,
      listed: listedInfo,
      signal,
      now: this.now
    });
    // A probe cut off by shutdown, or by the entry changing under it, is not
    // an observation of the model: nothing is stored.
    if (this._closed || this._transports.get(id)?.transport !== transport) return null;
    const record = this._merge(fresh, this._probes.get(key) || null);
    this._store(key, record);
    log.info(`Probed ${key}: tools ${record.toolCall}, context ${record.context ?? 'unknown'}${record.error ? ', with a failed step' : ''}.`);
    return record;
  }

  /**
   * List a server's models and probe each one that was never probed (R-LI-7:
   * a probed model is not probed again). With `only`, just those models.
   * Two calls for the same thing share one run.
   * @returns {Promise<{ id: string, listedAt: string|null, models: object[] }>}
   * @throws when the server is unknown or unusable, or its listing fails
   */
  refresh(id, { only = null, signal = null } = {}) {
    const key = Array.isArray(only) ? JSON.stringify([...only].sort()) : '*';
    const running = this._refreshing.get(id);
    if (running && running.key === key) return running.promise;
    const after = running ? running.promise.catch(() => {}) : Promise.resolve();
    const promise = after.then(() => this._refresh(id, { only, signal })).finally(() => {
      if (this._refreshing.get(id)?.promise === promise) this._refreshing.delete(id);
    });
    this._refreshing.set(id, { key, promise });
    return promise;
  }

  async _refresh(id, { only, signal }) {
    const row = this._require(id);
    const { found, transport, provider } = await this._list(id, row, signal);
    const wanted = Array.isArray(only) ? only.filter((m) => typeof m === 'string') : null;
    for (const m of found) {
      if (m.cloud) continue;
      if (wanted && !wanted.some((w) => sameModel(row.kind, w, m.id))) continue;
      const existing = this._probes.get(`${id}/${m.id}`);
      if (existing && existing.probedAt) continue;
      const record = await this._probeOne(id, row, m.id, m, { transport, provider, signal });
      if (record === null) break;
    }
    return this.models(id);
  }

  /** Probe one model again (the owner asked). Owner-entered values are kept. */
  async probe(id, model) {
    const row = this._require(id);
    if (plainModelId(model) === null) throw new LocalServerError('LOCAL_MODEL_NOT_LISTED', 'That is not a model id.');
    if (row.kind === 'ollama' && isOllamaCloudModelId(model)) {
      throw new LocalServerError('LOCAL_CLOUD_MODEL', `${model} runs on Ollama's cloud, not on ${row.name}.`);
    }
    const { found, transport, provider } = await this._list(id, row, null);
    const listed = found.find((m) => sameModel(row.kind, m.id, model));
    if (!listed) throw new LocalServerError('LOCAL_MODEL_NOT_LISTED', `${model} is not in ${row.name}'s model list.`);
    const record = await this._probeOne(id, row, model, listed, { transport, provider, signal: null });
    if (record === null) throw new LocalServerError('LOCAL_SERVER_UNUSABLE', `The local server ${id} changed while it was probed.`);
    return this.probeRecord(id, model);
  }

  /**
   * What the owner says about a model the server does not describe: its
   * context size and whether it sees images (`contextSource: 'owner'`). A
   * later probe keeps both. `null` clears a value back to unknown.
   */
  setModelInfo(id, model, { context, imageInput } = {}) {
    const row = this._require(id);
    const invalid = (message) => new LocalServerError('LOCAL_MODEL_INFO_INVALID', message);
    if (plainModelId(model) === null) throw invalid('That is not a model id.');
    if (row.kind === 'ollama' && isOllamaCloudModelId(model)) {
      throw new LocalServerError('LOCAL_CLOUD_MODEL', `${model} runs on Ollama's cloud, not on ${row.name}.`);
    }
    if (context !== undefined && context !== null && !(Number.isInteger(context) && context > 0 && context <= MAX_CONTEXT)) {
      throw invalid('A context size is a whole number of tokens, more than 0.');
    }
    if (imageInput !== undefined && imageInput !== null && typeof imageInput !== 'boolean') {
      throw invalid('Image input is true or false.');
    }
    const key = `${id}/${model}`;
    const record = { ...(this._probes.get(key) || emptyRecord()) };
    if (context === null) {
      record.context = null;
      record.contextSource = 'unknown';
    } else if (context !== undefined) {
      record.context = context;
      record.contextSource = 'owner';
    }
    if (imageInput === null) {
      record.imageInput = 'unknown';
      delete record.imageInputSource;
    } else if (imageInput !== undefined) {
      record.imageInput = imageInput ? 'yes' : 'no';
      record.imageInputSource = 'owner';
    }
    this._store(key, readRecord(record));
    return this.probeRecord(id, model);
  }

  /**
   * Before a turn resolves its models: probe the local targets that were
   * never probed, and only those. A server whose listing fails is left
   * alone (its models stay unprobed, and the call itself will say what is
   * wrong); it is not asked again within the minute. Never throws.
   */
  async ensureProbed(targets) {
    const wanted = new Map();
    for (const target of Array.isArray(targets) ? targets : []) {
      if (!isPlainObject(target) || target.provider !== LOCAL_PROVIDER) continue;
      const split = splitModel(target.model);
      const row = split ? this._usableRow(split.serverId) : null;
      if (!row || plainModelId(split.model) === null) continue;
      if (row.kind === 'ollama' && isOllamaCloudModelId(split.model)) continue;
      if (this._probes.get(`${row.id}/${split.model}`)?.probedAt) continue;
      // Already listed in this process, and the model was not there.
      const listed = this._listed.get(row.id);
      if (listed && !listed.models.some((m) => sameModel(row.kind, m.id, split.model))) continue;
      const failedAt = this._listFailedAt.get(row.id);
      if (failedAt !== undefined && Date.now() - failedAt < LIST_FAILURE_WINDOW_MS) continue;
      if (!wanted.has(row.id)) wanted.set(row.id, []);
      if (!wanted.get(row.id).includes(split.model)) wanted.get(row.id).push(split.model);
    }
    await Promise.all([...wanted].map(([id, models]) => this.refresh(id, { only: models }).catch((err) => {
      log.warn(`Listing the models of the local server ${id} failed (${err?.code || err?.status || 'error'}); they stay unprobed.`);
    })));
  }

  /**
   * Whether a `local` model can take a call, in Availability#explain's shape
   * (plus `code` when it cannot).
   * @returns {{ usable: boolean, reasons: string[], notes: string[], entry: object|null, code?: string }}
   */
  explain(modelId, { needs = {} } = {}) {
    const refuse = (code, reason) => ({ usable: false, reasons: [reason], notes: [], entry: null, code });
    const split = splitModel(typeof modelId === 'string' ? modelId.trim() : modelId);
    if (!split) return refuse('LOCAL_SERVER_UNKNOWN', 'A local model is named "<server>/<model>", and this one names no local server.');
    const row = this._row(split.serverId);
    if (!row) return refuse('LOCAL_SERVER_UNKNOWN', `No local server "${split.serverId}" is configured.`);
    if (!row.usable) return refuse('LOCAL_SERVER_UNUSABLE', row.problem);
    if (row.kind === 'ollama' && isOllamaCloudModelId(split.model)) {
      return refuse('LOCAL_CLOUD_MODEL', `${split.model} runs on Ollama's cloud, not on ${row.name}.`);
    }
    const listed = this._listed.get(row.id);
    if (listed && !listed.models.some((m) => sameModel(row.kind, m.id, split.model))) {
      return refuse('LOCAL_MODEL_NOT_LISTED', `${split.model} is not in ${row.name}'s model list.`);
    }
    const key = `${row.id}/${split.model}`;
    const record = this._probes.get(key) || null;
    // The catalog's entry is the record plus the owner's overrides (§6.5).
    const entry = this.catalog && typeof this.catalog.get === 'function' ? this.catalog.get(LOCAL_PROVIDER, key) : null;
    const notes = [];
    if (!record || !record.probedAt) notes.push(`${split.model} on ${row.name} is not probed: its capabilities are unknown.`);
    const reasons = [];
    const n = isPlainObject(needs) ? needs : {};
    // Unknown follows the rule for an unknown model: never claim it sees
    // images, and do not refuse it tools. A smoke call that answered a tool
    // request in text does refuse a tool job (§6.2).
    if (n.toolCall && record && record.toolCall === 'no' && entry?.toolCall !== true) {
      reasons.push(`${split.model} did not call a tool when it was probed.`);
    }
    if (n.imageInput && !(record?.imageInput === 'yes' || (entry && entry.input.includes('image')))) {
      reasons.push(`${split.model} is not known to take image input.`);
    }
    const context = entry?.limits?.context ?? record?.context ?? null;
    if (Number.isFinite(n.minContext) && context !== null && context < n.minContext) {
      reasons.push(`${split.model} has a context of ${context} tokens, below ${n.minContext}.`);
    }
    if (reasons.length) return { usable: false, reasons, notes, entry, code: 'LOCAL_MODEL_UNFIT' };
    return { usable: true, reasons: [], notes, entry };
  }

  /** Close every transport. The registry lists and dials nothing afterwards. */
  close() {
    if (this._closed) return;
    for (const id of [...this._transports.keys()]) this._dropTransport(id);
    this._providers.clear();
    this._listed.clear();
    this._memo = null;
    this._closed = true;
  }
}

module.exports = { LocalServers, LocalServerError, SERVER_ID_RE, SERVER_KINDS, LOCAL_PROVIDER, splitModel, readEntry };
