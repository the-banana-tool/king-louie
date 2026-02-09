const { parseArgs } = require('../utils/parser');
const { formatSuccess } = require('../utils/formatter');

/**
 * Delete an STD task
 * Usage: /std delete <id>
 */
async function deleteCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.positional.length === 0) {
    return {
      ok: false,
      error: 'Task ID is required. Usage: /std delete <id>'
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
  const existing = database.findById(id);
  if (!existing) {
    return {
      ok: false,
      error: `Task #${id} not found.`
    };
  }

  try {
    const deleted = database.delete(id);
    if (deleted) {
      return {
        ok: true,
        message: formatSuccess(`Task #${id} deleted.`)
      };
    } else {
      return {
        ok: false,
        error: `Failed to delete task #${id}.`
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `Failed to delete task: ${error.message}`
    };
  }
}

module.exports = deleteCommand;
