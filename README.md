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