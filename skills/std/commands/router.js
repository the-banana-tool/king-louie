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
const contextCommand = require('./context');
const smartCommand = require('./smart');

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
      statistics: statsCommand, // Alias
      context: contextCommand, // NEW: Manage RAG context
      smart: smartCommand // NEW: NLP task parsing
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

    // If no handler found, check if NLP is available and use smart command
    if (!handler) {
      if (this.context.nlpParser) {
        console.log('[std-router] Unknown subcommand, trying NLP parser...');
        // Treat entire input as natural language
        return await smartCommand(args, this.database, this.context, commandContext);
      } else {
        return {
          ok: false,
          error: `Unknown subcommand: ${subcommand}. Try: /std help\n\nNote: NLP parsing not available (LLM provider required)`
        };
      }
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
    const hasNLP = Boolean(this.context.nlpParser);

    const helpLines = [
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
      ''
    ];

    if (hasNLP) {
      helpLines.push(
        '🧠 AI-Powered Commands:',
        '  /std smart <natural language> - Parse natural language and create tasks',
        '    Example: /std smart add new login for scott\'s site and update chris',
        '  /std <natural language> - Auto-detect and parse (no "smart" needed)',
        '',
        '📚 Context Management (for RAG):',
        '  /std context add person "Name" --role "..." --notes "..."',
        '  /std context add project "Name" --description "..."',
        '  /std context list people - Show all people',
        '  /std context list projects - Show all projects',
        ''
      );
    }

    helpLines.push(
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
    );

    if (hasNLP) {
      helpLines.push(
        '',
        'AI Examples:',
        '  /std add new login for scott\'s site and update chris',
        '  /std smart email bob about the project and call sarah',
        '  /std context add person "Scott" --role "Client" --notes "Website owner"'
      );
    }

    return {
      ok: true,
      message: helpLines.join('\n')
    };
  }
}

module.exports = CommandRouter;
