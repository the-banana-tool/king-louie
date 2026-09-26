// src/cases/contact-host.js
// Wires contact into a host (cases stage 4 spec §7): builds the adapters,
// Presence, ContactRouter and LadderEngine, attaches the Telegram and Discord
// bridges, polls the relays, mounts the relay push route and exposes what
// IPC needs. Electron-free; createCore calls it from start().
const path = require('path');
const { DesktopChannelPlugin } = require('../channels/channel-plugin');
const { EmailChannel } = require('../channels/email-channel');
const { createRelayEmailTransport, createImapSmtpTransport } = require('../channels/email-transports');
const { TelephonyChannel } = require('../channels/telephony-channel');
const { NtfyContact } = require('../channels/ntfy-contact');
const { ContactRelayClient, RelayPoller, createRelayPushHandler } = require('../channels/relay-client');
const { ContactState } = require('./contact-state');
const { ContactRouter } = require('./contact');
const { Presence } = require('./presence');
const { LadderEngine } = require('./ladder');
const { CONTACT_CHANNELS, validatePolicy, effectivePolicy } = require('./contact-format');
const { resolveContactConfig } = require('./contact-settings');
const { createLogger } = require('../logging');

const ATTACH_MS = 2000;

class PassiveHostError extends Error {
  constructor() {
    super('this host does not run the contact ladder');
    this.name = 'PassiveHostError';
  }
}

// C3's gateLeaves when it has merged, else null (every non-owner send refuses).
// Integration point for C3: once src/cases/gates.js exports gateLeaves this
// returns the module and ContactRouter.sendExternal gates through it; no edit
// here is needed. Until then every non-owner send is refused.
function defaultGetGate() {
  try {
    const gates = require('./gates');
    return typeof gates.gateLeaves === 'function' ? gates : null;
  } catch {
    return null;
  }
}

function createContactHost({
  getSettings, setSettings = null, contactConfig = null, isService = false, caseRuntime, channelRegistry = null, vault = null,
  dataDir, features = {}, getBridges = () => ({}), getWebhookServer = () => null, approvals = null,
  clock = () => new Date(), tickMs = Number(process.env.KING_LOUIE_CONTACT_TICK_MS) || 30000, getGate = defaultGetGate,
  fetchImpl = globalThis.fetch, extraAdapters = {}, log = createLogger('contact/host')
} = {}) {
  const host = caseRuntime.host || {};
  const settings = () => {
    try {
      return getSettings() || {};
    } catch {
      return {};
    }
  };
  const channelSettings = (id) => (settings().channels && settings().channels[id]) || {};
  const contact = () => resolveContactConfig({ settings: settings(), contactConfig, isService, logger: log });
  const interactive = () => {
    try {
      return typeof host.interactive === 'function' && host.interactive() === true;
    } catch {
      return false;
    }
  };
  const secret = (key) => (vault && typeof vault.get === 'function' ? vault.get(key) : null);
  const contactDir = path.join(dataDir, 'contact');
  const state = new ContactState({ dir: contactDir, clock });

  const built = new Map();
  const attached = {};
  let stopping = null;
  let inApp = null;
  let presence = null;

  // M9: in service mode a desktop attaches (F7's bridge) after start, and
  // host.interactive() only turns true then. The in-app adapter is built
  // on first use while a UI is attached, and served only while it is.
  function inAppAdapter() {
    if (!interactive() || typeof host.notify !== 'function') return null;
    if (!inApp) {
      inApp = new DesktopChannelPlugin({
        sendToUi: (event, payload) => host.notify(event, payload),
        uiToast: host.uiToast || null,
        isFocused: () => presence.status().signals.desktop?.focused === true
      });
    }
    return inApp;
  }

  const adapters = {
    get(id) {
      if (id === 'in-app') return inAppAdapter();
      if (id === 'telegram' || id === 'discord') {
        attachBridges();
        const b = getBridges()[id];
        return b && attached[id] === b ? b : null;
      }
      return built.get(id) || null;
    }
  };

  presence = new Presence({
    file: path.join(contactDir, 'presence.json'),
    getPolicy: () => settings().contactPolicy,
    clock,
    interactive,
    isEnabled: (id) => Boolean(adapters.get(id)?.contactConfigured()),
    getTimeZone: () => settings().cases?.timeZone || ''
  });
  const router = new ContactRouter({ state, runtime: caseRuntime, adapters, presence, getGate, clock, getTimeZone: () => presence.timeZone() });
  const ladder = new LadderEngine({
    state, casesRoot: caseRuntime.root, runtime: caseRuntime, router, presence, getPolicy: () => settings().contactPolicy, clock, tickMs, dataDir
  });

  function wire(id, adapter) {
    adapter.onContactReply((correlationId, answer, meta) => router.handleReply(id, correlationId, answer, meta));
    adapter.onContactStatus((s) => router.recordStatus(id, s));
  }

  function attachBridges() {
    if (stopping) return;
    for (const id of ['telegram', 'discord']) {
      const bridge = getBridges()[id];
      if (!bridge || attached[id] === bridge || typeof bridge.setContactHost !== 'function') continue;
      bridge.setContactHost({
        router,
        getOwnerUserId: () => contact()[id]?.ownerUserId || '',
        isEnabled: () => channelSettings(id).contactEnabled === true
      });
      wire(id, bridge);
      attached[id] = bridge;
    }
  }

  // Relays and the channels built on them, only with features.channels on.
  const relays = new Map();
  const pollers = [];
  function buildAdapters() {
    const cfg = contact();
    for (const [name, r] of Object.entries(cfg.relays || {})) {
      try {
        relays.set(name, {
          client: new ContactRelayClient({ name, baseUrl: r.baseUrl, getToken: () => secret(`contact.relay.${name}.token`), fetchImpl }),
          pollSec: r.pollSec || 30
        });
      } catch (err) {
        log.warn(`contact relay ${name} is not usable: ${err.message}`);
      }
    }
    const email = channelSettings('email');
    if (email.enabled && cfg.email) {
      let transport = null;
      if (email.transport === 'imap-smtp' && cfg.email.smtp && cfg.email.imap) {
        transport = createImapSmtpTransport({ smtp: cfg.email.smtp, imap: cfg.email.imap, getPassword: (which) => secret(`contact.email.${which}Password`) });
      } else if (relays.has(cfg.email.relay)) {
        transport = createRelayEmailTransport({ relay: relays.get(cfg.email.relay).client });
      }
      if (transport) {
        built.set('email', new EmailChannel({
          transport,
          getConfig: () => ({ owner: contact().email?.owner, from: contact().email?.from, trustedAuthServId: contact().email?.imap?.trustedAuthServId || '' }),
          pollSec: cfg.email.imap?.pollSec || 60
        }));
      }
    }
    for (const kind of ['sms', 'voice']) {
      const s = channelSettings(kind);
      const c = cfg[kind];
      if (s.enabled && c && relays.has(c.relay)) {
        built.set(kind, new TelephonyChannel({
          kind,
          relay: relays.get(c.relay).client,
          getConfig: () => ({ owner: contact()[kind]?.owner, from: contact()[kind]?.from, maxChars: channelSettings(kind).maxChars, language: channelSettings(kind).language })
        }));
      }
    }
    if (channelSettings('ntfy').enabled && cfg.ntfy) {
      built.set('ntfy', new NtfyContact({
        getConfig: () => ({ baseUrl: contact().ntfy?.baseUrl, topic: contact().ntfy?.topic, includeText: channelSettings('ntfy').includeText === true })
      }));
    }
    for (const [id, adapter] of Object.entries(extraAdapters)) {
      if (adapter) built.set(id, adapter);
    }
    for (const [id, adapter] of built) {
      wire(id, adapter);
      if (channelRegistry) channelRegistry.register(adapter);
    }
  }

  let attachTimer = null;
  const api = {
    state, router, presence, ladder, adapters, relays,

    async start() {
      if (features.channels !== false) buildAdapters();
      for (const adapter of built.values()) {
        try {
          await adapter.initialize();
        } catch (err) {
          log.warn(`contact channel ${adapter.id} did not start: ${err.message}`);
        }
      }
      for (const [name, r] of relays) {
        const poller = new RelayPoller({
          client: r.client, state, pollSec: r.pollSec,
          onEvents: async (events) => (ladder.active ? router.ingestRelayEvents(name, events) : null)
        });
        poller.start();
        pollers.push(poller);
      }
      const webhook = getWebhookServer();
      if (webhook && typeof webhook.setContactRelayHandler === 'function') {
        // Spec §7: only the process holding the ladder lease applies relay
        // events; a passive one answers 503 after the signature check. The
        // refusal throws inside onEvents, so the push handler does not
        // remember it as applied and the relay's retry (or the active
        // host's poll) still delivers it.
        const push = createRelayPushHandler({
          getSecret: (name) => secret(`contact.relay.${name}.webhookSecret`),
          hasRelay: (name) => relays.has(name),
          onEvents: (name, events) => {
            if (!ladder.active) throw new PassiveHostError();
            return router.ingestRelayEvents(name, events);
          },
          clock
        });
        webhook.setContactRelayHandler(async (name, rawBody, headers) => {
          try {
            return await push(name, rawBody, headers);
          } catch (err) {
            if (err instanceof PassiveHostError) return { status: 503, body: { error: 'this host does not run the contact ladder' } };
            throw err;
          }
        });
      }
      attachBridges();
      attachTimer = setInterval(attachBridges, ATTACH_MS);
      if (typeof attachTimer.unref === 'function') attachTimer.unref();
      ladder.start();
      if (approvals && typeof api.startMobile === 'function') await api.startMobile(approvals);
    },

    // M10: createCore stops the contact host before the channel registry and
    // the webhook server. Idempotent: a second call waits for the first. The
    // adapters leave the registry first, so the core's
    // channelRegistry.shutdownAll() never shuts one a second time.
    stop() {
      if (!stopping) stopping = stopOnce();
      return stopping;
    },

    channelStatuses() {
      const out = {};
      for (const id of CONTACT_CHANNELS) out[id] = router.channelStatus(id);
      return out;
    },

    getPolicy() {
      return { policy: effectivePolicy(settings().contactPolicy), channels: api.channelStatuses() };
    },

    setPolicy(policy) {
      const r = validatePolicy(policy, { now: clock() });
      if (!r.ok) return r;
      if (typeof setSettings !== 'function') return { ok: false, error: 'this host cannot save settings' };
      setSettings({ ...settings(), contactPolicy: r.policy });
      return { ok: true, policy: r.policy };
    },

    presenceStatus() {
      const status = presence.status();
      const s = ladder.status();
      return { ...status, ladder: s.runsHere ? { runsHere: true } : { runsHere: false, message: s.holder ? `contact ladder runs in ${s.holder.host}:${s.holder.pid}` : 'no cases yet' } };
    },

    // Wave 3 (R44): the phone app, when the service runs F3 approvals. The
    // approver store is F3's admin <configDir>/approvers/ set (never a
    // data-dir one); the relay link goes on the adapter's `link`.
    async startMobile(approvals) {
      if (!approvals || !approvals.relayClient || !approvals.approverStore || !approvals.identity) return;
      const { MobileAppChannel } = require('../channels/mobile-app-channel');
      const { NonceCache } = require('../approvals/verify-device');
      const mobile = new MobileAppChannel({
        link: approvals.relayClient,
        approverStore: approvals.approverStore,
        identity: approvals.identity,
        nonces: new NonceCache({}),
        getRouter: () => router,
        presence,
        isEnabled: () => channelSettings('mobile').enabled === true,
        clock
      });
      mobile.registerMethods();
      wire('mobile', mobile);
      built.set('mobile', mobile);
    },

    // core.context.getContact()
    context() {
      return {
        ladder, presence, router,
        ladderState: () => ladder.list(),
        getPolicy: () => api.getPolicy(),
        setPolicy: (p) => api.setPolicy(p),
        heartbeat: (p) => presence.heartbeat(p || {}),
        presenceStatus: () => api.presenceStatus()
      };
    }
  };

  async function stopOnce() {
    if (attachTimer) clearInterval(attachTimer);
    attachTimer = null;
    const webhook = getWebhookServer();
    if (webhook && typeof webhook.setContactRelayHandler === 'function') webhook.setContactRelayHandler(null);
    for (const p of pollers) p.stop();
    // The bridges stop taking contact replies (and attachBridges no longer
    // re-attaches them once stopping is set).
    for (const id of Object.keys(attached)) {
      try {
        attached[id].setContactHost(null);
      } catch (err) {
        log.warn(`contact: detaching ${id} failed: ${err.message}`);
      }
      delete attached[id];
    }
    // Out of the registry before awaiting anything: if the core's timeout
    // gives up on this stop (a hung tick), its shutdownAll() must not shut
    // these adapters while they are still ours to shut below.
    for (const [id, adapter] of built) {
      if (channelRegistry && channelRegistry.get(id) === adapter) channelRegistry.unregister(id);
    }
    // The in-flight tick drains before any adapter it delivers through stops.
    await ladder.stop();
    for (const adapter of built.values()) {
      try {
        await adapter.shutdown();
      } catch (err) {
        log.warn(`contact channel ${adapter.id} did not stop cleanly: ${err.message}`);
      }
    }
  }

  return api;
}

module.exports = { createContactHost, defaultGetGate };
