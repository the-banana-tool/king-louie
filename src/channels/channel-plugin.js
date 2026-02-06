class ChannelPlugin {
  constructor(config = {}) {
    this.id = config.id;
    this.label = config.label || config.id || 'Channel';
    this.capabilities = config.capabilities || {};
  }

  normalizeTarget(rawTarget) {
    throw new Error('normalizeTarget must be implemented by channel plugin');
  }

  async send(_target, _message, _options = {}) {
    throw new Error('send must be implemented by channel plugin');
  }

  listActions() {
    return ['send', 'reply'];
  }
}

class DesktopChannelPlugin extends ChannelPlugin {
  constructor() {
    super({
      id: 'desktop',
      label: 'Desktop App',
      capabilities: {
        chatTypes: ['direct', 'group'],
        media: true,
        buttons: true
      }
    });
  }

  normalizeTarget(rawTarget = '') {
    return String(rawTarget || '').trim();
  }

  async send(target, message, options = {}) {
    const { BrowserWindow } = require('electron');
    const mainWindow = BrowserWindow.getAllWindows()[0];

    if (mainWindow) {
      mainWindow.webContents.send('channel:message', {
        channel: 'desktop',
        target,
        message,
        media: options.media,
        buttons: options.buttons
      });
    }

    return { status: 'sent' };
  }
}

module.exports = { ChannelPlugin, DesktopChannelPlugin };