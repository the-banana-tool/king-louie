const fs = require('fs').promises;
const path = require('path');

class PinManager {
  /**
   * @param {Object} options
   * @param {string} options.storageFile - Path to the JSON file for persistence
   */
  constructor(options = {}) {
    if (!options.storageFile) {
      throw new Error('PinManager requires storageFile option');
    }
    this.storageFile = options.storageFile;
    this.pins = new Map(); // sessionKey -> skillId
  }

  /**
   * Load pins from disk
   */
  async load() {
    try {
      const data = await fs.readFile(this.storageFile, 'utf8');
      const json = JSON.parse(data);
      this.pins = new Map(Object.entries(json));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[pin-manager] Failed to load pins:', error.message);
      }
      this.pins = new Map();
    }
  }

  /**
   * Save pins to disk
   */
  async save() {
    const json = Object.fromEntries(this.pins);
    await fs.writeFile(this.storageFile, JSON.stringify(json, null, 2), 'utf8');
  }

  /**
   * Pin a skill to a session
   * @param {string} sessionKey
   * @param {string} skillId
   */
  async pin(sessionKey, skillId) {
    this.pins.set(sessionKey, skillId);
    await this.save();
  }

  /**
   * Unpin a skill from a session
   * @param {string} sessionKey
   */
  async unpin(sessionKey) {
    if (this.pins.has(sessionKey)) {
      this.pins.delete(sessionKey);
      await this.save();
    }
  }

  /**
   * Get the pinned skill for a session
   * @param {string} sessionKey
   * @returns {string|null} skillId or null
   */
  getPinned(sessionKey) {
    return this.pins.get(sessionKey) || null;
  }

  /**
   * List all pins
   * @returns {Array<{sessionKey: string, skillId: string}>}
   */
  listAll() {
    return Array.from(this.pins.entries()).map(([sessionKey, skillId]) => ({
      sessionKey,
      skillId
    }));
  }
}

module.exports = PinManager;
