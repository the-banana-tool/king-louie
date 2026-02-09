-- STD Tasks Database Schema

CREATE TABLE IF NOT EXISTS stds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  details TEXT,
  dueDate TEXT,  -- ISO 8601 format
  priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in-progress', 'completed', 'archived')),
  tags TEXT,  -- JSON array
  isRecurring INTEGER DEFAULT 0,  -- Boolean (0 or 1)
  recurringPattern TEXT,  -- e.g., 'daily', 'weekly', 'monthly'
  reminderTime TEXT,  -- ISO 8601 format
  attachments TEXT,  -- JSON array
  customFields TEXT,  -- JSON object
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_stds_status ON stds(status);
CREATE INDEX IF NOT EXISTS idx_stds_priority ON stds(priority);
CREATE INDEX IF NOT EXISTS idx_stds_dueDate ON stds(dueDate);
CREATE INDEX IF NOT EXISTS idx_stds_createdAt ON stds(createdAt);

-- Trigger to update updatedAt timestamp
CREATE TRIGGER IF NOT EXISTS update_stds_timestamp
AFTER UPDATE ON stds
FOR EACH ROW
BEGIN
  UPDATE stds SET updatedAt = datetime('now') WHERE id = NEW.id;
END;
