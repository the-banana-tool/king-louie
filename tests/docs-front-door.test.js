// tests/docs-front-door.test.js — the deployment guide (fleet stage 4 §3.14)
// names only commands the CLI has.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main } = require('../src/service/cli');

const DOC = path.join(__dirname, '..', 'docs', 'fleet', 'front-door.md');

async function help() {
  let out = '';
  await main(['help'], { stdin: null, stdout: { write: (s) => { out += s; return true; } }, stderr: { write: () => true } });
  return out;
}

describe('docs/fleet/front-door.md', () => {
  it('exists and covers §3.14', () => {
    const text = fs.readFileSync(DOC, 'utf8');
    for (const topic of ['## DNS', '## Firewall', '## Upgrades and the clock', '## Install', '## Bootstrap', '## Re-pinning', '## doctor', 'CAA', 'CAP_NET_BIND_SERVICE', 'chrony', 'rotate-tls-key', 'relay qr']) {
      assert.ok(text.includes(topic), `mentions ${topic}`);
    }
  });

  it('names only commands the CLI lists, with example names only', async () => {
    const text = fs.readFileSync(DOC, 'utf8');
    const usage = await help();
    const shown = [...text.matchAll(/king-louie-service ([a-z-]+)(?: ([a-z-]+))?/g)].map((m) => [m[1], m[2]]);
    assert.ok(shown.length >= 8);
    for (const [command, sub] of shown) {
      assert.ok(usage.includes(`king-louie-service ${command}`), `${command} is a command`);
      if (['frontdoor', 'relay', 'device'].includes(command) && sub) assert.ok(usage.includes(sub), `${command} ${sub} is listed`);
    }
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/, 'no real email addresses');
    for (const host of text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|dev)\b/g) || []) {
      assert.match(host, /(^|\.)example\.com$|letsencrypt\.org$/, `${host} is a placeholder`);
    }
  });
});
