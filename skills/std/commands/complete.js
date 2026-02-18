const { parseArgs } = require('../utils/parser');
const { formatTask, formatSuccess } = require('../utils/formatter');

/**
 * Mark an STD task as complete
 * Usage: /std complete <id>
 */
async function completeCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.positional.length === 0) {
    return {
      ok: false,
      error: 'Task ID is required. Usage: /std complete <id>'
    };
  }

  const id = parseInt(parsed.positional[0], 10);
  if (isNaN(id)) {
    return {
      ok: false,
      error: 'Invalid task ID. Must be a number.'
    };
  }

  // Check if task exists
  const existing = await database.findById(id);
  if (!existing) {
    return {
      ok: false,
      error: `Task #${id} not found.`
    };
  }

  try {
    const completed = await database.complete(id);
    return {
      ok: true,
      message: formatSuccess(`Task completed! 🎉\n\n${formatTask(completed)}`)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to complete task: ${error.message}`
    };
  }
}

module.exports = completeCommand;
