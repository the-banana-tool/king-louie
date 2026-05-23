const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createLogger, setLogLevel, getLogLevel, setSubsystemFilter } = require('../src/logging');

describe('logging', () => {
  let captured;
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origDebug = console.debug;

  beforeEach(() => {
    captured = [];
    console.log = (...args) => captured.push({ method: 'log', args });
    console.warn = (...args) => captured.push({ method: 'warn', args });
    console.error = (...args) => captured.push({ method: 'error', args });
    console.debug = (...args) => captured.push({ method: 'debug', args });
    setLogLevel('trace');
    setSubsystemFilter(null);
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    console.debug = origDebug;
    setLogLevel('info');
    setSubsystemFilter(null);
  });

  it('logs with subsystem prefix', () => {
    const log = createLogger('mesh');
    log.info('peer connected');
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].method, 'log');
    assert.strictEqual(captured[0].args[0], '[mesh]');
    assert.strictEqual(captured[0].args[1], 'peer connected');
  });

  it('routes levels to correct console methods', () => {
    const log = createLogger('test');
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    assert.deepStrictEqual(captured.map(c => c.method), [
      'debug', 'debug', 'log', 'warn', 'error', 'error',
    ]);
  });

  it('filters by log level', () => {
    setLogLevel('warn');
    const log = createLogger('test');
    log.debug('hidden');
    log.info('hidden');
    log.warn('shown');
    log.error('shown');
    assert.strictEqual(captured.length, 2);
  });

  it('appends metadata', () => {
    const log = createLogger('chat');
    log.info('message sent', { channelId: 'c-1', userId: 'u-2' });
    assert.strictEqual(captured.length, 1);
    assert.ok(captured[0].args[1].includes('channelId=c-1'));
    assert.ok(captured[0].args[1].includes('userId=u-2'));
  });

  it('creates child loggers with hierarchical names', () => {
    const log = createLogger('mesh');
    const child = log.child('discovery');
    child.info('found peer');
    assert.strictEqual(captured[0].args[0], '[mesh/discovery]');
  });

  it('child of child nests names', () => {
    const log = createLogger('channels').child('slack').child('webhooks');
    log.warn('rate limited');
    assert.strictEqual(captured[0].args[0], '[channels/slack/webhooks]');
  });

  it('isEnabled reflects current log level', () => {
    setLogLevel('warn');
    const log = createLogger('test');
    assert.strictEqual(log.isEnabled('debug'), false);
    assert.strictEqual(log.isEnabled('info'), false);
    assert.strictEqual(log.isEnabled('warn'), true);
    assert.strictEqual(log.isEnabled('error'), true);
  });

  it('withContext binds metadata to all subsequent calls', () => {
    const log = createLogger('agent-loop');
    const bound = log.withContext({ sessionId: 's-123' });
    bound.info('iteration started');
    bound.warn('tool failed', { toolName: 'bash' });
    assert.ok(captured[0].args[1].includes('sessionId=s-123'));
    assert.ok(captured[1].args[1].includes('sessionId=s-123'));
    assert.ok(captured[1].args[1].includes('toolName=bash'));
  });

  it('withContext child inherits bound metadata', () => {
    const log = createLogger('gateway').withContext({ reqId: 'r-1' });
    const child = log.child('sessions');
    child.info('created');
    assert.strictEqual(captured[0].args[0], '[gateway/sessions]');
    assert.ok(captured[0].args[1].includes('reqId=r-1'));
  });

  it('subsystem filter restricts output', () => {
    setSubsystemFilter(['mesh', 'cron']);
    const meshLog = createLogger('mesh');
    const cronLog = createLogger('cron');
    const chatLog = createLogger('chat');
    meshLog.info('ok');
    cronLog.info('ok');
    chatLog.info('should be hidden');
    assert.strictEqual(captured.length, 2);
  });

  it('subsystem filter includes child loggers', () => {
    setSubsystemFilter(['mesh']);
    const child = createLogger('mesh').child('discovery');
    child.info('found peer');
    assert.strictEqual(captured.length, 1);
  });

  it('setLogLevel rejects unknown levels', () => {
    assert.throws(() => setLogLevel('verbose'), /Unknown log level/);
  });

  it('getLogLevel returns current level name', () => {
    setLogLevel('debug');
    assert.strictEqual(getLogLevel(), 'debug');
    setLogLevel('error');
    assert.strictEqual(getLogLevel(), 'error');
  });

  it('JSON-stringifies non-string metadata values', () => {
    const log = createLogger('test');
    log.info('data', { count: 42, tags: ['a', 'b'] });
    assert.ok(captured[0].args[1].includes('count=42'));
    assert.ok(captured[0].args[1].includes('tags=["a","b"]'));
  });

  it('skips metadata suffix when meta is empty', () => {
    const log = createLogger('test');
    log.info('clean message', {});
    assert.strictEqual(captured[0].args.length, 2);
    assert.strictEqual(captured[0].args[1], 'clean message');
  });
});
