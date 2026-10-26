const { describe, it } = require('node:test');
const assert = require('node:assert');
const { checkPersonalOwner, assertPersonalOwner } = require('../src/service/personal-host');

const ME = 'S-1-5-21-1-2-3-1001';
const DATA = 'D:\\n\\data';
const CONFIG = 'D:\\n\\config';

const inspect = (me, owners, links = {}) => (paths) => ({
  me,
  entries: paths.map((p) => (owners[p] === undefined ? null : { owner: owners[p], link: Boolean(links[p]) }))
});

describe('personal-node owner check', () => {
  it('passes when both dirs are owned by the process account (win32)', () => {
    const r = checkPersonalOwner({ dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: inspect(ME, { [DATA]: ME, [CONFIG]: ME }) });
    assert.deepEqual(r, { ok: true, me: ME, owners: { dataDir: ME, configDir: ME }, problem: null });
    assert.doesNotThrow(() => assertPersonalOwner({ dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: inspect(ME, { [DATA]: ME, [CONFIG]: ME }) }));
  });

  it('asks the inspector about the data dir and then the config dir', () => {
    let asked = null;
    checkPersonalOwner({ dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: (paths) => { asked = paths; return inspect(ME, { [DATA]: ME, [CONFIG]: ME })(paths); } });
    assert.deepEqual(asked, [DATA, CONFIG]);
  });

  it('refuses an Administrators-owned config dir (a fleet layout), naming both', () => {
    const options = { dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: inspect(ME, { [DATA]: ME, [CONFIG]: 'S-1-5-32-544' }) };
    const r = checkPersonalOwner(options);
    assert.strictEqual(r.ok, false);
    assert.deepEqual(r.owners, { dataDir: ME, configDir: 'S-1-5-32-544' });
    assert.throws(() => assertPersonalOwner(options), (e) => e.code === 'PERSONAL_NOT_OWNER'
      && e.message === `Refusing to start: hosting is personal but ${CONFIG} is owned by S-1-5-32-544, not this account (${ME})`);
  });

  it('refuses a data dir owned by another account', () => {
    const options = { dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: inspect(ME, { [DATA]: 'S-1-5-21-1-2-3-1002', [CONFIG]: ME }) };
    assert.throws(() => assertPersonalOwner(options), (e) => e.code === 'PERSONAL_NOT_OWNER'
      && e.message.includes(`${DATA} is owned by S-1-5-21-1-2-3-1002, not this account (${ME})`));
  });

  it('refuses a link', () => {
    const options = { dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: inspect(ME, { [DATA]: ME, [CONFIG]: ME }, { [DATA]: true }) };
    const r = checkPersonalOwner(options);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problem, `${DATA} is a link`);
    assert.throws(() => assertPersonalOwner(options), (e) => e.code === 'PERSONAL_NOT_OWNER'
      && e.message === `Refusing to start: hosting is personal but ${DATA} is a link`);
  });

  it('refuses when the owner cannot be read', () => {
    const options = { dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: inspect(ME, { [DATA]: ME }) };
    const r = checkPersonalOwner(options);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.owners.configDir, null);
    assert.ok(r.problem.includes(CONFIG), r.problem);
    assert.throws(() => assertPersonalOwner(options), (e) => e.code === 'PERSONAL_NOT_OWNER' && e.message.includes(CONFIG));
  });

  it('refuses when the inspector reports no owner', () => {
    const r = checkPersonalOwner({ dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: inspect(ME, { [DATA]: '(none)', [CONFIG]: ME }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.owners.dataDir, null);
    assert.ok(r.problem.includes(DATA), r.problem);
  });

  it('refuses when the inspector itself fails', () => {
    const r = checkPersonalOwner({ dataDir: DATA, configDir: CONFIG, platform: 'win32', inspectOwners: () => { throw new Error('powershell failed'); } });
    assert.strictEqual(r.ok, false);
    assert.deepEqual(r.owners, { dataDir: null, configDir: null });
    assert.ok(r.problem.includes(DATA), r.problem);
  });

  it('POSIX: compares uids', () => {
    const r = checkPersonalOwner({ dataDir: '/n/data', configDir: '/n/config', platform: 'linux', geteuid: () => 1000, statSync: () => ({ uid: 1000 }), lstatSync: () => ({ isSymbolicLink: () => false }) });
    assert.deepEqual(r, { ok: true, me: '1000', owners: { dataDir: '1000', configDir: '1000' }, problem: null });
  });

  it('POSIX: refuses a dir owned by root', () => {
    const uids = { '/n/data': 1000, '/n/config': 0 };
    const options = { dataDir: '/n/data', configDir: '/n/config', platform: 'linux', geteuid: () => 1000, statSync: (p) => ({ uid: uids[p] }), lstatSync: () => ({ isSymbolicLink: () => false }) };
    assert.throws(() => assertPersonalOwner(options), (e) => e.code === 'PERSONAL_NOT_OWNER'
      && e.message === 'Refusing to start: hosting is personal but /n/config is owned by 0, not this account (1000)');
  });

  it('POSIX: refuses a symlink', () => {
    const r = checkPersonalOwner({ dataDir: '/n/data', configDir: '/n/config', platform: 'linux', geteuid: () => 1000, statSync: () => ({ uid: 1000 }), lstatSync: (p) => ({ isSymbolicLink: () => p === '/n/config' }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problem, '/n/config is a link');
  });

  it('POSIX: refuses a dir that cannot be read', () => {
    const r = checkPersonalOwner({ dataDir: '/n/data', configDir: '/n/config', platform: 'linux', geteuid: () => 1000,
      statSync: () => ({ uid: 1000 }),
      lstatSync: (p) => { if (p === '/n/data') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { isSymbolicLink: () => false }; } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.owners.dataDir, null);
    assert.ok(r.problem.includes('/n/data'), r.problem);
  });
});
