// tests/platform-paths.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { defaultServiceDataDir, personalDataDir, fleetDataDir, desktopProfileDirs } = require('../src/platform/paths');

const env = { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\U\\a\\AppData\\Local', HOME: '/home/a' };

describe('personalDataDir', () => {
  it('win32: under LOCALAPPDATA', () => {
    assert.equal(personalDataDir({ platform: 'win32', env }), 'C:\\U\\a\\AppData\\Local\\KingLouie\\node\\data');
  });
  it('darwin: under Application Support', () => {
    assert.equal(personalDataDir({ platform: 'darwin', env: { HOME: '/Users/a' } }), '/Users/a/Library/Application Support/KingLouie/node/data');
  });
  it('linux: under ~/.local/share', () => {
    assert.equal(personalDataDir({ platform: 'linux', env: { HOME: '/home/a' } }), '/home/a/.local/share/king-louie/node/data');
  });
});

describe('defaultServiceDataDir falls back to the personal node', () => {
  const FLEET = 'C:\\ProgramData\\KingLouie\\data';
  const FLEET_YAML = 'C:\\ProgramData\\KingLouie\\config\\node.yaml';
  const PERSONAL = 'C:\\U\\a\\AppData\\Local\\KingLouie\\node\\data';
  it('win32: the fleet dir when its node.yaml exists', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env, exists: (p) => p === FLEET_YAML || p === FLEET }), FLEET));
  it('win32: the fleet dir when its node.yaml and the personal dir both exist', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env, exists: () => true }), FLEET));
  it('win32: a leftover fleet data dir (no node.yaml) yields to the personal dir', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env, exists: (p) => p === FLEET || p === PERSONAL }), PERSONAL));
  it('win32: a leftover fleet data dir alone is still the default', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env, exists: (p) => p === FLEET }), FLEET));
  it('win32: the personal dir when only it exists', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\U\\a\\AppData\\Local' }, exists: (p) => p.endsWith('node\\data') }), 'C:\\U\\a\\AppData\\Local\\KingLouie\\node\\data'));
  it('win32: the fleet dir when neither exists', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env, exists: () => false }), 'C:\\ProgramData\\KingLouie\\data'));
  it('win32: the fleet dir when LOCALAPPDATA is unset', () => assert.equal(defaultServiceDataDir({ platform: 'win32', env: { ProgramData: 'C:\\ProgramData' }, exists: (p) => p !== 'C:\\ProgramData\\KingLouie\\data' }), 'C:\\ProgramData\\KingLouie\\data'));
  it('linux is unchanged', () => assert.equal(defaultServiceDataDir({ platform: 'linux', env, exists: () => true }), '/var/lib/king-louie'));
  it('darwin is unchanged', () => assert.equal(defaultServiceDataDir({ platform: 'darwin', env, exists: () => true }), '/Library/Application Support/KingLouie/data'));
  it('no arguments still returns a path', () => assert.equal(typeof defaultServiceDataDir(), 'string'));
});

describe('fleetDataDir', () => {
  it('win32: under ProgramData, whatever exists', () => assert.equal(fleetDataDir({ platform: 'win32', env }), 'C:\\ProgramData\\KingLouie\\data'));
  it('win32: C:\\ProgramData when the variable is unset', () => assert.equal(fleetDataDir({ platform: 'win32', env: {} }), 'C:\\ProgramData\\KingLouie\\data'));
  it('linux and darwin: the service layout', () => {
    assert.equal(fleetDataDir({ platform: 'linux', env }), '/var/lib/king-louie');
    assert.equal(fleetDataDir({ platform: 'darwin', env }), '/Library/Application Support/KingLouie/data');
  });
});

describe('desktopProfileDirs', () => {
  it('both spellings of the desktop app profile per platform; none on win32 without APPDATA', () => {
    assert.deepEqual(desktopProfileDirs({ platform: 'win32', env: { APPDATA: 'C:\\U\\a\\AppData\\Roaming' } }), ['C:\\U\\a\\AppData\\Roaming\\king-louie', 'C:\\U\\a\\AppData\\Roaming\\King Louie']);
    assert.deepEqual(desktopProfileDirs({ platform: 'win32', env: {} }), []);
    assert.deepEqual(desktopProfileDirs({ platform: 'darwin', env: { HOME: '/Users/a' } }), ['/Users/a/Library/Application Support/king-louie', '/Users/a/Library/Application Support/King Louie']);
    assert.deepEqual(desktopProfileDirs({ platform: 'linux', env: { HOME: '/home/a' } }), ['/home/a/.config/king-louie', '/home/a/.config/King Louie']);
  });
});
