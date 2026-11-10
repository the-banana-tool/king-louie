// The Settings drawer's navigation (settings redesign spec): groups of pages, which
// pages a host offers, search over page labels and keywords, and the page Settings
// opens on. A plain script of the renderer's, and a module for its test: the renderer
// has no require. `tab` is a pane's `data-tab` id; `sections` names the panes a merged
// page holds.
const SETTINGS_GROUPS = Object.freeze([
  {
    id: 'models',
    label: 'Models',
    pages: [
      { tab: 'models', label: 'Model profiles', keywords: ['profile', 'main', 'worker', 'utility', 'vision', 'catalog', 'custom role', 'king louie', 'role', 'model'] },
      { tab: 'providers', label: 'Providers & keys', keywords: ['api key', 'token', 'openrouter', 'openai', 'anthropic', 'brave', 'tavily', 'fal', 'image', 'search', 'gemini', 'ollama', 'key'] },
      { tab: 'local-servers', label: 'Local servers', keywords: ['local', 'ollama', 'lm studio', 'llama.cpp', 'vllm', 'private'] },
    ],
  },
  {
    id: 'chats',
    label: 'Chats',
    pages: [
      { tab: 'general', label: 'New chats', keywords: ['general', 'agent mode', 'default', 'theme'] },
      { tab: 'profile', label: 'About you', keywords: ['profile', 'name', 'about me'] },
      { tab: 'history', label: 'History & recall', keywords: ['recall', 'embedding', 'rerank', 'typesafe', 'jev', 'import'] },
      { tab: 'voice', label: 'Voice', keywords: ['speech', 'read aloud', 'tts', 'microphone'] },
    ],
  },
  {
    id: 'reaching-you',
    label: 'Reaching you',
    pages: [
      { tab: 'notifications', label: 'Notifications', keywords: ['alert', 'ntfy', 'sound'] },
      { tab: 'contact', label: 'Contact ladder', keywords: ['quiet hours', 'ladder', 'digest', 'away', 'breakthrough'] },
      { tab: 'channels', label: 'Telegram & Discord', keywords: ['telegram', 'discord', 'bot', 'channel'] },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    pages: [
      { tab: 'mcp', label: 'MCP servers', keywords: ['mcp', 'server'] },
      { tab: 'skills', label: 'Skills', keywords: ['skill', 'install'] },
      { tab: 'permissions', label: 'Permissions & hooks', sections: ['permissions', 'hooks'], keywords: ['permission', 'allow', 'deny', 'approve', 'hook', 'rule'] },
      { tab: 'scheduler', label: 'Scheduled jobs', keywords: ['cron', 'schedule', 'job'] },
      { tab: 'webhooks', label: 'Webhooks', keywords: ['webhook', 'http'] },
      { tab: 'system-apps', label: 'Apps on this computer', keywords: ['apps', 'discovery', 'programs'] },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    pages: [
      { tab: 'vault', label: 'Vault', keywords: ['secret', 'password', 'credential', 'login'] },
    ],
  },
  {
    id: 'this-computer',
    label: 'This computer',
    pages: [
      { tab: 'service', label: 'Node & connection', keywords: ['node', 'pair', 'attach', 'detach', 'import', 'phone', 'service', 'restart'] },
      { tab: 'diagnostics', label: 'Diagnostics', keywords: ['logs', 'debug', 'data folder'] },
    ],
  },
]);

// Hidden when its own tab is unavailable, or when every section it holds is.
function pageHidden(page, unavailable) {
  if (unavailable.has(page.tab)) return true;
  return Array.isArray(page.sections) && page.sections.length > 0 && page.sections.every((s) => unavailable.has(s));
}

function visibleGroups(groups, unavailableTabs, extraToolPages) {
  const unavailable = new Set(unavailableTabs || []);
  const extra = Array.isArray(extraToolPages) ? extraToolPages : [];
  const out = [];
  for (const group of groups) {
    const pages = [];
    for (const page of group.pages) {
      if (!pageHidden(page, unavailable)) pages.push(page);
      if (group.id === 'tools' && page.tab === 'skills') {
        for (const p of extra) pages.push({ tab: p.tab, label: p.label, keywords: [] });
      }
    }
    if (pages.length) out.push({ id: group.id, label: group.label, pages });
  }
  return out;
}

function hiddenSections(page, unavailableTabs) {
  if (!page || !Array.isArray(page.sections)) return [];
  const unavailable = new Set(unavailableTabs || []);
  return page.sections.filter((s) => unavailable.has(s));
}

function matchSettings(query, groups) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!q) return [];
  const hits = [];
  for (const group of groups) {
    for (const page of group.pages) {
      const words = [page.label, ...(page.keywords || [])];
      if (words.some((w) => String(w).toLowerCase().includes(q))) {
        hits.push({ tab: page.tab, label: page.label, groupLabel: group.label });
      }
    }
  }
  return hits;
}

function resolveInitialTab(lastTab, groups) {
  const pages = groups.flatMap((g) => g.pages);
  if (lastTab && pages.some((p) => p.tab === lastTab)) return lastTab;
  return pages.length ? pages[0].tab : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SETTINGS_GROUPS, visibleGroups, hiddenSections, matchSettings, resolveInitialTab };
}
