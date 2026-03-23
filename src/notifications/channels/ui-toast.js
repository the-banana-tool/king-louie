const { Notification } = require('electron');

class UiToastChannel {
  async send(payload = {}) {
    const title = String(payload.title || 'King Louie');
    const body = String(payload.body || 'Task completed.');

    if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) {
      return {
        ok: false,
        skipped: true,
        reason: 'Desktop notifications are not supported on this system.'
      };
    }

    const toast = new Notification({
      title,
      body,
      silent: false
    });

    toast.show();
    return { ok: true, channel: 'ui-toast' };
  }
}

module.exports = UiToastChannel;