# King Louie Skills

This directory contains custom skills/plugins for King Louie.

## What is a Skill?

A skill is a self-contained module that extends King Louie's functionality with custom commands, tools, and behaviors. Skills can:

- Handle custom commands (e.g., `/std add "Task name"`)
- Register custom tools that the agent can use
- Maintain their own state/database
- Work seamlessly with both Telegram and UI interfaces

## Creating a Skill

### 1. Project Structure

Create a new directory in `skills/` with the following structure:

```
skills/
└── my-skill/
    ├── package.json
    ├── index.js
    ├── README.md
    └── ... (other files)
```

### 2. Package.json

```json
{
  "name": "king-louie-my-skill",
  "version": "1.0.0",
  "main": "index.js",
  "description": "My custom King Louie skill",
  "dependencies": {}
}
```

### 3. Skill Implementation

Your `index.js` should export a class or object implementing the skill interface:

```javascript
const { Skill } = require('../../src/skills/skill-interface');

class MySkill extends Skill {
  constructor() {
    super();
    this.context = null;
  }

  getMetadata() {
    return {
      id: 'my-skill',
      name: 'My Skill',
      version: '1.0.0',
      description: 'Does something awesome',
      author: 'Your Name',
      commands: ['mycommand'] // Commands this skill handles (without /)
    };
  }

  async initialize(context) {
    this.context = context;
    console.log('[my-skill] Initialized with context:', context);

    // context contains:
    // - workingDirectory: King Louie working directory
    // - userDataPath: Path for storing skill data
    // - toolRegistry: For registering custom tools
    // - sessionManager: For managing sessions
    // - sendMessage: Function to send messages
  }

  async handleCommand(command, args, context) {
    // command: 'mycommand' (without /)
    // args: Array of command arguments
    // context: {chatId, channel, userId, session}

    if (args.length === 0) {
      return {
        ok: false,
        error: 'Please provide an argument'
      };
    }

    // Do something...
    const result = `You said: ${args.join(' ')}`;

    return {
      ok: true,
      message: result
    };
  }

  async getHelp() {
    return [
      'My Skill Help',
      '',
      'Usage:',
      '  /mycommand <arg1> <arg2> ... - Does something awesome'
    ].join('\n');
  }

  async cleanup() {
    // Clean up resources when skill is unloaded
    console.log('[my-skill] Cleaning up...');
  }
}

module.exports = MySkill;
```

## Command Context

When your skill's `handleCommand` is called, it receives a context object:

```javascript
{
  chatId: string,      // Chat/session identifier
  channel: string,     // 'telegram', 'ui', or 'api'
  userId: string,      // User identifier
  session: object      // Session object for this chat
}
```

## Return Value

Your `handleCommand` should return a Promise resolving to:

```javascript
{
  ok: boolean,         // Success status
  message?: string,    // Message to display (if ok=true)
  error?: string,      // Error message (if ok=false)
  data?: any          // Optional data payload
}
```

## Skill Context

During initialization, your skill receives a context object:

```javascript
{
  workingDirectory: string,    // King Louie working directory
  userDataPath: string,        // User data directory for storage
  toolRegistry: object,        // King Louie's tool registry
  sessionManager: object,      // Session manager
  sendMessage: function        // (chatId, message) => Promise
}
```

## Loading Skills

Skills are automatically loaded from the `skills/` directory when King Louie starts. Each subdirectory is scanned for a `package.json` with a `main` entry point.

## Testing Your Skill

1. Create your skill directory in `skills/`
2. Implement the skill interface
3. Restart King Louie
4. Use `/help` in Telegram or UI to see your skill listed
5. Test your commands!

## Example: Hello World Skill

See `skills/hello-world/` for a complete working example.

## Tips

- Use `userDataPath` to store skill-specific data
- Skills can use SQLite, JSON files, or any Node.js module
- Handle errors gracefully and return meaningful error messages
- Log important events with `console.log('[my-skill] ...')`
- Test commands in both Telegram and UI interfaces
