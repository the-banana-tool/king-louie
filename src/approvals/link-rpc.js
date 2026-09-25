// Request/response and notifications over an authenticated MeshTransport
// link (node ↔ relay, spec §4.6). Every frame is a signed mesh envelope; the
// payload is { rpc: 1, id, method, params } for a call, { rpc: 1, id, result }
// or { rpc: 1, id, error: { code, message } } for its answer, and
// { rpc: 1, method, params } (no id) for a notification.
const crypto = require('crypto');
const { createLogger } = require('../logging');

const log = createLogger('approvals/link-rpc');

// Bounds on incoming ids and method names: a hostile peer sending
// arbitrarily long or many distinct values must not grow memory (the
// `pending` map is keyed on locally generated ids only, but `handlers`
// lookups and log lines still see whatever a peer sends).
const MAX_ID_LENGTH = 128;
const MAX_METHOD_LENGTH = 128;

class LinkRpcError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'LinkRpcError';
    this.code = code;
  }
}

function createLinkRpc(transport, { defaultTimeoutMs = 10000 } = {}) {
  const handlers = new Map();
  const pending = new Map();
  let fallback = null;
  let closed = false;

  const send = (peerId, payload) => {
    try {
      transport.send(peerId, payload);
      return true;
    } catch (err) {
      log.debug(`link send to ${peerId} failed: ${err.message}`);
      return false;
    }
  };

  const isValidId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
  const isValidMethod = (method) => typeof method === 'string' && method.length > 0 && method.length <= MAX_METHOD_LENGTH;

  const onMessage = ({ from, payload }) => {
    if (!payload || payload.rpc !== 1) return;
    // A malformed rpc payload is dropped, never crashes the transport or the
    // pending/handlers maps.
    if (payload.id !== undefined && !isValidId(payload.id)) {
      log.debug(`link message from ${from} dropped: malformed id`);
      return;
    }
    if (payload.method !== undefined && !isValidMethod(payload.method)) {
      log.debug(`link message from ${from} dropped: malformed method`);
      return;
    }
    if (payload.id && !payload.method) {
      // An answer: matched by id AND by the answering peer, so peer B
      // cannot answer a call made to peer A.
      const waiter = pending.get(payload.id);
      if (!waiter || waiter.peerId !== from) return;
      pending.delete(payload.id);
      clearTimeout(waiter.timer);
      if (payload.error) waiter.reject(new LinkRpcError(payload.error.code || 'error', payload.error.message));
      else waiter.resolve(payload.result === undefined ? null : payload.result);
      return;
    }
    if (typeof payload.method !== 'string') {
      log.debug(`link message from ${from} dropped: malformed payload`);
      return;
    }
    const own = handlers.get(payload.method);
    const handler = own || (fallback ? (params, ctx) => fallback(payload.method, params, ctx) : null);
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    if (!payload.id) {
      if (handler) {
        Promise.resolve()
          .then(() => handler(params, { peerId: from }))
          .catch((err) => log.warn(`notification ${payload.method} failed: ${err.message}`));
      }
      return;
    }
    if (!handler) {
      send(from, { rpc: 1, id: payload.id, error: { code: 'unknown_method', message: `no handler for ${payload.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(params, { peerId: from }))
      .then(
        (result) => send(from, { rpc: 1, id: payload.id, result: result === undefined ? null : result }),
        // Only the handler's own code and message cross the wire — never a
        // stack trace, and a throwing handler never crashes the transport.
        (err) => send(from, { rpc: 1, id: payload.id, error: { code: err.code || 'error', message: err.message } })
      );
  };

  const onDisconnect = ({ peerId }) => {
    for (const [id, waiter] of pending) {
      if (waiter.peerId !== peerId) continue;
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new LinkRpcError('peer_disconnected', `${peerId} disconnected`));
    }
  };

  transport.on('peerMessage', onMessage);
  transport.on('peerDisconnected', onDisconnect);

  return {
    call(peerId, method, params = {}, { timeoutMs = defaultTimeoutMs } = {}) {
      if (closed) return Promise.reject(new LinkRpcError('closed', 'link closed'));
      const id = crypto.randomBytes(12).toString('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new LinkRpcError('timeout', `${method} to ${peerId} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(id, { peerId, resolve, reject, timer });
        if (!send(peerId, { rpc: 1, id, method, params })) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new LinkRpcError('offline', `${peerId} is not connected`));
        }
      });
    },
    notify(peerId, method, params = {}) {
      send(peerId, { rpc: 1, method, params });
    },
    handle(method, fn) {
      handlers.set(method, fn);
    },
    unhandle(method) {
      handlers.delete(method);
    },
    // Called as fn(method, params, ctx) for any method without its own handler.
    onUnhandled(fn) {
      fallback = fn;
    },
    close() {
      closed = true;
      transport.removeListener('peerMessage', onMessage);
      transport.removeListener('peerDisconnected', onDisconnect);
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new LinkRpcError('closed', 'link closed'));
        pending.delete(id);
      }
    }
  };
}

module.exports = { createLinkRpc, LinkRpcError };
