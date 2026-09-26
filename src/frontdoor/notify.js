// Pushes for the front door's own events (fleet stage 4 §3.13): pairing
// requests and alerts go to the front door's active approvers, when they
// have a push token. Grants are never pushed (§3.4): the owner starts them.
// A push carries only { kind, id }; the phone fetches the rest itself.
const { createLogger } = require('../logging');

const log = createLogger('frontdoor/notify');

const PUSH_KINDS = Object.freeze(['pairing', 'alert']);
const PUSH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function createApproverNotifier({ approverStore, devices, pusher } = {}) {
  if (!approverStore || typeof approverStore.list !== 'function' || typeof approverStore.isActive !== 'function') throw new TypeError('createApproverNotifier needs the front door approver store');
  if (!devices || typeof devices.get !== 'function') throw new TypeError('createApproverNotifier needs the device registry');
  if (!pusher || typeof pusher.notify !== 'function') throw new TypeError('createApproverNotifier needs a pusher');
  // Never throws: a push is a hint, and whatever raised it has already happened.
  return (kind, id) => {
    try {
      if (!PUSH_KINDS.includes(kind) || typeof id !== 'string' || !PUSH_ID_RE.test(id)) {
        log.warn(`refusing a push that is not a pairing or alert id (${String(kind).slice(0, 32)})`);
        return;
      }
      for (const r of approverStore.list()) {
        if (!approverStore.isActive(r.device_id)) continue;
        const device = devices.get(r.device_id);
        if (!device || !device.push) continue;
        Promise.resolve()
          .then(() => pusher.notify(device, { kind, id }))
          .catch((err) => log.warn(`${kind} push to ${r.device_id} failed: ${err && err.message}`));
      }
    } catch (err) {
      log.warn(`cannot send a ${kind} push: ${err && err.message}`);
    }
  };
}

module.exports = { createApproverNotifier, PUSH_KINDS };
