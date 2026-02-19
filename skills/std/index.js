/**
 * STD (Task Management) Skill for King Louie
 *
 * Manages STDs (tasks) with full CRUD operations, filtering, reminders, and more.
 */

const path = require('path');
const StdDatabase = require('./database/std-db');
const ContextDatabase = require('./database/context-db');
const NLPParser = require('./nlp/parser');
const CommandRouter = require('./commands/router');

class StdSkill {
  constructor() {
    this.context = null;
    this.database = null;
    this.contextDb = null;
    this.nlpParser = null;
    this.commandRouter = null;
  }

  getMetadata() {
    return {
      id: 'std',
      name: 'STD Task Manager',
      version: '1.0.0',
      description: 'Manage your tasks (STDs) with full CRUD, reminders, and sync',
      author: 'Seth Blackman',
      commands: ['std'],
      pinnable: true
    };
  }

  async initialize(context) {
    this.context = context;
    console.log('[std-skill] Initializing...');

    // Initialize task database
    const dbPath = path.join(context.userDataPath, 'std-tasks.db');
    this.database = new StdDatabase(dbPath);
    await this.database.initialize();

    // Initialize context database for RAG
    const contextDbPath = path.join(context.userDataPath, 'std-context.db');
    this.contextDb = new ContextDatabase(contextDbPath);
    await this.contextDb.initialize();

    // Initialize NLP parser (requires LLM provider from context)
    if (context.llmProvider) {
      this.nlpParser = new NLPParser(context.llmProvider, this.contextDb);
      console.log('[std-skill] NLP parser initialized');
    } else {
      console.warn('[std-skill] LLM provider not available - NLP features disabled');
    }

    // Initialize command router with extended context
    const extendedContext = {
      ...context,
      contextDb: this.contextDb,
      nlpParser: this.nlpParser
    };
    this.commandRouter = new CommandRouter(this.database, extendedContext);

    console.log('[std-skill] Initialized successfully!');
    console.log('[std-skill] Task database:', dbPath);
    console.log('[std-skill] Context database:', contextDbPath);
  }

  async handleCommand(command, args, context) {
    if (!this.commandRouter) {
      return {
        ok: false,
        error: 'STD skill not initialized'
      };
    }

    return this.commandRouter.route(args, context);
  }

  async handleMessage(text, context) {
    if (!this.commandRouter) {
      return {
        ok: false,
        error: 'STD skill not initialized',
        continueWithAgent: false
      };
    }

    const args = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (args[0] && args[0].toLowerCase() === '/std') {
      args.shift();
    }

    if (args.length === 0) {
      return {
        ok: true,
        message: 'STD command not provided. Try: /std help',
        continueWithAgent: false
      };
    }

    const result = await this.commandRouter.route(args, context);
    return {
      ...result,
      continueWithAgent: false
    };
  }

  async getHelp() {
    return [
      '📋 STD Task Manager',
      '',
      'Basic Commands:',
      '  /std add <title> [details] - Add a new task',
      '  /std list [filter] - List tasks',
      '  /std update <id> <field> <value> - Update a task',
      '  /std complete <id> - Mark task as complete',
      '  /std delete <id> - Delete a task',
      '',
      'Advanced Commands:',
      '  /std filter <criteria> - Filter tasks by status/priority/tag',
      '  /std search <query> - Search tasks',
      '  /std sort <field> - Sort tasks',
      '  /std archive - List archived tasks',
      '  /std remind <id> <datetime> - Set reminder',
      '  /std recurring <id> <pattern> - Set as recurring',
      '  /std export - Export tasks to JSON',
      '  /std login - Interactive API login (username then password)',
      '  /std api <status|set|test|clear> - Configure and test remote API mode',
      '',
      'Examples:',
      '  /std add "Buy groceries" --priority high --due tomorrow',
      '  /std list --status pending',
      '  /std complete 5',
      '  /std filter priority:high status:pending',
      '  /std login',
      '  /std login <username>',
      '  /std login <password>',
      '  /std api set --username <user> --password <pass> --url https://www.sethserver.com/api/v1',
    ].join('\n');
  }

  async cleanup() {
    console.log('[std-skill] Cleaning up...');
    if (this.database) {
      await this.database.close();
    }
    if (this.contextDb) {
      await this.contextDb.close();
    }
  }
}

module.exports = StdSkill;
