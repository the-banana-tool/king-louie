const { formatSuccess } = require('../utils/formatter');

/**
 * Export all STD tasks to JSON
 * Usage: /std export
 */
async function exportCommand(args, database) {
  try {
    const tasks = database.exportAll();
    const json = JSON.stringify(tasks, null, 2);

    // For now, return the JSON as text
    // In the future, this could save to a file or send via API
    return {
      ok: true,
      message: formatSuccess(`Exported ${tasks.length} task(s):\n\n\`\`\`json\n${json}\n\`\`\``)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to export tasks: ${error.message}`
    };
  }
}

module.exports = exportCommand;
