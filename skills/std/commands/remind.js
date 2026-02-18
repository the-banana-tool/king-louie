const { parseArgs, parseDate } = require('../utils/parser');
const { formatTask, formatSuccess } = require('../utils/formatter');

/**
 * Set reminder for an STD task
 * Usage: /std remind <id> <datetime>
 */
async function remindCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 2) {
    return {
      ok: false,
      error: 'Task ID and reminder time required. Usage: /std remind <id> <datetime>'
    };
  }

  const id = parseInt(parsed.positional[0], 10);
  if (isNaN(id)) {
    return {
      ok: false,
      error: 'Invalid task ID. Must be a number.'
    };
  }

  const reminderTimeStr = parsed.positional.slice(1).join(' ');
  const reminderTime = parseDate(reminderTimeStr);

  if (!reminderTime) {
    return {
      ok: false,
      error: 'Invalid date/time format. Use: YYYY-MM-DDTHH:MM:SS or tomorrow'
    };
  }

  try {
    const updated = await database.update(id, { reminderTime });
    if (updated) {
      return {
        ok: true,
        message: formatSuccess(`Reminder set!\n\n${formatTask(updated, true)}`)
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
      error: `Failed to set reminder: ${error.message}`
    };
  }
}

module.exports = remindCommand;
