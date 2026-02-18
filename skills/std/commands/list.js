const { parseArgs, parseStatus, parsePriority } = require('../utils/parser');
const { formatTaskList } = require('../utils/formatter');

/**
 * List STD tasks with optional filters
 * Usage: /std list [--status pending] [--priority high] [--limit 10] [--detailed]
 */
async function listCommand(args, database) {
  const parsed = parseArgs(args);

  const filters = {};

  if (parsed.flags.status) {
    const status = parseStatus(parsed.flags.status);
    if (status) {
      filters.status = status;
    }
  }

  if (parsed.flags.priority) {
    const priority = parsePriority(parsed.flags.priority);
    if (priority) {
      filters.priority = priority;
    }
  }

  if (parsed.flags.limit) {
    filters.limit = parseInt(parsed.flags.limit, 10);
  }

  if (parsed.flags.sortBy) {
    filters.sortBy = parsed.flags.sortBy;
  }

  if (parsed.flags.sortOrder) {
    filters.sortOrder = parsed.flags.sortOrder.toUpperCase();
  }

  try {
    const tasks = await database.findAll(filters);
    const detailed = parsed.flags.detailed === true || parsed.flags.detailed === 'true';

    return {
      ok: true,
      message: formatTaskList(tasks, { detailed, showCount: true })
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to list tasks: ${error.message}`
    };
  }
}

module.exports = listCommand;
