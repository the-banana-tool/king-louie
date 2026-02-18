const { parseArgs, parseFilters, parseStatus, parsePriority } = require('../utils/parser');
const { formatTaskList } = require('../utils/formatter');

/**
 * Filter STD tasks by criteria
 * Usage: /std filter status:pending priority:high tag:work
 */
async function filterCommand(args, database) {
  const parsed = parseArgs(args);
  const filterStr = parsed.positional.join(' ');

  if (!filterStr) {
    return {
      ok: false,
      error: 'Filter criteria required. Usage: /std filter status:pending priority:high tag:work'
    };
  }

  const filters = parseFilters(filterStr);
  const dbFilters = {};

  if (filters.status) {
    const status = parseStatus(filters.status);
    if (status) {
      dbFilters.status = status;
    }
  }

  if (filters.priority) {
    const priority = parsePriority(filters.priority);
    if (priority) {
      dbFilters.priority = priority;
    }
  }

  try {
    let tasks;

    if (filters.tag) {
      tasks = await database.filterByTag(filters.tag);
      // Apply additional filters
      if (dbFilters.status) {
        tasks = tasks.filter((t) => t.status === dbFilters.status);
      }
      if (dbFilters.priority) {
        tasks = tasks.filter((t) => t.priority === dbFilters.priority);
      }
    } else {
      tasks = await database.findAll(dbFilters);
    }

    return {
      ok: true,
      message: formatTaskList(tasks, { detailed: false, showCount: true })
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to filter tasks: ${error.message}`
    };
  }
}

module.exports = filterCommand;
