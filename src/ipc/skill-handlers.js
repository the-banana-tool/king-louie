const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const childProcess = require('child_process');
const path = require('path');
const fs = require('fs');
const { isCommandAvailable, resetRuntimeEnvironmentCache } = require('../execution/runtime-environment');

function registerSkillHandlers(ipcMain, context = {}) {
  const {
    skillRegistry,
    ensureSkillCustomizationFile
  } = context;

  const getSkillLoader = () => (
    typeof context.getSkillLoader === 'function' ? context.getSkillLoader() : context.skillLoader
  );

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
      const dependencyStatus = (skill && typeof skill.getDependencyStatus === 'function')
        ? skill.getDependencyStatus()
        : [];
      const hasMissingDeps = (skill && typeof skill.getMissingDependencies === 'function')
        ? skill.getMissingDependencies().length > 0
        : false;
      return { ...meta, settingsSchema: schema, settings, enabled, dependencyStatus, hasMissingDeps };
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
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(customization.path, 'utf-8'));
    } catch (err) { console.debug('[skill] customization read failed, starting fresh:', err.message); }

    existing.enabled = Boolean(enabled);
    fs.writeFileSync(customization.path, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    return { ok: true, skillId, enabled: Boolean(enabled) };
  }));

  ipcMain.handle(IPC.SKILL_INSTALL, wrapHandler(IPC.SKILL_INSTALL, async (_event, { url } = {}) => {
    if (!url || typeof url !== 'string') {
      return { ok: false, error: 'A GitHub URL or local directory path is required.' };
    }

    const cleaned = url.trim().replace(/\/+$/, '');
    const loader = getSkillLoader();
    if (!loader) {
      return { ok: false, error: 'Skill loader is not initialized.' };
    }

    // Detect local directory vs git URL
    const isLocalPath = /^[a-zA-Z]:[\\/]|^\/|^~\/|^\.\.?[\\/]/.test(cleaned);
    let targetDir;
    let skillDir; // The actual directory containing the skill files

    if (isLocalPath) {
      // Local directory — resolve and symlink into skills/
      const resolved = path.resolve(cleaned);
      if (!fs.existsSync(resolved)) {
        return { ok: false, error: `Directory not found: ${resolved}` };
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { ok: false, error: `Not a directory: ${resolved}` };
      }
      const dirName = path.basename(resolved);
      targetDir = path.join(loader.skillsDirectory, dirName);

      if (fs.existsSync(targetDir)) {
        return { ok: false, error: `Skill "${dirName}" already exists. Remove it first.` };
      }

      try {
        fs.symlinkSync(resolved, targetDir, 'junction');
      } catch (err) {
        return { ok: false, error: `Failed to create symlink: ${err.message}` };
      }
      skillDir = resolved;
    } else {
      // Git URL — clone into skills/
      const strippedGit = cleaned.replace(/\.git$/, '');
      const repoName = path.basename(strippedGit);
      if (!repoName || !/^[a-zA-Z0-9._-]+$/.test(repoName)) {
        return { ok: false, error: `Invalid repository name: ${repoName}` };
      }

      targetDir = path.join(loader.skillsDirectory, repoName);
      if (fs.existsSync(targetDir)) {
        return { ok: false, error: `Directory already exists: ${repoName}. Remove the existing skill first.` };
      }

      try {
        const cloneUrl = cleaned.endsWith('.git') ? cleaned : `${strippedGit}.git`;
        childProcess.execSync(`git clone "${cloneUrl}" "${targetDir}"`, {
          timeout: 60000,
          stdio: 'pipe'
        });
      } catch (err) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (cleanupErr) { console.warn('[skill] cleanup after clone failure failed:', cleanupErr.message); }
        return { ok: false, error: `Git clone failed: ${err.stderr?.toString().trim() || err.message}` };
      }
      skillDir = targetDir;
    }

    // Run npm install if package.json has dependencies
    try {
      const pkgPath = path.join(skillDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
          childProcess.execSync('npm install --production', {
            cwd: skillDir,
            timeout: 120000,
            stdio: 'pipe'
          });
        }
      }
    } catch (err) {
      console.warn(`[skill-install] npm install warning:`, err.message);
    }

    // Load and register the skill
    try {
      const skill = await loader.loadSkill(targetDir);
      if (!skill) {
        return { ok: false, error: `Install succeeded but failed to load skill. Check that it has a valid package.json and entry point.` };
      }
      skillRegistry.register(skill);
      const meta = skill.getMetadata();
      return { ok: true, skillId: meta.id, name: meta.name };
    } catch (err) {
      return { ok: false, error: `Installed but registration failed: ${err.message}` };
    }
  }));

  ipcMain.handle(IPC.SKILL_REMOVE, wrapHandler(IPC.SKILL_REMOVE, async (_event, { skillId } = {}) => {
    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      return { ok: false, error: `Unknown skill: ${skillId}` };
    }

    const skillPath = skill._skillPath;
    if (!skillPath) {
      return { ok: false, error: `Cannot determine install path for skill '${skillId}'.` };
    }

    // Prevent removing builtin skills (those inside the app directory)
    const loader = getSkillLoader();
    if (loader?.builtinSkillsDirectory && skillPath.startsWith(loader.builtinSkillsDirectory)) {
      return { ok: false, error: `Cannot remove built-in skill '${skillId}'.` };
    }

    // Unregister first
    await skillRegistry.unregister(skillId);

    // Clear the require cache for this skill's files
    Object.keys(require.cache).forEach((key) => {
      if (key.startsWith(skillPath)) {
        delete require.cache[key];
      }
    });

    // Delete the directory (or unlink if symlink)
    try {
      const stat = fs.lstatSync(skillPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(skillPath);
      } else {
        fs.rmSync(skillPath, { recursive: true, force: true });
      }
    } catch (err) {
      return { ok: false, error: `Unregistered skill but failed to remove directory: ${err.message}` };
    }

    return { ok: true, skillId, removed: true };
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
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(customization.path, 'utf-8'));
    } catch (err) { console.debug('[skill] customization read failed, starting fresh:', err.message); }

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

  ipcMain.handle(IPC.SKILL_CHECK_DEPS, wrapHandler(IPC.SKILL_CHECK_DEPS, async (_event, { skillId } = {}) => {
    // Clear the runtime environment cache so we get fresh results
    resetRuntimeEnvironmentCache();

    const skill = skillId ? skillRegistry.getSkill(skillId) : null;
    const skills = skillId ? (skill ? [skill] : []) : Array.from(skillRegistry.skills?.values() || []);

    if (skillId && !skill) {
      return { ok: false, error: `Unknown skill: ${skillId}` };
    }

    const results = {};

    for (const s of skills) {
      const metadata = typeof s.getMetadata === 'function' ? s.getMetadata() : {};
      const deps = metadata.systemDependencies;
      if (!Array.isArray(deps) || deps.length === 0) {
        results[metadata.id] = [];
        continue;
      }

      const statuses = await Promise.all(
        deps.map(async (dep) => ({
          command: dep.command,
          name: dep.name || dep.command,
          available: await isCommandAvailable(dep.command),
          required: dep.required !== false,
          installUrl: dep.installUrl || null,
          install: dep.install || null
        }))
      );

      s._dependencyStatus = statuses;
      results[metadata.id] = statuses;
    }

    return { ok: true, results };
  }));
  // --- skill update checking ---

  ipcMain.handle(IPC.SKILL_CHECK_UPDATES, wrapHandler(IPC.SKILL_CHECK_UPDATES, async () => {
    const skills = Array.from(skillRegistry.skills?.values() || []);
    const results = {};

    for (const skill of skills) {
      const skillPath = skill._skillPath;
      if (!skillPath || skill._isSymlink) continue;

      const gitDir = path.join(skillPath, '.git');
      if (!fs.existsSync(gitDir)) continue;

      const meta = typeof skill.getMetadata === 'function' ? skill.getMetadata() : {};
      const skillId = meta.id || path.basename(skillPath);

      try {
        childProcess.execSync('git fetch', { cwd: skillPath, timeout: 30000, stdio: 'pipe' });

        const local = childProcess.execSync('git rev-parse HEAD', { cwd: skillPath, timeout: 5000, stdio: 'pipe' }).toString().trim();
        const remote = childProcess.execSync('git rev-parse @{u}', { cwd: skillPath, timeout: 5000, stdio: 'pipe' }).toString().trim();

        if (local !== remote) {
          // Get the remote version from package.json on the remote branch
          let remoteVersion = null;
          try {
            const remotePkg = childProcess.execSync('git show @{u}:package.json', { cwd: skillPath, timeout: 5000, stdio: 'pipe' }).toString();
            const parsed = JSON.parse(remotePkg);
            remoteVersion = parsed.version || null;
          } catch (err) { console.debug('[skill] remote package.json check failed:', err.message); }

          const behind = childProcess.execSync('git rev-list HEAD..@{u} --count', { cwd: skillPath, timeout: 5000, stdio: 'pipe' }).toString().trim();

          results[skillId] = {
            updateAvailable: true,
            currentVersion: meta.version || null,
            remoteVersion,
            behind: parseInt(behind, 10) || 0
          };
        } else {
          results[skillId] = { updateAvailable: false };
        }
      } catch (err) {
        results[skillId] = { updateAvailable: false, error: err.message };
      }
    }

    return { ok: true, results };
  }));

  ipcMain.handle(IPC.SKILL_UPDATE, wrapHandler(IPC.SKILL_UPDATE, async (_event, { skillId } = {}) => {
    const skill = skillRegistry.getSkill(skillId);
    if (!skill) {
      return { ok: false, error: `Unknown skill: ${skillId}` };
    }

    const skillPath = skill._skillPath;
    if (!skillPath) {
      return { ok: false, error: `Cannot determine install path for skill '${skillId}'.` };
    }

    if (skill._isSymlink) {
      return { ok: false, error: `Skill '${skillId}' is symlinked — update it manually.` };
    }

    const gitDir = path.join(skillPath, '.git');
    if (!fs.existsSync(gitDir)) {
      return { ok: false, error: `Skill '${skillId}' is not a git repository.` };
    }

    try {
      childProcess.execSync('git pull --ff-only', { cwd: skillPath, timeout: 60000, stdio: 'pipe' });
    } catch (err) {
      return { ok: false, error: `Git pull failed: ${err.stderr?.toString().trim() || err.message}` };
    }

    // Re-run npm install if needed
    try {
      const pkgPath = path.join(skillPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
          childProcess.execSync('npm install --production', { cwd: skillPath, timeout: 120000, stdio: 'pipe' });
        }
      }
    } catch (err) {
      console.warn(`[skill-update] npm install warning:`, err.message);
    }

    // Clear require cache for the skill so it reloads fresh
    Object.keys(require.cache).forEach((key) => {
      if (key.startsWith(skillPath)) {
        delete require.cache[key];
      }
    });

    // Unregister old instance, reload, and re-register
    await skillRegistry.unregister(skillId);

    const loader = getSkillLoader();
    try {
      const reloaded = await loader.loadSkill(skillPath);
      if (!reloaded) {
        return { ok: false, error: `Update pulled but failed to reload skill.` };
      }
      skillRegistry.register(reloaded);
      const meta = reloaded.getMetadata();
      return { ok: true, skillId: meta.id, name: meta.name, version: meta.version };
    } catch (err) {
      return { ok: false, error: `Update pulled but reload failed: ${err.message}` };
    }
  }));
}

module.exports = {
  registerSkillHandlers
};