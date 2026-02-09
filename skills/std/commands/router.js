/**
 * Command router for STD skill
 * Routes subcommands to appropriate handlers
 */

const addCommand = require('./add');
const listCommand = require('./list');
const updateCommand = require('./update');
const completeCommand = require('./complete');
const deleteCommand = require('./delete');
const filterCommand = require('./filter');
const searchCommand = require('./search');
const archiveCommand = require('./archive');
const remindCommand = require('./remind');
const recurringCommand = require('./recurring');
const exportCommand = require('./export');
const statsCommand = require('./stats');

class CommandRouter {
  constructor(database, context) {
    this.database = database;
    this.context = context;

    // Command map
    this.commands = {
      add: addCommand,
      create: addCommand, // Alias
      list: listCommand,
      ls: listCommand, // Alias
      update: updateCommand,
      edit: updateCommand, // Alias
      complete: completeCommand,
      done: completeCommand, // Alias
      finish: completeCommand, // Alias
      delete: deleteCommand,
      remove: deleteCommand, // Alias
      rm: deleteCommand, // Alias
      filter: filterCommand,
      search: searchCommand,
      find: searchCommand, // Alias
      archive: archiveCommand,
      remind: remindCommand,
      reminder: remindCommand, // Alias
      recurring: recurringCommand,
      repeat: recurringCommand, // Alias
      export: exportCommand,
      stats: statsCommand,
      statistics: statsCommand // Alias
    };
  }

  /**
   * Route command to appropriate handler
   */
  async route(args, commandContext) {
    if (args.length === 0) {
      return {
        ok: false,
        error: 'Subcommand required. Try: /std help or /std list'
      };
    }

    const subcommand = args[0].toLowerCase();
    const subcommandArgs = args.slice(1);

    // Handle help
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      return this.getHelp();
    }

    // Find handler
    const handler = this.commands[subcommand];
    if (!handler) {
      return {
        ok: false,
        error: `Unknown subcommand: ${subcommand}. Try: /std help`
      };
    }

    // Execute command
    try {
      return await handler(subcommandArgs, this.database, this.context, commandContext);
    } catch (error) {
      console.error(`[std-router] Error executing ${subcommand}:`, error);
      return {
        ok: false,
        error: `Command failed: ${error.message}`
      };
    }
  }

  /**
   * Get help text
   */
  async getHelp() {
    return {
      ok: true,
      message: [
        '📋 STD Task Manager - Help',
        '',
        'Basic Commands:',
        '  /std add <title> [options] - Add a new task',
        '    Options: --details "..." --priority <low|medium|high|critical> --due <date> --tags <tag1,tag2>',
        '  /std list [options] - List tasks',
        '    Options: --status <status> --priority <priority> --limit <n> --detailed',
        '  /std update <id> [options] - Update a task',
        '    Options: --title "..." --details "..." --priority <...> --status <...> --due <date>',
        '  /std complete <id> - Mark task as complete',
        '  /std delete <id> - Delete a task',
        '',
        'Advanced Commands:',
        '  /std filter <criteria> - Filter tasks',
        '    Example: /std filter status:pending priority:high tag:work',
        '  /std search <query> - Search tasks by text',
        '  /std archive [id] - Archive task or list archived',
        '  /std remind <id> <datetime> - Set reminder',
        '  /std recurring <id> <pattern> - Set as recurring (daily, weekly, etc.)',
        '  /std export - Export all tasks to JSON',
        '  /std stats - Show task statistics',
        '',
        'Aliases:',
        '  add = create, list = ls, update = edit, complete = done = finish',
        '  delete = remove = rm, search = find, remind = reminder, recurring = repeat',
        '',
        'Examples:',
        '  /std add "Buy groceries" --priority high --due tomorrow --tags shopping',
        '  /std list --status pending --priority high',
        '  /std update 5 --status in-progress',
        '  /std complete 5',
        '  /std filter status:pending tag:work',
        '  /std search "meeting"'
      ].join('\n')
    };
  }
}

module.exports = CommandRouter;
