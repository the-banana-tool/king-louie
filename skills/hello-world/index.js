const { Skill } = require('king-louie/skill-interface');

/**
 * Example Hello World Skill
 *
 * Demonstrates the basic skill interface including:
 * - Command handling via the resolver chain
 * - Configurable settings exposed in the settings overlay
 * - Reading settings at runtime
 */
class HelloWorldSkill extends Skill {
  constructor() {
    super();
    this.context = null;
    this.greetCount = 0;
  }

  getMetadata() {
    return {
      id: 'hello-world',
      name: 'Hello World',
      version: '26.3.24',
      description: 'Example skill that greets users',
      author: 'King Louie Team',
      commands: ['hello', 'greet'],
      resolvers: ['code', 'skill']
    };
  }

  getSettingsSchema() {
    return [
      {
        key: 'name',
        label: 'Your Name',
        type: 'text',
        default: '',
        description: 'If set, greetings will address you by name.',
        placeholder: 'e.g. Alice'
      }
    ];
  }

  async initialize(context) {
    this.context = context;
    const settings = this.getSettings();
    const who = settings.name || 'the world';
    console.log(`[hello-world] Skill initialized! Ready to greet ${who}.`);
  }

  async resolveCode({ command, args = [], context }) {
    if (!['hello', 'greet'].includes(command)) {
      return null;
    }

    this.greetCount++;
    const settings = this.getSettings();

    if (command === 'hello') {
      // Use the arg if provided, fall back to the configured name, then "friend"
      const name = args.length > 0
        ? args.join(' ')
        : (settings.name || 'friend');
      return {
        ok: true,
        message: `Hello, ${name}! (Greeting #${this.greetCount})`
      };
    }

    const greetings = [
      'Howdy',
      'Hi there',
      'Greetings',
      'Salutations',
      'Hey',
      'What\'s up'
    ];
    const random = greetings[Math.floor(Math.random() * greetings.length)];
    const suffix = settings.name ? `, ${settings.name}!` : '!';
    return {
      ok: true,
      message: `${random}${suffix}`
    };
  }

  async handleCommand(command, args, context) {
    return this.resolveCode({ command, args, context });
  }

  async getHelp() {
    return [
      'Hello World Skill',
      '',
      'Commands:',
      '  /hello [name] - Say hello (uses your configured name if no arg given)',
      '  /greet        - Get a random greeting',
      '',
      'Set your name in Settings > Hello World so greetings are personalized.'
    ].join('\n');
  }

  async cleanup() {
    console.log(`[hello-world] Shutting down. Said hello ${this.greetCount} times.`);
  }
}

module.exports = HelloWorldSkill;
