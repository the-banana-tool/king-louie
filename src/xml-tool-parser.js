/**
 * XML tool-call extraction for non-agent-mode LLM responses.
 *
 * When the LLM outputs tool calls as XML tags in plain text
 * (e.g. <bash>ls -la</bash>), these helpers extract them so
 * the renderer can display compact tool pills instead of raw markup.
 */

/**
 * Known tool names the LLM might emit as XML tags.
 * Case-insensitive lookup map: lowercase tag → canonical tool name.
 */
const XML_TOOL_NAMES = {
  bash: 'Bash', powershell: 'Bash', shell: 'Bash', terminal: 'Bash', cmd: 'Bash',
  read: 'Read', write: 'Write', edit: 'Edit',
  grep: 'Grep', glob: 'Glob', git: 'Git',
  webfetch: 'WebFetch', fetch: 'WebFetch',
  websearch: 'WebSearch', search: 'WebSearch',
  browser: 'Browser', askuser: 'AskUser', cron: 'Cron', skill: 'Skill'
};

/**
 * Regex that matches complete XML tool blocks: <toolName>...content...</toolName>
 * Captures: (1) tag name, (2) inner content.
 */
const XML_TOOL_TAG_NAMES = Object.keys(XML_TOOL_NAMES).join('|');
const XML_TOOL_BLOCK_RE = new RegExp(
  `<(${XML_TOOL_TAG_NAMES})>([\\s\\S]*?)<\\/\\1>`,
  'gi'
);

/**
 * Detect whether text still has an unclosed XML tool tag at the end
 * (i.e. the LLM is still streaming content inside a tool block).
 */
const XML_TOOL_OPEN_RE = new RegExp(
  `<(${XML_TOOL_TAG_NAMES})>([\\s\\S]*)$`,
  'i'
);

/**
 * Parse completed XML tool blocks from text.
 * Returns { cleanText, toolBlocks: [{ toolName, content }] }.
 */
function extractXmlToolBlocks(text) {
  const toolBlocks = [];
  // Reset lastIndex since regex has 'g' flag
  XML_TOOL_BLOCK_RE.lastIndex = 0;
  const cleanText = text.replace(XML_TOOL_BLOCK_RE, (match, tagName, content) => {
    const canonical = XML_TOOL_NAMES[tagName.toLowerCase()] || tagName;
    toolBlocks.push({ toolName: canonical, content: content.trim() });
    return '';
  });
  return { cleanText: cleanText.trim(), toolBlocks };
}

/**
 * Strip any trailing unclosed tool tag from display text so we don't render
 * partial XML while the LLM is still streaming inside a tool block.
 */
function stripTrailingOpenToolTag(text) {
  return text.replace(XML_TOOL_OPEN_RE, '').trim();
}

module.exports = {
  XML_TOOL_NAMES,
  XML_TOOL_BLOCK_RE,
  XML_TOOL_OPEN_RE,
  extractXmlToolBlocks,
  stripTrailingOpenToolTag
};
