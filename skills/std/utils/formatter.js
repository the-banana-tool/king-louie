/**
 * Output formatting utilities
 */

/**
 * Format a single STD task for display
 */
function formatTask(task, detailed = false) {
  if (!task) return 'Task not found';

  const priorityEmoji = {
    low: '🟢',
    medium: '🟡',
    high: '🟠',
    critical: '🔴'
  };

  const statusEmoji = {
    pending: '⏳',
    'in-progress': '🔄',
    completed: '✅',
    archived: '📦'
  };

  const parts = [
    `${statusEmoji[task.status] || '📋'} #${task.id}: ${task.title}`,
    `   ${priorityEmoji[task.priority] || ''} Priority: ${task.priority}`
  ];

  if (task.dueDate) {
    const dueDate = new Date(task.dueDate);
    const now = new Date();
    const isOverdue = dueDate < now && task.status !== 'completed';
    const dueDateStr = dueDate.toLocaleDateString();
    parts.push(`   📅 Due: ${dueDateStr}${isOverdue ? ' ⚠️ OVERDUE' : ''}`);
  }

  if (task.tags && task.tags.length > 0) {
    parts.push(`   🏷️  Tags: ${task.tags.join(', ')}`);
  }

  if (detailed) {
    if (task.details) {
      parts.push(`   📝 Details: ${task.details}`);
    }

    if (task.isRecurring) {
      parts.push(`   🔁 Recurring: ${task.recurringPattern || 'yes'}`);
    }

    if (task.reminderTime) {
      const reminderDate = new Date(task.reminderTime);
      parts.push(`   ⏰ Reminder: ${reminderDate.toLocaleString()}`);
    }

    if (task.customFields && Object.keys(task.customFields).length > 0) {
      parts.push(`   ⚙️  Custom: ${JSON.stringify(task.customFields)}`);
    }

    parts.push(`   🕒 Created: ${new Date(task.createdAt).toLocaleString()}`);
    parts.push(`   🕒 Updated: ${new Date(task.updatedAt).toLocaleString()}`);
  }

  return parts.join('\n');
}

/**
 * Format a list of tasks
 */
function formatTaskList(tasks, options = {}) {
  if (!tasks || tasks.length === 0) {
    return 'No tasks found.';
  }

  const { detailed = false, showCount = true } = options;

  const parts = [];

  if (showCount) {
    parts.push(`📋 Found ${tasks.length} task(s):\n`);
  }

  for (const task of tasks) {
    parts.push(formatTask(task, detailed));
    parts.push(''); // Empty line between tasks
  }

  return parts.join('\n');
}

/**
 * Format stats
 */
function formatStats(stats) {
  if (!stats) return 'No stats available';

  return [
    '📊 Task Statistics',
    '',
    `Total Tasks: ${stats.total}`,
    `⏳ Pending: ${stats.pending}`,
    `🔄 In Progress: ${stats.inProgress}`,
    `✅ Completed: ${stats.completed}`,
    `📦 Archived: ${stats.archived}`,
    `🔴 High Priority: ${stats.highPriority}`,
    `⚠️  Overdue: ${stats.overdue}`
  ].join('\n');
}

/**
 * Format error message
 */
function formatError(message) {
  return `❌ Error: ${message}`;
}

/**
 * Format success message
 */
function formatSuccess(message) {
  return `✅ ${message}`;
}

module.exports = {
  formatTask,
  formatTaskList,
  formatStats,
  formatError,
  formatSuccess
};
