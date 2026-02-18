const { formatTaskList, formatSuccess } = require('../utils/formatter');

/**
 * Smart add - parse natural language and create tasks using NLP + RAG
 * Usage: /std smart add new login for scott's site and update chris
 */
async function smartCommand(args, database, context) {
  if (args.length === 0) {
    return {
      ok: false,
      error: 'Natural language input required. Usage: /std smart <natural language>'
    };
  }

  const nlpParser = context.nlpParser;
  if (!nlpParser) {
    return {
      ok: false,
      error: 'NLP parser not available. Make sure LLM provider is configured.'
    };
  }

  const naturalLanguage = args.join(' ');

  try {
    // Parse natural language into tasks
    const tasks = await nlpParser.parseToTasks(naturalLanguage);

    if (!tasks || tasks.length === 0) {
      return {
        ok: false,
        error: 'Could not extract any tasks from input'
      };
    }

    // Create tasks in database
    const createdTasks = [];
    for (const taskData of tasks) {
      const task = await database.create(taskData);
      createdTasks.push(task);
    }

    // Format response
    const message = [
      formatSuccess(`Created ${createdTasks.length} task(s) from natural language!`),
      '',
      'Input: "' + naturalLanguage + '"',
      '',
      formatTaskList(createdTasks, { detailed: true, showCount: false })
    ].join('\n');

    return {
      ok: true,
      message
    };
  } catch (error) {
    console.error('[smart-command] Error:', error);
    return {
      ok: false,
      error: `Failed to parse natural language: ${error.message}`
    };
  }
}

module.exports = smartCommand;
