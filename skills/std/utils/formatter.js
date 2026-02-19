/**
 * Output formatting utilities
 */

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function wrapLine(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`;
}

/**
 * Format a single STD task for display
 */
function formatTask(task, detailed = false) {
  if (!task) return '<div style="font-family:sans-serif;color:#888;">Task not found</div>';

  const project = task["customFields"]?.project || "Unknown Project";
  const title = task.title || "Untitled Task";

  const styles = {
    card: `
      display:block;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      font-size:14px;
      line-height:1.5;
      background:#ffffff;
      border:1px solid #e0e0e0;
      border-radius:10px;
      padding:12px 16px;
      box-shadow:0 1px 3px rgba(0,0,0,0.08);
    `,
    project: `
      font-size:11px;
      font-weight:600;
      text-transform:uppercase;
      letter-spacing:0.05em;
      color:#888;
      margin-bottom:4px;
    `,
    title: `
      font-size:15px;
      font-weight:600;
      color:#111;
      margin-bottom:10px;
    `,
    divider: `
      border:none;
      border-top:1px solid #f0f0f0;
      margin:8px 0;
    `,
    row: `
      display:flex;
      gap:6px;
      font-size:13px;
      color:#444;
      margin-bottom:4px;
    `,
    label: `
      font-weight:600;
      color:#666;
      white-space:nowrap;
    `,
    overdue: `
      display:inline-block;
      background:#fee2e2;
      color:#dc2626;
      font-size:11px;
      font-weight:700;
      border-radius:4px;
      padding:1px 5px;
      margin-left:6px;
    `,
    tag: `
      display:inline-block;
      background:#f0f4ff;
      color:#4361c2;
      font-size:11px;
      border-radius:4px;
      padding:2px 7px;
      margin-right:4px;
    `,
    meta: `
      font-size:11px;
      color:#aaa;
      margin-top:8px;
    `,
    status: `
      display:inline-block;
      background:#f0fdf4;
      color:#16a34a;
      font-size:11px;
      font-weight:600;
      border-radius:4px;
      padding:1px 6px;
    `
  };

  const row = (label, value) =>
    `<div style="${styles.row}"><span style="${styles.label}">${label}</span><span>${value}</span></div>`;

  const parts = [
    `<div style="${styles.project}">${escapeHtml(project)}</div>`,
    `<div style="${styles.title}">${escapeHtml(title)}</div>`,
  ];

  parts.push(`<hr style="${styles.divider}">`);

  var needsNextHr = false;

  if (task.dueDate) {
    needsNextHr = true;
    const dueDate = new Date(task.dueDate);
    const isOverdue = dueDate < new Date() && task.status !== 'completed';
    const dueDateStr = dueDate.toLocaleDateString();
    const overdueTag = isOverdue ? `<span style="${styles.overdue}">OVERDUE</span>` : '';
    parts.push(row('Due:', `${escapeHtml(dueDateStr)}${overdueTag}`));
  }

  if (task.priority && task.priority !== 'medium') {
    needsNextHr = true;
    const priorityColors = {
      high:   { bg: '#fee2e2', color: '#dc2626' },
      medium: { bg: '#fef3c7', color: '#d97706' },
      low:    { bg: '#f0fdf4', color: '#16a34a' },
    };
    const p = priorityColors[task.priority] || { bg: '#f3f4f6', color: '#374151' };
    parts.push(row('Priority:',
      `<span style="background:${p.bg};color:${p.color};font-size:11px;font-weight:600;border-radius:4px;padding:1px 6px;">${escapeHtml(task.priority)}</span>`
    ));
  }

  if (task.details) {
    needsNextHr = true;
    parts.push(row('Details:', escapeHtml(task.details)));
  }

  if (task.tags && task.tags.length > 0) {
    needsNextHr = true;
    const tagHtml = task.tags.map(t => `<span style="${styles.tag}">${escapeHtml(t)}</span>`).join('');
    parts.push(row('Tags:', tagHtml));
  }

  if (detailed) {
    if (task.isRecurring) {
      needsNextHr = true;
      parts.push(row('Recurring:', escapeHtml(task.recurringPattern || 'Yes')));
    }
    if (task.reminderTime) {
      needsNextHr = true;
      parts.push(row('Reminder:', escapeHtml(formatDate(task.reminderTime))));
    }
    if (task.customFields && Object.keys(task.customFields).length > 0) {
      needsNextHr = true;
      parts.push(row('Custom:', escapeHtml(JSON.stringify(task.customFields))));
    }
  }

  if (needsNextHr) {
    parts.push(`<hr style="${styles.divider}">`);
  }
  parts.push(`<div style="${styles.meta}">Created ${escapeHtml(formatDate(task.createdAt))}</div>`);

  return `<div style="${styles.card}">${parts.join('')}</div>`;
}

/**
 * Format a list of tasks
 */
function formatTaskList(tasks, options = {}) {
  if (!tasks || tasks.length === 0) {
    return '<div><strong>No tasks found.</strong></div>';
  }

  const { detailed = false } = options;

  const parts = [];

  const cards = tasks.map(task => formatTask(task, detailed)).join('');
  return `<div style="display:flex; flex-direction:column; gap:12px;">${cards}</div>`;
}

/**
 * Format stats
 */
function formatStats(stats) {
  if (!stats) return '<div>No stats available</div>';

  return [
    '<div><strong>Task Statistics</strong></div>',
    wrapLine('Total Tasks', stats.total),
    wrapLine('Pending', stats.pending),
    wrapLine('In Progress', stats.inProgress),
    wrapLine('Completed', stats.completed),
    wrapLine('Archived', stats.archived),
    wrapLine('High Priority', stats.highPriority),
    wrapLine('Overdue', stats.overdue)
  ].join('');
}

/**
 * Format error message
 */
function formatError(message) {
  return `Error: ${message}`;
}

/**
 * Format success message
 */
function formatSuccess(message) {
  return `${message}`;
}

module.exports = {
  formatTask,
  formatTaskList,
  formatStats,
  formatError,
  formatSuccess
};
