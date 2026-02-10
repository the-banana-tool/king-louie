const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

/**
 * Context/Knowledge database for RAG
 * Stores information about people, projects, and task patterns
 */
class ContextDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.SQL = null;
  }

  /**
   * Initialize context database
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

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        aliases TEXT, -- JSON array of alternative names
        role TEXT,
        email TEXT,
        notes TEXT,
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        owner TEXT,
        status TEXT DEFAULT 'active',
        tags TEXT, -- JSON array
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS task_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL,
        template TEXT NOT NULL, -- JSON template for task creation
        description TEXT,
        createdAt TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
      CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
    `);

    this._save();
    console.log('[context-db] Context database initialized:', this.dbPath);
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
   * Add or update a person
   */
  addPerson(data) {
    const stmt = this.db.prepare(`
      INSERT INTO people (name, aliases, role, email, notes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        aliases = excluded.aliases,
        role = excluded.role,
        email = excluded.email,
        notes = excluded.notes,
        updatedAt = datetime('now')
    `);

    stmt.run([
      data.name,
      data.aliases ? JSON.stringify(data.aliases) : null,
      data.role || null,
      data.email || null,
      data.notes || null
    ]);

    stmt.free();
    this._save();
  }

  /**
   * Find person by name or alias
   */
  findPerson(name) {
    const stmt = this.db.prepare(`
      SELECT * FROM people
      WHERE LOWER(name) = LOWER(?)
         OR aliases LIKE ?
      LIMIT 1
    `);

    stmt.bind([name, `%"${name}"%`]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    if (!row) return null;

    return {
      ...row,
      aliases: row.aliases ? JSON.parse(row.aliases) : []
    };
  }

  /**
   * Get all people
   */
  getAllPeople() {
    const stmt = this.db.prepare('SELECT * FROM people ORDER BY name');
    const results = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        ...row,
        aliases: row.aliases ? JSON.parse(row.aliases) : []
      });
    }

    stmt.free();
    return results;
  }

  /**
   * Add or update a project
   */
  addProject(data) {
    const stmt = this.db.prepare(`
      INSERT INTO projects (name, description, owner, status, tags)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run([
      data.name,
      data.description || null,
      data.owner || null,
      data.status || 'active',
      data.tags ? JSON.stringify(data.tags) : null
    ]);

    stmt.free();
    this._save();
  }

  /**
   * Find project by name
   */
  findProject(name) {
    const stmt = this.db.prepare(`
      SELECT * FROM projects
      WHERE LOWER(name) LIKE LOWER(?)
      LIMIT 1
    `);

    stmt.bind([`%${name}%`]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    if (!row) return null;

    return {
      ...row,
      tags: row.tags ? JSON.parse(row.tags) : []
    };
  }

  /**
   * Get all projects
   */
  getAllProjects() {
    const stmt = this.db.prepare('SELECT * FROM projects ORDER BY name');
    const results = [];

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        ...row,
        tags: row.tags ? JSON.parse(row.tags) : []
      });
    }

    stmt.free();
    return results;
  }

  /**
   * Add a task pattern
   */
  addPattern(pattern, template, description) {
    const stmt = this.db.prepare(`
      INSERT INTO task_patterns (pattern, template, description)
      VALUES (?, ?, ?)
    `);

    stmt.run([
      pattern,
      JSON.stringify(template),
      description || null
    ]);

    stmt.free();
    this._save();
  }

  /**
   * Get all context for RAG
   */
  getContextForRAG() {
    const people = this.getAllPeople();
    const projects = this.getAllProjects();

    return {
      people,
      projects,
      summary: this._buildContextSummary(people, projects)
    };
  }

  /**
   * Build a text summary of context for LLM
   */
  _buildContextSummary(people, projects) {
    const lines = ['# Context Information', ''];

    if (people.length > 0) {
      lines.push('## People:');
      for (const person of people) {
        const aliases = person.aliases.length > 0 ? ` (${person.aliases.join(', ')})` : '';
        lines.push(`- ${person.name}${aliases}: ${person.role || 'No role'}`);
        if (person.notes) {
          lines.push(`  Notes: ${person.notes}`);
        }
      }
      lines.push('');
    }

    if (projects.length > 0) {
      lines.push('## Projects:');
      for (const project of projects) {
        lines.push(`- ${project.name}: ${project.description || 'No description'}`);
        if (project.owner) {
          lines.push(`  Owner: ${project.owner}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Close database
   */
  async close() {
    if (this.db) {
      this._save();
      this.db.close();
      console.log('[context-db] Context database closed');
    }
  }
}

module.exports = ContextDatabase;
