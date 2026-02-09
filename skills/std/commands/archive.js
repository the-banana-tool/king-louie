const { parseArgs } = require('../utils/parser');
const { formatTaskList, formatSuccess } = require('../utils/formatter');

/**
 * Archive task(s) or list archived tasks
 * Usage: /std archive [<id>] [--list]
 */
async function archiveCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.flags.list || parsed.positional.length === 0) {
    // List archived tasks
    try {
      const tasks = database.findAll({ status: 'archived' });
      return {
        ok: true,
        message: formatTaskList(tasks, { detailed: false, showCount: true })
      };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to list archived tasks: ${error.message}`
      };
    }
  }

  // Archive a specific task
  const id = parseInt(parsed.positional[0], 10);
  if (isNaN(id)) {
    return {
      ok: false,
      error: 'Invalid task ID. Must be a number.'
    };
  }

  try {
    const task = database.archive(id);
    if (task) {
      return {
        ok: true,
        message: formatSuccess(`Task #${id} archived.`)
      };
    } else {
      return {
        ok: false,
        error: `Task #${id} not found.`
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Failed to archive task: ${error.message}`
    };
  }
}

module.exports = archiveCommand;
