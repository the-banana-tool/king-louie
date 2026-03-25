/**
 * Base interface for King Louie skills/plugins
 *
 * A skill is a self-contained module that can:
 * - Handle custom commands (e.g., /std add "Task name")
 * - Register custom tools
 * - Maintain its own state/database
 * - Integrate with Telegram and UI
 *
 * Skills should export an object implementing this interface.
 */

/**
 * @typedef {Object} SkillSettingsField
 * @property {string} key - Setting key (dot-notation for nested, e.g. 'docker.image')
 * @property {string} label - Human-readable label
 * @property {'text'|'number'|'toggle'|'select'|'password'} type - Field type
 * @property {any} default - Default value
 * @property {string} [description] - Help text shown below the field
 * @property {Array<{label: string, value: string}>} [options] - For 'select' type
 * @property {string} [placeholder] - Placeholder text for text/number/password inputs
 */

/**
 * @typedef {Object} SkillMetadata
 * @property {string} id - Unique skill identifier (e.g., 'std', 'calendar')
 * @property {string} name - Human-readable skill name
 * @property {string} version - Skill version (semver)
 * @property {string} description - Brief description of what the skill does
 * @property {string} author - Skill author
 * @property {string[]} commands - List of commands this skill handles (e.g., ['std'])
 * @property {Array<'code'|'cli'|'prompt'|'skill'>} [resolvers] - Ordered resolver chain. Default: ['skill']
 * @property {boolean} [pinnable] - If true, skill can be pinned to a chat. Pinned skill must implement handleMessage().
 */

/**
 * @typedef {Object} SkillContext
 * @property {string} workingDirectory - King Louie working directory
 * @property {string} userDataPath - Path to user data directory for storing skill data
 * @property {Object} toolRegistry - King Louie's tool registry (for registering custom tools)
 * @property {Object} sessionManager - Session manager for multi-session support
 * @property {Function} sendMessage - Function to send messages back to user (chatId, message)
 */

/**
 * @typedef {Object} CommandContext
 * @property {string} chatId - Chat/session identifier where command was invoked
 * @property {string} channel - Channel where command came from ('telegram', 'ui', 'api')
 * @property {string} userId - User identifier
 * @property {Object} session - Session object for this chat
 */

/**
 * @typedef {Object} CommandResult
 * @property {boolean} ok - Whether command executed successfully
 * @property {string} [message] - Message to display to user
 * @property {string} [error] - Error message if ok=false
 * @property {'json'|'html'|'markdown'|'xml'|'text'} [format] - Content format for message/error payload
 * @property {any} [data] - Optional data payload
 */

/**
 * @typedef {Object} MessageResult
 * @property {boolean} ok
 * @property {string} [message]
 * @property {string} [error]
 * @property {'json'|'html'|'markdown'|'xml'|'text'} [format] - Content format for message/error payload
 * @property {any} [data]
 * @property {boolean} [continueWithAgent] - If true, also run the AI agent after this response.
 *                                            Defaults to false (skill handles it completely).
 */

class Skill {
  /**
   * Get skill metadata
   * @returns {SkillMetadata}
   */
  getMetadata() {
    throw new Error('Skill must implement getMetadata()');
  }

  /**
   * Initialize the skill with King Louie context
   * Called once when the skill is loaded
   *
   * @param {SkillContext} context - King Louie context
   * @returns {Promise<void>}
   */
  async initialize(context) {
    throw new Error('Skill must implement initialize()');
  }

  /**
   * Optional deterministic code resolver (first in priority chain when enabled)
   *
   * @param {{ command: string, args: string[], context: CommandContext }} payload
   * @returns {Promise<CommandResult|null>}
   */
  async resolveCode(payload) {
    return null;
  }

  /**
   * Optional CLI resolver
   *
   * @param {{ command: string, args: string[], context: CommandContext }} payload
   * @returns {Promise<CommandResult|null>}
   */
  async resolveCli(payload) {
    return null;
  }

  /**
   * Optional prompt/LLM resolver
   *
   * @param {{ command: string, args: string[], context: CommandContext }} payload
   * @returns {Promise<CommandResult|null>}
   */
  async resolvePrompt(payload) {
    return null;
  }

  /**
   * Handle a command invocation
   *
   * @param {string} command - The base command (e.g., 'std')
   * @param {string[]} args - Command arguments
   * @param {CommandContext} context - Execution context
   * @returns {Promise<CommandResult>}
   */
  async handleCommand(command, args, context) {
    throw new Error('Skill must implement handleCommand()');
  }

  /**
   * Handle a free-form message when this skill is pinned to a chat.
   * Only called when the skill is pinned AND the user sends non-command text.
   *
   * @param {string} text - Raw user message
   * @param {CommandContext} context
   * @returns {Promise<MessageResult|null>} - null means "not handled, fall through to agent"
   */
  async handleMessage(text, context) {
    return null; // Default: not handled
  }

  /**
   * Get settings schema for this skill.
   * Override to expose configurable settings in the settings overlay.
   *
   * @returns {SkillSettingsField[]} - Array of field definitions (empty = no settings)
   */
  getSettingsSchema() {
    return [];
  }

  /**
   * Get current settings values for this skill.
   * Returns the merged result of defaults + stored customizations.
   *
   * @returns {Object} - Key-value pairs of current settings
   */
  getSettings() {
    const schema = this.getSettingsSchema();
    const defaults = {};
    for (const field of schema) {
      defaults[field.key] = field.default;
    }
    return { ...defaults, ...(this.customSettings || {}) };
  }

  /**
   * Called when settings are updated from the UI.
   * Override to react to setting changes (e.g. reconfigure internal state).
   *
   * @param {Object} settings - The full settings object after the update
   */
  applyCustomization(settings) {
    // Optional: override in subclass to react to settings changes
  }

  /**
   * Get help text for this skill
   *
   * @returns {Promise<string>} - Formatted help text
   */
  async getHelp() {
    return 'No help available for this skill.';
  }

  /**
   * Clean up resources when skill is unloaded
   *
   * @returns {Promise<void>}
   */
  async cleanup() {
    // Optional cleanup
  }
}

module.exports = { Skill };
