/**
 * App Discovery — detects installed desktop applications on the local system.
 *
 * Scans platform-specific locations to find installed apps and maps them
 * to capabilities so agents know what local software is available.
 *
 * Supported platforms: Windows, macOS, Linux
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

/**
 * Known apps and their capability tags.
 * Each entry maps an app identifier to metadata about what it can do.
 * The discovery engine tries to find these on the system.
 */
const APP_CATALOG = [
  // Office / Documents
  { id: 'excel', names: ['excel', 'EXCEL.EXE'], winReg: 'Excel.Application', capabilities: ['spreadsheet', 'csv', 'data-analysis'], category: 'office', description: 'Microsoft Excel — create and edit spreadsheets' },
  { id: 'word', names: ['winword', 'WINWORD.EXE'], winReg: 'Word.Application', capabilities: ['document', 'docx', 'writing'], category: 'office', description: 'Microsoft Word — create and edit documents' },
  { id: 'powerpoint', names: ['powerpnt', 'POWERPNT.EXE'], winReg: 'PowerPoint.Application', capabilities: ['presentation', 'pptx', 'slides'], category: 'office', description: 'Microsoft PowerPoint — create presentations' },
  { id: 'libreoffice-calc', names: ['libreoffice', 'soffice'], macApp: 'LibreOffice', capabilities: ['spreadsheet', 'csv', 'data-analysis'], category: 'office', description: 'LibreOffice Calc — open-source spreadsheet editor' },
  { id: 'google-sheets', names: [], capabilities: ['spreadsheet', 'csv'], category: 'office', webOnly: true, description: 'Google Sheets — browser-based spreadsheets (use Browser tool)' },

  // Code editors
  { id: 'vscode', names: ['code', 'code.cmd'], macApp: 'Visual Studio Code', capabilities: ['code-editor', 'text-editor', 'ide'], category: 'development', description: 'Visual Studio Code — code editor' },
  { id: 'cursor', names: ['cursor', 'cursor.cmd'], macApp: 'Cursor', capabilities: ['code-editor', 'text-editor', 'ide'], category: 'development', description: 'Cursor — AI code editor' },
  { id: 'sublime', names: ['subl', 'sublime_text'], macApp: 'Sublime Text', capabilities: ['code-editor', 'text-editor'], category: 'development', description: 'Sublime Text — text editor' },
  { id: 'notepad++', names: ['notepad++'], capabilities: ['text-editor'], category: 'development', description: 'Notepad++ — advanced text editor' },

  // Browsers
  { id: 'chrome', names: ['chrome', 'google-chrome', 'google-chrome-stable'], macApp: 'Google Chrome', capabilities: ['browser', 'web'], category: 'browser', description: 'Google Chrome — web browser' },
  { id: 'firefox', names: ['firefox'], macApp: 'Firefox', capabilities: ['browser', 'web'], category: 'browser', description: 'Mozilla Firefox — web browser' },
  { id: 'edge', names: ['msedge', 'microsoft-edge'], macApp: 'Microsoft Edge', capabilities: ['browser', 'web'], category: 'browser', description: 'Microsoft Edge — web browser' },

  // Graphics / Media
  { id: 'photoshop', names: ['photoshop'], winReg: 'Photoshop.Application', capabilities: ['image-editing', 'graphics', 'psd'], category: 'graphics', description: 'Adobe Photoshop — image editing' },
  { id: 'figma', names: ['figma'], macApp: 'Figma', capabilities: ['design', 'ui-design', 'prototyping'], category: 'graphics', description: 'Figma — UI design tool' },
  { id: 'gimp', names: ['gimp'], macApp: 'GIMP', capabilities: ['image-editing', 'graphics'], category: 'graphics', description: 'GIMP — open-source image editor' },
  { id: 'obs', names: ['obs', 'obs64'], macApp: 'OBS', capabilities: ['screen-recording', 'streaming', 'video'], category: 'media', description: 'OBS Studio — screen recording and streaming' },
  { id: 'vlc', names: ['vlc'], macApp: 'VLC', capabilities: ['media-player', 'video', 'audio'], category: 'media', description: 'VLC — media player' },
  { id: 'ffmpeg', names: ['ffmpeg'], capabilities: ['video-conversion', 'audio-conversion', 'media-processing'], category: 'media', description: 'FFmpeg — media conversion CLI' },

  // Communication
  { id: 'slack', names: ['slack'], macApp: 'Slack', capabilities: ['messaging', 'team-chat'], category: 'communication', description: 'Slack — team messaging' },
  { id: 'discord', names: ['discord'], macApp: 'Discord', capabilities: ['messaging', 'voice-chat'], category: 'communication', description: 'Discord — chat and voice' },
  { id: 'teams', names: ['teams'], macApp: 'Microsoft Teams', capabilities: ['messaging', 'video-calls', 'meetings'], category: 'communication', description: 'Microsoft Teams — communication platform' },
  { id: 'zoom', names: ['zoom'], macApp: 'zoom.us', capabilities: ['video-calls', 'meetings'], category: 'communication', description: 'Zoom — video conferencing' },

  // Database / Data
  { id: 'dbeaver', names: ['dbeaver'], macApp: 'DBeaver', capabilities: ['database', 'sql', 'data-browser'], category: 'data', description: 'DBeaver — database management tool' },
  { id: 'pgadmin', names: ['pgadmin4'], capabilities: ['database', 'postgresql'], category: 'data', description: 'pgAdmin — PostgreSQL management' },
  { id: 'postman', names: ['postman'], macApp: 'Postman', capabilities: ['api-testing', 'http-client'], category: 'development', description: 'Postman — API testing' },

  // Terminal / Shell
  { id: 'windows-terminal', names: ['wt', 'wt.exe'], capabilities: ['terminal'], category: 'development', description: 'Windows Terminal' },
  { id: 'iterm2', names: [], macApp: 'iTerm', capabilities: ['terminal'], category: 'development', description: 'iTerm2 — macOS terminal' },
  { id: 'wezterm', names: ['wezterm'], capabilities: ['terminal'], category: 'development', description: 'WezTerm — cross-platform terminal' },

  // Utilities
  { id: '7zip', names: ['7z'], capabilities: ['compression', 'archive'], category: 'utility', description: '7-Zip — file archiver' },
  { id: 'everything', names: ['everything', 'es'], capabilities: ['file-search'], category: 'utility', description: 'Everything — instant file search (Windows)' },
];

let discoveryCache = null;
let discoveryCachedAt = 0;
const DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Check if an app is available by trying its command names.
 */
async function isAppAvailable(app) {
  // Try command-line detection first
  for (const name of app.names || []) {
    const lookup = process.platform === 'win32'
      ? `where ${name} 2>NUL`
      : `command -v ${name} 2>/dev/null`;
    try {
      const { stdout } = await execAsync(lookup, { windowsHide: true, timeout: 5000, shell: true });
      if (stdout.trim()) {
        return { found: true, launchCmd: stdout.trim().split('\n')[0].trim() };
      }
    } catch {
      // Not found via this name
    }
  }

  // Platform-specific checks
  if (process.platform === 'win32') {
    return await detectWindows(app);
  } else if (process.platform === 'darwin') {
    return await detectMacOS(app);
  } else {
    return await detectLinux(app);
  }
}

async function detectWindows(app) {
  // Check Windows registry via COM automation class
  if (app.winReg) {
    try {
      await execAsync(
        `powershell -NoProfile -Command "(New-Object -ComObject ${app.winReg}).Visible = $false" 2>$null`,
        { windowsHide: true, timeout: 8000, shell: true }
      );
      return { found: true, launchCmd: app.names[0] || app.id };
    } catch {
      // COM object not registered
    }
  }

  // Check common Windows install paths
  const programDirs = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    path.join(process.env.LOCALAPPDATA || '', 'Programs')
  ].filter(Boolean);

  for (const dir of programDirs) {
    for (const name of app.names || []) {
      const baseName = name.replace(/\.exe$/i, '');
      // Check common patterns
      const candidates = [
        path.join(dir, baseName, `${baseName}.exe`),
        path.join(dir, baseName, `${name}`),
        path.join(dir, `${name}.exe`),
      ];
      for (const candidate of candidates) {
        try {
          await fs.promises.access(candidate, fs.constants.X_OK);
          return { found: true, launchCmd: candidate };
        } catch {
          // Not at this path
        }
      }
    }
  }

  // Start Menu shortcut check for common apps
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-StartApps | Where-Object { $_.Name -like '*${app.id}*' } | Select-Object -First 1 -ExpandProperty AppID"`,
      { windowsHide: true, timeout: 8000, shell: true }
    );
    if (stdout.trim()) {
      return { found: true, launchCmd: `start "" "${stdout.trim()}"`, appId: stdout.trim() };
    }
  } catch {
    // Get-StartApps not available or no match
  }

  return { found: false };
}

async function detectMacOS(app) {
  if (app.macApp) {
    const appPath = `/Applications/${app.macApp}.app`;
    try {
      await fs.promises.access(appPath);
      return { found: true, launchCmd: `open -a "${app.macApp}"` };
    } catch {
      // Not in /Applications
    }

    // Try mdfind (Spotlight)
    try {
      const { stdout } = await execAsync(
        `mdfind "kMDItemKind == 'Application'" -name "${app.macApp}" 2>/dev/null | head -1`,
        { timeout: 5000 }
      );
      if (stdout.trim()) {
        return { found: true, launchCmd: `open "${stdout.trim()}"` };
      }
    } catch {
      // Spotlight not available
    }
  }

  return { found: false };
}

async function detectLinux(app) {
  // Check .desktop files
  const desktopDirs = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(process.env.HOME || '', '.local/share/applications')
  ];

  for (const dir of desktopDirs) {
    for (const name of [app.id, ...(app.names || [])]) {
      const desktopFile = path.join(dir, `${name}.desktop`);
      try {
        await fs.promises.access(desktopFile);
        return { found: true, launchCmd: name };
      } catch {
        // Not found
      }
    }
  }

  return { found: false };
}

/**
 * Discover all installed applications.
 * Returns an array of discovered app objects with their launch commands.
 */
async function discoverApps(options = {}) {
  const now = Date.now();
  if (!options.force && discoveryCache && (now - discoveryCachedAt) < DISCOVERY_CACHE_TTL_MS) {
    return discoveryCache;
  }

  const catalog = options.catalog || APP_CATALOG;
  const concurrency = options.concurrency || 5;

  const results = [];
  // Process in batches to avoid spawning too many processes
  for (let i = 0; i < catalog.length; i += concurrency) {
    const batch = catalog.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (app) => {
        if (app.webOnly) return null; // Skip web-only apps
        try {
          const detection = await isAppAvailable(app);
          if (detection.found) {
            return {
              id: app.id,
              description: app.description,
              capabilities: app.capabilities,
              category: app.category,
              launchCmd: detection.launchCmd,
              appId: detection.appId || null
            };
          }
        } catch {
          // Discovery failed for this app — skip
        }
        return null;
      })
    );
    results.push(...batchResults.filter(Boolean));
  }

  discoveryCache = results;
  discoveryCachedAt = now;
  return results;
}

/**
 * Find apps that match a given capability.
 * e.g., findByCapability('spreadsheet') → [excel, libreoffice-calc]
 */
function findByCapability(capability, discoveredApps = []) {
  const normalized = String(capability).toLowerCase();
  return discoveredApps.filter((app) =>
    app.capabilities.some((c) => c.toLowerCase().includes(normalized))
  );
}

/**
 * Find an app by ID.
 */
function findById(id, discoveredApps = []) {
  return discoveredApps.find((app) => app.id === id) || null;
}

/**
 * Build a summary string for injection into the system prompt.
 */
function buildAppContextSection(discoveredApps = []) {
  if (!discoveredApps.length) return '';

  const byCategory = {};
  for (const app of discoveredApps) {
    const cat = app.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(app);
  }

  const lines = ['Installed local applications (prefer these over generating content via LLM):'];
  for (const [category, apps] of Object.entries(byCategory)) {
    lines.push(`  ${category}:`);
    for (const app of apps) {
      lines.push(`    - ${app.id}: ${app.description} [launch: ${app.launchCmd}]`);
    }
  }
  lines.push('');
  lines.push('When a task can be done with a local app (e.g., creating a spreadsheet, editing an image),');
  lines.push('use the Bash tool to launch the app with the appropriate file. Create the file content first,');
  lines.push('then open it in the local app. For example: create a .xlsx file, then run the launch command to open it in Excel.');

  return lines.join('\n');
}

/**
 * Reset the discovery cache.
 */
function resetDiscoveryCache() {
  discoveryCache = null;
  discoveryCachedAt = 0;
}

// ── Custom / user-managed apps ──────────────────────────────────────────────

let customAppsStore = null;

/**
 * Set the store reference for persisting custom apps.
 * Expected to be an electron-store instance or similar with get/set.
 */
function setCustomAppsStore(store) {
  customAppsStore = store;
}

/**
 * Get user-added custom apps from the store.
 */
function getCustomApps() {
  if (!customAppsStore) return [];
  return customAppsStore.get('customApps', []);
}

/**
 * Add a custom app entry.
 */
function addCustomApp(app) {
  if (!app.id || !app.launchCmd) {
    throw new Error('Custom app requires id and launchCmd');
  }
  const customs = getCustomApps();
  // Replace if same id exists
  const filtered = customs.filter((a) => a.id !== app.id);
  const entry = {
    id: app.id,
    description: app.description || app.id,
    capabilities: Array.isArray(app.capabilities) ? app.capabilities : [],
    category: app.category || 'custom',
    launchCmd: app.launchCmd,
    custom: true
  };
  filtered.push(entry);
  if (customAppsStore) customAppsStore.set('customApps', filtered);
  resetDiscoveryCache();
  return entry;
}

/**
 * Remove a custom app by id.
 */
function removeCustomApp(id) {
  const customs = getCustomApps();
  const filtered = customs.filter((a) => a.id !== id);
  if (customAppsStore) customAppsStore.set('customApps', filtered);
  resetDiscoveryCache();
  return filtered;
}

/**
 * Run full discovery including custom apps.
 * Merges auto-detected apps with user-added custom apps.
 */
async function discoverAllApps(options = {}) {
  const autoApps = await discoverApps({ ...options, force: options.force });
  const customs = getCustomApps();

  // Merge: custom apps override auto-detected ones with same id
  const autoById = new Map(autoApps.map((a) => [a.id, a]));
  for (const custom of customs) {
    autoById.set(custom.id, { ...custom, custom: true });
  }

  return Array.from(autoById.values());
}

module.exports = {
  APP_CATALOG,
  discoverApps,
  discoverAllApps,
  findByCapability,
  findById,
  buildAppContextSection,
  resetDiscoveryCache,
  setCustomAppsStore,
  getCustomApps,
  addCustomApp,
  removeCustomApp
};
