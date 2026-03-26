const { Tool } = require('../tool-schema');
const { Skill } = require('../../skills/skill-interface');
const { registry: skillRegistry } = require('../../skills/skill-registry');

function listAvailableSkills() {
  const skills =
    typeof skillRegistry.listSkills === 'function'
      ? skillRegistry.listSkills()
      : typeof skillRegistry.list === 'function'
        ? skillRegistry.list()
        : [];

  return skills.map((entry) => {
    const id = entry?.id || null;
    const skill = id ? skillRegistry.getSkill(id) : null;
    const metadata =
      skill && typeof skill.getMetadata === 'function'
        ? skill.getMetadata()
        : entry;

    return {
      id: metadata?.id || id,
      name: metadata?.name || null,
      description: metadata?.description || '',
      commands: Array.isArray(metadata?.commands) ? metadata.commands : []
    };
  });
}

function getSkillToolDescription() {
  try {
    const skills = listAvailableSkills();
    if (skills.length > 0) {
      const skillList = skills.map((s) => `"${s.id}"`).join(', ');
      return `Invoke an installed skill by ID. When the user mentions a skill by name, use this tool. Installed skills: ${skillList}. Use list=true to see full details.`;
    }
  } catch { /* fall through */ }
  return 'Invoke an installed skill by ID, or list available skills for discovery.';
}

const SkillTool = new Tool({
  name: 'Skill',
  description: 'Invoke an installed skill by ID, or list available skills for discovery.',
  parameters: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'The target skill identifier (e.g. "gh", "claude-code")'
      },
      message: {
        type: 'string',
        description: 'The message payload to pass to the skill'
      },
      list: {
        type: 'boolean',
        description: 'When true, return available skills and descriptions'
      }
    }
  },
  requiresApproval: true,

  async execute(params, context = {}) {
    const { skill_id, message, list = false } = params;

    if (list) {
      return {
        ok: true,
        skills: listAvailableSkills()
      };
    }

    if (!skill_id || typeof skill_id !== 'string') {
      return {
        ok: false,
        error: 'Missing required parameter: skill_id'
      };
    }

    if (typeof message !== 'string') {
      return {
        ok: false,
        error: 'Missing required parameter: message'
      };
    }

    const skill = skillRegistry.getSkill(skill_id);
    if (!skill) {
      return {
        ok: false,
        error: `Skill not found: ${skill_id}`
      };
    }

    const supportsHandleMessage =
      typeof skill.handleMessage === 'function' && skill.handleMessage !== Skill.prototype.handleMessage;

    let result;
    if (supportsHandleMessage) {
      result = await skill.handleMessage(message, context);
    }

    if (result === null || result === undefined) {
      if (typeof skill.handleCommand !== 'function') {
        return {
          ok: false,
          error: `Skill '${skill_id}' does not implement handleCommand()`
        };
      }

      result = await skill.handleCommand(skill_id, [message], context);
    }

    return result;
  }
});

// Override to include dynamic skill list in the description sent to the LLM
const originalToFunctionDefinition = SkillTool.toFunctionDefinition.bind(SkillTool);
SkillTool.toFunctionDefinition = function () {
  const def = originalToFunctionDefinition();
  def.description = getSkillToolDescription();
  return def;
};

module.exports = SkillTool;
