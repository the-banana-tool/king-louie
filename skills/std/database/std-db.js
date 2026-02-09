const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

/**
 * SQLite database wrapper for STD tasks
 */
class StdDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize database and create tables
   */
  async initialize() {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    // Load and execute schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);

    console.log('[std-db] Database initialized:', this.dbPath);
  }

  /**
   * Create a new STD task
   */
  create(data) {
    const stmt = this.db.prepare(`
      INSERT INTO stds (
        title, details, dueDate, priority, status, tags,
        isRecurring, recurringPattern, reminderTime, attachments, customFields
      ) VALUES (
        @title, @details, @dueDate, @priority, @status, @tags,
        @isRecurring, @recurringPattern, @reminderTime, @attachments, @customFields
      )
    `);

    const result = stmt.run({
      title: data.title,
      details: data.details || null,
      dueDate: data.dueDate || null,
      priority: data.priority || 'medium',
      status: data.status || 'pending',
      tags: data.tags ? JSON.stringify(data.tags) : null,
      isRecurring: data.isRecurring ? 1 : 0,
      recurringPattern: data.recurringPattern || null,
      reminderTime: data.reminderTime || null,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      customFields: data.customFields ? JSON.stringify(data.customFields) : null
    });

    return this.findById(result.lastInsertRowid);
  }

  /**
   * Find task by ID
   */
  findById(id) {
    const stmt = this.db.prepare('SELECT * FROM stds WHERE id = ?');
    const row = stmt.get(id);
    return row ? this._deserialize(row) : null;
  }

  /**
   * Find all tasks with optional filters
   */
  findAll(filters = {}) {
    let query = 'SELECT * FROM stds WHERE 1=1';
    const params = {};

    if (filters.status) {
      query += ' AND status = @status';
      params.status = filters.status;
    }

    if (filters.priority) {
      query += ' AND priority = @priority';
      params.priority = filters.priority;
    }

    if (filters.dueDate) {
      query += ' AND date(dueDate) = date(@dueDate)';
      params.dueDate = filters.dueDate;
    }

    if (filters.dueBefore) {
      query += ' AND dueDate < @dueBefore';
      params.dueBefore = filters.dueBefore;
    }

    if (filters.dueAfter) {
      query += ' AND dueDate > @dueAfter';
      params.dueAfter = filters.dueAfter;
    }

    if (filters.isRecurring !== undefined) {
      query += ' AND isRecurring = @isRecurring';
      params.isRecurring = filters.isRecurring ? 1 : 0;
    }

    // Sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortBy} ${sortOrder}`;

    // Limit
    if (filters.limit) {
      query += ' LIMIT @limit';
      params.limit = filters.limit;
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(params);
    return rows.map((row) => this._deserialize(row));
  }

  /**
   * Search tasks by text query
   */
  search(query) {
    const stmt = this.db.prepare(`
      SELECT * FROM stds
      WHERE title LIKE @query OR details LIKE @query
      ORDER BY updatedAt DESC
    `);

    const searchPattern = `%${query}%`;
    const rows = stmt.all({ query: searchPattern });
    return rows.map((row) => this._deserialize(row));
  }

  /**
   * Filter tasks by tags
   */
  filterByTag(tag) {
    const stmt = this.db.prepare('SELECT * FROM stds WHERE tags LIKE @tag');
    const rows = stmt.all({ tag: `%"${tag}"%` });
    return rows.map((row) => this._deserialize(row));
  }

  /**
   * Update a task
   */
  update(id, data) {
    const fields = [];
    const params = { id };

    if (data.title !== undefined) {
      fields.push('title = @title');
      params.title = data.title;
    }

    if (data.details !== undefined) {
      fields.push('details = @details');
      params.details = data.details;
    }

    if (data.dueDate !== undefined) {
      fields.push('dueDate = @dueDate');
      params.dueDate = data.dueDate;
    }

    if (data.priority !== undefined) {
      fields.push('priority = @priority');
      params.priority = data.priority;
    }

    if (data.status !== undefined) {
      fields.push('status = @status');
      params.status = data.status;
    }

    if (data.tags !== undefined) {
      fields.push('tags = @tags');
      params.tags = JSON.stringify(data.tags);
    }

    if (data.isRecurring !== undefined) {
      fields.push('isRecurring = @isRecurring');
      params.isRecurring = data.isRecurring ? 1 : 0;
    }

    if (data.recurringPattern !== undefined) {
      fields.push('recurringPattern = @recurringPattern');
      params.recurringPattern = data.recurringPattern;
    }

    if (data.reminderTime !== undefined) {
      fields.push('reminderTime = @reminderTime');
      params.reminderTime = data.reminderTime;
    }

    if (data.attachments !== undefined) {
      fields.push('attachments = @attachments');
      params.attachments = JSON.stringify(data.attachments);
    }

    if (data.customFields !== undefined) {
      fields.push('customFields = @customFields');
      params.customFields = JSON.stringify(data.customFields);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    const query = `UPDATE stds SET ${fields.join(', ')} WHERE id = @id`;
    const stmt = this.db.prepare(query);
    stmt.run(params);

    return this.findById(id);
  }

  /**
   * Delete a task
   */
  delete(id) {
    const stmt = this.db.prepare('DELETE FROM stds WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Bulk delete tasks
   */
  bulkDelete(ids) {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM stds WHERE id IN (${placeholders})`);
    const result = stmt.run(...ids);
    return result.changes;
  }

  /**
   * Mark task as complete
   */
  complete(id) {
    return this.update(id, { status: 'completed' });
  }

  /**
   * Archive a task
   */
  archive(id) {
    return this.update(id, { status: 'archived' });
  }

  /**
   * Get statistics
   */
  getStats() {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in-progress' THEN 1 ELSE 0 END) as inProgress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
        SUM(CASE WHEN priority = 'high' OR priority = 'critical' THEN 1 ELSE 0 END) as highPriority,
        SUM(CASE WHEN dueDate < datetime('now') AND status != 'completed' THEN 1 ELSE 0 END) as overdue
      FROM stds
    `);

    return stmt.get();
  }

  /**
   * Export all tasks
   */
  exportAll() {
    const stmt = this.db.prepare('SELECT * FROM stds ORDER BY createdAt DESC');
    const rows = stmt.all();
    return rows.map((row) => this._deserialize(row));
  }

  /**
   * Deserialize JSON fields
   */
  _deserialize(row) {
    if (!row) return null;

    return {
      ...row,
      isRecurring: Boolean(row.isRecurring),
      tags: row.tags ? JSON.parse(row.tags) : [],
      attachments: row.attachments ? JSON.parse(row.attachments) : [],
      customFields: row.customFields ? JSON.parse(row.customFields) : {}
    };
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.db) {
      this.db.close();
      console.log('[std-db] Database closed');
    }
  }
}

module.exports = StdDatabase;
