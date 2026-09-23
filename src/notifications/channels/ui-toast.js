class UiToastChannel {
  constructor({ Notification } = {}) {
    this.Notification = Notification || null;
  }

  async send(payload = {}) {
    const title = String(payload.title || 'King Louie');
    const body = String(payload.body || 'Task completed.');
    const Notification = this.Notification;

    if (!Notification) {
      return { ok: false, skipped: true, reason: 'Desktop notifications are not available in this host.' };
    }
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      return { ok: false, skipped: true, reason: 'Desktop notifications are not supported on this system.' };
    }

    new Notification({ title, body, silent: false }).show();
    return { ok: true, channel: 'ui-toast' };
  }
}

module.exports = UiToastChannel;
