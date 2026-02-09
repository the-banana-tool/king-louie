const { parseArgs, parseDate, parsePriority, parseTags } = require('../utils/parser');
const { formatTask, formatSuccess } = require('../utils/formatter');

/**
 * Add a new STD task
 * Usage: /std add "Task title" --details "Details" --priority high --due tomorrow --tags work,urgent
 */
async function addCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.positional.length === 0) {
    return {
      ok: false,
      error: 'Task title is required. Usage: /std add "Task title" [--details ...] [--priority ...] [--due ...]'
    };
  }

  const title = parsed.positional.join(' ');

  const taskData = {
    title,
    details: parsed.flags.details || null,
    priority: parsePriority(parsed.flags.priority) || 'medium',
    dueDate: parseDate(parsed.flags.due) || null,
    tags: parseTags(parsed.flags.tags) || [],
    status: parsed.flags.status || 'pending'
  };

  try {
    const task = database.create(taskData);
    return {
      ok: true,
      message: formatSuccess(`Task created!\n\n${formatTask(task, true)}`)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to create task: ${error.message}`
    };
  }
}

module.exports = addCommand;
