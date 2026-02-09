const { formatStats } = require('../utils/formatter');

/**
 * Show STD task statistics
 * Usage: /std stats
 */
async function statsCommand(args, database) {
  try {
    const stats = database.getStats();
    return {
      ok: true,
      message: formatStats(stats)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to get stats: ${error.message}`
    };
  }
}

module.exports = statsCommand;
