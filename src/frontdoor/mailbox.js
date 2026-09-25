// Node-signed messages sent with link.send (F5 leases, C4 questions), held in
// memory for phones to fetch. A type is routed only once a consumer has
// registered its prefix (src/frontdoor/extensions.js).
const { EventEmitter } = require('events');
const { open } = require('../approvals/envelope');
const { NODE_ID_RE, DEVICE_ID_RE } = require('../approvals/messages');

const PER_NODE = 1000;
const MAX_WAIT_MS = 25000;

const err = (code, message) => Object.assign(new Error(message || code), { code });

class Mailbox extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.types = new Map();
    this.items = [];
    this.seq = 0;
  }

  // A prefix must end in '.': a message type is routed only when it matches
  // a full dotted segment, so a consumer registered for 'kl.enroll.' can
  // never catch 'kl.enrollx.anything' on a bare string-prefix overlap.
  registerType(prefix, { ttlMs, maxBytes = 262144 } = {}) {
    if (typeof prefix !== 'string' || !prefix.endsWith('.') || !Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("registerType(prefix, { ttlMs }) needs a prefix ending in '.' and a positive ttlMs");
    }
    this.types.set(prefix, { ttlMs, maxBytes });
  }

  _typeConfig(type) {
    for (const [prefix, config] of this.types) if (String(type).startsWith(prefix)) return config;
    return null;
  }

  put(nodeId, envelope, { to_device: toDevice = null } = {}) {
    if (!NODE_ID_RE.test(nodeId)) throw err('bad_node', 'node id is not well-formed');
    if (toDevice !== null && !DEVICE_ID_RE.test(toDevice)) throw err('bad_device', 'to_device is not well-formed');
    const { message, bytes } = open(envelope);
    const config = this._typeConfig(message.type);
    if (!config) throw err('type_not_routed', `no consumer routes ${message.type}`);
    if (bytes.length > config.maxBytes) throw err('too_large', `${message.type} is over ${config.maxBytes} bytes`);
    this.seq += 1;
    this.items.push({ seq: this.seq, node_id: nodeId, type: message.type, envelope, to_device: toDevice, expires_at: this.now() + config.ttlMs });
    const mine = this.items.filter((i) => i.node_id === nodeId);
    if (mine.length > PER_NODE) {
      const drop = new Set(mine.slice(0, mine.length - PER_NODE).map((i) => i.seq));
      this.items = this.items.filter((i) => !drop.has(i.seq));
    }
    this.emit('change', this.seq);
    return { seq: this.seq };
  }

  // A message for a specific device (`to_device`) is listed only for it.
  list({ nodeIds, typePrefix = null, toDevice = null, afterSeq = 0 } = {}) {
    const wanted = new Set(nodeIds || []);
    const now = this.now();
    return this.items
      .filter((i) => wanted.has(i.node_id) && i.seq > afterSeq && now <= i.expires_at)
      .filter((i) => !typePrefix || i.type.startsWith(typePrefix))
      .filter((i) => i.to_device === null || i.to_device === toDevice)
      .map(({ seq, node_id, envelope, to_device, expires_at }) => ({ seq, node_id, envelope, to_device, expires_at: new Date(expires_at).toISOString() }));
  }

  // Long poll: resolves with the list as soon as it is non-empty, else [] at
  // timeout (clamped to MAX_WAIT_MS either way). The listener is removed on
  // whichever path fires, so a client that never returns for the result
  // leaves nothing registered.
  wait(filter, { timeoutMs = MAX_WAIT_MS } = {}) {
    const first = this.list(filter);
    const limit = Math.min(Math.max(0, timeoutMs), MAX_WAIT_MS);
    if (first.length || limit === 0) return Promise.resolve(first);
    return new Promise((resolve) => {
      const onChange = () => {
        const items = this.list(filter);
        if (!items.length) return;
        this.removeListener('change', onChange);
        clearTimeout(timer);
        resolve(items);
      };
      const timer = setTimeout(() => { this.removeListener('change', onChange); resolve([]); }, limit);
      if (typeof timer.unref === 'function') timer.unref();
      this.on('change', onChange);
    });
  }

  sweep() {
    const now = this.now();
    this.items = this.items.filter((i) => now <= i.expires_at);
  }
}

module.exports = { Mailbox, MAX_WAIT_MS };
