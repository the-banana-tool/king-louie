// The badge on a task's chat (attach stage 2 spec §6.7), from the chat's own fields.
// A plain script of the renderer's, and a module for its test: the renderer has no
// require. The string comes from the node, so it goes on the page by textContent.
function taskBadge(chat) {
  if (!chat || typeof chat.taskId !== 'string' || !chat.taskId) return null;
  return typeof chat.client === 'string' && chat.client ? `Task · ${chat.client}` : 'Task';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { taskBadge };
