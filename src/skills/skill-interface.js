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
 * @typedef {Object} SkillMetadata
 * @property {string} id - Unique skill identifier (e.g., 'std', 'calendar')
 * @property {string} name - Human-readable skill name
 * @property {string} version - Skill version (semver)
 * @property {string} description - Brief description of what the skill does
 * @property {string} author - Skill author
 * @property {string[]} commands - List of commands this skill handles (e.g., ['std'])
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
 * @property {any} [data] - Optional data payload
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
