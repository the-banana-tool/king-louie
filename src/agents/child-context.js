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

function toolSet(value) {
  if (value == null) return null;
  // Anything but a Set or an Array fails closed: nothing allowed.
  return value instanceof Set || Array.isArray(value) ? new Set(value) : new Set();
}

function childRuntimeOptions(agent, options = {}) {
  // The parent's origin (program §4.21), read the same way createCore's
  // agentExecutorAdapter reads it: a child of a remote-origin run stays
  // remote-origin.
  const origin = (options.approvalRequester && options.approvalRequester.origin) || options.origin || null;
  // An isolated child gets its agent's tools (none listed: nothing runs),
  // never more than the parent run's allowedToolNames.
  let tools = options.isolatedContext === true ? new Set(Array.isArray(agent?.allowedTools) ? agent.allowedTools : []) : null;
  const parentTools = toolSet(options.allowedToolNames);
  if (parentTools) tools = tools ? new Set([...tools].filter((name) => parentTools.has(name))) : parentTools;
  return {
    workingDirectory: options.workingDirectory,
    ...(origin ? { origin } : {}),
    ...(options.guardContext ? { guardContext: options.guardContext } : {}),
    ...(tools ? { allowedToolNames: tools } : {})
  };
}

module.exports = { buildChildContext, childRuntimeOptions };
