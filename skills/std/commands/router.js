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
const apiCommand = require('./api');
const loginCommand = require('./login');

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
      smart: smartCommand, // NEW: NLP task parsing
      api: apiCommand,
      login: loginCommand
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

    // If user is mid /std login flow, treat any follow-up text as login input
    // unless they explicitly invoke another /std login command.
    if (subcommand !== 'login' && loginCommand.hasPendingLogin(commandContext)) {
      return await loginCommand(args, this.database, this.context, commandContext);
    }

    // Handle help
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      return this.getHelp();
    }

    // Find handler
    const handler = this.commands[subcommand];

    // If no handler found, check if NLP is available and use smart command
    if (!handler) {
      const naturalInput = args.join(' ');
      const intent = this.detectNaturalLanguageIntent(naturalInput);

      if (intent === 'complete') {
        console.log('[std-router] Unknown subcommand, detected completion intent');
        return await this.handleNaturalLanguageComplete(naturalInput, commandContext);
      }

      // Handle query-style natural language without creating tasks
      if (intent === 'list') {
        console.log('[std-router] Unknown subcommand, detected list/query intent');
        const filterArgs = this.extractQueryFilters(naturalInput);
        if (filterArgs.length > 0) {
          return await filterCommand(filterArgs, this.database, this.context, commandContext);
        }
        return await listCommand([], this.database, this.context, commandContext);
      }

      if (intent === 'stats') {
        console.log('[std-router] Unknown subcommand, detected stats intent');
        return await statsCommand([], this.database, this.context, commandContext);
      }

      if (intent === 'search') {
        console.log('[std-router] Unknown subcommand, detected search intent');
        const query = this.extractSearchQuery(naturalInput);
        return await searchCommand(query ? [query] : [], this.database, this.context, commandContext);
      }

      if (this.context.nlpParser) {
        console.log('[std-router] Unknown subcommand, trying NLP parser...');
        // Treat entire input as natural language task-creation input
        return await smartCommand(args, this.database, this.context, commandContext);
      }

      return {
        ok: false,
        error: `Unknown subcommand: ${subcommand}. Try: /std help\n\nNote: NLP parsing not available (LLM provider required)`
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
      '  /std login - Interactive API login (username/password prompts)',
      '  /std stats - Show task statistics',
      '  /std api <status|set|test|clear> - Configure/test remote API mode',
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
      '  /std login',
      '  /std login <username>',
      '  /std login <password>',
      '  /std search "meeting"',
      '  /std api status',
      '  /std api set --username <user> --password <pass> --url https://www.sethserver.com/api/v1',
      '  /std api test'
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

  detectNaturalLanguageIntent(input) {
    const text = String(input || '').trim().toLowerCase();
    if (!text) return null;

    if (this.extractCompletionTarget(text)) {
      return 'complete';
    }

    // Query/list intent (e.g., "what are my current tasks?", "do I have any high priority tasks?")
    if (
      (/(^|\b)(what|which|show|list|display)\b/.test(text) && /\b(task|tasks|todo|todos)\b/.test(text)) ||
      /\b(current tasks?)\b/.test(text) ||
      /\b(my tasks?)\b/.test(text) ||
      (/\b(do\s+i\s+have|are\s+there|have\s+i\s+got|any)\b/.test(text) && /\b(task|tasks|todo|todos)\b/.test(text)) ||
      (/\?$/.test(text.trim()) && /\b(task|tasks|todo|todos)\b/.test(text))
    ) {
      return 'list';
    }

    // Stats/count intent
    if (
      /\b(how many|count|statistics|stats|summary)\b/.test(text) &&
      /\b(task|tasks|todo|todos)\b/.test(text)
    ) {
      return 'stats';
    }

    // Search/find intent
    if (/\b(search|find|look for)\b/.test(text) && /\b(task|tasks|todo|todos)\b/.test(text)) {
      return 'search';
    }

    return null;
  }

  extractQueryFilters(input) {
    const text = String(input || '').toLowerCase();
    const args = [];

    if (/\bcritical\b/.test(text)) args.push('priority:critical');
    else if (/\bhigh[\s-]priority\b|\bpriority[\s:]high\b|\bhigh\s+priority\b/.test(text)) args.push('priority:high');
    else if (/\blow[\s-]priority\b|\bpriority[\s:]low\b/.test(text)) args.push('priority:low');
    else if (/\bmedium[\s-]priority\b|\bpriority[\s:]medium\b/.test(text)) args.push('priority:medium');

    if (/\boverdue\b/.test(text) || /\bpast\s+due\b/.test(text)) args.push('status:pending');
    else if (/\bin[\s-]progress\b/.test(text)) args.push('status:in-progress');
    else if (/\bpending\b/.test(text)) args.push('status:pending');

    return args;
  }

  extractSearchQuery(input) {
    const text = String(input || '').trim();
    if (!text) return '';

    return text
      .replace(/\b(search|find|look for)\b/gi, '')
      .replace(/\b(task|tasks|todo|todos)\b/gi, '')
      .replace(/[?.!]+$/g, '')
      .trim();
  }

  extractCompletionTarget(input) {
    const text = String(input || '').trim();
    if (!text) return null;

    const lower = text.toLowerCase();
    const completionVerb = /(\bdone\b|\bfinished\b|\bcomplete(?:d)?\b|\bwrapped up\b|\bclosed\b)/;

    if (!completionVerb.test(lower)) {
      return null;
    }

    // Prefer explicit task ID references first (e.g., "I've finished #64")
    const idMatch = text.match(/#(\d+)\b/) || text.match(/\btask\s*#?\s*(\d+)\b/i);
    if (idMatch) {
      return { id: parseInt(idMatch[1], 10) };
    }

    // Quoted task title (e.g., "\"onboard jerica\" is done")
    const quotedMatch = text.match(/"([^"]+)"/) || text.match(/'([^']+)'/);
    if (quotedMatch) {
      const title = quotedMatch[1].trim();
      if (title) {
        return { title };
      }
    }

    // Patterns like: "I've finished onboard jerica"
    const finishedPattern = text.match(
      /(?:^|\b)(?:i\s*(?:have|'ve)\s+)?(?:just\s+)?(?:finished|completed|done\s+with|wrapped\s+up|closed)\s+(.+)$/i
    );
    if (finishedPattern && finishedPattern[1]) {
      const title = this._cleanupCompletionTitle(finishedPattern[1]);
      if (title) {
        return { title };
      }
    }

    // Patterns like: "onboard jerica is done"
    const isDonePattern = text.match(/^(.+?)\s+(?:is|was|has been)\s+(?:done|finished|completed)\b/i);
    if (isDonePattern && isDonePattern[1]) {
      const title = this._cleanupCompletionTitle(isDonePattern[1]);
      if (title) {
        return { title };
      }
    }

    return null;
  }

  _cleanupCompletionTitle(rawTitle) {
    return String(rawTitle || '')
      .replace(/^[\s"']+|[\s"'.,!?]+$/g, '')
      .replace(/^(task\s*#?\s*\d+\s*)/i, '')
      .trim();
  }

  async handleNaturalLanguageComplete(naturalInput, commandContext) {
    const target = this.extractCompletionTarget(naturalInput);
    if (!target) {
      return {
        ok: false,
        error: 'I could not determine which task to complete. Try: /std complete <id>'
      };
    }

    if (target.id) {
      return await completeCommand([String(target.id)], this.database, this.context, commandContext);
    }

    if (target.title) {
      const allTasks = await this.database.findAll({});
      const normalizedTarget = target.title.toLowerCase().trim();

      const activeTasks = allTasks.filter((task) => task.status !== 'completed' && task.status !== 'archived');

      // Exact title match first
      let matches = activeTasks.filter((task) => task.title.toLowerCase().trim() === normalizedTarget);

      // Fallback to partial contains match
      if (matches.length === 0) {
        matches = activeTasks.filter((task) => task.title.toLowerCase().includes(normalizedTarget));
      }

      if (matches.length === 0) {
        return {
          ok: false,
          error: `Couldn't find an active task matching "${target.title}". Try using the task ID, e.g. /std complete <id>.`
        };
      }

      if (matches.length > 1) {
        const suggestions = matches.slice(0, 5).map((task) => `  #${task.id} ${task.title}`).join('\n');
        return {
          ok: false,
          error: `Found multiple matching tasks for "${target.title}". Please complete by ID:\n${suggestions}`
        };
      }

      return await completeCommand([String(matches[0].id)], this.database, this.context, commandContext);
    }

    return {
      ok: false,
      error: 'I could not determine which task to complete. Try: /std complete <id>'
    };
  }
}

module.exports = CommandRouter;
