// tests/docs-driving.test.js — the driver's guide (agent-driven demo takes
// D1, spec §11 and §12) keeps its sections and names only commands, tools
// and refusals the code has.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main } = require('../src/service/cli');
const { MCP_TOOLS } = require('../src/fleet/tool-definitions');
const browserPageTool = require('../src/tools/builtin/browser-page-tool');
const { mapApprovalResult } = require('../src/execution/tool-executor');
const { REFUSE_UNSAFE_MESSAGE } = require('../src/approvals/executor-options');
const { TAKE_CODES } = require('../src/gui/take-policy');
const { TAKE_ACTIONS } = require('../src/gui/take-tool');
const { STEP_KINDS } = require('../src/gui/take-steps');
const { parseGuiConfig } = require('../src/gui/config');
const { GUI_ERROR_CODES } = require('../src/gui/errors');
const { parseYaml } = require('../src/platform/yaml');
const { WAIT_MS_MAX } = require('../src/fleet/tool-definitions');

const DOC = path.join(__dirname, '..', 'docs', 'driving-king-louie.md');
const read = () => fs.readFileSync(DOC, 'utf8');
const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));
// A backticked snake_case word with one of these prefixes reads as an MCP
// tool name, so it must be one.
const TOOL_PREFIXES = /^(list|describe|get|run|send|cancel)_[a-z_]+$/;

// The text of one "## N. <title>" section, up to the next one.
function section(title) {
  const lines = read().split(/\r?\n/);
  const start = lines.findIndex((l) => /^## \d+\. /.test(l) && l.replace(/^## \d+\. /, '') === title);
  assert.ok(start >= 0, `the guide has a section "${title}"`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n');
}

// A fenced block inside a list item is indented with it: strip the common indent.
function dedent(block) {
  const lines = block.split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

async function help() {
  let out = '';
  await main(['help'], { stdin: null, stdout: { write: (s) => { out += s; return true; } }, stderr: { write: () => true } });
  return out;
}

describe('docs/driving-king-louie.md', () => {
  it('has the five sections in order', () => {
    const heads = read().split(/\r?\n/).filter((l) => l.startsWith('## ')).map((l) => l.replace(/^## \d+\. /, ''));
    assert.deepEqual(heads, ['What King Louie offers a driver', 'Setting up the desktop', 'Driving a session', 'Recording a take', 'What refuses, and why']);
  });

  it('names only real service commands', async () => {
    const text = read();
    const usage = await help();
    const shown = [...text.matchAll(/king-louie-service ([a-z-]+)(?: ([a-z-]+))?/g)].map((m) => [m[1], m[2]]);
    assert.ok(shown.length >= 6, 'the setup names its commands');
    for (const [command, sub] of shown) {
      assert.ok(usage.includes(`king-louie-service ${command}`), `${command} is a command`);
      if (['session', 'identity', 'desktop', 'device'].includes(command) && sub) {
        assert.ok(usage.includes(`king-louie-service ${command} ${sub}`) || usage.includes(`${sub}|`) || usage.includes(`|${sub}`), `${command} ${sub} is listed`);
      }
    }
  });

  it('names only real MCP tools and browser actions', () => {
    const text = read();
    const words = new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]));
    for (const name of ['delegate', 'send_to_job', 'get_job', 'get_job_logs', 'cancel_job', 'list_machines']) {
      assert.ok(TOOL_NAMES.has(name), `${name} is an MCP tool`);
      assert.ok(text.includes(`\`${name}\``), `the guide names ${name}`);
    }
    for (const word of words) {
      // Take's own actions (run_steps) read like tool names and are not MCP tools.
      if (TOOL_PREFIXES.test(word) && !TAKE_ACTIONS.includes(word)) assert.ok(TOOL_NAMES.has(word), `${word} is an MCP tool`);
      if (word.startsWith('wait_for')) {
        assert.ok(browserPageTool.parameters.properties.action.enum.includes(word) || STEP_KINDS.includes(word), `${word} is a BrowserPage action or a step`);
      }
    }
    assert.ok(words.has('wait_for') && words.has('wait_for_url') && words.has('wait_for_text'), 'names the waits that exist');
  });

  it('quotes the refusals as the code words them', () => {
    // Markdown wraps a long sentence across lines; compare it as one line.
    const text = read().replace(/\s+/g, ' ');
    for (const code of ['node_busy', 'node_restarted', 'job_not_found']) assert.ok(text.includes(`\`${code}\``), `names ${code}`);
    assert.ok(text.includes(REFUSE_UNSAFE_MESSAGE), 'quotes REFUSE_UNSAFE_MESSAGE');
    const timeout = mapApprovalResult('timeout', {}, { timeoutMs: 1000 }).refusal.error.replace('1s', '<N>s');
    assert.ok(text.includes(timeout), 'quotes the approval timeout');
  });

  it('no longer marks the take as not there yet', () => {
    assert.doesNotMatch(read(), /D1 part [A-D]/);
  });

  it('gives node.yaml lines for takes that node.yaml accepts', () => {
    const blocks = [...section('Setting up the desktop').matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => parseYaml(dedent(m[1])));
    const yaml = blocks.find((y) => y && y.gui);
    assert.ok(yaml, 'section 2 has a node.yaml block with gui');
    const gui = parseGuiConfig(yaml.gui, { profile: 'agent', platform: 'win32' });
    assert.equal(gui.enabled, true);
    assert.equal(gui.take.enabled, true);
    assert.equal(gui.take.maxMinutes, 240);
    assert.equal(gui.browser, 'chrome');
    assert.ok(gui.apps.chrome, 'the browser is one of gui.apps');
  });

  it('describes the take as the Take tool has it', () => {
    const take = section('Recording a take');
    for (const name of ['Take', 'start', 'run_steps', 'stop', 'wait_ms']) assert.ok(take.includes(`\`${name}\``), `section 4 names ${name}`);
    for (const action of TAKE_ACTIONS) assert.ok(take.includes(`\`${action}\``), `section 4 names the ${action} action`);
    for (const step of STEP_KINDS) assert.ok(take.includes(`\`${step}\``), `section 4 names the ${step} step`);
    assert.ok(take.replace(/[\s,]/g, '').includes(String(WAIT_MS_MAX)), 'section 4 gives the wait cap');
    assert.match(take, /STUCK at step N/);
    assert.match(take, /30 minutes/);
  });

  it('lists every take code in section 5', () => {
    const refuses = section('What refuses, and why');
    for (const code of TAKE_CODES) assert.ok(refuses.includes(`\`${code}\``), `section 5 names ${code}`);
    // And nothing take-looking that is not a real code.
    for (const [, word] of refuses.matchAll(/`((?:take|recorder|browser)_[a-z_]+)`/g)) {
      assert.ok(TAKE_CODES.includes(word) || GUI_ERROR_CODES.includes(word), `${word} is a real code`);
    }
  });
});
