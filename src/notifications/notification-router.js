const UiToastChannel = require('./channels/ui-toast');
const NtfyChannel = require('./channels/ntfy-channel');

const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: true,
  thresholdsMs: {
    toast: 30000,
    external: 120000
  },
  uiToast: {
    enabled: true
  },
  ntfy: {
    enabled: false,
    topic: ''
  },
  telegram: {
    longTaskNotice: true
  }
};

function normalizeNotificationSettings(settings = {}) {
  const source = settings || {};
  const thresholds = source.thresholdsMs || {};

  const toast = Math.max(0, Number(thresholds.toast || DEFAULT_NOTIFICATION_SETTINGS.thresholdsMs.toast));
  const external = Math.max(
    toast,
    Number(thresholds.external || DEFAULT_NOTIFICATION_SETTINGS.thresholdsMs.external)
  );

  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...source,
    thresholdsMs: {
      toast,
      external
    },
    uiToast: {
      ...(DEFAULT_NOTIFICATION_SETTINGS.uiToast || {}),
      ...(source.uiToast || {})
    },
    ntfy: {
      ...(DEFAULT_NOTIFICATION_SETTINGS.ntfy || {}),
      ...(source.ntfy || {})
    },
    telegram: {
      ...(DEFAULT_NOTIFICATION_SETTINGS.telegram || {}),
      ...(source.telegram || {})
    }
  };
}

class NotificationRouter {
  constructor(options = {}) {
    this.getSettings =
      typeof options.getSettings === 'function'
        ? options.getSettings
        : () => DEFAULT_NOTIFICATION_SETTINGS;

    this.channels = {
      uiToast: options.uiToastChannel || new UiToastChannel(),
      ntfy: options.ntfyChannel || new NtfyChannel(options.ntfy || {})
    };
  }

  classify(durationMs, settings = DEFAULT_NOTIFICATION_SETTINGS) {
    if (!settings.enabled) {
      return 'none';
    }

    if (durationMs < settings.thresholdsMs.toast) {
      return 'none';
    }

    if (durationMs < settings.thresholdsMs.external) {
      return 'ui-toast';
    }

    return 'external';
  }

  async route(payload = {}) {
    const settings = normalizeNotificationSettings(this.getSettings());
    const durationMs = Math.max(0, Number(payload.durationMs || 0));
    const route = this.classify(durationMs, settings);

    if (route === 'none') {
      return { ok: true, route, skipped: true };
    }

    const title = String(payload.title || 'King Louie task update');
    const body = String(payload.body || `Completed in ${Math.round(durationMs / 1000)}s.`);

    if (route === 'ui-toast') {
      if (!settings.uiToast?.enabled) {
        return { ok: true, route, skipped: true, reason: 'UI toast channel disabled.' };
      }
      return this.channels.uiToast.send({ ...payload, title, body, durationMs });
    }

    if (!settings.ntfy?.enabled) {
      return { ok: true, route, skipped: true, reason: 'External ntfy channel disabled.' };
    }

    return this.channels.ntfy.send({
      ...payload,
      title,
      body,
      durationMs,
      topic: settings.ntfy?.topic || ''
    });
  }
}

module.exports = {
  NotificationRouter,
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings
};