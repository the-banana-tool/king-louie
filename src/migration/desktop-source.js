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
const { parseCaseYaml } = require('../cases/case-store');
const { BUILTIN_IDS } = require('../cases/executors/builtins');
const { EXCLUDED, isReservedVaultKey, hasPrototypePart, INSTALL_ID_RE, CASE_DIR_RE, isSkippedCaseFile, caseTreeCounted, safeRelPath, CHANNEL_TOKEN_KEYS, CHANNEL_ALLOWLISTS_KEY, ALLOWLIST_CHANNELS, MAX_CHAT_PART_BYTES, MAX_CHAT_BYTES } = require('./desktop-import');

const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
// A desktop store file or a case file bigger than this is refused rather
// than read into memory (fix round 1): the tree is user-controlled.
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const arr = (v) => (Array.isArray(v) ? v : []);
// What takes a message's place on the node when it cannot be sent at all.
const TOO_LARGE_TEXT = 'This message was too large to move to King Louie Node. The whole message is in the old profile on this computer and in the backup.';
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
// The node measures the whole batch: the message, the entry around it, `chatPart`, and
// part 0's chat head. What a message may be here leaves room for all of that, or a
// message just under the limit is refused there and holds the mark back for good.
const BATCH_WRAPPER_BYTES = 4096;
function messageLimit(chat, maxMessageBytes) {
  const { messages: _messages, ...head } = chat;
  return maxMessageBytes - jsonBytes(head) - BATCH_WRAPPER_BYTES;
}
function withoutTooLarge(chat, maxMessageBytes) {
  const limit = messageLimit(chat, maxMessageBytes);
  const messages = chat.messages.map((m) => (jsonBytes(m) <= limit ? m : {
    ...(m.id ? { id: m.id } : {}), sender: m.sender, ...(m.timestamp ? { timestamp: m.timestamp } : {}), text: TOO_LARGE_TEXT
  }));
  return { ...chat, messages };
}

// electron-store nests a key at each dot, so browser_cred:<profile>:<host.tld> is
// an object under a truncated name. Each entry by its whole key, from the string
// leaves; a key stored flat reads the same. No part of a key may be a prototype
// key. What is there and cannot be read is said, never dropped unsaid.
const VAULT_STORE_PREFIX = '__vault_';
const VAULT_UNREAD_NOTE = 'this stored vault entry is not in a form the move can read; it stays on this computer and in the backup';
const MAX_VAULT_DEPTH = 64;
function readVaultEntries(config, attention) {
  const entries = new Map();
  const unread = (key) => attention.push({ category: 'vault', key, note: VAULT_UNREAD_NOTE });
  const walk = (key, value, depth) => {
    if (!value) return;
    if (!key || hasPrototypePart(key)) unread(key);
    else if (typeof value === 'string') {
      if (entries.has(key)) unread(key);
      else entries.set(key, value);
    } else if (typeof value === 'object' && !Array.isArray(value) && depth < MAX_VAULT_DEPTH) {
      for (const part of Object.keys(value)) walk(`${key}.${part}`, value[part], depth + 1);
    } else unread(key);
  };
  for (const k of Object.keys(config)) {
    if (k.startsWith(VAULT_STORE_PREFIX)) walk(k.slice(VAULT_STORE_PREFIX.length), config[k], 0);
  }
  return entries;
}

// Windows residual (fix round 1, I3): there is no owner check on win32. The
// owner SID of each file could be read through the installers' handle-based
// inspector (src/desktop-bridge/pairing.js inspectWindowsOwners), but that
// compiles and runs PowerShell per call, and this reader is synchronous and
// per file. What holds on Windows is the lstat chain (links, junctions and
// mount points refused), nlink === 1, the handle identity check, and the
// root identity re-check on every call.
function createSafeReader({ root, platform = process.platform, fsImpl = fs, maxFileBytes = MAX_FILE_BYTES }) {
  const rootPath = path.resolve(root);
  const rootStat = fsImpl.lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`${rootPath} is not a directory (links are refused)`);
  const ownerUid = rootStat.uid;
  const checkOwner = platform !== 'win32';
  const c = fsImpl.constants;
  // O_NONBLOCK so a FIFO swapped in after the lstat can't hang the open;
  // O_NOCTTY so a terminal device can never become the controlling tty
  // (fix round 1, I4). Each only where the platform defines it.
  const OPEN_FLAGS = c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0) | (c.O_NOCTTY || 0);

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
    // The root itself is re-checked on every call (fix round 1, I3): a
    // profile directory renamed away and replaced after the reader was
    // built is a different tree, and nothing is read from it.
    let now;
    try {
      now = fsImpl.lstatSync(rootPath);
    } catch (err) {
      return { refused: `${rootPath}: ${err.message}` };
    }
    if (now.isSymbolicLink() || !now.isDirectory() || now.ino !== rootStat.ino || now.dev !== rootStat.dev) {
      return { refused: `${rootPath} was replaced after the import started` };
    }
    let cur = rootPath;
    let st = rootStat;
    for (let i = 0; i < segs.length; i += 1) {
      cur = path.join(cur, segs[i]);
      try {
        st = fsImpl.lstatSync(cur);
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
    if (r.stat.size > maxFileBytes) return { ok: false, reason: `${r.path} is larger than ${maxFileBytes} bytes` };
    let fd;
    try {
      fd = fsImpl.openSync(r.path, OPEN_FLAGS);
      const st = fsImpl.fstatSync(fd);
      if (!st.isFile() || st.ino !== r.stat.ino || st.dev !== r.stat.dev || st.nlink > 1) return { ok: false, reason: `${r.path} changed while it was being read` };
      // Read at most one byte past the cap, so a file that grows after the
      // stat still can't make this read unbounded.
      const chunks = [];
      let total = 0;
      for (;;) {
        const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, maxFileBytes + 1 - total));
        const n = fsImpl.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        chunks.push(buf.subarray(0, n));
        total += n;
        if (total > maxFileBytes) return { ok: false, reason: `${r.path} is larger than ${maxFileBytes} bytes` };
      }
      return { ok: true, data: Buffer.concat(chunks, total) };
    } catch (err) {
      return { ok: false, reason: `${r.path}: ${err.message}` };
    } finally {
      if (fd !== undefined) fsImpl.closeSync(fd);
    }
  }

  // For a file that has to be opened by path (history.sqlite, which SQLite
  // opens itself): readFile's checks without reading the bytes. The open
  // that follows goes by path, so a link swapped in after this check is a
  // residual this narrows but cannot close.
  function checkFile(rel) {
    const r = check(rel);
    if (r.missing) return { ok: false, missing: true };
    if (r.refused) return { ok: false, reason: r.refused };
    if (!r.stat.isFile()) return { ok: false, reason: `${r.path} is not a regular file` };
    if (r.stat.nlink > 1) return { ok: false, reason: `${r.path} has ${r.stat.nlink} hard links` };
    return { ok: true, path: r.path };
  }

  function listDir(rel) {
    const r = check(rel);
    if (r.missing) return { dirs: [], refused: [] };
    if (r.refused) return { dirs: [], refused: [{ relPath: String(rel), reason: r.refused }] };
    const dirs = [];
    const refused = [];
    for (const name of fsImpl.readdirSync(r.path)) {
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
        for (const name of fsImpl.readdirSync(r.path).sort()) walk(sub ? `${sub}/${name}` : name);
        return;
      }
      if (!r.stat.isFile()) { refused.push({ relPath: sub, reason: `${r.path} is not a regular file` }); return; }
      if (r.stat.nlink > 1) { refused.push({ relPath: sub, reason: `${r.path} has ${r.stat.nlink} hard links` }); return; }
      files.push({ relPath: sub, mode: r.stat.mode & 0o777, size: r.stat.size });
    };
    walk('');
    return { files, refused };
  }

  return { root: rootPath, readFile, checkFile, listDir, listFiles };
}

// customRootEmpty: the caller counted the setting's cases root and it holds no
// case, so the profile's own folder is where the cases are. It is how an owner
// with a custom root gets them moved (attach stage 2 §6.5): the setting cannot be
// changed from a window with no core, and the desktop never writes this profile's
// stores. The CLI does not pass it.
function readDesktopSource({ userDataDir, reader, decrypt = null, secrets = decrypt ? 'included' : 'needs-desktop', history = null, customRootEmpty = false, maxMessageBytes = MAX_CHAT_PART_BYTES, maxChatBytes = MAX_CHAT_BYTES }) {
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
  const vaultEntries = readVaultEntries(config, attention);
  // Since history stage H1 a profile's chats live in history.sqlite; any
  // that could not be migrated are still in chat-data.json. The store wins
  // for an id both hold. `history` is readHistoryChats' result, read by the
  // caller first because node:sqlite's backup is async.
  const historyChats = history ? history.chats : [];
  if (history) attention.push(...history.attention);
  const historyIds = new Set(historyChats.map((c) => c.id));
  const chats = [
    ...historyChats,
    ...arr(chatData.chats).filter((c) => c && typeof c.id === 'string' && c.id && !historyIds.has(c.id))
  ];
  const tokens = chatData.apiTokens && typeof chatData.apiTokens === 'object' ? chatData.apiTokens : {};
  // Ids only: a stored default never travels, and a list naming nobody is no
  // list. Who may reach a bot, for a node that takes the bot.
  const channelAllowlist = (channel) => {
    const lists = chatData[CHANNEL_ALLOWLISTS_KEY];
    const held = ALLOWLIST_CHANNELS.includes(channel) && lists && typeof lists === 'object' ? lists[channel] : null;
    if (!held || typeof held !== 'object') return null;
    const users = arr(held.users).map(String);
    const groups = arr(held.groups).map(String);
    return users.length || groups.length ? { users, groups } : null;
  };
  const toolApprovals = chatData.toolApprovals && typeof chatData.toolApprovals === 'object' ? chatData.toolApprovals : {};
  const alwaysApprove = toolApprovals.alwaysApproveTools && typeof toolApprovals.alwaysApproveTools === 'object' ? toolApprovals.alwaysApproveTools : {};
  const oauth = chatData.anthropicOAuth && chatData.anthropicOAuth.accessToken ? chatData.anthropicOAuth : null;
  const casesRootSetting = !customRootEmpty && settings.cases && typeof settings.cases.root === 'string' ? settings.cases.root.trim() : '';
  const memoryEntries = arr(memoryDoc.entries).filter((e) => e && typeof e.id === 'string' && e.id);
  // System jobs (cases stage 2's cases:wakeups) are created by every core for
  // itself and can't be written through the cron API, so they are never sent.
  const cronJobs = Object.values(cronDoc).filter((j) => j && typeof j.id === 'string' && j.id && j.system !== true);

  // The receiving importer refuses a whole case outright if any file in it
  // resolves under a nested (non-top-level) .git segment, or is a bare .git
  // file — isSkippedCaseFile throws for exactly those shapes — and fails
  // the whole case if any relPath breaks safeRelPath's rules (a reserved
  // device name, a trailing dot or space). Rather than send such a case only
  // to have it bounce, the walker runs the same decisions up front and
  // reports it as needs-attention instead (Task 8 fix round 3 carry; Task 9
  // fix round 1 minors). Every other skip/no-skip decision is not applied
  // here — the walker counts and sends every file, landed or skipped, so
  // both sides mean the same thing by "how many files" (M8).
  const refusedCaseNote = (files) => {
    for (const f of files) {
      try {
        safeRelPath(f.relPath);
      } catch (err) {
        return `has a file the service cannot store and cannot be imported (${err.message})`;
      }
      try {
        isSkippedCaseFile(f.relPath);
      } catch (err) {
        return /"\.git" file/.test(err.message)
          ? `has a .git file where a .git directory belongs (a git indirection) and cannot be imported (${err.message})`
          : `contains a nested repository and cannot be imported (${err.message})`;
      }
    }
    return null;
  };

  // The private mark (local inference R-LI-10, kept through a move): a chat's
  // own, its case's, and a case's from any chat of it. What cannot be read is
  // private: a case.yaml that does not parse, and a chat naming a case when not
  // every case could be read.
  for (const c of chats) {
    if (!Object.prototype.hasOwnProperty.call(c, 'private')) continue;
    if (c.private === false) delete c.private;
    else c.private = true;
  }
  const chatMarkedCases = new Set(chats.filter((c) => c.private === true && c.caseId).map((c) => String(c.caseId)));
  const caseIds = new Map(); // case id -> private
  let everyCaseRead = !casesRootSetting;

  const cases = [];
  // A case whose external agent is in the profile's executors folder, which does not
  // move: what the plan says of it, never sent to the node.
  const agentPackages = readAgentPackages(reader);
  const agentCases = [];
  if (!casesRootSetting) {
    const listed = reader.listDir('cases');
    if (listed.refused.length) everyCaseRead = false;
    // wholeCase: the case stays behind whole, so it can never show up as missing
    // from the plan, and a move that says it is done must refuse. A dot directory
    // with no case.yaml is the store's own (.index, .contact.lock): not a case, and
    // no doubt about any chat. One with a case.yaml is a case to CaseStore, which
    // lists every directory that has one, and this move would leave it behind.
    for (const r of listed.refused) attention.push({ category: 'case', key: r.relPath, note: r.reason, wholeCase: true });
    for (const dir of listed.dirs) {
      if (dir === '.index') continue; // cases stage 5: the cross-case index cache, not a case (M9)
      if (!CASE_DIR_RE.test(dir)) {
        const dotMark = dir.startsWith('.') ? readCaseMark(reader, dir) : null;
        const storeOwn = Boolean(dotMark && dotMark.missing);
        if (dotMark && dotMark.id !== null) caseIds.set(dotMark.id, dotMark.private || chatMarkedCases.has(dotMark.id));
        else if (!storeOwn) everyCaseRead = false;
        attention.push({ category: 'case', key: dir, note: 'not a valid case directory name; it was not copied', ...(storeOwn ? {} : { wholeCase: true }) });
        continue;
      }
      const mark = readCaseMark(reader, dir);
      if (mark.id === null) everyCaseRead = false;
      const casePrivate = mark.private || (mark.id !== null && chatMarkedCases.has(mark.id));
      if (mark.id !== null) caseIds.set(mark.id, casePrivate || caseIds.get(mark.id) === true);
      const { files, refused } = reader.listFiles(path.join('cases', dir));
      for (const r of refused) attention.push({ category: 'case', key: `${dir}/${r.relPath}`, note: r.reason });
      const held = refusedCaseNote(files);
      if (held) {
        attention.push({ category: 'case', key: dir, note: held, wholeCase: true });
        continue;
      }
      const agents = caseAgents(reader, dir, mark.type, agentPackages);
      if (agents.length) agentCases.push({ dir, agents });
      const counted = files.filter((f) => caseTreeCounted(f.relPath));
      cases.push({
        dir,
        files: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0),
        head: readCaseHead(reader, dir),
        tree: { files: counted.length, bytes: counted.reduce((n, f) => n + f.size, 0) },
        ...(mark.id !== null ? { caseId: mark.id } : {}),
        ...(casePrivate ? { private: true } : {}),
        ...(mark.movedElsewhere ? { movedElsewhere: true } : {})
      });
    }
  }
  for (const c of chats) {
    if (!c.caseId || c.private === true) continue;
    const known = caseIds.get(String(c.caseId));
    if (known === true || (known === undefined && !everyCaseRead)) c.private = true;
  }

  const inventory = {
    installId,
    sourceVersion: null,
    chats: chats.map((c) => {
      // Only past the limit, so every other chat's entry is as it always was.
      const sizes = arr(c.messages).map(jsonBytes);
      const whole = sizes.reduce((sum, n) => sum + n, 0);
      const largest = sizes.reduce((most, n) => Math.max(most, n), 0);
      const past = whole > maxChatBytes ? { overCapBytes: whole } : (largest > messageLimit(c, maxMessageBytes) ? { tooLargeBytes: largest } : {});
      return { id: c.id, updatedAt: c.updatedAt || null, title: String(c.title || ''), ...past };
    }),
    settingsKeys: Object.keys(settings).filter((k) => !['allowedDirectories', 'webSearch', 'imageGeneration'].includes(k)),
    userProfile: Boolean(chatData.userProfile),
    permissionRules: arr(toolApprovals.permissionRules).filter((r) => r && r.tool && r.action).map((r) => ({ tool: r.tool, pattern: r.pattern || '*', action: r.action })),
    alwaysApprove: Object.keys(alwaysApprove).filter((k) => alwaysApprove[k] === true),
    providerTokens: Object.keys(tokens).filter((k) => tokens[k] && (!k.startsWith('__') || k === '__elevenlabs_api_key')),
    searchKeys: Object.keys(settings.webSearch || {}).filter((p) => settings.webSearch[p] && settings.webSearch[p].apiKey),
    imageKeys: Object.keys(settings.imageGeneration || {}).filter((p) => settings.imageGeneration[p] && settings.imageGeneration[p].apiKey),
    vault: [...vaultEntries.keys()],
    anthropicOAuth: Boolean(oauth),
    channelTokens: CHANNEL_TOKEN_KEYS.filter((k) => tokens[k]),
    channelAllowlists: ALLOWLIST_CHANNELS.filter((c) => channelAllowlist(c)),
    modelProfileIds: arr(settings.models && settings.models.profiles).filter((p) => p && typeof p.id === 'string' && p.id).map((p) => p.id),
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
      case 'vault': return secret(vaultEntries.get(key));
      // Only these names, whatever a plan asks for: the typesafe.ai key and a
      // local server's key sit in the same object and never move.
      case 'channelToken': return CHANNEL_TOKEN_KEYS.includes(key) ? secret(tokens[key]) : null;
      case 'channelAllowlist': return channelAllowlist(key);
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

  return { installId, inventory, attention, getValue, caseFiles, maxMessageBytes, agentCases };
}

// The external agents installed in the profile: each package's executor id.
function readAgentPackages(reader) {
  const ids = [];
  for (const dir of reader.listDir('executors').dirs) {
    const r = reader.readFile(path.join('executors', dir, 'package.json'));
    if (!r.ok) continue;
    try {
      const id = JSON.parse(r.data.toString('utf8'))?.kingLouie?.executor?.id;
      if (typeof id === 'string' && id) ids.push(id);
    } catch { /* not a package */ }
  }
  return ids;
}

// Which of those a case needs: the agents its own executor snapshot names, and for an
// outreach case, whose sends go through an agent, every one when it names none yet.
function caseAgents(reader, dir, type, packages) {
  if (!packages.length) return [];
  let named = [];
  const r = reader.readFile(path.join('cases', dir, '.kl', 'executors.json'));
  if (r.ok) {
    try {
      named = Object.keys(JSON.parse(r.data.toString('utf8')) || {}).filter((id) => !BUILTIN_IDS.includes(id) && packages.includes(id));
    } catch { /* an unreadable snapshot names nobody */ }
  }
  if (named.length) return named;
  return type === 'outreach' ? packages : [];
}

// A case's id and private mark from its case.yaml. A file that is missing or
// does not parse gives no id and counts as private; a `private` that is not
// exactly false is private (CaseRuntime#isPrivate).
function readCaseMark(reader, dir) {
  const unread = { id: null, private: true, movedElsewhere: false, missing: false };
  const r = reader.readFile(path.join('cases', dir, 'case.yaml'));
  if (!r.ok) return { ...unread, missing: Boolean(r.missing) };
  let meta;
  try {
    meta = parseCaseYaml(r.data.toString('utf8'));
  } catch {
    return unread;
  }
  if (!meta) return unread;
  return {
    id: String(meta.id),
    type: typeof meta.type === 'string' ? meta.type : null,
    private: Object.prototype.hasOwnProperty.call(meta, 'private') && meta.private !== false,
    movedElsewhere: meta.status === 'abandoned' && Boolean(meta.statusReason) && meta.statusReason.kind === 'moved'
  };
}

// The commit a case's HEAD names, from its own files, with no git and nothing
// written into the old profile; null when there is none to read.
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
function readCaseHead(reader, dir) {
  const read = (rel) => {
    const r = reader.readFile(path.join('cases', dir, '.git', rel));
    return r.ok ? r.data.toString('utf8') : null;
  };
  const head = read('HEAD');
  if (head === null) return null;
  const text = head.trim();
  if (COMMIT_ID.test(text)) return text;
  const ref = /^ref: (\S+)$/.exec(text);
  if (!ref || ref[1].split('/').includes('..')) return null;
  const loose = read(ref[1]);
  if (loose !== null) return COMMIT_ID.test(loose.trim()) ? loose.trim() : null;
  for (const line of (read('packed-refs') || '').split(/\r?\n/)) {
    const [id, name] = line.split(' ');
    if (name === ref[1] && COMMIT_ID.test(id)) return id;
  }
  return null;
}

// For the one-time move: tries every stored key, and takes the ones that will not
// decrypt out of the inventory, so no plan holds them and nothing counts them as
// missing. Only names are kept; a value that does decrypt is dropped at once. They stay
// sealed in the profile and the backup. Whether so many failing is a wrong environment
// is the caller's to say, from the counts.
const SECRET_LISTS = Object.freeze({ providerToken: 'providerTokens', searchKey: 'searchKeys', imageKey: 'imageKeys', vault: 'vault', channelToken: 'channelTokens' });
function setAsideUnreadableSecrets(source) {
  const inventory = source.inventory;
  // A key that never moves is never opened, and says nothing about the environment.
  const held = Object.entries(SECRET_LISTS).flatMap(([category, list]) => arr(inventory[list]).map((key) => ({ category, key })))
    .filter(({ category, key }) => category !== 'vault' || !isReservedVaultKey(key));
  if (inventory.anthropicOAuth) held.push({ category: 'anthropicOAuth', key: 'anthropicOAuth' });
  const unreadable = held.filter(({ category, key }) => {
    try {
      source.getValue(category, key);
      return false;
    } catch {
      return true;
    }
  });
  for (const { category, key } of unreadable) {
    if (category === 'anthropicOAuth') inventory.anthropicOAuth = false;
    else inventory[SECRET_LISTS[category]] = inventory[SECRET_LISTS[category]].filter((k) => k !== key);
  }
  source.unreadableSecrets = unreadable;
  return { total: held.length, unreadable };
}

// A chat as entries: one when it fits a batch, as it always went; else one per run of
// messages under maxBytes, in order, and a message bigger than that alone. Measured
// message by message: a long chat with its attachments can be more than one string
// can hold.
function chatEntries(item, chat, maxBytes) {
  const { messages, ...head } = chat;
  const room = maxBytes - jsonBytes(head) - 256;
  const parts = [];
  let part = [];
  let size = 0;
  let whole = 0;
  for (const message of messages) {
    const bytes = jsonBytes(message) + 1;
    whole += bytes;
    if (part.length && size + bytes > room) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(message);
    size += bytes;
  }
  if (whole <= room) return [{ category: item.category, key: item.key, value: chat }];
  parts.push(part);
  return parts.map((run, index) => ({
    category: item.category,
    key: item.key,
    value: { ...(index === 0 ? head : { id: chat.id }), messages: run, chatPart: { index, total: parts.length } }
  }));
}

// Apply batches for the plan's write items. Secret values appear only here.
// `chatParts`: the plan said this node takes a chat in parts. Without it, as ever, a
// chat that overflows a batch is skipped.
function* planBatches(planItems, source, { maxBytes = 1900000, chunkBytes = 1024 * 1024, skipped = [], chatParts = false } = {}) {
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
    if (!WRITE_ACTIONS.has(item.action) && item.partial !== true) continue;
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
    if (chatParts && item.category === 'chat' && Array.isArray(value.messages)) {
      for (const entry of chatEntries(item, item.partial === true ? withoutTooLarge(value, source.maxMessageBytes ?? MAX_CHAT_PART_BYTES) : value, maxBytes)) yield* push(entry);
      continue;
    }
    const entry = { category: item.category, key: item.key, value };
    // One entry that alone would overflow a batch can never be sent; the
    // service would refuse the whole batch (fix round 1, I6).
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 3;
    if (bytes > maxBytes) {
      skipped.push({ category: item.category, key: item.key, error: `larger than the ${maxBytes}-byte import batch limit (${bytes} bytes)` });
      continue;
    }
    yield* push(entry);
  }
  if (batch.length) yield batch;
}

module.exports = { createSafeReader, readDesktopSource, planBatches, setAsideUnreadableSecrets, MAX_FILE_BYTES };
