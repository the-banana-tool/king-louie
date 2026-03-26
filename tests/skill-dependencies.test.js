const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { Skill } = require('../src/skills/skill-interface');
const { SkillRegistry } = require('../src/skills/skill-registry');
const SkillLoader = require('../src/skills/skill-loader');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueId(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeSkill(overrides = {}) {
  const id = overrides.id || uniqueId();
  const skill = new Skill();

  skill.getMetadata = () => ({
    id,
    name: overrides.name || 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    author: 'test',
    commands: overrides.commands || [id],
    systemDependencies: overrides.systemDependencies || []
  });

  skill.initialize = async () => {};
  skill.handleCommand = async () => ({ ok: true, message: 'executed' });

  return skill;
}

// ---------------------------------------------------------------------------
// Skill base class: dependency status methods
// ---------------------------------------------------------------------------

describe('Skill dependency status methods', () => {
  it('getDependencyStatus returns empty array by default', () => {
    const skill = makeSkill();
    assert.deepStrictEqual(skill.getDependencyStatus(), []);
  });

  it('getDependencyStatus returns whatever the loader set', () => {
    const skill = makeSkill();
    const status = [
      { command: 'gh', name: 'GitHub CLI', available: true, required: true }
    ];
    skill._dependencyStatus = status;
    assert.deepStrictEqual(skill.getDependencyStatus(), status);
  });

  it('getMissingDependencies filters to required + unavailable', () => {
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: true, required: true },
      { command: 'docker', name: 'Docker', available: false, required: true },
      { command: 'kubectl', name: 'kubectl', available: false, required: false }
    ];

    const missing = skill.getMissingDependencies();
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].command, 'docker');
  });

  it('getMissingDependencies returns empty when all satisfied', () => {
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: true, required: true },
      { command: 'git', name: 'Git', available: true, required: true }
    ];

    assert.deepStrictEqual(skill.getMissingDependencies(), []);
  });

  it('formatMissingDepsError returns null when no missing deps', () => {
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: true, required: true }
    ];

    assert.strictEqual(skill.formatMissingDepsError(), null);
  });

  it('formatMissingDepsError returns markdown with install info', () => {
    const skill = makeSkill();
    skill._dependencyStatus = [
      {
        command: 'gh',
        name: 'GitHub CLI',
        available: false,
        required: true,
        installUrl: 'https://cli.github.com/',
        install: {
          win: 'winget install --id GitHub.cli',
          mac: 'brew install gh',
          linux: 'sudo apt install gh'
        }
      }
    ];

    const error = skill.formatMissingDepsError();
    assert.ok(error.includes('GitHub CLI'));
    assert.ok(error.includes('`gh`'));
    assert.ok(error.includes('https://cli.github.com/'));
    // Should include a platform-specific install command
    assert.ok(
      error.includes('winget') || error.includes('brew') || error.includes('apt'),
      'Should include at least one platform install command'
    );
  });

  it('formatMissingDepsError only lists missing required deps', () => {
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: true, required: true },
      { command: 'docker', name: 'Docker', available: false, required: true, install: {} },
      { command: 'kubectl', name: 'kubectl', available: false, required: false, install: {} }
    ];

    const error = skill.formatMissingDepsError();
    assert.ok(error.includes('Docker'));
    assert.ok(!error.includes('kubectl'), 'Optional deps should not appear');
    assert.ok(!error.includes('GitHub CLI'), 'Available deps should not appear');
  });
});

// ---------------------------------------------------------------------------
// SkillLoader.checkDependencies
// ---------------------------------------------------------------------------

describe('SkillLoader.checkDependencies', () => {
  let loader;

  beforeEach(() => {
    loader = new SkillLoader({
      skillsDirectory: '/fake/skills',
      context: { userDataPath: '/fake/data' }
    });
  });

  it('sets empty array when skill has no systemDependencies', async () => {
    const skill = makeSkill({ systemDependencies: [] });
    await loader.checkDependencies(skill);
    assert.deepStrictEqual(skill._dependencyStatus, []);
  });

  it('sets empty array when systemDependencies is undefined', async () => {
    const skill = makeSkill();
    // Override to return no systemDependencies key at all
    const id = uniqueId();
    skill.getMetadata = () => ({
      id,
      name: 'No Deps Skill',
      version: '1.0.0',
      description: 'test',
      author: 'test',
      commands: [id]
    });
    await loader.checkDependencies(skill);
    assert.deepStrictEqual(skill._dependencyStatus, []);
  });

  it('detects a command that exists on this system (node)', async () => {
    const skill = makeSkill({
      systemDependencies: [
        { command: 'node', name: 'Node.js', required: true }
      ]
    });

    await loader.checkDependencies(skill);
    assert.strictEqual(skill._dependencyStatus.length, 1);
    assert.strictEqual(skill._dependencyStatus[0].command, 'node');
    assert.strictEqual(skill._dependencyStatus[0].available, true);
    assert.strictEqual(skill._dependencyStatus[0].required, true);
  });

  it('detects a command that does not exist', async () => {
    const skill = makeSkill({
      systemDependencies: [
        {
          command: 'this-command-does-not-exist-xyz-123',
          name: 'Fake Tool',
          required: true,
          installUrl: 'https://example.com',
          install: { win: 'winget install fake', mac: 'brew install fake', linux: 'apt install fake' }
        }
      ]
    });

    await loader.checkDependencies(skill);
    assert.strictEqual(skill._dependencyStatus.length, 1);
    assert.strictEqual(skill._dependencyStatus[0].available, false);
    assert.strictEqual(skill._dependencyStatus[0].name, 'Fake Tool');
    assert.strictEqual(skill._dependencyStatus[0].installUrl, 'https://example.com');
    assert.deepStrictEqual(skill._dependencyStatus[0].install, {
      win: 'winget install fake',
      mac: 'brew install fake',
      linux: 'apt install fake'
    });
  });

  it('defaults required to true when not specified', async () => {
    const skill = makeSkill({
      systemDependencies: [
        { command: 'node', name: 'Node.js' }
        // no 'required' field
      ]
    });

    await loader.checkDependencies(skill);
    assert.strictEqual(skill._dependencyStatus[0].required, true);
  });

  it('respects required: false', async () => {
    const skill = makeSkill({
      systemDependencies: [
        { command: 'this-does-not-exist-456', name: 'Optional Tool', required: false }
      ]
    });

    await loader.checkDependencies(skill);
    assert.strictEqual(skill._dependencyStatus[0].required, false);
    assert.strictEqual(skill._dependencyStatus[0].available, false);
  });

  it('checks multiple dependencies in parallel', async () => {
    const skill = makeSkill({
      systemDependencies: [
        { command: 'node', name: 'Node.js', required: true },
        { command: 'this-fake-tool-999', name: 'Fake', required: true }
      ]
    });

    await loader.checkDependencies(skill);
    assert.strictEqual(skill._dependencyStatus.length, 2);

    const nodeStatus = skill._dependencyStatus.find((d) => d.command === 'node');
    const fakeStatus = skill._dependencyStatus.find((d) => d.command === 'this-fake-tool-999');
    assert.strictEqual(nodeStatus.available, true);
    assert.strictEqual(fakeStatus.available, false);
  });

  it('defaults name to command when name is not provided', async () => {
    const skill = makeSkill({
      systemDependencies: [
        { command: 'node' }
      ]
    });

    await loader.checkDependencies(skill);
    assert.strictEqual(skill._dependencyStatus[0].name, 'node');
  });
});

// ---------------------------------------------------------------------------
// SkillRegistry.executeCommand – dependency gating
// ---------------------------------------------------------------------------

describe('SkillRegistry dependency gating', () => {
  it('blocks command when required dep is missing', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._dependencyStatus = [
      {
        command: 'gh',
        name: 'GitHub CLI',
        available: false,
        required: true,
        installUrl: 'https://cli.github.com/',
        install: { win: 'winget install --id GitHub.cli' }
      }
    ];

    registry.register(skill);
    const meta = skill.getMetadata();
    const result = await registry.executeCommand(meta.commands[0], ['pr', 'list'], {});

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('GitHub CLI'));
    assert.ok(Array.isArray(result.missingDependencies));
    assert.strictEqual(result.missingDependencies.length, 1);
    assert.strictEqual(result.format, 'markdown');
  });

  it('allows command when all required deps are available', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: true, required: true }
    ];

    registry.register(skill);
    const meta = skill.getMetadata();
    const result = await registry.executeCommand(meta.commands[0], [], {});

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.message, 'executed');
  });

  it('allows command when missing deps are all optional', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'docker', name: 'Docker', available: false, required: false }
    ];

    registry.register(skill);
    const meta = skill.getMetadata();
    const result = await registry.executeCommand(meta.commands[0], [], {});

    assert.strictEqual(result.ok, true);
  });

  it('allows command when skill has no dependencies', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._dependencyStatus = [];

    registry.register(skill);
    const meta = skill.getMetadata();
    const result = await registry.executeCommand(meta.commands[0], [], {});

    assert.strictEqual(result.ok, true);
  });

  it('blocks command listing multiple missing deps', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: false, required: true, install: {} },
      { command: 'git', name: 'Git', available: false, required: true, install: {} },
      { command: 'docker', name: 'Docker', available: true, required: true }
    ];

    registry.register(skill);
    const meta = skill.getMetadata();
    const result = await registry.executeCommand(meta.commands[0], [], {});

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.missingDependencies.length, 2);
    assert.ok(result.error.includes('GitHub CLI'));
    assert.ok(result.error.includes('Git'));
  });

  it('disabled check still takes priority over dep check', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._enabled = false;
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: false, required: true }
    ];

    registry.register(skill);
    const meta = skill.getMetadata();
    const result = await registry.executeCommand(meta.commands[0], [], {});

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('disabled'), 'Should show disabled message, not dep message');
  });
});

// ---------------------------------------------------------------------------
// SkillRegistry.listSkills – dependency info in listing
// ---------------------------------------------------------------------------

describe('SkillRegistry.listSkills includes dependency info', () => {
  it('includes dependencyStatus and hasMissingDeps in listing', () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'gh', name: 'GitHub CLI', available: false, required: true }
    ];

    registry.register(skill);
    const list = registry.listSkills();
    const entry = list.find((s) => s.id === skill.getMetadata().id);

    assert.ok(entry);
    assert.deepStrictEqual(entry.dependencyStatus, skill._dependencyStatus);
    assert.strictEqual(entry.hasMissingDeps, true);
  });

  it('hasMissingDeps is false when all satisfied', () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    skill._dependencyStatus = [
      { command: 'node', name: 'Node.js', available: true, required: true }
    ];

    registry.register(skill);
    const list = registry.listSkills();
    const entry = list.find((s) => s.id === skill.getMetadata().id);

    assert.strictEqual(entry.hasMissingDeps, false);
  });
});
