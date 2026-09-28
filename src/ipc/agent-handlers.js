const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const { roleForAgent, roleForTier } = require('../models/roles');
const { NO_RETRY } = require('../providers/failover-policy');

function registerAgentHandlers(ipcMain, context = {}) {
  const {
    getAgent,
    listAgents,
    createAgentRuntime,
    AgentExecutor,
    AgentOrchestrator,
    withNotificationTiming,
    buildAgentVoiceOptions,
    speakSummaryText,
    buildAgentCompletionSummary,
    getUserProfile,
    buildTemplateContextFromSettings,
    buildRuntimeSystemPrompt,
    buildMemoryContextSection,
    formatUserContextSection,
    formatProjectContextSection,
    getUsageTracker,
    prompter
  } = context;

  const usageTracker = () => (typeof getUsageTracker === 'function' ? getUsageTracker() : null);

  const fullSystemPrompt = (runtime, memorySection) => [
    buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
    memorySection,
    formatUserContextSection(),
    formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
  ].filter((part) => typeof part === 'string').join('\n\n');

  // One runtime per agent run (models spec 2026-09-27 §8; M2 carry): each
  // agent, and each dependency task, resolves its own role and gets its own
  // routed provider, so concurrent agents never share a route's failover
  // state. `first` is a runtime the handler already built to fail fast; the
  // first run of that agent uses it.
  const perAgentExecutor = (event, systemPromptFor, first = null) => {
    let spare = first;
    return {
      execute: async (agent, message, options = {}) => {
        let runtime;
        // Safe only because the orchestrator dispatches each task
        // synchronously up to its first await, so this check-and-clear of
        // `spare` never races a concurrent call for the same agent.
        if (spare && spare.agentId === agent.id) {
          runtime = spare.runtime;
          spare = null;
        } else {
          runtime = await createAgentRuntime({ role: roleForAgent(agent) }, event);
        }
        const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
          usageTracker: usageTracker(),
          prompter,
          failoverPolicy: NO_RETRY
        });
        return agentExecutor.execute(agent, message, {
          ...options,
          role: runtime.role,
          model: runtime.model,
          timeoutMs: runtime.timeoutMs,
          tools: runtime.toolDefinitions,
          systemPrompt: systemPromptFor(runtime)
        });
      }
    };
  };

  ipcMain.handle(IPC.AGENT_LIST, wrapHandler(IPC.AGENT_LIST, async () => {
    return listAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      role: roleForAgent(agent),
      allowedTools: agent.allowedTools
    }));
  }));

  ipcMain.handle(IPC.AGENT_EXECUTE, wrapHandler(IPC.AGENT_EXECUTE, async (event, { agentId, message, tier, role }) => {
    const agent = getAgent(agentId);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const runtime = await createAgentRuntime(
      { role: (typeof role === 'string' && role) || roleForTier(tier) || roleForAgent(agent) },
      event
    );

    const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
      usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null,
      prompter,
      failoverPolicy: NO_RETRY
    });
    return withNotificationTiming(`Agent ${agent.id}`, async () => {
      const result = await agentExecutor.execute(agent, message, {
        role: runtime.role,
        model: runtime.model,
        timeoutMs: runtime.timeoutMs,
        tools: runtime.toolDefinitions,
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings(),
        systemPrompt: [
          buildRuntimeSystemPrompt(runtime.runtimeEnvironment),
          await buildMemoryContextSection(message),
          formatUserContextSection(),
          formatProjectContextSection(runtime.runtimeEnvironment?.workingDirectory || process.cwd())
        ].join('\n\n')
      });

      const voiceOptions = buildAgentVoiceOptions(agent);
      let voiceResult = null;
      if (voiceOptions.enabled && voiceOptions.speakAgentSummary !== false) {
        voiceResult = await speakSummaryText(
          buildAgentCompletionSummary(agent, result?.content || ''),
          voiceOptions
        );
      }

      return {
        ...result,
        voice: voiceResult
      };
    });
  }));

  ipcMain.handle(IPC.AGENT_EXECUTE_PARALLEL, wrapHandler(IPC.AGENT_EXECUTE_PARALLEL, async (event, { agentIds = [], message }) => {
    const agents = agentIds
      .map((agentId) => getAgent(agentId))
      .filter(Boolean);
    const memorySection = await buildMemoryContextSection(message);
    const orchestrator = new AgentOrchestrator(perAgentExecutor(event, (runtime) => fullSystemPrompt(runtime, memorySection)));
    return withNotificationTiming('Parallel agent run', async () => {
      const results = await orchestrator.executeParallel(agents, message, {
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings()
      });

      await Promise.all(
        (results || []).map(async (result, index) => {
          const agent = agents[index];
          if (!agent) return;
          const voiceOptions = buildAgentVoiceOptions(agent);
          if (!voiceOptions.enabled || voiceOptions.speakAgentSummary === false) {
            return;
          }

          await speakSummaryText(buildAgentCompletionSummary(agent, result?.content || ''), voiceOptions);
        })
      );

      return results;
    });
  }));

  ipcMain.on(IPC.AGENT_USER_RESPONSE, (event, { requestId, response }) => {
    const { pendingAskUserResolvers } = context;
    if (pendingAskUserResolvers && pendingAskUserResolvers.has(requestId)) {
      const { resolve } = pendingAskUserResolvers.get(requestId);
      resolve(response);
      pendingAskUserResolvers.delete(requestId);
    }
  });

  ipcMain.handle(IPC.AGENT_EXECUTE_WITH_DEPS, wrapHandler(IPC.AGENT_EXECUTE_WITH_DEPS, async (event, payload) => {
    let taskConfigs = payload.tasks || [];
    let agentId = payload.agentId || 'code-writer';

    // If planFile is provided, read and parse it
    if (payload.planFile && !taskConfigs.length) {
      const fs = require('fs');
      const planPath = require('path').resolve(payload.planFile);
      const raw = fs.readFileSync(planPath, 'utf-8');
      const plan = JSON.parse(raw);
      taskConfigs = plan.tasks || [];
      agentId = plan.agentId || agentId;
    }

    if (!taskConfigs.length) throw new Error('No tasks provided');

    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const { getTaskManager } = context;
    const taskManager = typeof getTaskManager === 'function' ? getTaskManager() : context.taskManager;
    if (!taskManager) throw new Error('Task manager is not initialized');

    // Resolved once up front, so a role with no usable model fails before
    // any task exists; the first task reuses this runtime.
    const runtime = await createAgentRuntime({ role: roleForAgent(agent) }, event);

    // Create tasks in TaskManager from the provided configs
    const createdTasks = [];
    const idMap = new Map(); // Maps caller-provided id → real task id

    for (const tc of taskConfigs) {
      const task = taskManager.create({
        subject: tc.subject || 'Untitled',
        description: tc.description || '',
        metadata: { agentId: agent.id, ...(tc.metadata || {}) }
      });
      idMap.set(tc.id || task.id, task.id);
      createdTasks.push({ callerKey: tc.id, task });
    }

    // Wire up blockedBy using the id map
    for (const tc of taskConfigs) {
      if (!Array.isArray(tc.blockedBy) || !tc.blockedBy.length) continue;
      const realId = idMap.get(tc.id);
      if (!realId) continue;
      const resolvedBlockers = tc.blockedBy
        .map((dep) => idMap.get(dep))
        .filter(Boolean);
      if (resolvedBlockers.length) {
        taskManager.update(realId, { blockedBy: resolvedBlockers });
      }
    }

    // Also wire up blocks relationships
    for (const tc of taskConfigs) {
      const realId = idMap.get(tc.id);
      if (!realId) continue;
      const blocksIds = (tc.blockedBy || [])
        .map((dep) => idMap.get(dep))
        .filter(Boolean);
      // For each blocker, add this task to its blocks array
      for (const blockerId of blocksIds) {
        const blockerTask = taskManager.get(blockerId);
        if (blockerTask && !blockerTask.blocks.includes(realId)) {
          blockerTask.blocks.push(realId);
        }
      }
    }

    const orchestrator = new AgentOrchestrator(perAgentExecutor(
      event,
      (rt) => fullSystemPrompt(rt, null),
      { agentId: agent.id, runtime }
    ));

    return withNotificationTiming('Dependency-based agent run', async () => {
      const results = await orchestrator.executeWithDependencies(taskManager, [agent], {
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings()
      });

      // Convert Map to serializable object
      const serialized = {};
      for (const [taskId, result] of results) {
        serialized[taskId] = result;
      }
      return { tasks: createdTasks.map((ct) => ({ id: ct.task.id, subject: ct.task.subject, status: ct.task.status })), results: serialized };
    });
  }));

  ipcMain.handle(IPC.AGENT_EXECUTE_SERIAL, wrapHandler(IPC.AGENT_EXECUTE_SERIAL, async (event, { agentIds = [], message }) => {
    const agents = agentIds
      .map((agentId) => getAgent(agentId))
      .filter(Boolean);
    const memorySection = await buildMemoryContextSection(message);
    const orchestrator = new AgentOrchestrator(perAgentExecutor(event, (runtime) => fullSystemPrompt(runtime, memorySection)));
    return withNotificationTiming('Serial agent run', async () => {
      const results = await orchestrator.executeSerial(agents, message, {
        userProfile: getUserProfile(),
        templateContext: buildTemplateContextFromSettings()
      });

      for (let index = 0; index < (results || []).length; index += 1) {
        const agent = agents[index];
        if (!agent) continue;
        const voiceOptions = buildAgentVoiceOptions(agent);
        if (!voiceOptions.enabled || voiceOptions.speakAgentSummary === false) {
          continue;
        }

        await speakSummaryText(buildAgentCompletionSummary(agent, results[index]?.content || ''), voiceOptions);
      }

      return results;
    });
  }));
}

module.exports = {
  registerAgentHandlers
};