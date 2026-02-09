# King Louie STD Skill

A powerful task management skill for King Louie that helps you manage your STDs (tasks) via Telegram or the UI.

## Features

- **Full CRUD Operations**: Add, list, update, complete, and delete tasks
- **Advanced Filtering**: Filter by status, priority, tags, due date
- **Search**: Full-text search across task titles and details
- **Reminders**: Set reminders for tasks
- **Recurring Tasks**: Create tasks that repeat on a schedule
- **Bulk Operations**: Update or delete multiple tasks at once
- **Export**: Export tasks to JSON format
- **Sync Ready**: Prepared for Phase 2 API sync with sethserver.com

## Installation

### Prerequisites

- King Louie must be installed at `E:\Programming\king-louie` (or as a sibling directory)
- Node.js installed

### Development Install (Recommended for Development)

Creates a symbolic link so changes are reflected immediately:

```bash
cd E:\Programming\king-louie-std-skill
npm run install:dev
```

### Production Install

Copies files to King Louie's skills directory:

```bash
cd E:\Programming\king-louie-std-skill
npm run install:prod
```

### Uninstall

```bash
cd E:\Programming\king-louie-std-skill
npm run uninstall
```

### Verify Installation

1. Restart King Louie
2. In Telegram or UI, type: `/help`
3. You should see the STD skill listed
4. Try: `/std help`

## Usage

### Add a Task

```
/std add "Task title" --details "Task details" --priority high --due 2024-12-31
```

### List Tasks

```
/std list
/std list --status pending
/std list --priority high
```

### Update a Task

```
/std update 5 title "New title"
/std update 5 priority high
/std update 5 status completed
```

### Complete a Task

```
/std complete 5
```

### Delete a Task

```
/std delete 5
```

### Filter Tasks

```
/std filter status:pending priority:high
/std filter tag:work due:today
```

### Search Tasks

```
/std search "meeting"
```

### Set Reminder

```
/std remind 5 2024-12-25T09:00:00
```

### Make Recurring

```
/std recurring 5 daily
/std recurring 5 weekly
/std recurring 5 "every 2 weeks"
```

### Export Tasks

```
/std export
```

## Task Fields

Each STD task contains:

- **id**: Unique task identifier
- **title**: Task title
- **details**: Detailed description
- **dueDate**: Due date (ISO 8601)
- **priority**: low, medium, high, critical
- **status**: pending, in-progress, completed, archived
- **tags**: Array of tags (JSON)
- **isRecurring**: Boolean flag
- **recurringPattern**: Recurrence pattern (daily, weekly, etc.)
- **reminderTime**: Reminder date/time (ISO 8601)
- **attachments**: Array of attachments (JSON)
- **customFields**: Custom key-value pairs (JSON)
- **createdAt**: Creation timestamp
- **updatedAt**: Last update timestamp

## Development

```bash
cd E:\Programming\king-louie-std-skill
npm install
```

### Project Structure

```
king-louie-std-skill/
├── package.json
├── README.md
├── index.js              # Main skill entry point
├── database/
│   ├── std-db.js        # SQLite database operations
│   └── schema.sql       # Database schema
├── commands/
│   ├── router.js        # Command router
│   ├── add.js          # Add command
│   ├── list.js         # List command
│   ├── update.js       # Update command
│   ├── complete.js     # Complete command
│   ├── delete.js       # Delete command
│   ├── filter.js       # Filter command
│   ├── search.js       # Search command
│   ├── sort.js         # Sort command
│   ├── archive.js      # Archive command
│   ├── remind.js       # Reminder command
│   ├── recurring.js    # Recurring command
│   └── export.js       # Export command
└── utils/
    ├── parser.js       # Argument parser
    └── formatter.js    # Output formatter
```

## Phase 2: API Sync

The STD skill is designed to sync with your sethserver.com API. API sync will be implemented in Phase 2 with:

- Automatic background sync
- Conflict resolution
- Offline support
- Real-time updates

## License

ISC
