const { registry: toolRegistry } = require('./tool-registry');

const BashTool = require('./builtin/bash-tool');
const ReadTool = require('./builtin/read-tool');
const EditTool = require('./builtin/edit-tool');
const WriteTool = require('./builtin/write-tool');
const WebFetchTool = require('./builtin/web-fetch-tool');

let initialized = false;

function initializeTools() {
  if (initialized) return;

  toolRegistry.register(BashTool);
  toolRegistry.register(ReadTool);
  toolRegistry.register(EditTool);
  toolRegistry.register(WriteTool);
  toolRegistry.register(WebFetchTool);

  initialized = true;
}

module.exports = {
  toolRegistry,
  initializeTools
};
