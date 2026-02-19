const { parseArgs } = require('../utils/parser');
const { formatTask, formatSuccess } = require('../utils/formatter');

function isTaskActive(task) {
  return task && task.status !== 'completed' && task.status !== 'archived';
}

function normalizeCompletionInput(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return '';

  // Support quoted titles even when upstream tokenization split on spaces.
  return trimmed.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}

async function resolveTaskFromInput(rawInput, database) {
  const candidate = normalizeCompletionInput(rawInput);
  if (!candidate) return null;

  const numericId = parseInt(candidate, 10);
  if (!isNaN(numericId) && String(numericId) === candidate) {
    const byId = await database.findById(numericId);
    if (!byId) {
      return { error: `Task #${numericId} not found.` };
    }

    if (!isTaskActive(byId)) {
      return { error: `Task #${numericId} is already ${byId.status}.` };
    }

    return byId;
  }

  const allTasks = await database.findAll({});
  const activeTasks = allTasks.filter(isTaskActive);
  const normalizedCandidate = candidate.toLowerCase();

  // Prefer exact title match first
  let matches = activeTasks.filter((task) => task.title.toLowerCase().trim() === normalizedCandidate);

  // Fall back to partial title match
  if (matches.length === 0) {
    matches = activeTasks.filter((task) => task.title.toLowerCase().includes(normalizedCandidate));
  }

  if (matches.length === 0) {
    return {
      error: `Couldn't find an active task matching "${candidate}". Try /std list and then /std complete <id>.`
    };
  }

  if (matches.length > 1) {
    const suggestions = matches
      .slice(0, 5)
      .map((task) => `  #${task.id} ${task.title}`)
      .join('\n');

    return {
      error: `Found multiple matching tasks for "${candidate}". Please complete by ID:\n${suggestions}`
    };
  }

  return matches[0];
}

/**
 * Mark an STD task as complete
 * Usage: /std complete <id>
 */
async function completeCommand(args, database) {
  const parsed = parseArgs(args);

  if (parsed.positional.length === 0) {
    return {
      ok: false,
      error: 'Task ID or title is required. Usage: /std complete <id|"task title">'
    };
  }

  let task;
  try {
    const inputTarget = parsed.positional.join(' ');
    task = await resolveTaskFromInput(inputTarget, database);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to look up task: ${error.message}`
    };
  }

  if (!task) {
    return {
      ok: false,
      error: 'Task ID or title is required. Usage: /std complete <id|"task title">'
    };
  }

  if (task.error) {
    return {
      ok: false,
      error: task.error
    };
  }

  try {
    const completed = await database.complete(task.id);

    // Keep completed tasks out of the primary UI by immediately archiving them.
    let archivedTask = null;
    try {
      archivedTask = await database.archive(task.id);
    } catch (archiveError) {
      return {
        ok: true,
        message: formatSuccess(
          `Task completed!\n\n(Archive step failed: ${archiveError.message})\n\n${formatTask(completed)}`
        )
      };
    }

    return {
      ok: true,
      message: formatSuccess(`Task completed and archived!`)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to complete task: ${error.message}`
    };
  }
}

module.exports = completeCommand;
