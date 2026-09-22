const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { attachServiceLogFile } = require('../src/service/log-file');
const { createLogger } = require('../src/logging');

const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-log-')); created.push(d); return d; };

describe('service log file', () => {
  it('appends every log record to <logsDir>/service.log until closed', () => {
    const logsDir = tmp();
    fs.writeFileSync(path.join(logsDir, 'service.log'), 'earlier run\n');
    const sink = attachServiceLogFile(logsDir);
    const log = createLogger('svc-test');
    log.warn('disk nearly full', { freeMb: 12 });
    sink.close();
    log.warn('after close');
    sink.close(); // idempotent
    const text = fs.readFileSync(sink.file, 'utf8');
    assert.ok(text.startsWith('earlier run\n'), 'appends, never truncates');
    assert.match(text, /^\d{4}-\d{2}-\d{2}T\S+ WARN \[svc-test\] disk nearly full \{freeMb=12\}$/m);
    assert.ok(!text.includes('after close'));
  });

  it('creates the file private (0600) on POSIX', { skip: process.platform === 'win32' }, () => {
    const logsDir = tmp();
    const sink = attachServiceLogFile(logsDir);
    sink.close();
    assert.strictEqual(fs.statSync(path.join(logsDir, 'service.log')).mode & 0o777, 0o600);
  });
});
