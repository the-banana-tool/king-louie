# King Louie

A cross-platform Electron desktop chat application with a modern two-pane interface.

## Features

- **Two-Pane Layout**: Chat history sidebar (left 1/4) and main chat area (right 3/4)
- **Modern UI**: Clean, responsive design similar to ChatGPT, Claude, and Slack
- **Cross-Platform**: Works on Windows, macOS, and Linux
- **Secure**: Built with Electron's security best practices (context isolation, no node integration in renderer)

## Installation

1. Install dependencies:
```bash
npm install
```

## Running the Application

Start the Electron app:
```bash
npm start
```

## Project Structure

- `main.js` - Main Electron process
- `preload.js` - Preload script for secure IPC communication
- `index.html` - Main HTML structure with two-pane layout
- `styles.css` - Styling for the chat interface
- `renderer.js` - Frontend JavaScript for handling user interactions

## Development

The application includes:
- Chat history sidebar with sample conversations
- Main chat area with message display
- User input box at the bottom
- New chat functionality
- Auto-scrolling messages
- Responsive textarea that grows with content

## Future Enhancements

- Connect to real chat backend/API
- Persist chat history to local storage or database
- Add user authentication
- Implement real-time messaging
- Add file upload capabilities
- Support for markdown rendering
- Search functionality in chat history

## Agent Orchestration (Phase 3)

The app now includes core orchestration infrastructure in the main process:

- Task manager with status/dependency lifecycle (`task:create`, `task:list`, `task:update` IPC)
- Built-in agents (`main`, `code-explorer`, `code-writer`) with tool allow-lists
- Parallel and serial multi-agent execution (`agent:executeParallel`, `agent:executeSerial` IPC)
- Gateway + session orchestration foundation (`gateway:status`, `sessions:list`, `sessions:history` IPC)
- Messaging tools for agent-to-agent/session workflows (`message`, `sessions_list`, `sessions_history`, `sessions_spawn`)

The renderer API exposure for these capabilities is available in `preload.js` under:
`window.electron.task`, `window.electron.agent`, and `window.electron.orchestration`.

## Telegram Bot Bridge

King Louie now supports an optional Telegram bridge that routes Telegram chats into the existing gateway/session/agent pipeline.

### Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather)
2. Copy your bot token
3. In chat, configure the token using local commands:

```bash
/llm telegram add <token>
/llm telegram test
/llm telegram status
```

The token is saved securely (same storage path used for provider tokens) and the bridge starts automatically when configured.

To remove it later:

```bash
/llm telegram remove
```

### Supported Commands

- `/help` — bridge help and available agents
- `/status` — gateway/session status snapshot
- `/clear` — clear current Telegram chat session history
- `/agent <name>` — switch agent for current Telegram chat

### Behavior

- One Telegram chat maps to one King Louie session (`agent:<id>:telegram:<chatId>`)
- Messages are sent through the existing gateway (`agent:message` / `agent:response` events)
- Tool approvals can be handled in Telegram via inline approve/deny buttons