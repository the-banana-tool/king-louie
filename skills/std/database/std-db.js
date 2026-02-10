const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

/**
 * SQLite database wrapper for STD tasks using sql.js
 */
class StdDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.SQL = null;
  }

  /**
   * Initialize database and create tables
   */
  async initialize() {
    this.SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
    } else {
      this.db = new this.SQL.Database();
    }

    // Load and execute schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);

    // Save to disk
    this._save();

    console.log('[std-db] Database initialized:', this.dbPath);
  }

  /**
   * Save database to disk
   */
  _save() {
    if (this.db) {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    }
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
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    stmt.run([
      data.title,
      data.details || null,
      data.dueDate || null,
      data.priority || 'medium',
      data.status || 'pending',
      data.tags ? JSON.stringify(data.tags) : null,
      data.isRecurring ? 1 : 0,
      data.recurringPattern || null,
      data.reminderTime || null,
      data.attachments ? JSON.stringify(data.attachments) : null,
      data.customFields ? JSON.stringify(data.customFields) : null
    ]);

    stmt.free();
    this._save();

    const lastId = this.db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    return this.findById(lastId);
  }

  /**
   * Find task by ID
   */
  findById(id) {
    const stmt = this.db.prepare('SELECT * FROM stds WHERE id = ?');
    stmt.bind([id]);

    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return row ? this._deserialize(row) : null;
  }

  /**
   * Find all tasks with optional filters
   */
  findAll(filters = {}) {
    let query = 'SELECT * FROM stds WHERE 1=1';
    const params = [];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters.priority) {
      query += ' AND priority = ?';
      params.push(filters.priority);
    }

    if (filters.dueDate) {
      query += ' AND date(dueDate) = date(?)';
      params.push(filters.dueDate);
    }

    if (filters.dueBefore) {
      query += ' AND dueDate < ?';
      params.push(filters.dueBefore);
    }

    if (filters.dueAfter) {
      query += ' AND dueDate > ?';
      params.push(filters.dueAfter);
    }

    if (filters.isRecurring !== undefined) {
      query += ' AND isRecurring = ?';
      params.push(filters.isRecurring ? 1 : 0);
    }

    // Sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortBy} ${sortOrder}`;

    // Limit
    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const stmt = this.db.prepare(query);
    stmt.bind(params);

    const results = [];
    while (stmt.step()) {
      results.push(this._deserialize(stmt.getAsObject()));
    }
    stmt.free();

    return results;
  }

  /**
   * Search tasks by text query
   */
  search(query) {
    const stmt = this.db.prepare(`
      SELECT * FROM stds
      WHERE title LIKE ? OR details LIKE ?
      ORDER BY updatedAt DESC
    `);

    const searchPattern = `%${query}%`;
    stmt.bind([searchPattern, searchPattern]);

    const results = [];
    while (stmt.step()) {
      results.push(this._deserialize(stmt.getAsObject()));
    }
    stmt.free();

    return results;
  }

  /**
   * Filter tasks by tags
   */
  filterByTag(tag) {
    const stmt = this.db.prepare('SELECT * FROM stds WHERE tags LIKE ?');
    stmt.bind([`%"${tag}"%`]);

    const results = [];
    while (stmt.step()) {
      results.push(this._deserialize(stmt.getAsObject()));
    }
    stmt.free();

    return results;
  }

  /**
   * Update a task
   */
  update(id, data) {
    const fields = [];
    const params = [];

    if (data.title !== undefined) {
      fields.push('title = ?');
      params.push(data.title);
    }

    if (data.details !== undefined) {
      fields.push('details = ?');
      params.push(data.details);
    }

    if (data.dueDate !== undefined) {
      fields.push('dueDate = ?');
      params.push(data.dueDate);
    }

    if (data.priority !== undefined) {
      fields.push('priority = ?');
      params.push(data.priority);
    }

    if (data.status !== undefined) {
      fields.push('status = ?');
      params.push(data.status);
    }

    if (data.tags !== undefined) {
      fields.push('tags = ?');
      params.push(JSON.stringify(data.tags));
    }

    if (data.isRecurring !== undefined) {
      fields.push('isRecurring = ?');
      params.push(data.isRecurring ? 1 : 0);
    }

    if (data.recurringPattern !== undefined) {
      fields.push('recurringPattern = ?');
      params.push(data.recurringPattern);
    }

    if (data.reminderTime !== undefined) {
      fields.push('reminderTime = ?');
      params.push(data.reminderTime);
    }

    if (data.attachments !== undefined) {
      fields.push('attachments = ?');
      params.push(JSON.stringify(data.attachments));
    }

    if (data.customFields !== undefined) {
      fields.push('customFields = ?');
      params.push(JSON.stringify(data.customFields));
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    // Add updated timestamp
    fields.push('updatedAt = datetime("now")');

    const query = `UPDATE stds SET ${fields.join(', ')} WHERE id = ?`;
    params.push(id);

    const stmt = this.db.prepare(query);
    stmt.run(params);
    stmt.free();

    this._save();
    return this.findById(id);
  }

  /**
   * Delete a task
   */
  delete(id) {
    const stmt = this.db.prepare('DELETE FROM stds WHERE id = ?');
    stmt.run([id]);
    const changes = this.db.getRowsModified();
    stmt.free();

    this._save();
    return changes > 0;
  }

  /**
   * Bulk delete tasks
   */
  bulkDelete(ids) {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM stds WHERE id IN (${placeholders})`);
    stmt.run(ids);
    const changes = this.db.getRowsModified();
    stmt.free();

    this._save();
    return changes;
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
    const result = this.db.exec(`
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

    if (result.length === 0 || result[0].values.length === 0) {
      return { total: 0, pending: 0, inProgress: 0, completed: 0, archived: 0, highPriority: 0, overdue: 0 };
    }

    const values = result[0].values[0];
    const columns = result[0].columns;

    const stats = {};
    columns.forEach((col, idx) => {
      stats[col] = values[idx];
    });

    return stats;
  }

  /**
   * Export all tasks
   */
  exportAll() {
    const stmt = this.db.prepare('SELECT * FROM stds ORDER BY createdAt DESC');

    const results = [];
    while (stmt.step()) {
      results.push(this._deserialize(stmt.getAsObject()));
    }
    stmt.free();

    return results;
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
      this._save();
      this.db.close();
      console.log('[std-db] Database closed');
    }
  }
}

module.exports = StdDatabase;
