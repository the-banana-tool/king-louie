const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerAgentHandlers(ipcMain, context = {}) {
  const {
    getSettings,
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
    getUsageTracker
  } = context;

  ipcMain.handle(IPC.AGENT_LIST, wrapHandler(IPC.AGENT_LIST, async () => {
    return listAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      model: agent.model,
      inferenceTier: agent.inferenceTier,
      allowedTools: agent.allowedTools
    }));
  }));

  ipcMain.handle(IPC.AGENT_EXECUTE, wrapHandler(IPC.AGENT_EXECUTE, async (event, { agentId, message, tier }) => {
    const settings = getSettings();
    const agent = getAgent(agentId);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const runtime = await createAgentRuntime(
      { tier: tier || agent.inferenceTier || settings?.inference?.activeTier },
      event
    );

    const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
      usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null
    });
    return withNotificationTiming(`Agent ${agent.id}`, async () => {
      const result = await agentExecutor.execute(agent, message, {
        tier: runtime.tier,
        model: runtime.model || agent.model,
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
    const settings = getSettings();
    const runtime = await createAgentRuntime({ tier: settings?.inference?.activeTier }, event);

    const agents = agentIds
      .map((agentId) => getAgent(agentId))
      .filter(Boolean);

    const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
      usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null
    });
    const orchestrator = new AgentOrchestrator(agentExecutor);
    return withNotificationTiming('Parallel agent run', async () => {
      const results = await orchestrator.executeParallel(agents, message, {
        tier: runtime.tier,
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

  ipcMain.handle(IPC.AGENT_EXECUTE_SERIAL, wrapHandler(IPC.AGENT_EXECUTE_SERIAL, async (event, { agentIds = [], message }) => {
    const settings = getSettings();
    const runtime = await createAgentRuntime({ tier: settings?.inference?.activeTier }, event);

    const agents = agentIds
      .map((agentId) => getAgent(agentId))
      .filter(Boolean);

    const agentExecutor = new AgentExecutor(runtime.provider, runtime.toolExecutor, {
      usageTracker: typeof getUsageTracker === 'function' ? getUsageTracker() : null
    });
    const orchestrator = new AgentOrchestrator(agentExecutor);
    return withNotificationTiming('Serial agent run', async () => {
      const results = await orchestrator.executeSerial(agents, message, {
        tier: runtime.tier,
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