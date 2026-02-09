/**
 * Command argument parser utilities
 */

/**
 * Parse command arguments with support for flags and values
 * Example: ['add', 'Task title', '--priority', 'high', '--due', '2024-12-31']
 */
function parseArgs(args) {
  const parsed = {
    positional: [],
    flags: {}
  };

  let currentFlag = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      // It's a flag
      currentFlag = arg.slice(2);
      parsed.flags[currentFlag] = true; // Default to true if no value follows
    } else if (currentFlag) {
      // It's a value for the previous flag
      parsed.flags[currentFlag] = arg;
      currentFlag = null;
    } else {
      // It's a positional argument
      parsed.positional.push(arg);
    }
  }

  return parsed;
}

/**
 * Parse a date string into ISO format
 * Supports: 'today', 'tomorrow', 'YYYY-MM-DD', ISO strings
 */
function parseDate(dateStr) {
  if (!dateStr) return null;

  const lower = dateStr.toLowerCase();
  const now = new Date();

  if (lower === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }

  if (lower === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()).toISOString();
  }

  // Try to parse as ISO or standard date
  try {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  } catch (e) {
    // Ignore parse errors
  }

  return null;
}

/**
 * Parse priority string
 */
function parsePriority(priorityStr) {
  if (!priorityStr) return null;

  const lower = priorityStr.toLowerCase();
  const validPriorities = ['low', 'medium', 'high', 'critical'];

  if (validPriorities.includes(lower)) {
    return lower;
  }

  return null;
}

/**
 * Parse status string
 */
function parseStatus(statusStr) {
  if (!statusStr) return null;

  const lower = statusStr.toLowerCase();
  const validStatuses = ['pending', 'in-progress', 'completed', 'archived'];

  if (validStatuses.includes(lower)) {
    return lower;
  }

  return null;
}

/**
 * Parse tags from comma-separated string
 */
function parseTags(tagsStr) {
  if (!tagsStr) return [];

  return tagsStr
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Parse filter criteria
 * Example: 'status:pending priority:high tag:work'
 */
function parseFilters(filterStr) {
  const filters = {};

  if (!filterStr) return filters;

  const parts = filterStr.split(/\s+/);

  for (const part of parts) {
    const [key, value] = part.split(':');
    if (key && value) {
      filters[key.toLowerCase()] = value;
    }
  }

  return filters;
}

module.exports = {
  parseArgs,
  parseDate,
  parsePriority,
  parseStatus,
  parseTags,
  parseFilters
};
