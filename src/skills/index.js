const { Skill } = require('./skill-interface');
const { SkillRegistry, registry } = require('./skill-registry');
const SkillLoader = require('./skill-loader');
const PinManager = require('./pin-manager');

module.exports = {
  Skill,
  SkillRegistry,
  SkillLoader,
  PinManager,
  skillRegistry: registry
};
