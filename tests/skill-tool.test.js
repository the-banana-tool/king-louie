const { describe, it } = require('node:test');
const assert = require('node:assert');

const skillTool = require('../src/tools/builtin/skill-tool');
const { Skill } = require('../src/skills/skill-interface');
const { registry: skillRegistry } = require('../src/skills/skill-registry');
const { initializeTools, toolRegistry } = require('../src/tools');

function makeSkillId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

describe('Skill Tool', () => {
  it('has expected schema and approval requirements', () => {
    assert.strictEqual(skillTool.name, 'Skill');
    assert.strictEqual(skillTool.requiresApproval, true);
    assert.ok(skillTool.parameters.properties.skill_id);
    assert.ok(skillTool.parameters.properties.message);
    assert.ok(skillTool.parameters.properties.list);
  });

  it('is registered by initializeTools()', () => {
    initializeTools();
    const registered = toolRegistry.get('Skill');
    assert.ok(registered);
    assert.strictEqual(registered.name, 'Skill');
    assert.strictEqual(registered.requiresApproval, true);
  });

  it('returns list of available skills when list=true without requiring invocation params', async () => {
    class ListableSkill extends Skill {
      getMetadata() {
        return {
          id: this._id,
          name: 'Listable Skill',
          version: '1.0.0',
          description: 'Skill used for list-mode testing',
          author: 'test',
          commands: [this._id]
        };
      }

      async initialize() {}
      async handleCommand() {
        return { ok: true };
      }

      constructor(id) {
        super();
        this._id = id;
      }
    }

    const id = makeSkillId('listable');
    const skill = new ListableSkill(id);

    try {
      skillRegistry.register(skill);
      const result = await skillTool.execute({ list: true });

      assert.strictEqual(result.ok, true);
      assert.ok(Array.isArray(result.skills));

      const entry = result.skills.find((s) => s.id === id);
      assert.ok(entry);
      assert.strictEqual(entry.name, 'Listable Skill');
      assert.strictEqual(entry.description, 'Skill used for list-mode testing');
      assert.deepStrictEqual(entry.commands, [id]);
    } finally {
      await skillRegistry.unregister(id);
    }
  });

  it('invokes handleMessage when skill overrides it', async () => {
    class MessageSkill extends Skill {
      getMetadata() {
        return {
          id: this._id,
          name: 'Message Skill',
          version: '1.0.0',
          description: 'Skill with handleMessage',
          author: 'test',
          commands: [this._id]
        };
      }

      async initialize() {}

      async handleMessage(text, context) {
        this.lastMessage = text;
        this.lastContext = context;
        return { ok: true, via: 'handleMessage', text };
      }

      async handleCommand() {
        return { ok: true, via: 'handleCommand' };
      }

      constructor(id) {
        super();
        this._id = id;
      }
    }

    const id = makeSkillId('message');
    const skill = new MessageSkill(id);
    const context = { chatId: 'chat-1', channel: 'ui' };

    try {
      skillRegistry.register(skill);
      const result = await skillTool.execute({ skill_id: id, message: 'hello world' }, context);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.via, 'handleMessage');
      assert.strictEqual(skill.lastMessage, 'hello world');
      assert.deepStrictEqual(skill.lastContext, context);
    } finally {
      await skillRegistry.unregister(id);
    }
  });

  it('falls back to handleCommand when handleMessage is not implemented', async () => {
    class CommandOnlySkill extends Skill {
      getMetadata() {
        return {
          id: this._id,
          name: 'Command Skill',
          version: '1.0.0',
          description: 'Skill with only handleCommand',
          author: 'test',
          commands: [this._id]
        };
      }

      async initialize() {}

      async handleCommand(command, args, context) {
        this.calledWith = { command, args, context };
        return { ok: true, via: 'handleCommand', command, args };
      }

      constructor(id) {
        super();
        this._id = id;
      }
    }

    const id = makeSkillId('command');
    const skill = new CommandOnlySkill(id);
    const context = { chatId: 'chat-2', userId: 'u-1' };

    try {
      skillRegistry.register(skill);
      const result = await skillTool.execute({ skill_id: id, message: 'do thing' }, context);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.via, 'handleCommand');
      assert.deepStrictEqual(skill.calledWith.command, id);
      assert.deepStrictEqual(skill.calledWith.args, ['do thing']);
      assert.deepStrictEqual(skill.calledWith.context, context);
    } finally {
      await skillRegistry.unregister(id);
    }
  });

  it('falls back to handleCommand when handleMessage returns null', async () => {
    class NullMessageSkill extends Skill {
      getMetadata() {
        return {
          id: this._id,
          name: 'Null Message Skill',
          version: '1.0.0',
          description: 'handleMessage returns null',
          author: 'test',
          commands: [this._id]
        };
      }

      async initialize() {}

      async handleMessage() {
        return null;
      }

      async handleCommand(command, args) {
        return { ok: true, via: 'fallback', command, args };
      }

      constructor(id) {
        super();
        this._id = id;
      }
    }

    const id = makeSkillId('null-message');
    const skill = new NullMessageSkill(id);

    try {
      skillRegistry.register(skill);
      const result = await skillTool.execute({ skill_id: id, message: 'fallback please' });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.via, 'fallback');
      assert.strictEqual(result.command, id);
      assert.deepStrictEqual(result.args, ['fallback please']);
    } finally {
      await skillRegistry.unregister(id);
    }
  });

  it('returns an error when skill does not exist', async () => {
    const id = makeSkillId('missing');
    const result = await skillTool.execute({ skill_id: id, message: 'hello' });

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes(`Skill not found: ${id}`));
  });

  it('returns parameter errors for invocation mode when required values are missing', async () => {
    const missingSkillId = await skillTool.execute({ message: 'hello' });
    assert.strictEqual(missingSkillId.ok, false);
    assert.ok(missingSkillId.error.includes('skill_id'));

    const missingMessage = await skillTool.execute({ skill_id: 'any-skill' });
    assert.strictEqual(missingMessage.ok, false);
    assert.ok(missingMessage.error.includes('message'));
  });
});
