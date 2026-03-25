const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerSkillHandlers(ipcMain, context = {}) {
  const {
    skillRegistry,
    ensureSkillCustomizationFile
  } = context;

  const getSessionManager = () => (
    typeof context.getSessionManager === 'function' ? context.getSessionManager() : context.sessionManager
  );

  const getPinManager = () => (
    typeof context.getPinManager === 'function' ? context.getPinManager() : context.pinManager
  );

  const getShell = () => (
    typeof context.getShell === 'function' ? context.getShell() : context.shell
  );

  ipcMain.handle(IPC.SKILL_LIST, wrapHandler(IPC.SKILL_LIST, async () => {
    return skillRegistry.listSkills();
  }));

  ipcMain.handle(IPC.SKILL_CUSTOMIZE, wrapHandler(IPC.SKILL_CUSTOMIZE, async (_event, { skillId } = {}) => {
    const customization = ensureSkillCustomizationFile(skillId);
    const openError = await getShell().openPath(customization.path);
    if (openError) {
      return {
        ok: false,
        error: openError,
        ...customization
      };
    }

    return {
      ok: true,
      ...customization
    };
  }));

  ipcMain.handle(IPC.SKILL_LIST_WITH_SETTINGS, wrapHandler(IPC.SKILL_LIST_WITH_SETTINGS, async () => {
    const skills = skillRegistry.listSkills();
    return skills.map((meta) => {
      const skill = skillRegistry.getSkill(meta.id);
      const schema = (skill && typeof skill.getSettingsSchema === 'function')
        ? skill.getSettingsSchema()
        : [];
      const settings = (skill && typeof skill.getSettings === 'function')
        ? skill.getSettings()
        : {};
      const enabled = skill ? (skill._enabled !== false) : true;
      return { ...meta, settingsSchema: schema, settings, enabled };
    });
  }));

  ipcMain.handle(IPC.SKILL_SET_ENABLED, wrapHandler(IPC.SKILL_SET_ENABLED, async (_event, { skillId, enabled } = {}) => {
    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      return { ok: false, error: `Unknown skill: ${skillId}` };
    }

    skill._enabled = Boolean(enabled);

    // Persist via customization file
    const customization = ensureSkillCustomizationFile(skillId);
    const fs = require('fs');
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(customization.path, 'utf-8'));
    } catch { /* start fresh */ }

    existing.enabled = Boolean(enabled);
    fs.writeFileSync(customization.path, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    return { ok: true, skillId, enabled: Boolean(enabled) };
  }));

  ipcMain.handle(IPC.SKILL_GET_SETTINGS, wrapHandler(IPC.SKILL_GET_SETTINGS, async (_event, { skillId } = {}) => {
    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      return { ok: false, error: `Unknown skill: ${skillId}` };
    }
    const schema = typeof skill.getSettingsSchema === 'function' ? skill.getSettingsSchema() : [];
    const settings = typeof skill.getSettings === 'function' ? skill.getSettings() : {};
    return { ok: true, skillId, schema, settings };
  }));

  ipcMain.handle(IPC.SKILL_SAVE_SETTINGS, wrapHandler(IPC.SKILL_SAVE_SETTINGS, async (_event, { skillId, settings } = {}) => {
    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      return { ok: false, error: `Unknown skill: ${skillId}` };
    }

    // Persist via customization file
    const customization = ensureSkillCustomizationFile(skillId);
    const fs = require('fs');
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(customization.path, 'utf-8'));
    } catch { /* start fresh */ }

    existing.settings = { ...(existing.settings || {}), ...settings };
    fs.writeFileSync(customization.path, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    // Apply to live skill instance
    skill.customSettings = { ...(skill.customSettings || {}), ...settings };
    if (typeof skill.applyCustomization === 'function') {
      skill.applyCustomization(skill.customSettings);
    }

    return { ok: true, skillId, settings: skill.getSettings() };
  }));

  ipcMain.handle(IPC.SKILL_EXECUTE, wrapHandler(IPC.SKILL_EXECUTE, async (_event, { command, args = [], chatId }) => {
    const sessionManager = getSessionManager();

    const parsedArgs = Array.isArray(args) ? [...args] : [];
    const forcePrompt = parsedArgs.includes('--force-prompt');
    const sanitizedArgs = parsedArgs.filter((arg) => arg !== '--force-prompt');

    // Create a session for this chat if needed
    const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
    const session = sessionManager.getOrCreateSession(sessionKey, 'main', {
      channel: 'ui',
      peer: chatId,
      label: `ui:${chatId}`
    });

    const result = await skillRegistry.executeCommand(
      command,
      sanitizedArgs,
      {
        chatId,
        channel: 'ui',
        userId: chatId,
        session
      },
      { forcePrompt }
    );

    return result;
  }));

  ipcMain.handle(IPC.SKILL_PIN, wrapHandler(IPC.SKILL_PIN, async (_event, { chatId, skillId }) => {
    const pinManager = getPinManager();
    const sessionManager = getSessionManager();

    if (!pinManager) {
      return { ok: false, error: 'Pin manager is not initialized.' };
    }

    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      return { ok: false, error: `Unknown skill: ${skillId}` };
    }

    if (!skill.getMetadata().pinnable) {
      return { ok: false, error: `Skill '${skillId}' does not support pinning.` };
    }
    const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
    await pinManager.pin(sessionKey, skillId);
    return { ok: true, skillId, name: skill.getMetadata().name };
  }));

  ipcMain.handle(IPC.SKILL_UNPIN, wrapHandler(IPC.SKILL_UNPIN, async (_event, { chatId }) => {
    const pinManager = getPinManager();
    const sessionManager = getSessionManager();

    if (!pinManager) {
      return { ok: false, error: 'Pin manager is not initialized.' };
    }
    const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
    const previousId = pinManager.getPinned(sessionKey);
    await pinManager.unpin(sessionKey);
    return { ok: true, previousSkillId: previousId || null };
  }));

  ipcMain.handle(IPC.SKILL_GET_PINNED, wrapHandler(IPC.SKILL_GET_PINNED, async (_event, { chatId }) => {
    const pinManager = getPinManager();
    const sessionManager = getSessionManager();

    if (!pinManager) {
      return { ok: false, error: 'Pin manager is not initialized.' };
    }

    const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
    const skillId = pinManager.getPinned(sessionKey);
    if (!skillId) {
      return { ok: true, pinned: null };
    }

    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      return { ok: true, pinned: { skillId } };
    }

    return {
      ok: true,
      pinned: {
        skillId,
        ...skill.getMetadata()
      }
    };
  }));

  ipcMain.handle(IPC.SKILL_LIST_PINNABLE, wrapHandler(IPC.SKILL_LIST_PINNABLE, async () => {
    return skillRegistry.getPinnableSkills();
  }));

  ipcMain.handle(IPC.SKILL_HANDLE_MESSAGE, wrapHandler(IPC.SKILL_HANDLE_MESSAGE, async (_event, { chatId, message }) => {
    const pinManager = getPinManager();
    const sessionManager = getSessionManager();

    if (!pinManager) {
      return { ok: false, error: 'Pin manager is not initialized.', continueWithAgent: true };
    }

    const sessionKey = sessionManager.buildSessionKey('main', 'ui', chatId);
    const skillId = pinManager.getPinned(sessionKey);
    if (!skillId) {
      return { ok: false, error: 'No skill pinned', continueWithAgent: true };
    }

    const skill = skillRegistry.getSkill(skillId);
    if (!skill || typeof skill.handleMessage !== 'function') {
      return { ok: false, error: 'Pinned skill cannot handle messages', continueWithAgent: true };
    }

    const session = sessionManager.getOrCreateSession(sessionKey, 'main', {
      channel: 'ui',
      peer: chatId,
      label: `ui:${chatId}`
    });

    const result = await skill.handleMessage(message, {
      chatId,
      channel: 'ui',
      userId: chatId,
      session
    });
    return result || { ok: false, continueWithAgent: true };
  }));
}

module.exports = {
  registerSkillHandlers
};