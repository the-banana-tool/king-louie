class ChannelPlugin {
  constructor(config = {}) {
    this.id = config.id;
    this.label = config.label || config.id || 'Channel';
    this.capabilities = Array.isArray(config.capabilities)
      ? config.capabilities
      : ['send', 'receive'];
  }

  async initialize(_gateway) {
    throw new Error('initialize must be implemented by channel plugin');
  }

  async shutdown() {
    throw new Error('shutdown must be implemented by channel plugin');
  }

  normalizeTarget(rawTarget) {
    throw new Error('normalizeTarget must be implemented by channel plugin');
  }

  async send(_target, _message, _options = {}) {
    throw new Error('send must be implemented by channel plugin');
  }

  async onMessage(_handler) {}

  async listTargets() {
    return [];
  }

  getStatus() {
    return { connected: false };
  }

  supportsGroups() {
    return false;
  }

  async listGroups() {
    return [];
  }

  getMentionPattern() {
    return null;
  }
}

class ChannelRegistry {
  constructor() {
    this.channels = new Map();
  }

  register(channelPlugin) {
    if (!channelPlugin || !channelPlugin.id) {
      throw new Error('channelPlugin with a valid id is required');
    }
    this.channels.set(channelPlugin.id, channelPlugin);
  }

  get(id) {
    return this.channels.get(id);
  }

  unregister(id) {
    return this.channels.delete(id);
  }

  list() {
    return Array.from(this.channels.values());
  }

  async initializeAll(gateway) {
    for (const channel of this.channels.values()) {
      try {
        await channel.initialize(gateway);
      } catch (err) {
        console.error(`[channel:${channel.id}] init failed:`, err.message);
      }
    }
  }

  async shutdownAll() {
    for (const channel of this.channels.values()) {
      try {
        await channel.shutdown();
      } catch (err) {
        console.error(`[channel:${channel.id}] shutdown failed:`, err.message);
      }
    }
  }
}

class DesktopChannelPlugin extends ChannelPlugin {
  constructor() {
    super({
      id: 'desktop',
      label: 'Desktop App',
      capabilities: ['send', 'receive']
    });
  }

  async initialize() {}

  async shutdown() {}

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

module.exports = { ChannelPlugin, ChannelRegistry, DesktopChannelPlugin };