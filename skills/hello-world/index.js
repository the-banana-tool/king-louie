const { Skill } = require('../../src/skills/skill-interface');

/**
 * Example Hello World Skill
 * Demonstrates the basic skill interface
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
      version: '1.0.0',
      description: 'Example skill that greets users',
      author: 'King Louie Team',
      commands: ['hello', 'greet'],
      resolvers: ['code', 'skill']
    };
  }

  async initialize(context) {
    this.context = context;
    console.log('[hello-world] Skill initialized!');
    console.log('[hello-world] User data path:', context.userDataPath);
  }

  async resolveCode({ command, args = [], context }) {
    if (!['hello', 'greet'].includes(command)) {
      return null;
    }

    this.greetCount++;

    if (command === 'hello') {
      const name = args.length > 0 ? args.join(' ') : 'friend';
      return {
        ok: true,
        message: `👋 Hello, ${name}! (Greeting #${this.greetCount})\n\nChannel: ${context.channel}\nChat ID: ${context.chatId}`
      };
    }

    const greetings = [
      'Howdy!',
      'Hi there!',
      'Greetings!',
      'Salutations!',
      'Hey!',
      'What\'s up?'
    ];
    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
    return {
      ok: true,
      message: `${randomGreeting} 🎉`
    };
  }

  async handleCommand(command, args, context) {
    return {
      ok: false,
      error: `No fallback handler for command: ${command}`
    };
  }

  async getHelp() {
    return [
      '👋 Hello World Skill',
      '',
      'Commands:',
      '  /hello [name] - Say hello to someone (default: "friend")',
      '  /greet - Get a random greeting',
      '',
      'Examples:',
      '  /hello',
      '  /hello Alice',
      '  /greet'
    ].join('\n');
  }

  async cleanup() {
    console.log(`[hello-world] Shutting down... Said hello ${this.greetCount} times!`);
  }
}

module.exports = HelloWorldSkill;
