// Reads a desktop profile for import (fleet stage 7 §3.8, R51). The tree is
// user-controlled and may be read by root, so the walker lstats every level,
// refuses links (including Windows junctions and other reparse points —
// Node reports those through the same isSymbolicLink() a plain symlink
// gets), hardlinked files and foreign owners, opens with O_NOFOLLOW where
// the platform has it, and checks the opened handle is the inode it
// checked. A refused file is reported, never read.
//
// INSTALL_ID_RE, CASE_DIR_RE and isSkippedCaseFile come from
// ./desktop-import (Task 8) rather than being redefined here, so this
// walker's idea of a valid id/case name/case-file decision can never drift
// out of step with what the receiving importer actually accepts.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EXCLUDED, INSTALL_ID_RE, CASE_DIR_RE, isSkippedCaseFile } = require('./desktop-import');

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
const arr = (v) => (Array.isArray(v) ? v : []);

function createSafeReader({ root, platform = process.platform }) {
  const rootPath = path.resolve(root);
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`${rootPath} is not a directory (links are refused)`);
  const ownerUid = rootStat.uid;
  const checkOwner = platform !== 'win32';

  const parts = (rel) => {
    const segs = String(rel).split(/[\\/]+/).filter(Boolean);
    if (segs.some((s) => s === '.' || s === '..')) return null;
    return segs;
  };

  // lstat every component below root; never follows a link. A Windows
  // junction or other reparse point comes back from fs.lstatSync with
  // isSymbolicLink() === true too (verified: fs.symlinkSync(target, p,
  // 'junction') produces a Stats whose mode is S_IFLNK), so the same check
  // that refuses an ordinary symlink already refuses those.
  function check(rel) {
    const segs = parts(rel);
    if (!segs) return { refused: `${rel} leaves the profile directory` };
    let cur = rootPath;
    let st = rootStat;
    for (let i = 0; i < segs.length; i += 1) {
      cur = path.join(cur, segs[i]);
      try {
        st = fs.lstatSync(cur);
      } catch (err) {
        return err.code === 'ENOENT' ? { missing: true } : { refused: `${cur}: ${err.message}` };
      }
      if (st.isSymbolicLink()) return { refused: `${cur} is a link` };
      if (checkOwner && st.uid !== ownerUid) return { refused: `${cur} is owned by uid ${st.uid}, not by the owner of ${rootPath}` };
      if (i < segs.length - 1 && !st.isDirectory()) return { refused: `${cur} is not a directory` };
    }
    return { path: cur, stat: st };
  }

  function readFile(rel) {
    const r = check(rel);
    if (r.missing) return { ok: false, missing: true };
    if (r.refused) return { ok: false, reason: r.refused };
    if (!r.stat.isFile()) return { ok: false, reason: `${r.path} is not a regular file` };
    if (r.stat.nlink > 1) return { ok: false, reason: `${r.path} has ${r.stat.nlink} hard links` };
    let fd;
    try {
      fd = fs.openSync(r.path, fs.constants.O_RDONLY | NOFOLLOW);
      const st = fs.fstatSync(fd);
      if (st.ino !== r.stat.ino || st.dev !== r.stat.dev || st.nlink > 1) return { ok: false, reason: `${r.path} changed while it was being read` };
      return { ok: true, data: fs.readFileSync(fd) };
    } catch (err) {
      return { ok: false, reason: `${r.path}: ${err.message}` };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function listDir(rel) {
    const r = check(rel);
    if (r.missing) return { dirs: [], refused: [] };
    if (r.refused) return { dirs: [], refused: [{ relPath: String(rel), reason: r.refused }] };
    const dirs = [];
    const refused = [];
    for (const name of fs.readdirSync(r.path)) {
      const sub = check(path.join(String(rel), name));
      if (sub.refused) refused.push({ relPath: path.join(String(rel), name), reason: sub.refused });
      else if (sub.stat && sub.stat.isDirectory()) dirs.push(name);
    }
    return { dirs: dirs.sort(), refused };
  }

  function listFiles(rel) {
    const files = [];
    const refused = [];
    const walk = (sub) => {
      const full = sub ? path.join(String(rel), sub) : String(rel);
      const r = check(full);
      if (r.missing) return;
      if (r.refused) { refused.push({ relPath: sub || '.', reason: r.refused }); return; }
      if (r.stat.isDirectory()) {
        for (const name of fs.readdirSync(r.path).sort()) walk(sub ? `${sub}/${name}` : name);
        return;
      }
      if (!r.stat.isFile()) { refused.push({ relPath: sub, reason: `${r.path} is not a regular file` }); return; }
      if (r.stat.nlink > 1) { refused.push({ relPath: sub, reason: `${r.path} has ${r.stat.nlink} hard links` }); return; }
      files.push({ relPath: sub, mode: r.stat.mode & 0o777, size: r.stat.size });
    };
    walk('');
    return { files, refused };
  }

  return { root: rootPath, readFile, listDir, listFiles };
}

function readDesktopSource({ userDataDir, reader, decrypt = null, secrets = decrypt ? 'included' : 'needs-desktop' }) {
  const attention = [];
  const readJson = (rel) => {
    const r = reader.readFile(rel);
    if (r.ok) {
      try {
        return JSON.parse(r.data.toString('utf8'));
      } catch (err) {
        attention.push({ category: 'source', key: rel, note: `not JSON (${err.message})` });
        return null;
      }
    }
    if (!r.missing) attention.push({ category: 'source', key: rel, note: r.reason });
    return null;
  };

  const chatData = readJson('chat-data.json') || {};
  const config = readJson('config.json') || {};
  const memoryDoc = readJson(path.join('memory', 'memory-store.json')) || {};
  const cronDoc = readJson(path.join('cron', 'jobs.json')) || {};
  const desktopState = readJson('desktop-bridge.json');
  const installId = desktopState && typeof desktopState.installId === 'string' && INSTALL_ID_RE.test(desktopState.installId)
    ? desktopState.installId
    : crypto.createHash('sha256').update(fs.realpathSync.native(userDataDir)).digest('hex').slice(0, 16);

  const settings = chatData.settings && typeof chatData.settings === 'object' ? chatData.settings : {};
  const chats = arr(chatData.chats).filter((c) => c && typeof c.id === 'string' && c.id);
  const tokens = chatData.apiTokens && typeof chatData.apiTokens === 'object' ? chatData.apiTokens : {};
  const toolApprovals = chatData.toolApprovals && typeof chatData.toolApprovals === 'object' ? chatData.toolApprovals : {};
  const alwaysApprove = toolApprovals.alwaysApproveTools && typeof toolApprovals.alwaysApproveTools === 'object' ? toolApprovals.alwaysApproveTools : {};
  const oauth = chatData.anthropicOAuth && chatData.anthropicOAuth.accessToken ? chatData.anthropicOAuth : null;
  const casesRootSetting = settings.cases && typeof settings.cases.root === 'string' ? settings.cases.root.trim() : '';
  const memoryEntries = arr(memoryDoc.entries).filter((e) => e && typeof e.id === 'string' && e.id);
  const cronJobs = Object.values(cronDoc).filter((j) => j && typeof j.id === 'string' && j.id);

  // The receiving importer refuses a whole case outright if any file in it
  // resolves under a nested (non-top-level) .git segment — isSkippedCaseFile
  // throws for exactly that shape. Rather than send such a case only to have
  // it bounce, the walker runs the same decision up front and reports it as
  // needs-attention instead (Task 8 fix round 3 carry: "the walker reports a
  // case containing a nested repo as needs-attention up front rather than
  // sending it"). Every other skip/no-skip decision is not applied here —
  // the walker counts and sends every file, landed or skipped, so both
  // sides mean the same thing by "how many files" (M8).
  const nestedRepoNote = (files) => {
    for (const f of files) {
      try {
        isSkippedCaseFile(f.relPath);
      } catch (err) {
        return err.message;
      }
    }
    return null;
  };

  const cases = [];
  if (!casesRootSetting) {
    const listed = reader.listDir('cases');
    for (const r of listed.refused) attention.push({ category: 'case', key: r.relPath, note: r.reason });
    for (const dir of listed.dirs) {
      if (!CASE_DIR_RE.test(dir)) continue;
      const { files, refused } = reader.listFiles(path.join('cases', dir));
      for (const r of refused) attention.push({ category: 'case', key: `${dir}/${r.relPath}`, note: r.reason });
      const nested = nestedRepoNote(files);
      if (nested) {
        attention.push({ category: 'case', key: dir, note: `contains a nested repository and cannot be imported (${nested})` });
        continue;
      }
      cases.push({ dir, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });
    }
  }

  const inventory = {
    installId,
    sourceVersion: null,
    chats: chats.map((c) => ({ id: c.id, updatedAt: c.updatedAt || null, title: String(c.title || '') })),
    settingsKeys: Object.keys(settings).filter((k) => !['allowedDirectories', 'webSearch', 'imageGeneration'].includes(k)),
    userProfile: Boolean(chatData.userProfile),
    permissionRules: arr(toolApprovals.permissionRules).filter((r) => r && r.tool && r.action).map((r) => ({ tool: r.tool, pattern: r.pattern || '*', action: r.action })),
    alwaysApprove: Object.keys(alwaysApprove).filter((k) => alwaysApprove[k] === true),
    providerTokens: Object.keys(tokens).filter((k) => tokens[k] && (!k.startsWith('__') || k === '__elevenlabs_api_key')),
    searchKeys: Object.keys(settings.webSearch || {}).filter((p) => settings.webSearch[p] && settings.webSearch[p].apiKey),
    imageKeys: Object.keys(settings.imageGeneration || {}).filter((p) => settings.imageGeneration[p] && settings.imageGeneration[p].apiKey),
    vault: Object.keys(config).filter((k) => k.startsWith('__vault_') && config[k]).map((k) => k.slice('__vault_'.length)),
    anthropicOAuth: Boolean(oauth),
    memory: memoryEntries.map((e) => e.id),
    cron: cronJobs.map((j) => ({ id: j.id, name: String(j.name || '') })),
    cases,
    customCasesRoot: casesRootSetting || null,
    allowedDirectories: arr(settings.allowedDirectories).filter((d) => typeof d === 'string' && d),
    excluded: Object.keys(EXCLUDED),
    secrets
  };

  const secret = (encrypted) => {
    if (!decrypt) throw new Error('only the desktop app can read its secrets');
    return encrypted ? decrypt(encrypted) : null;
  };

  function getValue(category, key) {
    switch (category) {
      case 'settings': return settings[key] === undefined ? null : settings[key];
      case 'userProfile': return chatData.userProfile || null;
      case 'permissionRule': {
        const [tool, pattern, action] = String(key).split('|');
        return { tool, pattern, action };
      }
      case 'alwaysApprove': return true;
      case 'allowedDirectory': return key;
      case 'chat': return chats.find((c) => c.id === key) || null;
      case 'memory': return memoryEntries.find((e) => e.id === key) || null;
      case 'cron': return cronJobs.find((j) => j.id === key) || null;
      case 'providerToken': return secret(tokens[key]);
      case 'searchKey': return secret(settings.webSearch && settings.webSearch[key] && settings.webSearch[key].apiKey);
      case 'imageKey': return secret(settings.imageGeneration && settings.imageGeneration[key] && settings.imageGeneration[key].apiKey);
      case 'vault': return secret(config[`__vault_${key}`]);
      case 'anthropicOAuth':
        if (!oauth) return null;
        return {
          accessToken: secret(oauth.accessToken),
          refreshToken: oauth.refreshToken ? secret(oauth.refreshToken) : null,
          expiresAt: oauth.expiresAt ?? null,
          connectedAt: oauth.connectedAt ?? null,
          clientId: typeof chatData.anthropicOAuthClientId === 'string' ? chatData.anthropicOAuthClientId : ''
        };
      default: return null;
    }
  }

  function caseFiles(dir) {
    const base = path.join('cases', dir);
    return reader.listFiles(base).files.map((f) => ({ ...f, read: () => reader.readFile(path.join(base, ...f.relPath.split('/'))) }));
  }

  return { installId, inventory, attention, getValue, caseFiles };
}

// Apply batches for the plan's write items. Secret values appear only here.
function* planBatches(planItems, source, { maxBytes = 1900000, chunkBytes = 1024 * 1024, skipped = [] } = {}) {
  let batch = [];
  let size = 2;
  function* push(entry) {
    const s = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (batch.length && size + s > maxBytes) {
      yield batch;
      batch = [];
      size = 2;
    }
    batch.push(entry);
    size += s;
  }
  for (const item of planItems) {
    if (!WRITE_ACTIONS.has(item.action)) continue;
    if (item.category === 'case') {
      for (const f of source.caseFiles(item.key)) {
        const r = f.read();
        if (!r.ok) { skipped.push({ category: 'case', key: `${item.key}/${f.relPath}`, error: r.reason || 'missing' }); continue; }
        for (let offset = 0; offset === 0 || offset < r.data.length; offset += chunkBytes) {
          yield* push({ category: 'case', key: item.key, value: { relPath: f.relPath, mode: f.mode, offset, b64: r.data.subarray(offset, offset + chunkBytes).toString('base64') } });
        }
      }
      continue;
    }
    let value;
    try {
      value = source.getValue(item.category, item.key);
    } catch (err) {
      skipped.push({ category: item.category, key: item.key, error: err.message });
      continue;
    }
    if (value === null || value === undefined) {
      skipped.push({ category: item.category, key: item.key, error: 'not found in the desktop profile' });
      continue;
    }
    yield* push({ category: item.category, key: item.key, value });
  }
  if (batch.length) yield batch;
}

module.exports = { createSafeReader, readDesktopSource, planBatches };
