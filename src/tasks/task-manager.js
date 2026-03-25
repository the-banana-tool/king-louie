const { EventEmitter } = require('events');

class Task {
  constructor(config = {}) {
    this.id = config.id || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.subject = config.subject || 'Untitled Task';
    this.description = config.description || '';
    this.activeForm = config.activeForm || this.subject;
    this.status = config.status || 'pending'; // pending, in_progress, completed, deleted
    this.blocks = Array.isArray(config.blocks) ? [...config.blocks] : [];
    this.blockedBy = Array.isArray(config.blockedBy) ? [...config.blockedBy] : [];
    this.metadata = config.metadata && typeof config.metadata === 'object' ? { ...config.metadata } : {};
    this.createdAt = config.createdAt || Date.now();
    this.updatedAt = config.updatedAt || Date.now();
  }

  canStart() {
    return this.blockedBy.length === 0 && this.status === 'pending';
  }
}

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
  }

  create(config = {}) {
    const task = new Task(config);
    this.tasks.set(task.id, task);
    this.emit('taskCreated', task);
    return task;
  }

  get(taskId) {
    return this.tasks.get(taskId);
  }

  list() {
    return Array.from(this.tasks.values());
  }

  update(taskId, updates = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    Object.assign(task, updates || {});
    task.updatedAt = Date.now();

    this.emit('taskUpdated', task);
    return task;
  }

  markInProgress(taskId) {
    return this.update(taskId, { status: 'in_progress' });
  }

  markCompleted(taskId) {
    const task = this.update(taskId, { status: 'completed' });

    this.tasks.forEach((candidate) => {
      if (!candidate.blockedBy.includes(taskId)) return;

      candidate.blockedBy = candidate.blockedBy.filter((id) => id !== taskId);
      candidate.updatedAt = Date.now();
      this.emit('taskUnblocked', candidate);
      this.emit('taskUpdated', candidate);
    });

    return task;
  }

  getAvailableTasks() {
    return this.list().filter((task) => task.canStart());
  }
}

module.exports = { Task, TaskManager };