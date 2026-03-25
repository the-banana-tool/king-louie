# King Louie Skills

This directory is where installed skills are loaded from. Skills extend King Louie with custom commands, tools, and behaviors.

Skills are managed through **Settings > Skills** in the UI, or by placing them in this directory manually.

## Installing Skills

### From the UI

Open **Settings > Skills** and enter a source in the install field:

- **GitHub URL** — `https://github.com/user/king-louie-my-skill`
- **Local directory** — `E:\Programming\my-skill` or `/home/user/my-skill`

GitHub installs clone the repo into this directory. Local installs create a symlink, so the original directory stays in place and changes are reflected immediately.

If the skill has a `package.json` with dependencies, `npm install --production` runs automatically.

### Manual install

Clone or symlink a skill into this directory:

```bash
# Clone from GitHub
git clone https://github.com/user/king-louie-my-skill skills/my-skill

# Or symlink a local directory
ln -s /path/to/my-skill skills/my-skill       # Linux/macOS
mklink /J skills\my-skill E:\path\to\my-skill  # Windows
```

Restart King Louie (or reload skills) to pick it up.

## Removing Skills

Click **Remove** on any skill card in **Settings > Skills**. This deletes the directory (or removes the symlink for linked skills). The original directory is not touched for symlinked skills.

## Enabling / Disabling Skills

Each skill has an **Enable/Disable** toggle in **Settings > Skills**. Disabled skills stay installed but their commands return an error. The state persists across restarts.

## Creating a Skill

### Project structure

```
my-skill/
├── package.json
├── index.js
└── ... (other files)
```

### package.json

```json
{
  "name": "king-louie-my-skill",
  "version": "YY.M.D",
  "main": "index.js",
  "description": "My custom King Louie skill"
}
```

### Skill implementation

Export a class extending the `Skill` base class. Use `king-louie/skill-interface` to import it — this works regardless of where the skill lives on disk:

```javascript
const { Skill } = require('king-louie/skill-interface');

class MySkill extends Skill {
  getMetadata() {
    return {
      id: 'my-skill',
      name: 'My Skill',
      version: '25.3.4',
      description: 'Does something awesome',
      author: 'Your Name',
      commands: ['mycommand'],       // Commands this skill handles (without /)
      resolvers: ['code', 'skill'],  // Resolution chain (optional, default: ['skill'])
      pinnable: false                // Whether this skill can be pinned to a chat
    };
  }

  async initialize(context) {
    // context: { workingDirectory, userDataPath, toolRegistry, sessionManager, sendMessage, llmProvider }
    this.context = context;
  }

  async handleCommand(command, args, context) {
    // context: { chatId, channel, userId, session }
    return { ok: true, message: `You said: ${args.join(' ')}` };
  }

  async getHelp() {
    return '/mycommand <args> — does something awesome';
  }

  async cleanup() {
    // Called when the skill is unloaded
  }
}

module.exports = MySkill;
```

### Skill settings

Skills can expose configurable settings that appear as a dedicated tab in the settings overlay. Override `getSettingsSchema()` to declare fields:

```javascript
getSettingsSchema() {
  return [
    { key: 'apiUrl', label: 'API URL', type: 'text', default: 'https://example.com', description: 'Backend endpoint' },
    { key: 'timeout', label: 'Timeout (ms)', type: 'number', default: 30000 },
    { key: 'verbose', label: 'Verbose logging', type: 'toggle', default: false },
    { key: 'mode', label: 'Mode', type: 'select', default: 'fast', options: [
      { label: 'Fast', value: 'fast' },
      { label: 'Accurate', value: 'accurate' }
    ]}
  ];
}
```

Supported field types: `text`, `number`, `toggle`, `select`, `password`.

Read current values with `this.getSettings()`. React to changes by overriding `applyCustomization(settings)`.

Settings are persisted in `skill-customizations/<skill-id>/customization.json` under the user data directory, so they survive skill updates.

### Resolver chain

Skills can use multiple resolution strategies, tried in order:

| Resolver | Method | Use case |
|----------|--------|----------|
| `code` | `resolveCode()` | Deterministic logic, no AI needed |
| `cli` | `resolveCli()` | Shell command execution |
| `prompt` | `resolvePrompt()` | LLM-powered responses |
| `skill` | `handleCommand()` | Default fallback handler |

Set `resolvers` in metadata to control the chain, e.g. `['code', 'prompt', 'skill']`.

### Pinned mode

Skills with `pinnable: true` can be pinned to a chat with `/pin <skill-id>`. When pinned, all non-command messages go to the skill's `handleMessage(text, context)` method instead of the AI agent.

## Command context

```javascript
{
  chatId: string,      // Chat/session identifier
  channel: string,     // 'telegram', 'ui', or 'api'
  userId: string,      // User identifier
  session: object      // Session object for this chat
}
```

## Return value

```javascript
{
  ok: boolean,                    // Success status
  message?: string,               // Message to display
  error?: string,                 // Error message (if ok=false)
  format?: 'markdown'|'text',     // Content format (default: text)
  data?: any,                     // Optional data payload
  continueWithAgent?: boolean     // Also run AI agent after this response (pinned mode)
}
```

## Skill customizations

User-level overrides are stored in `skill-customizations/<skill-id>/customization.json` under the user data directory. This file can override metadata and settings without modifying skill source files:

```json
{
  "metadata": {
    "description": "My custom description",
    "resolvers": ["code", "prompt", "skill"]
  },
  "settings": {
    "apiUrl": "https://my-instance.com"
  },
  "enabled": true
}
```

Objects are deep-merged. Arrays are replaced (not concatenated). Create/open a customization file from chat with `/skill customize <skill-id>`.
