const { parseArgs } = require('../utils/parser');
const { formatTaskList } = require('../utils/formatter');

/**
 * Search STD tasks
 * Usage: /std search <query>
 */
async function searchCommand(args, database) {
  const parsed = parseArgs(args);
  const query = parsed.positional.join(' ');

  if (!query) {
    return {
      ok: false,
      error: 'Search query required. Usage: /std search <query>'
    };
  }

  try {
    const tasks = await database.search(query);
    return {
      ok: true,
      message: formatTaskList(tasks, { detailed: false, showCount: true })
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to search tasks: ${error.message}`
    };
  }
}

module.exports = searchCommand;
