// src/agents/child-context.js
// What a child agent run is given (cases stage 3 spec §3.10). By default a
// child gets the owner's memory, profile and project context; an isolated
// child (isolatedContext: true, the case-researcher) gets only the runtime
// section and its own agent prompt, and only its agent's tools.

async function buildChildContext({
  message, options = {}, runtimeSection, memorySection, userSection, projectSection, getUserProfile, baseTemplateContext
}) {
  if (options.isolatedContext === true) {
    return { systemPrompt: runtimeSection, userProfile: null, templateContext: { ...(options.templateContext || {}) } };
  }
  return {
    systemPrompt: [runtimeSection, await memorySection(message), userSection(), projectSection()].join('\n\n'),
    userProfile: getUserProfile(),
    templateContext: { ...baseTemplateContext(), ...(options.templateContext || {}) }
  };
}

function childRuntimeOptions(agent, options = {}) {
  // The parent's origin (program §4.21), read the same way createCore's
  // agentExecutorAdapter reads it: a child of a remote-origin run stays
  // remote-origin. An isolated child with no allowedTools gets an empty
  // allow-list (nothing runs), never "no limit".
  const origin = (options.approvalRequester && options.approvalRequester.origin) || options.origin || null;
  return {
    workingDirectory: options.workingDirectory,
    ...(origin ? { origin } : {}),
    ...(options.guardContext ? { guardContext: options.guardContext } : {}),
    ...(options.isolatedContext === true ? { allowedToolNames: new Set(Array.isArray(agent?.allowedTools) ? agent.allowedTools : []) } : {})
  };
}

module.exports = { buildChildContext, childRuntimeOptions };
