/**
 * STD (Task Management) Skill for King Louie
 *
 * Manages STDs (tasks) with full CRUD operations, filtering, reminders, and more.
 */

const path = require('path');
const StdDatabase = require('./database/std-db');
const CommandRouter = require('./commands/router');

class StdSkill {
  constructor() {
    this.context = null;
    this.database = null;
    this.commandRouter = null;
  }

  getMetadata() {
    return {
      id: 'std',
      name: 'STD Task Manager',
      version: '1.0.0',
      description: 'Manage your tasks (STDs) with full CRUD, reminders, and sync',
      author: 'Seth Blackman',
      commands: ['std']
    };
  }

  async initialize(context) {
    this.context = context;
    console.log('[std-skill] Initializing...');

    // Initialize database
    const dbPath = path.join(context.userDataPath, 'std-tasks.db');
    this.database = new StdDatabase(dbPath);
    await this.database.initialize();

    // Initialize command router
    this.commandRouter = new CommandRouter(this.database, context);

    console.log('[std-skill] Initialized successfully!');
    console.log('[std-skill] Database:', dbPath);
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
      '',
      'Examples:',
      '  /std add "Buy groceries" --priority high --due tomorrow',
      '  /std list --status pending',
      '  /std complete 5',
      '  /std filter priority:high status:pending'
    ].join('\n');
  }

  async cleanup() {
    console.log('[std-skill] Cleaning up...');
    if (this.database) {
      await this.database.close();
    }
  }
}

module.exports = StdSkill;
