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

    this.defaultApiBaseUrl = 'https://www.sethserver.com/api/v1';
    this.apiConfigPath = path.join(path.dirname(dbPath), 'std-api-config.json');

    this.apiBaseUrl = this.defaultApiBaseUrl;
    this.apiUsername = '';
    this.apiPassword = '';
    this.apiTimeoutMs = 15000;
    this.remoteMode = false;

    this._loadApiConfig();
  }

  /**
   * Initialize database and create tables
   */
  async initialize() {
    if (this.remoteMode) {
      console.log('[std-db] Remote API mode enabled:', this.apiBaseUrl);
      return;
    }

    await this._initializeLocalDb();

    console.log('[std-db] Database initialized:', this.dbPath);
  }

  _loadApiConfig() {
    const fileConfig = this._readApiConfigFile();
    const envConfig = {
      baseUrl: process.env.STD_API_BASE_URL,
      username: process.env.STD_API_USERNAME,
      password: process.env.STD_API_PASSWORD,
      timeoutMs: process.env.STD_API_TIMEOUT_MS
    };

    const merged = {
      baseUrl: envConfig.baseUrl || fileConfig.baseUrl || this.defaultApiBaseUrl,
      username: envConfig.username || fileConfig.username || '',
      password: envConfig.password || fileConfig.password || '',
      timeoutMs: Number(envConfig.timeoutMs || fileConfig.timeoutMs || 15000)
    };

    this._applyApiConfig(merged, { persist: false });
  }

  _readApiConfigFile() {
    if (!fs.existsSync(this.apiConfigPath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(this.apiConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      console.warn('[std-db] Failed to read API config file:', error.message);
      return {};
    }
  }

  _writeApiConfigFile() {
    const payload = {
      baseUrl: this.apiBaseUrl,
      username: this.apiUsername,
      password: this.apiPassword,
      timeoutMs: this.apiTimeoutMs,
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(this.apiConfigPath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  _applyApiConfig(config = {}, { persist = true } = {}) {
    this.apiBaseUrl = String(config.baseUrl || this.defaultApiBaseUrl).replace(/\/$/, '');
    this.apiUsername = String(config.username || '');
    this.apiPassword = String(config.password || '');

    const timeout = Number(config.timeoutMs || 15000);
    this.apiTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 15000;

    this.remoteMode = Boolean(this.apiUsername && this.apiPassword);

    if (persist) {
      this._writeApiConfigFile();
    }
  }

  async _initializeLocalDb() {
    if (this.db) {
      return;
    }

    if (!this.SQL) {
      this.SQL = await initSqlJs();
    }

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
  }

  _closeLocalDb() {
    if (!this.db) {
      return;
    }

    this._save();
    this.db.close();
    this.db = null;
  }

  async configureApi(config = {}) {
    const wasRemoteMode = this.remoteMode;
    this._applyApiConfig(config, { persist: true });

    if (this.remoteMode) {
      // Free local DB resources while operating in API mode.
      this._closeLocalDb();
    } else if (wasRemoteMode && !this.remoteMode) {
      // Switched from API mode back to local mode at runtime.
      await this._initializeLocalDb();
    }

    return this.getApiStatus();
  }

  async clearApiConfig() {
    const wasRemoteMode = this.remoteMode;

    this._applyApiConfig(
      {
        baseUrl: this.defaultApiBaseUrl,
        username: '',
        password: '',
        timeoutMs: 15000
      },
      { persist: false }
    );

    if (fs.existsSync(this.apiConfigPath)) {
      fs.unlinkSync(this.apiConfigPath);
    }

    if (wasRemoteMode) {
      await this._initializeLocalDb();
    }

    return this.getApiStatus();
  }

  getApiStatus() {
    return {
      remoteMode: this.remoteMode,
      baseUrl: this.apiBaseUrl,
      timeoutMs: this.apiTimeoutMs,
      hasCredentials: Boolean(this.apiUsername && this.apiPassword),
      username: this.apiUsername || null,
      configPath: this.apiConfigPath
    };
  }

  async testApiConnection() {
    if (!this.remoteMode) {
      return {
        ok: false,
        message: 'Remote API mode is disabled. Configure credentials with /std api set first.'
      };
    }

    await this._apiRequest('/stds', {
      method: 'GET',
      query: { archived: 'false' }
    });

    return {
      ok: true,
      message: 'Connected to STD API successfully.'
    };
  }

  async _apiRequest(endpoint, { method = 'GET', body = null, query = null } = {}) {
    const url = new URL(`${this.apiBaseUrl}${endpoint}`);

    if (query && typeof query === 'object') {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    const headers = {
      Authorization: `Basic ${Buffer.from(`${this.apiUsername}:${this.apiPassword}`).toString('base64')}`
    };

    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.apiTimeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!response.ok) {
        const serverMessage =
          (data && typeof data === 'object' && (data.error || data.message || data.detail)) ||
          (typeof data === 'string' ? data : '');

        throw this._createHttpApiError({
          method,
          url,
          status: response.status,
          statusText: response.statusText,
          serverMessage
        });
      }

      return data;
    } catch (error) {
      if (error && error.isStdApiError) {
        throw error;
      }

      throw this._createTransportApiError({ method, url, error });
    } finally {
      clearTimeout(timeout);
    }
  }

  _createHttpApiError({ method, url, status, statusText, serverMessage = '' }) {
    const normalizedMessage = String(serverMessage || '').trim();
    const responseSummary = `${status} ${statusText || ''}`.trim();

    let classification = 'http_error';
    let guidance = 'Request to STD API failed.';

    if (status === 401) {
      classification = 'auth_invalid';
      guidance =
        'Authentication failed (401). The API rejected your username/password. If credentials look correct, verify this base URL and auth scheme are correct for your API.';
    } else if (status === 403) {
      classification = 'auth_forbidden';
      guidance =
        'Authentication succeeded but access is forbidden (403). Your account may not have permission for this endpoint.';
    } else if (status === 404) {
      classification = 'endpoint_not_found';
      guidance =
        'Endpoint not found (404). This often means the base URL is wrong (for example missing /api/v1) or the route is unavailable on the server.';
    } else if (status >= 500) {
      classification = 'server_error';
      guidance = 'STD API server returned an internal error.';
    }

    const parts = [
      `STD API request failed: ${responseSummary}`,
      `Method: ${method}`,
      `URL: ${url.toString()}`
    ];

    if (normalizedMessage) {
      parts.push(`Server message: ${normalizedMessage}`);
    }

    parts.push(`Diagnosis: ${guidance}`);

    const apiError = new Error(parts.join('\n'));
    apiError.name = 'StdApiError';
    apiError.isStdApiError = true;
    apiError.type = 'http';
    apiError.classification = classification;
    apiError.status = status;
    apiError.statusText = statusText;
    apiError.method = method;
    apiError.url = url.toString();
    apiError.serverMessage = normalizedMessage || null;
    return apiError;
  }

  _createTransportApiError({ method, url, error }) {
    const isTimeout = error?.name === 'AbortError';
    const classification = isTimeout ? 'network_timeout' : 'network_error';

    const guidance = isTimeout
      ? 'The request timed out before the API responded. Check connectivity/server health or increase timeout with /std api set --timeout <ms>.'
      : 'Could not reach the STD API. Check base URL, DNS/network access, and whether the API server is running.';

    const parts = [
      `STD API request failed: ${isTimeout ? 'timeout' : 'network error'}`,
      `Method: ${method}`,
      `URL: ${url.toString()}`,
      `Cause: ${error?.message || 'unknown error'}`,
      `Diagnosis: ${guidance}`
    ];

    const apiError = new Error(parts.join('\n'));
    apiError.name = 'StdApiError';
    apiError.isStdApiError = true;
    apiError.type = 'transport';
    apiError.classification = classification;
    apiError.status = null;
    apiError.method = method;
    apiError.url = url.toString();
    apiError.cause = error;
    return apiError;
  }

  _fromApi(std) {
    const isArchived = Boolean(std.archived);
    const isCompleted = Boolean(std.completed_at) && !isArchived;

    return {
      id: std.id,
      title: std.task_description || '',
      details: std.details || null,
      dueDate: std.due_by || null,
      priority: 'medium',
      status: isArchived ? 'archived' : isCompleted ? 'completed' : 'pending',
      tags: [],
      isRecurring: false,
      recurringPattern: null,
      reminderTime: null,
      attachments: [],
      customFields: std.project
        ? { project: std.project, order: std.order ?? 0 }
        : { order: std.order ?? 0 },
      createdAt: std.created_at || null,
      updatedAt: std.created_at || null
    };
  }

  _toApiCreate(data) {
    return {
      task_description: data.title,
      details: data.details || null,
      due_by: data.dueDate || null,
      project: data.customFields?.project || data.project || null,
      order: data.customFields?.order ?? data.order ?? 0
    };
  }

  _toApiUpdate(data) {
    const payload = {};

    if (data.title !== undefined) payload.task_description = data.title;
    if (data.details !== undefined) payload.details = data.details;
    if (data.dueDate !== undefined) payload.due_by = data.dueDate;

    if (data.status !== undefined) {
      payload.archived = data.status === 'archived';
      payload.completed = data.status === 'completed';
    }

    if (data.project !== undefined) payload.project = data.project;
    if (data.order !== undefined) payload.order = data.order;

    if (data.customFields?.project !== undefined) payload.project = data.customFields.project;
    if (data.customFields?.order !== undefined) payload.order = data.customFields.order;

    return payload;
  }

  async _getRemoteTasks({ archived = false } = {}) {
    const result = await this._apiRequest('/stds', {
      query: { archived: archived ? 'true' : 'false' }
    });
    return Array.isArray(result) ? result.map((item) => this._fromApi(item)) : [];
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
  async create(data) {
    if (this.remoteMode) {
      const payload = this._toApiCreate(data);
      const created = await this._apiRequest('/stds', {
        method: 'POST',
        body: payload
      });
      return this.findById(created.id);
    }

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
  async findById(id) {
    if (this.remoteMode) {
      const all = [
        ...(await this._getRemoteTasks({ archived: false })),
        ...(await this._getRemoteTasks({ archived: true }))
      ];
      return all.find((task) => task.id === Number(id)) || null;
    }

    const stmt = this.db.prepare('SELECT * FROM stds WHERE id = ?');
    stmt.bind([id]);

    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return row ? this._deserialize(row) : null;
  }

  /**
   * Find all tasks with optional filters
   */
  async findAll(filters = {}) {
    if (this.remoteMode) {
      let tasks;

      if (filters.status === 'archived') {
        tasks = await this._getRemoteTasks({ archived: true });
      } else {
        tasks = await this._getRemoteTasks({ archived: false });
      }

      if (filters.status && filters.status !== 'archived') {
        tasks = tasks.filter((t) => t.status === filters.status);
      }

      if (filters.priority) {
        tasks = tasks.filter((t) => t.priority === filters.priority);
      }

      if (filters.dueDate) {
        const due = new Date(filters.dueDate).toDateString();
        tasks = tasks.filter((t) => t.dueDate && new Date(t.dueDate).toDateString() === due);
      }

      if (filters.dueBefore) {
        const before = new Date(filters.dueBefore).getTime();
        tasks = tasks.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < before);
      }

      if (filters.dueAfter) {
        const after = new Date(filters.dueAfter).getTime();
        tasks = tasks.filter((t) => t.dueDate && new Date(t.dueDate).getTime() > after);
      }

      const sortBy = filters.sortBy || 'createdAt';
      const sortOrder = filters.sortOrder === 'ASC' ? 'ASC' : 'DESC';
      tasks.sort((a, b) => {
        const av = a[sortBy] ?? '';
        const bv = b[sortBy] ?? '';
        if (av < bv) return sortOrder === 'ASC' ? -1 : 1;
        if (av > bv) return sortOrder === 'ASC' ? 1 : -1;
        return 0;
      });

      if (filters.limit) {
        tasks = tasks.slice(0, Number(filters.limit));
      }

      return tasks;
    }

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
  async search(query) {
    if (this.remoteMode) {
      const q = String(query || '').toLowerCase();
      const tasks = await this.findAll({});
      return tasks.filter(
        (t) =>
          (t.title && t.title.toLowerCase().includes(q)) ||
          (t.details && t.details.toLowerCase().includes(q))
      );
    }

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
  async filterByTag(tag) {
    if (this.remoteMode) {
      const tasks = await this.findAll({});
      return tasks.filter((t) => Array.isArray(t.tags) && t.tags.includes(tag));
    }

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
  async update(id, data) {
    if (this.remoteMode) {
      const payload = this._toApiUpdate(data);
      if (Object.keys(payload).length === 0) {
        return this.findById(id);
      }

      await this._apiRequest(`/stds/${id}`, {
        method: 'PUT',
        body: payload
      });
      return this.findById(id);
    }

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
  async delete(id) {
    if (this.remoteMode) {
      await this._apiRequest(`/stds/${id}`, { method: 'DELETE' });
      return true;
    }

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
  async bulkDelete(ids) {
    if (this.remoteMode) {
      let deleted = 0;
      for (const id of ids) {
        await this.delete(id);
        deleted += 1;
      }
      return deleted;
    }

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
  async complete(id) {
    return this.update(id, { status: 'completed' });
  }

  /**
   * Archive a task
   */
  async archive(id) {
    return this.update(id, { status: 'archived' });
  }

  /**
   * Get statistics
   */
  async getStats() {
    if (this.remoteMode) {
      const tasks = [
        ...(await this._getRemoteTasks({ archived: false })),
        ...(await this._getRemoteTasks({ archived: true }))
      ];

      const stats = {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === 'pending').length,
        inProgress: tasks.filter((t) => t.status === 'in-progress').length,
        completed: tasks.filter((t) => t.status === 'completed').length,
        archived: tasks.filter((t) => t.status === 'archived').length,
        highPriority: tasks.filter((t) => t.priority === 'high' || t.priority === 'critical').length,
        overdue: tasks.filter(
          (t) => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'completed' && t.status !== 'archived'
        ).length
      };

      return stats;
    }

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
  async exportAll() {
    if (this.remoteMode) {
      const tasks = [
        ...(await this._getRemoteTasks({ archived: false })),
        ...(await this._getRemoteTasks({ archived: true }))
      ];

      tasks.sort((a, b) => {
        const av = new Date(a.createdAt || 0).getTime();
        const bv = new Date(b.createdAt || 0).getTime();
        return bv - av;
      });

      return tasks;
    }

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
    if (!this.db) return;

    this._closeLocalDb();
    console.log('[std-db] Database closed');
  }
}

module.exports = StdDatabase;
