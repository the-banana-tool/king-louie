const { parseArgs } = require('../utils/parser');
const { formatTask, formatSuccess } = require('../utils/formatter');

/**
 * Set task as recurring
 * Usage: /std recurring <id> <pattern>
 */
async function recurringCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.positional.length < 2) {
    return {
      ok: false,
      error: 'Task ID and pattern required. Usage: /std recurring <id> <pattern> (e.g., daily, weekly)'
    };
  }

  const id = parseInt(parsed.positional[0], 10);
  if (isNaN(id)) {
    return {
      ok: false,
      error: 'Invalid task ID. Must be a number.'
    };
  }

  const pattern = parsed.positional.slice(1).join(' ');

  try {
    const updated = await database.update(id, {
      isRecurring: true,
      recurringPattern: pattern
    });

    if (updated) {
      return {
        ok: true,
        message: formatSuccess(`Task set as recurring!\n\n${formatTask(updated, true)}`)
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
      error: `Failed to set recurring: ${error.message}`
    };
  }
}

module.exports = recurringCommand;
