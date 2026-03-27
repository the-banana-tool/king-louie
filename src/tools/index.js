const { registry: toolRegistry } = require('./tool-registry');

const BashTool = require('./builtin/bash-tool');
const ReadTool = require('./builtin/read-tool');
const EditTool = require('./builtin/edit-tool');
const WriteTool = require('./builtin/write-tool');
const GrepTool = require('./builtin/grep-tool');
const WebSearchTool = require('./builtin/web-search-tool');
const WebFetchTool = require('./builtin/web-fetch-tool');
const GlobTool = require('./builtin/glob-tool');
const GitTool = require('./builtin/git-tool');
const SkillTool = require('./builtin/skill-tool');
const AskUserTool = require('./builtin/ask-user-tool');
const CronTool = require('./builtin/cron-tool');
const BrowserTool = require('./builtin/browser-tool');
const RemoteDispatchTool = require('./builtin/remote-dispatch-tool');

let initialized = false;

function initializeTools() {
  if (initialized) return;

  toolRegistry.register(BashTool);
  toolRegistry.register(ReadTool);
  toolRegistry.register(EditTool);
  toolRegistry.register(WriteTool);
  toolRegistry.register(GrepTool);
  toolRegistry.register(WebSearchTool);
  toolRegistry.register(WebFetchTool);
  toolRegistry.register(GlobTool);
  toolRegistry.register(GitTool);
  toolRegistry.register(SkillTool);
  toolRegistry.register(AskUserTool);
  toolRegistry.register(CronTool);
  toolRegistry.register(BrowserTool);
  toolRegistry.register(RemoteDispatchTool);

  initialized = true;
}

module.exports = {
  toolRegistry,
  initializeTools
};
