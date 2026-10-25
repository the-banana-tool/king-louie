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

const DOC = path.join(__dirname, '..', 'docs', 'driving-king-louie.md');
const read = () => fs.readFileSync(DOC, 'utf8');
const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));
// A backticked snake_case word with one of these prefixes reads as an MCP
// tool name, so it must be one.
const TOOL_PREFIXES = /^(list|describe|get|run|send|cancel)_[a-z_]+$/;

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
      if (TOOL_PREFIXES.test(word)) assert.ok(TOOL_NAMES.has(word), `${word} is an MCP tool`);
      if (word.startsWith('wait_for')) assert.ok(browserPageTool.parameters.properties.action.enum.includes(word), `${word} is a BrowserPage action`);
    }
    assert.ok(words.has('wait_for') && words.has('wait_for_url'), 'names the browser waits that exist');
    assert.ok(!words.has('wait_for_text'), 'wait_for_text arrives with D1, not yet');
  });

  it('quotes the refusals as the code words them', () => {
    // Markdown wraps a long sentence across lines; compare it as one line.
    const text = read().replace(/\s+/g, ' ');
    for (const code of ['node_busy', 'node_restarted', 'job_not_found']) assert.ok(text.includes(`\`${code}\``), `names ${code}`);
    assert.ok(text.includes(REFUSE_UNSAFE_MESSAGE), 'quotes REFUSE_UNSAFE_MESSAGE');
    const timeout = mapApprovalResult('timeout', {}, { timeoutMs: 1000 }).refusal.error.replace('1s', '<N>s');
    assert.ok(text.includes(timeout), 'quotes the approval timeout');
  });

  it('marks what is not there yet', () => {
    const text = read();
    assert.match(text, /from D1 part C/);
    assert.match(text, /arrives with D1 part D/);
  });
});
