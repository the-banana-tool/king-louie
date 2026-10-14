// src/models/local-servers.js
// The local server registry (spec 2026-10-13-local-inference-design.md §5.1,
// §5.3, §5.5): the servers the owner (desktop) or the administrator (service)
// added and marked local, their pinned addresses, and the one transport and
// one provider each of them gets.
//
// Everything here fails closed. An entry whose shape is wrong, that has no
// mark, or whose pinned addresses no longer pass the address check is listed
// as unusable and is never dialled. Whether a target may carry the guarantee
// (a private chat, a local-only role) is read from the entry and from its
// transport's own grade (R-LI-30), never from the target, the model id or
// the provider name. The built-in `ollama` provider is not a local server
// (R-LI-31).
//
// Electron-free. Log lines carry server ids, addresses and codes, never
// request or reply text.
const { createLogger } = require('../logging');
const { LOCAL_PROVIDER, isOllamaCloudModelId } = require('./provider-ids');
const { parseBaseUrl, checkPinned, canonicalAddress, isTlsFingerprint } = require('./local-address');
const { createLocalTransport } = require('./local-transport');

const log = createLogger('models/local-servers');

const SERVER_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SERVER_KINDS = Object.freeze(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'openai-compatible']);
const DEFAULT_MAX_CONCURRENT = 2;
const MAX_CONCURRENT_LIMIT = 64;
const MAX_NAME = 80;
// A name is shown in sentences and lists: one plain line.
// eslint-disable-next-line no-control-regex
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

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

class LocalServers {
  /**
   * @param {object} options
   * @param {Function} options.getEntries - the stored entries (an array)
   * @param {Function} [options.getToken] - `(serverId) => key | null`
   * @param {object|null} [options.catalog] - told which servers exist, so it prices their models at $0
   * @param {Function} [options.createTransport]
   * @param {Function} [options.now]
   */
  constructor({ getEntries, getToken = () => null, catalog = null, createTransport = createLocalTransport, now = () => new Date() } = {}) {
    if (typeof getEntries !== 'function') throw new Error('LocalServers needs getEntries().');
    this.getEntries = getEntries;
    this.getToken = typeof getToken === 'function' ? getToken : () => null;
    this.catalog = catalog || null;
    this.createTransport = createTransport;
    this.now = now;
    this._transports = new Map(); // id → { signature, transport }
    this._providers = new Map(); // id → { transport, key, kind, provider }
    this._memo = null; // { source, rows }
    this._entriesFailed = false;
    this._tokenFailed = new Set();
    this._closed = false;
    this._priceCheck = (serverId) => this._usableRow(serverId) !== null;
    if (this.catalog && typeof this.catalog.setLocalServerCheck === 'function') this.catalog.setLocalServerCheck(this._priceCheck);
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
    for (const id of [...this._transports.keys()]) if (!live.has(id)) this._dropTransport(id);
    this._memo = source === null ? null : { source, rows };
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

  /**
   * Whether a `local` model can take a call, in Availability#explain's shape
   * (plus `code` when it cannot).
   * @returns {{ usable: boolean, reasons: string[], notes: string[], entry: object|null, code?: string }}
   */
  explain(modelId, { needs = {} } = {}) { // eslint-disable-line no-unused-vars
    const refuse = (code, reason) => ({ usable: false, reasons: [reason], notes: [], entry: null, code });
    const split = splitModel(typeof modelId === 'string' ? modelId.trim() : modelId);
    if (!split) return refuse('LOCAL_SERVER_UNKNOWN', 'A local model is named "<server>/<model>", and this one names no local server.');
    const row = this._row(split.serverId);
    if (!row) return refuse('LOCAL_SERVER_UNKNOWN', `No local server "${split.serverId}" is configured.`);
    if (!row.usable) return refuse('LOCAL_SERVER_UNUSABLE', row.problem);
    if (row.kind === 'ollama' && isOllamaCloudModelId(split.model)) {
      return refuse('LOCAL_CLOUD_MODEL', `${split.model} runs on Ollama's cloud, not on ${row.name}.`);
    }
    return { usable: true, reasons: [], notes: [`${split.model} on ${row.name} is not probed: its capabilities are unknown.`], entry: null };
  }

  /** Close every transport. The registry lists and dials nothing afterwards. */
  close() {
    if (this._closed) return;
    for (const id of [...this._transports.keys()]) this._dropTransport(id);
    this._providers.clear();
    this._memo = null;
    this._closed = true;
  }
}

module.exports = { LocalServers, LocalServerError, SERVER_ID_RE, SERVER_KINDS, LOCAL_PROVIDER, splitModel, readEntry };
