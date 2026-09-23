// `king-louie-service channel` — the headless half of the channel
// configuration surface. Without it a service-mode operator has no way to
// allowlist a sender or name an approval target short of hand-editing an
// encrypted store.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { main, parseArgs } = require('../src/service/cli');

function io(stdinText = '') {
  const out = []; const err = [];
  return {
    out, err,
    stdin: Readable.from([stdinText]),
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) }
  };
}

const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-chan-')); createdTempDirs.push(d); return d; };

const readStore = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8'));

describe('service CLI — channel allowlist', () => {
  it('lists an unconfigured channel as denying everyone', async () => {
    const t = io();
    assert.strictEqual(await main(['channel', 'list', 'telegram', '--data-dir', tmp()], t), 0);
    const text = t.out.join('');
    assert.match(text, /default: deny/);
    assert.match(text, /users:\s*\(none\)/);
    assert.match(text, /approvals: denied/);
  });

  it('allows a user id and shows it in the listing', async () => {
    const dir = tmp();
    const add = io();
    assert.strictEqual(await main(['channel', 'allow', 'telegram', '4242', '--data-dir', dir], add), 0);
    assert.match(add.out.join(''), /4242/);
    assert.deepStrictEqual(readStore(dir).channelAllowlists.telegram.users, ['4242']);

    const list = io();
    assert.strictEqual(await main(['channel', 'list', 'telegram', '--data-dir', dir], list), 0);
    assert.match(list.out.join(''), /4242/);
  });

  it('allows a group id with --group', async () => {
    const dir = tmp();
    assert.strictEqual(await main(['channel', 'allow', 'discord', 'chan-9', '--group', '--data-dir', dir], io()), 0);
    const policy = readStore(dir).channelAllowlists.discord;
    assert.deepStrictEqual(policy.groups, ['chan-9']);
    assert.deepStrictEqual(policy.users, []);
  });

  it('removes an id again', async () => {
    const dir = tmp();
    await main(['channel', 'allow', 'telegram', '4242', '--data-dir', dir], io());
    assert.strictEqual(await main(['channel', 'remove', 'telegram', '4242', '--data-dir', dir], io()), 0);
    assert.deepStrictEqual(readStore(dir).channelAllowlists.telegram.users, []);
  });

  it('never re-opens the channel to everyone', async () => {
    const dir = tmp();
    await main(['channel', 'allow', 'telegram', '4242', '--data-dir', dir], io());
    assert.strictEqual(readStore(dir).channelAllowlists.telegram.default, 'deny');
  });

  it('rejects an unknown channel with exit 2', async () => {
    const t = io();
    assert.strictEqual(await main(['channel', 'list', 'irc', '--data-dir', tmp()], t), 2);
    assert.match(t.err.join(''), /Unknown channel "irc"/);
  });

  it('rejects an unknown subcommand with exit 2', async () => {
    const t = io();
    assert.strictEqual(await main(['channel', 'frobnicate', 'telegram', '--data-dir', tmp()], t), 2);
    assert.match(t.err.join(''), /Usage: king-louie-service channel/);
  });

  it('rejects allow with no id with exit 2, writing nothing', async () => {
    const dir = tmp();
    const t = io();
    assert.strictEqual(await main(['channel', 'allow', 'telegram', '--data-dir', dir], t), 2);
    assert.match(t.err.join(''), /Usage: king-louie-service channel/);
    assert.ok(!fs.existsSync(path.join(dir, 'chat-data.json')), 'nothing written');
  });
});

describe('service CLI — channel approval target', () => {
  it('sets the approval target the bridges read', async () => {
    const dir = tmp();
    const t = io();
    assert.strictEqual(await main(['channel', 'approval', 'telegram', '555', '--data-dir', dir], t), 0);
    assert.strictEqual(readStore(dir).settings.channels.telegram.approvalChatId, '555');
    assert.match(t.out.join(''), /555/);
  });

  it('clears the approval target with --clear, which denies approvals again', async () => {
    const dir = tmp();
    await main(['channel', 'approval', 'telegram', '555', '--data-dir', dir], io());
    const t = io();
    assert.strictEqual(await main(['channel', 'approval', 'telegram', '--clear', '--data-dir', dir], t), 0);
    assert.strictEqual(readStore(dir).settings.channels.telegram.approvalChatId, '');
    assert.match(t.out.join(''), /denied/i);
  });

  it('refuses approval with neither an id nor --clear', async () => {
    const t = io();
    assert.strictEqual(await main(['channel', 'approval', 'telegram', '--data-dir', tmp()], t), 2);
    assert.match(t.err.join(''), /Usage: king-louie-service channel/);
  });

  it('reports the approval target in the listing', async () => {
    const dir = tmp();
    await main(['channel', 'approval', 'discord', 'owner-chan', '--data-dir', dir], io());
    const t = io();
    await main(['channel', 'list', 'discord', '--data-dir', dir], t);
    assert.match(t.out.join(''), /approvals: owner-chan/);
  });
});

describe('service CLI — channel against a live service', () => {
  it('refuses a mutation with exit 1 while the service is running on that data dir', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));
    for (const argv of [
      ['channel', 'allow', 'telegram', '1'],
      ['channel', 'remove', 'telegram', '1'],
      ['channel', 'approval', 'telegram', '2']
    ]) {
      const t = io();
      assert.strictEqual(await main([...argv, '--data-dir', dir], t), 1, argv.join(' '));
      assert.match(t.err.join(''), new RegExp(`running \\(pid ${process.pid}\\).*Stop it first`));
    }
    assert.ok(!fs.existsSync(path.join(dir, 'chat-data.json')), 'nothing written');
  });

  it('still allows the read-only listing while the service is running', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));
    const t = io();
    assert.strictEqual(await main(['channel', 'list', 'telegram', '--data-dir', dir], t), 0);
    assert.match(t.out.join(''), /default: deny/);
  });
});

describe('service CLI — channel help and flags', () => {
  it('lists the channel subcommand in help', async () => {
    const t = io();
    assert.strictEqual(await main(['help'], t), 0);
    assert.match(t.out.join(''), /king-louie-service channel list/);
  });

  it('parses --group and --clear as boolean flags', () => {
    const { positional, flags } = parseArgs(['channel', 'allow', 'discord', 'c-1', '--group']);
    assert.deepStrictEqual(positional, ['channel', 'allow', 'discord', 'c-1']);
    assert.strictEqual(flags.group, true);
    assert.strictEqual(parseArgs(['channel', 'approval', 'telegram', '--clear']).flags.clear, true);
  });

  it('rejects --group given a value, since it is a boolean flag', () => {
    assert.throws(() => parseArgs(['channel', 'allow', 'telegram', '1', '--group=true']), /--group.*value/);
    assert.throws(() => parseArgs(['channel', 'approval', 'telegram', '--clear=yes']), /--clear.*value/);
  });

  it('still rejects an unknown flag on the channel command', async () => {
    const t = io();
    assert.strictEqual(await main(['channel', 'list', 'telegram', '--verbose'], t), 2);
    assert.match(t.err.join(''), /Unknown flag.*--verbose/);
  });
});
