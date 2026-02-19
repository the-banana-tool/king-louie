const fs = require('fs');
const path = require('path');

class PinManager {
  constructor(options = {}) {
    this.storageFile = options.storageFile || path.join(process.cwd(), 'skill-pins.json');
    this.pins = {};
  }

  async load() {
    try {
      const dir = path.dirname(this.storageFile);
      await fs.promises.mkdir(dir, { recursive: true });

      if (!fs.existsSync(this.storageFile)) {
        this.pins = {};
        await this.save();
        return;
      }

      const raw = await fs.promises.readFile(this.storageFile, 'utf-8');
      const parsed = JSON.parse(raw || '{}');
      this.pins = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      console.warn('[pin-manager] Failed to load pin state, starting empty:', error.message);
      this.pins = {};
    }
  }

  async save() {
    const content = JSON.stringify(this.pins, null, 2);
    await fs.promises.writeFile(this.storageFile, content, 'utf-8');
  }

  async pin(sessionKey, skillId) {
    this.pins[String(sessionKey)] = String(skillId);
    await this.save();
  }

  async unpin(sessionKey) {
    delete this.pins[String(sessionKey)];
    await this.save();
  }

  getPinned(sessionKey) {
    return this.pins[String(sessionKey)] || null;
  }

  listAll() {
    return Object.entries(this.pins).map(([sessionKey, skillId]) => ({ sessionKey, skillId }));
  }
}

module.exports = PinManager;