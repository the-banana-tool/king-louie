const { Skill } = require('./skill-interface');
const { SkillRegistry, registry } = require('./skill-registry');
const SkillLoader = require('./skill-loader');

module.exports = {
  Skill,
  SkillRegistry,
  SkillLoader,
  skillRegistry: registry
};
