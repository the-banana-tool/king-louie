const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { registerSkillHandlers } = require('../src/ipc/skill-handlers');

// ── Helpers ────────────────────────────────────────────────

function createIpcMainMock() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };
}

function invoke(ipcMain, channel, payload) {
  const handler = ipcMain.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, payload);
}

function makeSkill(overrides = {}) {
  return {
    _skillPath: '_skillPath' in overrides ? overrides._skillPath : '/fake/skills/test-skill',
    _isSymlink: overrides._isSymlink ?? false,
    _enabled: overrides._enabled ?? true,
    _dependencyStatus: [],
    getMetadata: () => ({
      id: overrides.id ?? 'test-skill',
      name: overrides.name ?? 'Test Skill',
      version: overrides.version ?? '1.0.0',
      commands: ['test'],
      ...(overrides.meta || {})
    }),
    handleCommand: async () => ({ ok: true }),
    getDependencyStatus: () => [],
    getMissingDependencies: () => [],
    getSettingsSchema: () => [],
    getSettings: () => ({}),
    ...(overrides.methods || {})
  };
}

function createContext(overrides = {}) {
  const skills = new Map();
  const skillRegistry = {
    skills,
    getSkill: (id) => skills.get(id) || null,
    listSkills: () => Array.from(skills.values()).map((s) => s.getMetadata()),
    register: mock.fn((skill) => {
      const meta = skill.getMetadata();
      skills.set(meta.id, skill);
    }),
    unregister: mock.fn(async (id) => {
      skills.delete(id);
    }),
    ...(overrides.skillRegistry || {})
  };

  const skillLoader = {
    skillsDirectory: '/fake/skills',
    builtinSkillsDirectory: '/fake/builtin-skills',
    loadSkill: mock.fn(async () => null),
    ...(overrides.skillLoader || {})
  };

  return {
    ipcMain: createIpcMainMock(),
    skillRegistry,
    context: {
      skillRegistry,
      ensureSkillCustomizationFile: (id) => ({ path: `/fake/customizations/${id}/customization.json` }),
      getSkillLoader: () => skillLoader,
      getSessionManager: () => ({ buildSessionKey: () => 'key', getOrCreateSession: () => ({}) }),
      getPinManager: () => ({ pin: async () => {}, unpin: async () => {}, getPinned: () => null }),
      getShell: () => ({ openPath: async () => '' }),
      ...(overrides.context || {})
    },
    skillLoader,
    addSkill(skill) {
      skills.set(skill.getMetadata().id, skill);
    }
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('skill-handlers: registration', () => {
  it('registers all expected IPC channels', () => {
    const { ipcMain, context } = createContext();
    registerSkillHandlers(ipcMain, context);

    const expected = [
      'skill:list', 'skill:customize', 'skill:listWithSettings',
      'skill:setEnabled', 'skill:install', 'skill:remove',
      'skill:getSettings', 'skill:saveSettings', 'skill:execute',
      'skill:pin', 'skill:unpin', 'skill:getPinned', 'skill:listPinnable',
      'skill:handleMessage', 'skill:checkDeps',
      'skill:checkUpdates', 'skill:update'
    ];

    for (const channel of expected) {
      assert.ok(ipcMain.handlers.has(channel), `missing handler for ${channel}`);
    }
  });
});

describe('skill:checkUpdates', () => {
  let origExistsSync;
  let origExecSync;
  let fs_;
  let cp_;

  beforeEach(() => {
    fs_ = require('fs');
    cp_ = require('child_process');
    origExistsSync = fs_.existsSync;
    origExecSync = cp_.execSync;
  });

  afterEach(() => {
    fs_.existsSync = origExistsSync;
    cp_.execSync = origExecSync;
  });

  it('returns ok with empty results when no skills exist', async () => {
    const { ipcMain, context } = createContext();
    registerSkillHandlers(ipcMain, context);

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.results, {});
  });

  it('skips symlinked skills', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'sym-skill', _isSymlink: true }));

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.results, {});
  });

  it('skips skills without _skillPath', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'no-path', _skillPath: null }));

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.results, {});
  });

  it('skips skills without a .git directory', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'no-git' }));
    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return false;
      return origExistsSync(p);
    };

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.results, {});
  });

  it('reports updateAvailable: false when local == remote', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'up-to-date', _skillPath: '/fake/skills/up-to-date' }));

    fs_.existsSync = (p) => {
      if (p === path.join('/fake/skills/up-to-date', '.git')) return true;
      return origExistsSync(p);
    };

    const sameHash = 'abc123abc123abc123abc123abc123abc123abc1';
    cp_.execSync = (cmd) => {
      if (cmd === 'git fetch') return Buffer.from('');
      if (cmd === 'git rev-parse HEAD') return Buffer.from(sameHash + '\n');
      if (cmd === 'git rev-parse @{u}') return Buffer.from(sameHash + '\n');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.results['up-to-date'].updateAvailable, false);
  });

  it('reports updateAvailable: true with version and commit count when behind', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({
      id: 'outdated',
      version: '1.0.0',
      _skillPath: '/fake/skills/outdated'
    }));

    fs_.existsSync = (p) => {
      if (p === path.join('/fake/skills/outdated', '.git')) return true;
      return origExistsSync(p);
    };

    cp_.execSync = (cmd) => {
      if (cmd === 'git fetch') return Buffer.from('');
      if (cmd === 'git rev-parse HEAD') return Buffer.from('aaa\n');
      if (cmd === 'git rev-parse @{u}') return Buffer.from('bbb\n');
      if (cmd.startsWith('git show @{u}:package.json')) {
        return Buffer.from(JSON.stringify({ version: '2.0.0' }));
      }
      if (cmd.startsWith('git rev-list')) return Buffer.from('3\n');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.ok, true);

    const info = result.results['outdated'];
    assert.strictEqual(info.updateAvailable, true);
    assert.strictEqual(info.currentVersion, '1.0.0');
    assert.strictEqual(info.remoteVersion, '2.0.0');
    assert.strictEqual(info.behind, 3);
  });

  it('handles git fetch failure gracefully', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'fetch-fail', _skillPath: '/fake/skills/fetch-fail' }));

    fs_.existsSync = (p) => {
      if (p === path.join('/fake/skills/fetch-fail', '.git')) return true;
      return origExistsSync(p);
    };

    cp_.execSync = (cmd) => {
      if (cmd === 'git fetch') throw new Error('network error');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.results['fetch-fail'].updateAvailable, false);
    assert.ok(result.results['fetch-fail'].error);
  });

  it('handles missing remote package.json gracefully', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'no-remote-pkg', _skillPath: '/fake/skills/no-remote-pkg' }));

    fs_.existsSync = (p) => {
      if (p === path.join('/fake/skills/no-remote-pkg', '.git')) return true;
      return origExistsSync(p);
    };

    cp_.execSync = (cmd) => {
      if (cmd === 'git fetch') return Buffer.from('');
      if (cmd === 'git rev-parse HEAD') return Buffer.from('aaa\n');
      if (cmd === 'git rev-parse @{u}') return Buffer.from('bbb\n');
      if (cmd.startsWith('git show @{u}:package.json')) throw new Error('not found');
      if (cmd.startsWith('git rev-list')) return Buffer.from('1\n');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    const info = result.results['no-remote-pkg'];
    assert.strictEqual(info.updateAvailable, true);
    assert.strictEqual(info.remoteVersion, null);
  });

  it('checks multiple skills independently', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'skill-a', _skillPath: '/fake/skills/skill-a' }));
    addSkill(makeSkill({ id: 'skill-b', _skillPath: '/fake/skills/skill-b' }));

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      return origExistsSync(p);
    };

    const hashA = 'aaa';
    const hashB = 'bbb';

    cp_.execSync = (cmd, opts) => {
      if (cmd === 'git fetch') return Buffer.from('');
      const isA = opts?.cwd?.includes('skill-a');
      if (cmd === 'git rev-parse HEAD') return Buffer.from(isA ? hashA : hashB);
      if (cmd === 'git rev-parse @{u}') return Buffer.from(isA ? hashA : 'ccc');  // A up-to-date, B behind
      if (cmd.startsWith('git show')) return Buffer.from(JSON.stringify({ version: '9.9.9' }));
      if (cmd.startsWith('git rev-list')) return Buffer.from('2\n');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:checkUpdates');
    assert.strictEqual(result.results['skill-a'].updateAvailable, false);
    assert.strictEqual(result.results['skill-b'].updateAvailable, true);
  });
});

describe('skill:update', () => {
  let origExistsSync;
  let origExecSync;
  let origReadFileSync;
  let fs_;
  let cp_;

  beforeEach(() => {
    fs_ = require('fs');
    cp_ = require('child_process');
    origExistsSync = fs_.existsSync;
    origExecSync = cp_.execSync;
    origReadFileSync = fs_.readFileSync;
  });

  afterEach(() => {
    fs_.existsSync = origExistsSync;
    cp_.execSync = origExecSync;
    fs_.readFileSync = origReadFileSync;
  });

  it('returns error for unknown skill', async () => {
    const { ipcMain, context } = createContext();
    registerSkillHandlers(ipcMain, context);

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'nonexistent' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Unknown skill'));
  });

  it('returns error for skill without _skillPath', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'no-path', _skillPath: null }));

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'no-path' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Cannot determine install path'));
  });

  it('returns error for symlinked skill', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'sym', _isSymlink: true }));

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'sym' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('symlinked'));
  });

  it('returns error when .git directory is missing', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'no-git' }));

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return false;
      return origExistsSync(p);
    };

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'no-git' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('not a git repository'));
  });

  it('returns error when git pull fails', async () => {
    const { ipcMain, context, addSkill } = createContext();
    registerSkillHandlers(ipcMain, context);

    addSkill(makeSkill({ id: 'pull-fail' }));

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      return origExistsSync(p);
    };

    const pullError = new Error('merge conflict');
    pullError.stderr = Buffer.from('cannot fast-forward');
    cp_.execSync = (cmd) => {
      if (cmd.startsWith('git pull')) throw pullError;
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'pull-fail' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('Git pull failed'));
    assert.ok(result.error.includes('cannot fast-forward'));
  });

  it('successfully updates, reloads, and returns new version', async () => {
    const { ipcMain, context, addSkill, skillLoader } = createContext();

    const reloadedSkill = makeSkill({ id: 'test-skill', version: '2.0.0', name: 'Test Skill v2' });
    skillLoader.loadSkill = mock.fn(async () => reloadedSkill);

    registerSkillHandlers(ipcMain, context);
    addSkill(makeSkill({ id: 'test-skill', version: '1.0.0' }));

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      if (p.endsWith('package.json')) return false; // skip npm install
      return origExistsSync(p);
    };

    cp_.execSync = (cmd) => {
      if (cmd.startsWith('git pull')) return Buffer.from('Already up to date.\n');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'test-skill' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.version, '2.0.0');
    assert.strictEqual(result.name, 'Test Skill v2');
    assert.strictEqual(skillLoader.loadSkill.mock.callCount(), 1);
  });

  it('runs npm install when package.json has dependencies', async () => {
    const { ipcMain, context, addSkill, skillLoader } = createContext();

    const reloadedSkill = makeSkill({ id: 'deps-skill', version: '2.0.0' });
    skillLoader.loadSkill = mock.fn(async () => reloadedSkill);

    registerSkillHandlers(ipcMain, context);
    addSkill(makeSkill({ id: 'deps-skill', _skillPath: '/fake/skills/deps-skill' }));

    const npmInstallCalls = [];

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      if (p.endsWith('package.json')) return true;
      return origExistsSync(p);
    };

    fs_.readFileSync = (p, enc) => {
      if (typeof p === 'string' && p.endsWith('package.json')) {
        return JSON.stringify({ dependencies: { lodash: '^4.0.0' } });
      }
      return origReadFileSync(p, enc);
    };

    cp_.execSync = (cmd, opts) => {
      if (cmd.startsWith('git pull')) return Buffer.from('');
      if (cmd.startsWith('npm install')) {
        npmInstallCalls.push({ cmd, cwd: opts?.cwd });
        return Buffer.from('');
      }
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'deps-skill' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(npmInstallCalls.length, 1);
    assert.strictEqual(npmInstallCalls[0].cwd, '/fake/skills/deps-skill');
  });

  it('skips npm install when no dependencies', async () => {
    const { ipcMain, context, addSkill, skillLoader } = createContext();

    const reloadedSkill = makeSkill({ id: 'no-deps', version: '2.0.0' });
    skillLoader.loadSkill = mock.fn(async () => reloadedSkill);

    registerSkillHandlers(ipcMain, context);
    addSkill(makeSkill({ id: 'no-deps' }));

    const npmCalls = [];

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      if (p.endsWith('package.json')) return true;
      return origExistsSync(p);
    };

    fs_.readFileSync = (p, enc) => {
      if (typeof p === 'string' && p.endsWith('package.json')) {
        return JSON.stringify({ name: 'no-deps' });
      }
      return origReadFileSync(p, enc);
    };

    cp_.execSync = (cmd) => {
      if (cmd.startsWith('git pull')) return Buffer.from('');
      if (cmd.startsWith('npm install')) npmCalls.push(cmd);
      return origExecSync(cmd);
    };

    await invoke(ipcMain, 'skill:update', { skillId: 'no-deps' });
    assert.strictEqual(npmCalls.length, 0);
  });

  it('unregisters old skill and registers reloaded one', async () => {
    const { ipcMain, context, addSkill, skillLoader } = createContext();

    const reloadedSkill = makeSkill({ id: 'reload-test', version: '3.0.0' });
    skillLoader.loadSkill = mock.fn(async () => reloadedSkill);

    registerSkillHandlers(ipcMain, context);
    addSkill(makeSkill({ id: 'reload-test', version: '1.0.0' }));

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      if (p.endsWith('package.json')) return false;
      return origExistsSync(p);
    };

    cp_.execSync = (cmd) => {
      if (cmd.startsWith('git pull')) return Buffer.from('');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'reload-test' });
    assert.strictEqual(result.ok, true);

    assert.strictEqual(context.skillRegistry.unregister.mock.callCount(), 1);
    assert.strictEqual(context.skillRegistry.unregister.mock.calls[0].arguments[0], 'reload-test');

    assert.strictEqual(context.skillRegistry.register.mock.callCount(), 1);
    const registeredSkill = context.skillRegistry.register.mock.calls[0].arguments[0];
    assert.strictEqual(registeredSkill.getMetadata().version, '3.0.0');
  });

  it('returns error when reload returns null', async () => {
    const { ipcMain, context, addSkill, skillLoader } = createContext();

    skillLoader.loadSkill = mock.fn(async () => null);

    registerSkillHandlers(ipcMain, context);
    addSkill(makeSkill({ id: 'reload-null' }));

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      if (p.endsWith('package.json')) return false;
      return origExistsSync(p);
    };

    cp_.execSync = (cmd) => {
      if (cmd.startsWith('git pull')) return Buffer.from('');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'reload-null' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('failed to reload'));
  });

  it('returns error when reload throws', async () => {
    const { ipcMain, context, addSkill, skillLoader } = createContext();

    skillLoader.loadSkill = mock.fn(async () => { throw new Error('bad entry point'); });

    registerSkillHandlers(ipcMain, context);
    addSkill(makeSkill({ id: 'reload-throw' }));

    fs_.existsSync = (p) => {
      if (p.endsWith('.git')) return true;
      if (p.endsWith('package.json')) return false;
      return origExistsSync(p);
    };

    cp_.execSync = (cmd) => {
      if (cmd.startsWith('git pull')) return Buffer.from('');
      return origExecSync(cmd);
    };

    const result = await invoke(ipcMain, 'skill:update', { skillId: 'reload-throw' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('reload failed'));
    assert.ok(result.error.includes('bad entry point'));
  });
});
