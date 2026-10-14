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
const { parseBaseUrl, checkPinned, canonicalAddress, isTlsFingerprint, resolveAndPin } = require('./local-address');
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

// What the owner types when adding a server. A pin and a mark are made here,
// never taken from a caller.
const ADD_KEYS = Object.freeze(['id', 'name', 'kind', 'baseUrl', 'tlsFingerprint', 'allowCgnat', 'maxConcurrent', 'timeoutMs']);
const DEFAULT_PIN_TIMEOUT_MS = 5000;

const sameAddresses = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && [...a].sort().every((value, i) => value === [...b].sort()[i]);

/**
 * Service mode: turn the administrator's `localInference.servers` into
 * registry entries, each with its pin (spec §5.6). An address the admin
 * wrote is the pin; a host name is resolved once, now. An entry whose address
 * is refused, does not resolve or does not answer in time is left out and
 * reported; the others are kept. Never throws.
 *
 * @returns {Promise<{ entries: object[], keys: Map<string, string>, failures: { id: string, code: string, refused: object[] }[] }>}
 */
async function pinAdminServers(servers, { lookup = undefined, timeoutMs = DEFAULT_PIN_TIMEOUT_MS, now = () => new Date() } = {}) {
  const entries = [];
  const keys = new Map();
  const failures = [];
  const results = await Promise.all((Array.isArray(servers) ? servers : []).map(async (server) => {
    const id = isPlainObject(server) && typeof server.id === 'string' ? server.id : '(no id)';
    let timer = null;
    try {
      if (!isPlainObject(server)) throw new LocalServerError('LOCAL_SERVER_INVALID', 'This local server entry is not an object.');
      const allowCgnat = server.allowCgnat === true;
      const listed = Array.isArray(server.addresses) && server.addresses.length ? server.addresses : null;
      const pin = resolveAndPin(server.baseUrl, {
        allowCgnat,
        now,
        // The admin's own addresses stand in for the answer; nothing is resolved.
        ...(listed ? { lookup: async () => listed.map((address) => ({ address })) } : (lookup ? { lookup } : {}))
      });
      const pinned = await Promise.race([
        pin,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new LocalServerError('LOCAL_ADDRESS_UNRESOLVED', `Resolving the address did not finish in ${timeoutMs} ms.`)), timeoutMs);
        })
      ]);
      const candidate = {
        id: server.id,
        name: server.name === undefined || server.name === null ? server.id : server.name,
        kind: server.kind,
        baseUrl: server.baseUrl,
        tlsFingerprint: server.tlsFingerprint ?? null,
        allowCgnat,
        maxConcurrent: server.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        timeoutMs: server.timeoutMs ?? null,
        pinned,
        // The administrator listing the server is the mark (R-LI-6).
        markedLocalAt: now().toISOString()
      };
      const { entry, problem } = readEntry(candidate);
      if (problem) throw new LocalServerError('LOCAL_SERVER_INVALID', problem);
      return { entry, key: typeof server.key === 'string' && server.key ? server.key : null };
    } catch (err) {
      return { failure: { id, code: typeof err?.code === 'string' ? err.code : 'LOCAL_SERVER_INVALID', refused: Array.isArray(err?.refused) ? err.refused : [] } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
  for (const result of results) {
    if (result.failure) failures.push(result.failure);
    else if (entries.some((e) => e.id === result.entry.id)) failures.push({ id: result.entry.id, code: 'LOCAL_SERVER_EXISTS', refused: [] });
    else {
      entries.push(result.entry);
      if (result.key) keys.set(result.entry.id, result.key);
    }
  }
  return { entries, keys, failures };
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
   * @param {Function|null} [options.writeEntries] - `(entries) => void`: replaces the stored list. Absent in
   *   service mode, where the list is the administrator's and every change is refused (R-LI-6).
   * @param {Function} [options.getProfiles] - `() => Profiles`, for the profile targets that name a server's models
   * @param {Function} [options.getOllamaBaseUrl] - the built-in Ollama provider's address (`fromOllama`)
   * @param {Function} [options.onRemoved] - `(serverId) => void`, after a server is removed (its key is cleared)
   * @param {Function} [options.lookup] - `dns.promises.lookup`, for `add` and `recheck`
   * @param {Function} [options.createTransport]
   * @param {Function} [options.now]
   */
  constructor({
    getEntries, getToken = () => null, catalog = null, probeFile = null, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    writeEntries = null, getProfiles = null, getOllamaBaseUrl = null, onRemoved = null, lookup = null,
    createTransport = createLocalTransport, now = () => new Date()
  } = {}) {
    if (typeof getEntries !== 'function') throw new Error('LocalServers needs getEntries().');
    this.getEntries = getEntries;
    this._writeEntries = typeof writeEntries === 'function' ? writeEntries : null;
    this.getProfiles = typeof getProfiles === 'function' ? getProfiles : null;
    this.getOllamaBaseUrl = typeof getOllamaBaseUrl === 'function' ? getOllamaBaseUrl : null;
    this.onRemoved = typeof onRemoved === 'function' ? onRemoved : null;
    this.lookup = typeof lookup === 'function' ? lookup : null;
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

  // ---- Who may change the list (§5.6, R-LI-6) ----

  /** True when the list is the administrator's (service mode): nothing here changes it. */
  get adminOnly() {
    return this._writeEntries === null;
  }

  _requireWritable() {
    if (this._closed) throw new LocalServerError('LOCAL_SERVER_UNKNOWN', 'The local server registry is closed.');
    if (this._writeEntries === null) {
      throw new LocalServerError('LOCAL_SERVER_ADMIN_ONLY', 'In service mode local servers come only from the administrator\'s service.json.');
    }
  }

  /**
   * The one function that replaces `settings.models.localServers` (the
   * core's settings save keeps the stored list whatever it is passed). Only
   * `add`, `remove`, `recheck` and `fromOllama` call it.
   */
  write(entries) {
    this._requireWritable();
    this._writeEntries(entries.map((entry) => ({ ...entry })));
    this._memo = null;
    this._rows();
  }

  _lookupOption(lookup) {
    const fn = typeof lookup === 'function' ? lookup : this.lookup;
    return fn ? { lookup: fn } : {};
  }

  _dropRecords(id) {
    const prefix = `${id}/`;
    let dropped = false;
    for (const key of [...this._probes.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this._probes.delete(key);
      dropped = true;
    }
    if (dropped) {
      this._saveProbes();
      this.syncCatalog();
    }
  }

  /**
   * Add a server. This is the owner's mark (R-LI-4, R-LI-5): the address is
   * resolved once, every answer must be on this machine or the owner's own
   * network, and what it answered is stored as the pin. Then its models are
   * listed and probed. A caller's own `pinned` or `markedLocalAt` is refused.
   *
   * @returns {Promise<{ server: object, models: object[], probeError: { code: string|null, status: number|null }|null }>}
   * @throws LOCAL_SERVER_ADMIN_ONLY, LOCAL_SERVER_INVALID, LOCAL_SERVER_EXISTS, LOCAL_URL_INVALID,
   *   LOCAL_ADDRESS_PUBLIC, LOCAL_ADDRESS_UNRESOLVED; nothing is stored then
   */
  async add(input, { lookup = null, refresh = true } = {}) {
    this._requireWritable();
    const invalid = (message) => new LocalServerError('LOCAL_SERVER_INVALID', message);
    if (!isPlainObject(input)) throw invalid('A local server is an object with an id, a kind and an address.');
    for (const key of Object.keys(input)) {
      if (!ADD_KEYS.includes(key)) throw invalid(`A local server has no "${shown(key) || 'that'}" setting to give: ${ADD_KEYS.join(', ')}.`);
    }
    if (typeof input.id !== 'string' || !SERVER_ID_RE.test(input.id)) throw invalid('A local server id is 2 to 40 lowercase letters, digits and dashes, starting with a letter.');
    if (!SERVER_KINDS.includes(input.kind)) throw invalid(`A local server needs a kind: ${SERVER_KINDS.join(', ')}.`);
    if (input.allowCgnat !== undefined && input.allowCgnat !== null && typeof input.allowCgnat !== 'boolean') throw invalid('allowCgnat must be true or false.');
    const taken = () => this._readEntries().some((e) => isPlainObject(e) && e.id === input.id);
    if (taken()) throw new LocalServerError('LOCAL_SERVER_EXISTS', `A local server with the id ${input.id} already exists.`);

    const allowCgnat = input.allowCgnat === true;
    const pinned = await resolveAndPin(input.baseUrl, { allowCgnat, now: this.now, ...this._lookupOption(lookup) });
    const { entry, problem } = readEntry({
      id: input.id,
      name: input.name === undefined || input.name === null ? input.id : input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      tlsFingerprint: input.tlsFingerprint ?? null,
      allowCgnat,
      maxConcurrent: input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      timeoutMs: input.timeoutMs ?? null,
      pinned,
      markedLocalAt: this.now().toISOString()
    });
    if (problem) throw invalid(problem);
    // The lookup was awaited: the list may have changed meanwhile.
    this._requireWritable();
    if (taken()) throw new LocalServerError('LOCAL_SERVER_EXISTS', `A local server with the id ${input.id} already exists.`);
    // Whatever was once observed under this id was another machine's.
    this._dropRecords(entry.id);
    this.write([...this._readEntries(), entry]);
    log.info(`Added the local server ${entry.id} at ${entry.pinned.addresses.join(', ')} (${entry.pinned.class}).`);

    let probeError = null;
    if (refresh) {
      try {
        await this.refresh(entry.id);
      } catch (err) {
        probeError = { code: typeof err?.code === 'string' ? err.code : null, status: Number.isFinite(err?.status) ? err.status : null };
        log.warn(`The local server ${entry.id} was added, but its models could not be listed (${probeError.code || probeError.status || 'error'}).`);
      }
    }
    return { server: this.get(entry.id), models: this.models(entry.id).models, probeError };
  }

  /** The profile targets that name one of a server's models. */
  references(id) {
    const profiles = this.getProfiles ? this.getProfiles() : null;
    const out = [];
    if (!profiles || typeof profiles.list !== 'function') return out;
    for (const profile of profiles.list()) {
      for (const [role, targets] of Object.entries(profile.roles || {})) {
        for (const target of Array.isArray(targets) ? targets : []) {
          if (target.provider !== LOCAL_PROVIDER) continue;
          if (splitModel(target.model)?.serverId === id) out.push({ profileId: profile.id, profileName: profile.name, role, model: target.model });
        }
      }
    }
    return out;
  }

  /**
   * Remove a server. Refused while a profile target names one of its models
   * (`LOCAL_SERVER_IN_USE`, with `references`). Its probe records go too.
   */
  async remove(id, { references = [] } = {}) {
    this._requireWritable();
    const stored = this._readEntries();
    if (typeof id !== 'string' || !stored.some((e) => isPlainObject(e) && e.id === id)) {
      throw new LocalServerError('LOCAL_SERVER_UNKNOWN', `No local server "${shown(String(id)) || ''}" is configured.`);
    }
    const refs = [...this.references(id), ...(Array.isArray(references) ? references : [])];
    if (refs.length) {
      throw new LocalServerError('LOCAL_SERVER_IN_USE', `The local server ${id} is still used by ${refs.length} model${refs.length === 1 ? '' : 's'} in your profiles. Remove them there first.`, { references: refs });
    }
    this.write(stored.filter((e) => !(isPlainObject(e) && e.id === id)));
    this._dropRecords(id);
    if (this.onRemoved) {
      try {
        this.onRemoved(id);
      } catch (err) {
        log.warn(`Clearing what belonged to the removed local server ${id} failed: ${err.message}`);
      }
    }
    log.info(`Removed the local server ${id}.`);
    return { removed: id };
  }

  /**
   * Resolve a server's address again and show the old and the new answer.
   * The pin changes only with `confirm: true` and `expected` holding the
   * addresses the owner was shown: an answer that changed in between is
   * refused (`LOCAL_RECHECK_STALE`). An answer that is not allowed is refused
   * as on `add`, and the pin is kept.
   * @returns {Promise<{ previous: object|null, resolved: object, changed: boolean, stored: boolean }>}
   */
  async recheck(id, { lookup = null, confirm = false, expected = null } = {}) {
    this._requireWritable();
    const find = () => this._readEntries().find((e) => isPlainObject(e) && e.id === id) || null;
    const raw = typeof id === 'string' ? find() : null;
    if (!raw) throw new LocalServerError('LOCAL_SERVER_UNKNOWN', `No local server "${shown(String(id)) || ''}" is configured.`);
    const previous = isPlainObject(raw.pinned) ? { addresses: Array.isArray(raw.pinned.addresses) ? [...raw.pinned.addresses] : [], class: raw.pinned.class ?? null, at: raw.pinned.at ?? null } : null;
    const resolved = await resolveAndPin(raw.baseUrl, { allowCgnat: raw.allowCgnat === true, now: this.now, ...this._lookupOption(lookup) });
    const changed = !previous || !sameAddresses(previous.addresses, resolved.addresses) || previous.class !== resolved.class;
    if (confirm !== true) return { previous, resolved, changed, stored: false };
    if (!sameAddresses(expected, resolved.addresses)) {
      throw new LocalServerError('LOCAL_RECHECK_STALE', 'The address answered differently from what was shown. Check it again.');
    }
    if (!changed) return { previous, resolved, changed, stored: false };
    this._requireWritable();
    const current = find();
    if (!current || JSON.stringify(current.pinned) !== JSON.stringify(raw.pinned) || current.baseUrl !== raw.baseUrl) {
      throw new LocalServerError('LOCAL_RECHECK_STALE', 'The local server changed while its address was checked. Check it again.');
    }
    this.write(this._readEntries().map((e) => (isPlainObject(e) && e.id === id ? { ...e, pinned: resolved } : e)));
    log.info(`The local server ${id} is now pinned at ${resolved.addresses.join(', ')} (${resolved.class}).`);
    return { previous, resolved, changed, stored: true };
  }

  /**
   * R-LI-31: make a local server from the built-in Ollama provider's
   * address. The built-in provider, its address setting and its targets stay
   * as they are; with `rewrite: true` every `ollama/<model>` profile target
   * becomes `local/<id>/<model>` (a cloud id is left alone).
   * @returns {Promise<{ added: boolean, server: object, models: object[], probeError: object|null, rewritten: { profileId: string, role: string, from: string, to: string }[] }>}
   */
  async fromOllama({ id = 'ollama-local', rewrite = false, lookup = null } = {}) {
    this._requireWritable();
    if (typeof id !== 'string' || !SERVER_ID_RE.test(id)) throw new LocalServerError('LOCAL_SERVER_INVALID', 'A local server id is 2 to 40 lowercase letters, digits and dashes, starting with a letter.');
    const baseUrl = this.getOllamaBaseUrl ? this.getOllamaBaseUrl() : null;
    const wanted = parseBaseUrl(baseUrl).href;
    const existing = this._readEntries().find((e) => isPlainObject(e) && e.id === id) || null;
    let added = false;
    let probeError = null;
    if (existing) {
      let held = null;
      try { held = parseBaseUrl(existing.baseUrl).href; } catch { /* not this server */ }
      if (existing.kind !== 'ollama' || held !== wanted) {
        throw new LocalServerError('LOCAL_SERVER_EXISTS', `Another local server already has the id ${id}.`);
      }
    } else {
      ({ probeError } = await this.add({ id, name: 'Ollama', kind: 'ollama', baseUrl: wanted }, { lookup }));
      added = true;
    }
    const rewritten = [];
    if (rewrite === true) {
      this._require(id);
      const profiles = this.getProfiles ? this.getProfiles() : null;
      if (!profiles || typeof profiles.list !== 'function' || typeof profiles.update !== 'function') {
        throw new LocalServerError('LOCAL_SERVER_INVALID', 'Profiles are not available in this host.');
      }
      for (const profile of profiles.list()) {
        const roles = {};
        const moved = [];
        for (const [role, targets] of Object.entries(profile.roles || {})) {
          roles[role] = (Array.isArray(targets) ? targets : []).map((target) => {
            if (target.provider !== 'ollama' || isOllamaCloudModelId(target.model)) return target;
            const to = { provider: LOCAL_PROVIDER, model: `${id}/${target.model}`, effort: null };
            moved.push({ profileId: profile.id, role, from: `ollama/${target.model}`, to: `${LOCAL_PROVIDER}/${to.model}` });
            return to;
          });
        }
        if (!moved.length) continue;
        profiles.update(profile.id, { roles });
        rewritten.push(...moved);
      }
      if (rewritten.length) log.info(`Moved ${rewritten.length} profile target${rewritten.length === 1 ? '' : 's'} from the built-in Ollama provider to the local server ${id}.`);
    }
    return { added, server: this.get(id), models: this.models(id).models, probeError, rewritten };
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

module.exports = { LocalServers, LocalServerError, SERVER_ID_RE, SERVER_KINDS, LOCAL_PROVIDER, splitModel, readEntry, pinAdminServers };
