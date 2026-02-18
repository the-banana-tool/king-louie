const { parseArgs, parseDate, parsePriority, parseStatus, parseTags } = require('../utils/parser');
const { formatTask, formatSuccess } = require('../utils/formatter');

/**
 * Update an STD task
 * Usage: /std update <id> --title "New title" --priority high --status in-progress
 */
async function updateCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.positional.length === 0) {
    return {
      ok: false,
      error: 'Task ID is required. Usage: /std update <id> --title "..." --priority ... --status ...'
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

  const updates = {};

  if (parsed.flags.title) {
    updates.title = parsed.flags.title;
  }

  if (parsed.flags.details !== undefined) {
    updates.details = parsed.flags.details;
  }

  if (parsed.flags.priority) {
    const priority = parsePriority(parsed.flags.priority);
    if (priority) {
      updates.priority = priority;
    } else {
      return {
        ok: false,
        error: 'Invalid priority. Must be: low, medium, high, or critical.'
      };
    }
  }

  if (parsed.flags.status) {
    const status = parseStatus(parsed.flags.status);
    if (status) {
      updates.status = status;
    } else {
      return {
        ok: false,
        error: 'Invalid status. Must be: pending, in-progress, completed, or archived.'
      };
    }
  }

  if (parsed.flags.due) {
    const dueDate = parseDate(parsed.flags.due);
    if (dueDate) {
      updates.dueDate = dueDate;
    } else {
      return {
        ok: false,
        error: 'Invalid date format. Use: YYYY-MM-DD, today, tomorrow, or ISO format.'
      };
    }
  }

  if (parsed.flags.tags) {
    updates.tags = parseTags(parsed.flags.tags);
  }

  if (Object.keys(updates).length === 0) {
    return {
      ok: false,
      error: 'No fields to update. Use --title, --details, --priority, --status, --due, or --tags.'
    };
  }

  try {
    const updated = await database.update(id, updates);
    return {
      ok: true,
      message: formatSuccess(`Task updated!\n\n${formatTask(updated, true)}`)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to update task: ${error.message}`
    };
  }
}

module.exports = updateCommand;
