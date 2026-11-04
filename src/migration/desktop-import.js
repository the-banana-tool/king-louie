// Import from a desktop profile into the service (fleet stage 7 §3.8). One
// engine for both sources (the desktop over the bridge, and `import --from`).
// Plans carry ids and keys only; secret values exist only inside apply
// batches and are never logged, reported or written to the manifest.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { DEFAULT_SETTINGS, mergeSettings } = require('../core/settings');
const { resolveCasesRoot } = require('../cases');
const { initRepo, git } = require('../cases/git');
const { parseCaseYaml, newId: newCaseId } = require('../cases/case-store');
const yaml = require('js-yaml');
const UserProfile = require('../telos/user-profile');
const { writeFileAtomic } = require('../desktop-bridge/pairing');
const { MESSAGES, LIMITS } = require('../desktop-bridge/protocol');
const { normalizeDirectory } = require('../desktop-bridge/desktop-scope');
const { guardCheck } = require('../platform/write-guard');
const { hasPrototypePart } = require('../platform/vault');
const { chatsOutOfOrder } = require('./migration-verify');
const { isContactVaultKey } = require('../cases/contact-settings');
const { isLocalServerVaultKey } = require('../models/local-vault-keys');

const log = createLogger('desktop-import');

const PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
// A personal node takes a chat in parts (final review, finding 1). A part is one
// run of messages under the batch limit, except a message bigger than that, which
// goes alone in its own batch up to what a bridge frame or a CLI channel line can
// carry. A message past this cannot be sent at all.
const MAX_CHAT_PART_BYTES = LIMITS.frameBytes - 1024 * 1024;
// What the node holds in memory for one chat while it assembles it.
const MAX_CHAT_BYTES = 512 * 1024 * 1024;
const IMPORTED_SETTINGS_KEYS = Object.freeze(['defaults', 'checkpoints', 'templateVariables', 'notifications', 'voice', 'cases']);
// What a personal node takes besides (attach stage 2 spec C-9). It is the
// owner's own machine and account, and the desktop has no core once it is
// attached, so EXCLUDED's reasons for these do not hold there. EXCLUDED stays
// the fleet's list.
const PERSONAL_SETTINGS_KEYS = Object.freeze(['models', 'channels', 'hooks', 'mcpServers']);
const PERSONAL_CARRIED = new Set(['settings.models', 'settings.channels', 'settings.hooks', 'settings.mcpServers', 'channelTokens']);
const importedSettingsKeys = (hosting) => (hosting === 'personal' ? [...IMPORTED_SETTINGS_KEYS, ...PERSONAL_SETTINGS_KEYS] : [...IMPORTED_SETTINGS_KEYS]);
// The stored names, one by one: never a prefix, which would also take
// __typesafe_api_key and a local server's __local_<id>.
const CHANNEL_TOKEN_KEYS = Object.freeze(['__telegram_bot_token', '__discord_bot_token', '__slack_app_token', '__slack_bot_token']);
// Who may reach a bot: AllowlistManager's store key, per channel. It denies by
// default, so a bot moved without its list refuses everyone.
const CHANNEL_ALLOWLISTS_KEY = 'channelAllowlists';
const ALLOWLIST_CHANNELS = Object.freeze(['telegram', 'discord', 'slack']);
const SECRET_CATEGORIES = new Set(['providerToken', 'searchKey', 'imageKey', 'vault', 'anthropicOAuth', 'channelToken']);
const CATEGORY_ORDER = Object.freeze(['settings', 'userProfile', 'permissionRule', 'alwaysApprove', 'allowedDirectory', 'chat', 'memory', 'cron', 'case', 'providerToken', 'searchKey', 'imageKey', 'vault', 'anthropicOAuth', 'channelToken', 'channelAllowlist', 'excluded']);
const ACTIONS = Object.freeze(['new', 'update', 'copy', 'skip-present', 'skip-excluded', 'needs-attention', 'needs-desktop']);
const WRITE_ACTIONS = new Set(['new', 'update', 'copy']);
const INSTALL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// No leading dot (fix round 1, M7): a top-level case directory named like a
// dotfile (".git", ".kl") could collide with the case's own internals.
const CASE_DIR_RE = /^(?!\.)[A-Za-z0-9._-]{1,128}$/;
const COPY_SUFFIX = ' (from desktop)';
const ELEVENLABS_TOKEN = '__elevenlabs_api_key';
// Allow-listed the same way provider tokens are (fix round 1, M10): a name
// not in this set never reaches a 'new'/'skip-present' action, only
// 'skip-excluded', so an unknown key can't be planned for import.
const KNOWN_SEARCH_KEYS = new Set(['brave', 'tavily']);
const KNOWN_IMAGE_KEYS = new Set(['fal']);

// Windows reserved device names, with or without an extension (fix round 1,
// M7): CON.txt still opens the console device, not a file named CON.txt.
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);
const isReservedDeviceName = (name) => RESERVED_DEVICE_NAMES.has(String(name).split('.')[0].toLowerCase());
// A trailing dot or space is silently stripped by Windows, so "notes." and
// "notes" name the same file there — never obviously true on POSIX, so
// refused everywhere rather than only where it would matter.
const hasTrailingDotOrSpace = (name) => /[. ]$/.test(String(name));
const isValidCaseDir = (dir) => typeof dir === 'string' && CASE_DIR_RE.test(dir) && !isReservedDeviceName(dir) && !hasTrailingDotOrSpace(dir);

// What stays behind, and why (spec §3.8 "Stays behind").
const EXCLUDED = Object.freeze({
  'mesh.identity': 'the desktop mesh identity and peers stay with the desktop',
  gatewayToken: 'the gateway token belongs to the desktop gateway',
  apiStatus: 'provider status is recomputed by the service',
  embeddings: 'embedding caches and context vectors are rebuilt',
  'tool-results': 'tool results stay with the desktop',
  'background-tasks': 'background tasks stay with the desktop',
  checkpoints: 'checkpoints stay with the desktop',
  voice: 'voice files stay with the desktop',
  skills: 'skills, pins and customizations are set up on the service by an administrator',
  workflows: 'workflows are not available while attached',
  webhooks: 'the webhook registry is set up on the service by an administrator',
  'settings.hooks': 'hooks spawn processes; an administrator sets them with the service CLI',
  'settings.mcpServers': 'MCP servers spawn processes; an administrator sets them with the service CLI',
  'settings.channels': 'a chat bot must not answer from two hosts; an administrator sets channels with the service CLI',
  channelTokens: 'bot tokens stay with the desktop',
  'settings.activeProvider': 'model choice moved to profiles; set the models up under Settings → Models on the service',
  'settings.providerModels': 'model choice moved to profiles; set the models up under Settings → Models on the service',
  'settings.inference': 'tiers became profiles; set the models up under Settings → Models on the service',
  // Local inference stage L1 (R-LI-6): settings.models, and with it
  // models.localServers, is not in IMPORTED_SETTINGS_KEYS. On a service a
  // local server comes only from the administrator's service.json, and the
  // core's setSettings keeps the stored models.localServers whatever an
  // import passes. A personal node takes settings.models with the list
  // removed (withoutLocalServers).
  'settings.models': 'model profiles are set up on the service; a local server comes only from the administrator\'s service.json'
});

// A setting that stays behind, on a personal node, in the owner's words. Each its own
// line: the stays-behind list shows a sentence once.
const PERSONAL_SETTING_LINES = Object.freeze({
  playbooks: 'Playbook sources and auto-update do not move. On the node they come only from the playbooks block of its service.json.',
  executors: 'External agents and their settings (the agents a case can send through, the default country code, check timing and your own outbound keywords) do not move. On the node, external agents are set up in its service.json.',
  contactPolicy: 'How questions reach you (contact ladders, quiet hours, breakthrough and digest) does not move. Set it again under Settings > Contact on the node.',
  contact: 'Who you are to the contact channels (your identity and addresses) does not move. On the node they come only from the contact block of its service.json.'
});

// What the owner reads on a carried item: a move that looks complete in a
// count can still leave something to do.
const PERSONAL_NOTES = Object.freeze({
  models: 'profiles, custom roles and King Louie settings; local servers stay behind, and a profile that names one skips it until it is in the node\'s service.json',
  channels: 'the bots answer from the node once it next starts; on a node the owner ids for contact questions come only from the contact block of its service.json',
  hooks: 'on and off choices only; hook folders are not copied',
  mcpServers: 'each starts with the node, as you, in the node\'s working folder unless it names its own; a relative path or a command only your shell finds may need changing'
});
const ALREADY_ON_NODE = 'already set on this node; left as it is';
const ALLOWLIST_NOTE = 'who may reach this bot';
const ALLOWLIST_LEFT_BEHIND = 'this node already has a list for this bot; the desktop\'s list was left behind';
const profilesNotMoved = (n) => `your ${n} model ${n === 1 ? 'profile was' : 'profiles were'} not moved: this node's models were already set up, so they were left as they are; set the ${n === 1 ? 'profile' : 'profiles'} up again under Settings > Models`;
// Trying again cannot help either of these: the plan comes out the same. What
// helps is the owner looking, and removing the node's folder is the last resort,
// after that, with what it would lose named.
const lastResort = (added) => `Two ways keep both copies. If the node's copy is the one you work in, press Not now to open the old standalone mode once, open this case there and choose Moved elsewhere, then plan again. To bring the desktop's copy over as well, close this app, rename the case's folder inside the cases folder of this app's own profile, open the app and plan again: it lands as a second case. Only if nothing in the node's copy matters (${added}), stop the node, remove that folder from its cases folder, and move again.`;
const landedIncomplete = (dir, added) => `${dir} is on this node but an earlier import landed it incomplete, so it does not count as moved, and trying again will not change that. ${lastResort(added)}`;
const caseOnNodeDiffers = (dir, added) => `a folder named ${dir} is on this node and is not this case as the desktop has it (its history or files differ), so it does not count as moved, and trying again will not change that. ${lastResort(added)}`;
const MOVED_OUT_NOTE = 'moved to this node by hand and closed on the desktop as moved elsewhere; the copy on this node is the live one and was left as it is. Anything done in the desktop\'s copy after the move is only in the backup';
const LANDED_NO_RECORD = 'already on this node, its history and files as the desktop has them';
const RESTART_NOTE = 'MCP servers, channel bots and hook choices that moved take effect when the node next starts.';
const SECOND_CASE_NOTE = 'the node has this case under another folder; it lands as a second case, with an id of its own';
// EXCLUDED's reasons are the fleet's. On a personal node the owner is the
// administrator and these panes work, so the line says what he will find.
const PERSONAL_EXCLUDED = Object.freeze({
  skills: 'Skills, their pins and customizations do not move: they stay on this computer, and the node starts without them. Install them again in Settings > Skills on the node.',
  workflows: 'Workflows do not move: they stay on this computer, and the node starts with none. Set them up again in Settings > Workflows on the node.',
  webhooks: 'Webhooks do not move: they stay on this computer. Set them up again in Settings > Webhooks on the node.',
  apiStatus: 'provider status is recomputed by the node',
  embeddings: 'Search over your old chats fills in over time after the node\'s first start: the search index and its model stay on this computer, so the node builds its own in the background, fetching the model if it needs one.'
});
const OLD_MODEL_KEYS = new Set(['settings.activeProvider', 'settings.providerModels', 'settings.inference']);
const OLD_MODELS_REPLACED = 'The old model settings (active provider, provider models and tiers) do not move: your model profiles replaced them.';
const OLD_MODELS_SET_UP = 'The old model settings (active provider, provider models and tiers) do not move, and this profile has no model profile to move: set the models up under Settings > Models on the node.';
const overCapNote = (c) => `chat "${String(c.title || c.id).slice(0, 80)}" is ${(c.overCapBytes / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_CHAT_BYTES / (1024 * 1024)} MB a chat can move in. It does not move: it stays in this computer's copy and in the backup.`;
const tooLargeNote = (c, exists) => `chat "${String(c.title || c.id).slice(0, 80)}" has a message of ${(c.tooLargeBytes / (1024 * 1024)).toFixed(1)} MB, too large to send to the node. ${exists ? 'The node already holds this chat, and it is left as it is.' : 'The chat moves without what that message holds, with a line saying so in its place.'} The whole message stays in this computer's copy and in the backup.`;

// What the Vault tool keeps to itself on a node, read as it reads a key. Such a key
// never moves, on any host: a contact credential and a local server's key are the
// administrator's there.
const isReservedVaultKey = (key) => isContactVaultKey(key) || isLocalServerVaultKey(key);
const reservedVaultNote = (key, where) => (isContactVaultKey(key)
  ? `Vault entry ${key} is a contact channel's credential. It stays on this computer and in the backup: on the ${where}, contact credentials are set only by its administrator.`
  : `Vault entry ${key} is a local server's key. It stays on this computer and in the backup: on the ${where}, a local server and its key come only from its service.json.`);
const vaultBlockedNote = (key, blocker, where) => `Vault entry ${key} was not moved: the ${where} holds ${blocker === key ? 'other entries under that name' : blocker}, and a name cannot hold both. It stays on this computer and in the backup; enter it again under another name if you need it there.`;

// This process, so a landing can tell whether the node has started since.
const NODE_BOOT = crypto.randomUUID();
// What takes effect only when a personal node next starts.
const startsWithNode = (item) => item.category === 'channelToken' || (item.category === 'settings' && ['channels', 'hooks', 'mcpServers'].includes(item.key));

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const itemKey = (category, key) => `${category}:${key}`;
const arr = (v) => (Array.isArray(v) ? v : []);
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const withoutRoot = (cases) => {
  const { root, ...rest } = cases || {};
  return rest;
};
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const withoutLocalServers = (models) => {
  const { localServers, ...rest } = models || {};
  return rest;
};
// Whether the node's models are what its own first start made: the defaults
// and the one Default profile that start creates, which is not the owner
// having chosen anything. A stored local server list says nothing about that.
function modelsUntouched(current, dflt, isFreshProfile) {
  const { profiles = [], defaultProfileId = null, ...rest } = withoutLocalServers(current);
  const { profiles: _p, defaultProfileId: _d, ...base } = withoutLocalServers(dflt);
  if (stable(rest) !== stable(base)) return false;
  if (profiles.length === 0) return defaultProfileId === null;
  return profiles.length === 1 && profiles[0].id === defaultProfileId && isFreshProfile(profiles[0]);
}
// Whether a stored setting is one the move would carry and is not the default. The
// one profile a first start makes is nobody having chosen anything; the fleet does
// not ask.
function settingsWouldMove(settings) {
  let merged;
  try {
    merged = mergeSettings(settings);
  } catch {
    return false;
  }
  const base = mergeSettings(DEFAULT_SETTINGS);
  return importedSettingsKeys('personal').filter((key) => settings[key] !== undefined).some((key) => {
    if (key === 'cases') return stable(withoutRoot(merged.cases)) !== stable(withoutRoot(base.cases));
    if (key !== 'models') return stable(merged[key]) !== stable(base[key]);
    // models.kingLouie is the suggester's, written with nobody choosing anything.
    const { profiles = [], defaultProfileId: _id, kingLouie: _k, ...rest } = withoutLocalServers(merged.models);
    const { profiles: _p, defaultProfileId: _d, kingLouie: _b, ...plain } = withoutLocalServers(base.models);
    return profiles.length > 1 || stable(rest) !== stable(plain);
  });
}
// What a value comes to on either side, for telling whether the node already holds
// the desktop's (a plan carries ids and keys, never settings). Over the merged value,
// without what never moves. A desktop with no profiles leaves the node its own, so
// its models are compared without them.
const digestOf = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');
function settingDigest(key, value, { profiles = true } = {}) {
  if (key === 'cases') return digestOf(withoutRoot(value));
  if (key !== 'models') return digestOf(value);
  const { profiles: _p, defaultProfileId: _d, kingLouie: _k, ...rest } = withoutLocalServers(value);
  return digestOf(profiles ? withoutLocalServers(value) : rest);
}
const userProfileDigest = (profile) => digestOf(new UserProfile().normalizeProfile({ ...UserProfile.getDefaultProfile(), ...(profile || {}) }));

function countActions(items) {
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  for (const item of items) counts[item.action] = (counts[item.action] || 0) + 1;
  return counts;
}

// A relative path inside a case: no NUL, not absolute, no drive letter, no
// '.'/'..'/empty segments, no segment that is a Windows reserved device name
// or ends in a dot or space (fix round 1, M7 — these apply per segment, not
// just to the case directory name itself, since any of them could name a
// file the import writes).
function safeRelPath(relPath) {
  const text = String(relPath);
  if (text.includes('\0')) throw new ImportError('BAD_PATH', 'a NUL byte is not allowed in a case path');
  const norm = text.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) throw new ImportError('BAD_PATH', `${text} escapes the case directory`);
  const parts = norm.split('/');
  for (const s of parts) {
    if (s === '' || s === '.' || s === '..') throw new ImportError('BAD_PATH', `${text} escapes the case directory`);
    if (isReservedDeviceName(s)) throw new ImportError('BAD_PATH', `${text} uses a reserved device name`);
    if (hasTrailingDotOrSpace(s)) throw new ImportError('BAD_PATH', `${text} has a trailing dot or space`);
  }
  return parts.join('/');
}

// Whether a case file's name can't be stored on this host (fix round 4,
// ruling (c)). On Windows a ':' in a path segment names an NTFS alternate
// data stream, not a file: ".git::$INDEX_ALLOCATION" reaches the very
// directory ".git" names. Such a file is skipped with an attention note
// rather than refused, so a case holding a name that's legal on macOS or
// Linux ("10:30 call.md") still lands minus that file. Elsewhere ':' is an
// ordinary character; the canonical backstop still refuses the write if the
// name ever resolves somewhere this import doesn't write.
const unstorableOnHost = (rel) => process.platform === 'win32' && rel.split('/').some((s) => s.includes(':'));

// Whether `segment` is ".git" itself, or one of the names a filesystem can
// resolve to the very same directory entry without the segment ever
// literally spelling ".git" (fix round 3, C1, after the reviewer's probe
// found NTFS answers to more than the literal name):
//   - a trailing dot or space — NTFS/FAT silently strip these when
//     resolving a path, so ".git." and ".git " address the same directory
//     ".git" does. (safeRelPath's own hasTrailingDotOrSpace check runs on
//     every segment already, but throws outright; that's wrong for THIS
//     name specifically, which needs the *same* leading-.git/ handling a
//     literal ".git" gets, not a hard refusal that would apply even to an
//     unrelated file that happens to end in a dot.)
//   - the 8.3 short name NTFS auto-assigns to ".git" (and to any later
//     colliding entry): GIT~1, GIT~2, … — this is exactly git's own
//     is_ntfs_dotgit() rule, for the same reason git itself needs it.
// (".git::$INDEX_ALLOCATION", the NTFS alternate-data-stream route to the
// same directory, is caught by unstorableOnHost on Windows, where it's
// skipped, never written.)
function isDotGitSegment(segment) {
  const stripped = String(segment).replace(/[.\s]+$/, '');
  if (stripped.toLowerCase() === '.git') return true;
  return /^git~\d+$/i.test(stripped);
}

// Given the lowercased segments of a path already known to sit under a
// leading .git/ (segs[0] is a .git alias per isDotGitSegment), whether the
// rest of it is one of the few things this import trusts there: HEAD,
// objects/** (except objects/info/**, see below), refs/**, packed-refs,
// info/exclude.
//
// objects/info/** is excluded even though it's under objects/** (fix round
// 3, item 2): objects/info/alternates (and http-alternates) tell git to
// also read objects from another object store entirely. A UNC path there
// makes git open that share as the service account — leaking its NTLM
// credentials to whoever controls it — and a path relative to another
// case's directory reads that case's objects into this one.
function isAllowedUnderDotGit(segs) {
  if (segs.length === 2 && (segs[1] === 'head' || segs[1] === 'packed-refs')) return true;
  if (segs[1] === 'objects' && segs[2] === 'info') return false;
  if (segs[1] === 'objects' || segs[1] === 'refs') return true;
  if (segs.length === 3 && segs[1] === 'info' && segs[2] === 'exclude') return true;
  return false;
}

// What the import may write, may silently drop, or must refuse outright,
// for a case file (fix round 1 C1, hardened in fix round 2 and round 3
// after the reviewer's probes found bypasses). Matched case-insensitively,
// per path segment.
//
// Round 1 blocked only the exact paths .git/config, .git/hooks/** and
// .kl/no-hooks/** at the top of the case. The reviewer's probe showed two
// ways past that: a ".git" *file* at the case root containing
// "gitdir: inner/.git" (a normal git indirection — "gitfile" — that makes
// git treat inner/.git as the real git directory for the whole working
// tree), and a nested "inner/.git/config" (first path segment "inner", so
// the old check's `segs[0] === '.git'` test never even looked at it). A
// .gitattributes file naming a filter defined in that nested config, run on
// `git add`, then executed the filter as the service account.
//
// Round 2's rule is an allow-list for what a LEADING .git/ may contain,
// plus two outright refusals that a silent skip cannot express: a ".git"
// segment anywhere but the very start of the path (closes the
// "inner/.git/config" and ".git/modules/x/config" routes — no legitimate
// case file ever needs a nested git directory), and a bare ".git" *file*.
// Both refusals throw — the caller must never plant them, not even to skip
// them — unlike a plain skip, which is a normal, "accepted but not
// written" outcome counted the same way a landed file is (fix round 2,
// M8).
//
// Round 3: every place this checked `segs[i] === '.git'` literally now
// checks isDotGitSegment(segs[i]) instead — NTFS resolves "GIT~1/config" to
// the very directory ".git/config" would name, once ".git" itself exists
// (created, e.g., by a preceding ".git/HEAD" landing), and the segment
// comparison never saw it. See DesktopImporter#writeCaseFile for the
// second layer this round adds: re-checking the *canonical* path after
// ensureRealDirs, in case some other aliasing this function doesn't yet
// know about slips a write under the real .git anyway.
//
// Exported so the M8 count on the receiving side, and Task 9's desktop-side
// walker, use exactly this decision — never a hand-rolled copy that could
// silently drift out of step with what actually lands.
function isSkippedCaseFile(rel) {
  const segs = rel.toLowerCase().split('/');
  if (segs.length === 2 && segs[0] === '.kl' && segs[1] === 'lock') return true;
  if (segs[0] === '.kl' && segs[1] === 'no-hooks') return true;
  for (let i = 1; i < segs.length; i++) {
    if (isDotGitSegment(segs[i])) throw new ImportError('BAD_PATH', `${rel} has a .git segment that is not at the start of the path`);
  }
  if (!isDotGitSegment(segs[0])) return false;
  if (segs.length === 1) throw new ImportError('BAD_PATH', `${rel}: a ".git" file is not allowed`);
  return !isAllowedUnderDotGit(segs);
}

// Before trusting a landed (or about-to-be-initialized) case directory to
// initRepo, make sure its .git — if present at all — really is a directory
// (fix round 2, C1): defence in depth alongside isSkippedCaseFile's refusal
// of a bare ".git" file, in case that file ever reached disk by some other
// route than a case-file write.
function assertGitDirSafe(caseDir) {
  const gitPath = path.join(caseDir, '.git');
  let st;
  try {
    st = fs.lstatSync(gitPath);
  } catch {
    return; // absent — initRepo will create it fresh
  }
  if (!st.isDirectory()) throw new ImportError('BAD_PATH', `${gitPath} exists but is not a directory`);
}

// Null when the repository has no commit yet (a case with no history is fine)
// or its index now matches HEAD; otherwise what is wrong with its history.
async function rebuildIndexFromHead(dir) {
  try {
    await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    return null;
  }
  try {
    await git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    await git(dir, ['read-tree', 'HEAD']);
    return null;
  } catch (err) {
    return String((err && err.message) || err).split(/\r?\n/)[0];
  }
}

// What a case's working tree is counted over, on the desktop and on the node
// alike: not .git, not what never lands (.kl/lock, .kl/no-hooks, a name this host
// cannot store), and not the .gitattributes the host itself writes to.
function caseTreeCounted(rel) {
  const first = String(rel).split('/')[0];
  if (isDotGitSegment(first) || String(rel).toLowerCase() === '.gitattributes' || unstorableOnHost(String(rel))) return false;
  try {
    return !isSkippedCaseFile(String(rel));
  } catch {
    return false;
  }
}

async function nodeTreeTotals(dir) {
  const totals = { files: 0, bytes: 0 };
  const walk = async (rel) => {
    for (const entry of await fs.promises.readdir(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!(rel === '' && isDotGitSegment(entry.name))) await walk(child);
      } else if (entry.isFile() && caseTreeCounted(child)) {
        totals.files += 1;
        totals.bytes += (await fs.promises.lstat(path.join(dir, ...child.split('/')))).size;
      }
    }
  };
  await walk('');
  return totals;
}

// What a landing recorded of its source, to tell later whether the source is still
// what landed. Null for what the inventory did not say.
const sourceRecord = (c) => ({
  head: typeof c.head === 'string' && c.head ? c.head : null,
  tree: c.tree && Number.isInteger(c.tree.files) && Number.isInteger(c.tree.bytes) ? { files: c.tree.files, bytes: c.tree.bytes } : null,
  clean: typeof c.clean === 'boolean' ? c.clean : null
});

const sameSource = (a, b) => Boolean(a && b && a.tree && b.tree)
  && a.head === b.head && a.clean === b.clean && a.tree.files === b.tree.files && a.tree.bytes === b.tree.bytes;

// The commit HEAD names, or null when there is none to read.
async function nodeHeadOf(dir) {
  try {
    return (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

const repoIsWhole = (dir) => git(dir, ['fsck', '--connectivity-only', '--no-dangling', '--no-progress']);

// A landing on record whose source still equals what landed. Whatever the node
// did since is its own work, but its repository must still be whole.
async function recordedLandingHolds(dir, entry, source) {
  if (!entry || !sameSource(entry.landedFrom, sourceRecord(source))) return false;
  try {
    const nodeHead = await nodeHeadOf(dir);
    if (nodeHead === null) return !source.head;
    await repoIsWhole(dir);
    return true;
  } catch {
    return false;
  }
}

function nodeCasePrivate(dir) {
  try {
    const meta = parseCaseYaml(fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8'));
    return Boolean(meta) && meta.private === true;
  } catch {
    return false;
  }
}

function nodeCaseId(dir) {
  try {
    const meta = parseCaseYaml(fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8'));
    return meta ? String(meta.id) : null;
  } catch {
    return null;
  }
}

// What removing the node's folder would lose, as far as git can say. Counted from
// the commit that landed when that is on record, else the source's HEAD; when the
// node knows neither, the histories cannot be told apart, and it says only that.
async function whatTheNodeAdded(dir, ...bases) {
  const parts = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  try {
    let ahead = null;
    for (const base of bases) {
      if (ahead === null && base) ahead = await git(dir, ['rev-list', '--count', `${base}..HEAD`]).catch(() => null);
    }
    if (ahead !== null && Number(ahead) > 0) parts.push(`${plural(Number(ahead), 'commit')} made on the node`);
    if (ahead === null) parts.push(`a history of ${plural(Number(await git(dir, ['rev-list', '--count', 'HEAD'])), 'commit')} that is not the desktop's`);
    const changes = (await git(dir, ['status', '--porcelain'])).split(/\r?\n/).filter(Boolean).length;
    if (changes > 0) parts.push(plural(changes, 'uncommitted change'));
  } catch { /* said below */ }
  return parts.length ? `it holds ${parts.join(' and ')}, and anything else the node wrote there` : 'and anything the node wrote there';
}

// Whether a case directory already on the node is the desktop's. Its repository
// must be whole (fsck reaches every object, an old blob included). At the
// source's HEAD its files must count and weigh what the source's do, which also
// proves a dirty source landed as it stood and sees a missing ignored file; a
// source known clean also needs a clean tree here. Ahead of the source's HEAD
// (the node went on) the tree has moved, so the only proof is that the source had
// nothing beyond that commit (a source not known clean is a no), and that no file
// of that commit has gone: a sweep commits a loss like anything else. Any doubt is a no.
async function caseMatchesSource(dir, source) {
  const { head, tree, clean } = source;
  if (!tree || !Number.isInteger(tree.files) || !Number.isInteger(tree.bytes)) return false;
  const sameTree = async () => {
    const totals = await nodeTreeTotals(dir);
    return totals.files === tree.files && totals.bytes === tree.bytes;
  };
  const cleanHere = async () => (await git(dir, ['status', '--porcelain'])).trim() === '';
  try {
    const nodeHead = await nodeHeadOf(dir);
    if (typeof head !== 'string' || !head) return nodeHead === null && sameTree();
    if (nodeHead === null) return false;
    await repoIsWhole(dir);
    if (nodeHead === head) return (await sameTree()) && (clean !== true || cleanHere());
    if (clean !== true) return false;
    await git(dir, ['merge-base', '--is-ancestor', head, nodeHead]);
    if ((await git(dir, ['diff', '--no-renames', '--diff-filter=D', '--name-only', head, 'HEAD'])).trim() !== '') return false;
    return cleanHere();
  } catch {
    return false;
  }
}

// Whether `child` is strictly inside `parent`. Compares the *first path
// segment* of the relative path, not a raw string prefix (fix round 1, M6):
// path.relative can legitimately return a string that starts with the two
// characters ".." without meaning "go up a directory" — a file literally
// named "..notes.md" resolves to a relative path of "..notes.md", which
// starts with ".." as a substring but is a single segment naming a file
// inside `parent`, not an escape. Only a segment that IS exactly ".." means
// "go up".
const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
};

// The backstop behind isSkippedCaseFile (fix round 3, widened in fix round
// 4). isSkippedCaseFile judges the spelling the desktop sent, but the
// filesystem can resolve that spelling to a different real path: NTFS
// answers to 8.3 short names ("GIT~1" for .git, a hash form such as
// "KL50A7~1" for .kl), and there may be aliasing nobody has listed yet.
// Once ensureRealDirs has made target's parent exist, ask the filesystem
// (fs.realpathSync.native) for the real path, rebuild the relPath from it
// relative to the real case directory, and run the full skip/refuse
// decision on that rebuilt path. Refuse when it refuses or skips: the
// spelling said "write this", the real name says "never write this". Round
// 3 only rechecked "is it under .git", which let
// "<.kl's short name>/no-hooks/pre-commit" land as .kl/no-hooks/pre-commit.
// If realpath fails, refuse too: a path the filesystem can't name is not
// one to write.
function assertCanonicalPathAllowed(caseDir, target, rel) {
  const refuse = (why) => new ImportError('BAD_PATH', `${rel} resolves to a different path by its real filesystem name (${why}), and this import does not write it`);
  let canonicalRel;
  try {
    const realCaseDir = fs.realpathSync.native(caseDir);
    let exists = true;
    try { fs.lstatSync(target); } catch { exists = false; }
    // An existing target is resolved whole, so a short name in the file
    // name itself is expanded too; a new one can only be the name given.
    const realTarget = exists
      ? fs.realpathSync.native(target)
      : path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target));
    canonicalRel = path.relative(realCaseDir, realTarget);
  } catch (err) {
    throw refuse(`it could not be resolved: ${err.message}`);
  }
  if (!canonicalRel || path.isAbsolute(canonicalRel) || canonicalRel.split(path.sep)[0] === '..') throw refuse('outside the case');
  const canonical = canonicalRel.split(path.sep).join('/');
  let skipped;
  try {
    skipped = isSkippedCaseFile(canonical);
  } catch (err) {
    throw refuse(err.message);
  }
  if (skipped) throw refuse(canonical);
}

class DesktopImporter {
  // `cleanupStaging: false` skips the constructor's orphaned-staging sweep: a
  // dry run must not delete anything (Task 9 fix round 1, I1). `writeGuard`
  // (src/platform/write-guard.js) is passed only by the admin CLI's writer,
  // which on Windows writes as an Administrator inside a data dir the
  // service account controls (C1); every write, mkdir and removal below then
  // refuses a path that runs through a link. The bridge passes neither and
  // behaves as before.
  constructor({
    context, targets, dataDir, scope, checkPath, cipher = null,
    now = () => new Date(),
    randomId = () => crypto.randomBytes(8).toString('hex'),
    onPathWritten = () => {},
    cleanupStaging = true,
    writeGuard = null,
    hosting = 'service',
    bootId = NODE_BOOT,
    maxChatBytes = MAX_CHAT_BYTES
  }) {
    this.maxChatBytes = maxChatBytes;
    this.context = context;
    this.personal = hosting === 'personal';
    this.bootId = bootId;
    this.where = this.personal ? 'node' : 'service';
    this.settingsKeys = importedSettingsKeys(hosting);
    this.targets = targets;
    this.dataDir = dataDir;
    this.scope = scope;
    this.checkPath = checkPath;
    this.cipher = cipher;
    this.now = now;
    this.randomId = randomId;
    this.onPathWritten = onPathWritten;
    this.writeGuard = writeGuard;
    this.plans = new Map();
    if (cleanupStaging) this.cleanupOrphanedStaging();
  }

  // Why something the desktop holds stays behind: the fleet's words, or the node's.
  excludedNote(key, inventory) {
    if (!this.personal) return EXCLUDED[key] || 'stays with the desktop';
    if (OLD_MODEL_KEYS.has(key)) return arr(inventory.modelProfileIds).length ? OLD_MODELS_REPLACED : OLD_MODELS_SET_UP;
    return PERSONAL_EXCLUDED[key] || EXCLUDED[key] || 'stays with the desktop';
  }

  // Why a setting the desktop holds does not move.
  settingStaysNote(key, inventory) {
    if (!this.personal) return EXCLUDED[`settings.${key}`] || 'this setting is managed on the service';
    if (Object.hasOwn(PERSONAL_SETTING_LINES, key)) return PERSONAL_SETTING_LINES[key];
    return Object.hasOwn(EXCLUDED, `settings.${key}`) ? this.excludedNote(`settings.${key}`, inventory) : `The setting ${key} does not move: it stays on this computer.`;
  }

  // Whether the node still holds its own default for a setting, so an import
  // may fill it in.
  settingUntouched(key, settings, defaults) {
    if (key === 'models') return modelsUntouched(settings.models, defaults.models, this.context.isFreshModelProfile);
    if (key === 'cases') return stable(withoutRoot(settings.cases)) === stable(withoutRoot(defaults.cases));
    return stable(settings[key]) === stable(defaults[key]);
  }

  casesRoot() {
    return resolveCasesRoot({ settings: this.context.getSettings(), dataDir: this.dataDir });
  }

  // A staging directory (.import-<planId>) is normally removed by finish()
  // (success or failure) or by dropPlan() (expiry, connection close). One can
  // still be orphaned if the process exits between apply() and finish() —
  // there's no plan left in memory to expire, so nothing would ever clean it
  // up (fix round 1, M9). Best-effort and non-fatal: a resolution failure or
  // a removal failure just gets logged, never thrown from the constructor.
  cleanupOrphanedStaging() {
    let root;
    try {
      root = this.casesRoot();
    } catch (err) {
      log.warn('could not resolve the cases root to clean up orphaned import staging directories', { error: err.message });
      return;
    }
    try {
      guardCheck(this.writeGuard, root);
    } catch (err) {
      log.warn('not cleaning up orphaned import staging directories', { error: err.message });
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return; // cases root doesn't exist yet — nothing to clean up
    }
    for (const name of entries) {
      if (!name.startsWith('.import-')) continue;
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      } catch (err) {
        log.warn('could not remove an orphaned import staging directory', { dir: name, error: err.message });
      }
    }
  }

  manifestPath(installId) {
    return path.join(this.dataDir, 'imports', `desktop-${installId}.json`);
  }

  readManifest(installId) {
    try {
      const doc = JSON.parse(fs.readFileSync(this.manifestPath(installId), 'utf8'));
      if (doc && doc.v === 1 && doc.items && typeof doc.items === 'object') {
        return { v: 1, installId, runs: arr(doc.runs), items: doc.items, ...(typeof doc.restartBoot === 'string' ? { restartBoot: doc.restartBoot } : {}) };
      }
    } catch { /* no manifest yet */ }
    return { v: 1, installId, runs: [], items: {} };
  }

  writeManifest(manifest) {
    const dir = path.join(this.dataDir, 'imports');
    const file = this.manifestPath(manifest.installId);
    guardCheck(this.writeGuard, file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.onPathWritten(dir);
    guardCheck(this.writeGuard, file);
    writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    this.onPathWritten(file);
  }

  // Something from this desktop landed that waits for the node's next start, on record
  // at once and through any later try: a retry plans it as already there and writes
  // nothing, and a cut-off may never reach finish. Under the node's own start, so a node
  // that has started since runs it already.
  noteStartsWithNode(plan, item, out, value) {
    if (!this.personal || out.note || !startsWithNode(item)) return;
    // An empty list, or the defaults, started nothing new.
    if (item.category === 'settings') {
      const landed = mergeSettings({ [item.key]: value })[item.key];
      if (landed === undefined || landed === null || (isPlainObject(landed) && !Object.keys(landed).length)) return;
      if (stable(landed) === stable(mergeSettings(DEFAULT_SETTINGS)[item.key])) return;
    }
    const manifest = this.readManifest(plan.installId);
    if (manifest.restartBoot === this.bootId) return;
    this.writeManifest({ ...manifest, restartBoot: this.bootId });
  }

  expire() {
    const now = this.now().getTime();
    for (const [planId, plan] of this.plans) {
      if (now - plan.createdAt > PLAN_TTL_MS) this.dropPlan(planId);
    }
  }

  dropPlan(planId) {
    this.plans.delete(planId);
    try {
      const staging = path.join(this.casesRoot(), `.import-${planId}`);
      guardCheck(this.writeGuard, staging);
      fs.rmSync(staging, { recursive: true, force: true });
    } catch { /* nothing staged, or not safe to touch */ }
  }

  expireConnection(connectionId) {
    for (const [planId, plan] of this.plans) {
      if (plan.connectionId === connectionId) this.dropPlan(planId);
    }
  }

  getPlan(planId) {
    this.expire();
    const plan = this.plans.get(planId);
    if (!plan) throw new ImportError('PLAN_EXPIRED', 'The import plan expired; plan the import again.');
    return plan;
  }

  // A copy's id is fixed by the desktop, the chat and the version being copied, so
  // a retry after a cut-off (the manifest is written only at finish) finds its
  // own copy and writes no second one. A chat at that id with another stamp is the
  // node's by now, and is never overwritten: the next id is taken.
  copyTarget(installId, chat, chats) {
    for (let n = 0; ; n += 1) {
      const digest = crypto.createHash('sha256').update(`${installId}\0${chat.id}\0${chat.updatedAt}\0${n}`).digest('hex');
      const id = `${chat.id}-${digest.slice(0, 8)}`;
      const held = chats.find((c) => c.id === id);
      if (!held) return { id, landed: false };
      if (held.updatedAt === chat.updatedAt) return { id, landed: true };
    }
  }

  async plan({ installId, inventory, source = 'bridge', connectionId = null } = {}) {
    if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId)) throw new ImportError('BAD_REQUEST', 'installId must be 1-64 letters, digits or dashes');
    if (!inventory || typeof inventory !== 'object') throw new ImportError('BAD_REQUEST', 'an inventory is required');
    this.expire();
    const manifest = this.readManifest(installId);
    const done = (category, key) => {
      const entry = manifest.items[itemKey(category, key)];
      return entry && entry.result === 'ok' ? entry : null;
    };
    const items = [];
    const add = (category, key, action, note = null, targetKey = key) => items.push({ category, key: String(key), action, note, targetKey: targetKey === null ? null : String(targetKey) });

    const settings = this.context.getSettings();
    const defaults = mergeSettings(DEFAULT_SETTINGS);
    for (const key of arr(inventory.settingsKeys)) {
      if (!this.settingsKeys.includes(key)) { add('settings', key, 'skip-excluded', this.settingStaysNote(key, inventory)); continue; }
      // What landed, or what was never different: nothing to write.
      const digests = isPlainObject(inventory.settingDigests) ? inventory.settingDigests : {};
      if (Object.hasOwn(digests, key) && digests[key] === settingDigest(key, settings[key], { profiles: arr(inventory.modelProfileIds).length > 0 })) { add('settings', key, 'skip-present'); continue; }
      const carried = PERSONAL_SETTINGS_KEYS.includes(key);
      if (this.settingUntouched(key, settings, defaults)) { add('settings', key, 'new', carried ? PERSONAL_NOTES[key] : null); continue; }
      // A skip reads as done, so profiles this node does not hold are said
      // outright: the owner would otherwise end the move without them.
      const held = new Set(arr(settings.models && settings.models.profiles).map((p) => p && p.id));
      const lacking = key === 'models' ? arr(inventory.modelProfileIds).filter((id) => !held.has(id)) : [];
      if (lacking.length) add('settings', key, 'needs-attention', profilesNotMoved(lacking.length));
      else add('settings', key, 'skip-present', carried ? ALREADY_ON_NODE : null);
    }

    if (inventory.userProfile) {
      const same = inventory.userProfileDigest && inventory.userProfileDigest === userProfileDigest(this.targets.userProfile.get());
      add('userProfile', 'userProfile', !same && stable(this.targets.userProfile.get()) === stable(UserProfile.getDefaultProfile()) ? 'new' : 'skip-present');
    }

    const rules = this.context.getPermissionRules();
    for (const r of arr(inventory.permissionRules)) {
      if (!r || !r.tool || !['allow', 'ask', 'deny'].includes(r.action)) continue;
      const pattern = r.pattern || '*';
      const exists = rules.some((x) => x.tool === r.tool && (x.pattern || '*') === pattern && x.action === r.action);
      add('permissionRule', `${r.tool}|${pattern}|${r.action}`, exists ? 'skip-present' : 'new');
    }

    const approvals = (this.context.getStore().get('toolApprovals', {}) || {}).alwaysApproveTools || {};
    for (const tool of arr(inventory.alwaysApprove)) {
      add('alwaysApprove', tool, approvals[tool] ? 'skip-present' : 'new', 'applies only to runs started from the desktop');
    }

    // Both sides normalized before comparing (fix round 1, I2): the
    // desktop's own list is already normalized, but the service's raw
    // settings.allowedDirectories is exactly as last written, and the
    // incoming inventory entry is whatever the desktop happened to spell it
    // as. Comparing without normalizing both sides misses a re-spelling
    // (trailing separator, drive-letter case) of a directory that's already
    // allowed, and plans it as 'new' when it's really already present.
    const desktopNormalized = this.scope.listDirectories().map((d) => normalizeDirectory(d)).filter(Boolean);
    const serviceNormalized = arr(settings.allowedDirectories).map((d) => normalizeDirectory(d)).filter(Boolean);
    for (const dir of arr(inventory.allowedDirectories)) {
      if (typeof dir !== 'string' || !dir) continue;
      const normalized = normalizeDirectory(dir);
      if (!normalized) { add('allowedDirectory', dir, 'needs-attention', `${dir} is not an absolute directory path`); continue; }
      if (desktopNormalized.includes(normalized) || serviceNormalized.includes(normalized)) { add('allowedDirectory', dir, 'skip-present'); continue; }
      const check = await this.checkPath(normalized);
      if (check.readable && check.isDirectory) add('allowedDirectory', dir, 'new', 'applies only to runs started from the desktop');
      else add('allowedDirectory', dir, 'needs-attention', `the ${this.where} cannot read ${dir}`);
    }

    const chats = this.context.listChats({ messages: false });
    // Remembers the live updatedAt an 'update' action was planned against,
    // so apply() can tell whether the service's copy is still the one the
    // plan looked at (fix round 1, I4) before overwriting it.
    const chatExpected = new Map();
    const addCopy = (c, note) => {
      const { id, landed } = this.copyTarget(installId, c, chats);
      add('chat', c.id, landed ? 'skip-present' : 'copy', landed ? 'its copy from an earlier try is already on this node' : note, id);
    };
    for (const c of arr(inventory.chats)) {
      if (!c || typeof c.id !== 'string' || !c.id) continue;
      // Shown before the press, and landed as far as it can be. It is not a write
      // action, so nothing here counts it as moved and no check asks for it.
      if (this.personal && Number.isFinite(c.overCapBytes)) {
        add('chat', c.id, 'needs-attention', overCapNote(c));
        continue;
      }
      if (this.personal && Number.isFinite(c.tooLargeBytes)) {
        const held = chats.some((x) => x.id === c.id || x.id === done('chat', c.id)?.targetKey);
        add('chat', c.id, 'needs-attention', tooLargeNote(c, held));
        if (!held) items[items.length - 1].partial = true;
        continue;
      }
      const entry = done('chat', c.id);
      if (entry) {
        const target = chats.find((x) => x.id === entry.targetKey);
        const sourceChanged = c.updatedAt !== entry.sourceUpdatedAt;
        const targetChanged = !target || target.updatedAt !== entry.targetUpdatedAt;
        if (!sourceChanged) add('chat', c.id, 'skip-present', null, entry.targetKey);
        else if (!targetChanged) { add('chat', c.id, 'update', null, entry.targetKey); chatExpected.set(entry.targetKey, target.updatedAt); }
        else addCopy(c, 'changed on both sides; imported as a copy');
        continue;
      }
      const existing = chats.find((x) => x.id === c.id);
      if (!existing) add('chat', c.id, 'new');
      else if (existing.updatedAt === c.updatedAt) add('chat', c.id, 'skip-present');
      else addCopy(c, 'a different chat with this id exists; imported as a copy');
    }

    for (const id of arr(inventory.memory)) {
      add('memory', id, done('memory', id) || this.targets.memory.has(id) ? 'skip-present' : 'new');
    }
    for (const job of arr(inventory.cron)) {
      if (!job || !job.id) continue;
      add('cron', job.id, done('cron', job.id) || this.targets.cron.has(job.id) ? 'skip-present' : 'new', 'imported disabled');
    }

    if (inventory.customCasesRoot) {
      add('case', inventory.customCasesRoot, 'needs-attention', `cases under a custom cases.root (${inventory.customCasesRoot}) are not copied; move them by hand`);
    }
    const root = this.casesRoot();
    // What the inventory said a case should land with, kept so finish() can
    // tell a short delivery (fix round 1, M8) from a complete one.
    const caseExpected = new Map();
    // A case the owner renamed on the desktop lands beside the node's copy, and two
    // cases cannot share an id: every lookup would find the first. Its chats follow.
    const caseIdRemap = new Map();
    const heldCaseIds = this.personal && fs.existsSync(root) ? new Set(fs.readdirSync(root).map((d) => nodeCaseId(path.join(root, d))).filter(Boolean)) : new Set();
    for (const c of arr(inventory.cases)) {
      const dir = c && c.dir;
      if (!isValidCaseDir(dir)) { add('case', String(dir), 'needs-attention', 'not a valid case directory name'); continue; }
      const exists = fs.existsSync(path.join(root, dir));
      if (!exists) {
        const secondId = typeof c.caseId === 'string' && heldCaseIds.has(c.caseId) ? newCaseId() : null;
        add('case', dir, 'new', secondId ? SECOND_CASE_NOTE : null);
        if (secondId) caseIdRemap.set(c.caseId, secondId);
        caseExpected.set(dir, {
          files: Number.isFinite(c.files) ? c.files : null,
          bytes: Number.isFinite(c.bytes) ? c.bytes : null,
          private: c.private === true,
          landedFrom: this.personal ? sourceRecord(c) : null,
          secondId
        });
      // The owner moved this one by hand and closed the desktop's copy: the node
      // has the live one, and the two are meant to differ. Only if it is that case.
      // Before the checks below: this is what their words tell him to do.
      } else if (this.personal && c.movedElsewhere === true && nodeCaseId(path.join(root, dir)) === c.caseId) {
        add('case', dir, 'needs-attention', done('case', dir)?.incomplete ? `${MOVED_OUT_NOTE}; its earlier landing was incomplete` : MOVED_OUT_NOTE);
      } else if (done('case', dir)?.incomplete) {
        add('case', dir, 'needs-attention', landedIncomplete(dir, await whatTheNodeAdded(path.join(root, dir), done('case', dir).landedFrom?.head, c.head)));
        items[items.length - 1].incomplete = true;
      } else if (!this.personal) {
        if (done('case', dir)) add('case', dir, 'skip-present');
        else add('case', dir, 'needs-attention', `a case with this directory already exists on the ${this.where}`);
      // On record, and the source is what landed: the node's own work since (its
      // sweep commits what it finds within a minute) is no reason to doubt it.
      } else if (await recordedLandingHolds(path.join(root, dir), done('case', dir), c)) {
        add('case', dir, 'skip-present');
      // No record, or a source that has changed since: compared, never assumed.
      } else if (await caseMatchesSource(path.join(root, dir), c)) {
        add('case', dir, 'skip-present', LANDED_NO_RECORD);
      } else {
        add('case', dir, 'needs-attention', caseOnNodeDiffers(dir, await whatTheNodeAdded(path.join(root, dir), done('case', dir)?.landedFrom?.head, c.head)));
        items[items.length - 1].incomplete = true;
      }
    }

    const secretMode = inventory.secrets || 'included';
    const tokens = this.context.getApiTokens() || {};
    const knownTokens = new Set([...Object.keys(this.context.providerLabels || {}), ELEVENLABS_TOKEN]);
    const secret = (category, key, present) => {
      if (present) return add(category, key, 'skip-present');
      if (secretMode === 'needs-desktop') return add(category, key, 'needs-desktop', 'only the desktop app can read its secrets; import from Settings > Local service');
      if (secretMode === 'unavailable') return add(category, key, 'needs-attention', MESSAGES.SECURE_STORAGE_UNAVAILABLE);
      return add(category, key, 'new');
    };
    for (const p of arr(inventory.providerTokens)) {
      if (!knownTokens.has(p)) { add('providerToken', p, 'skip-excluded', `not a provider key this ${this.where} uses`); continue; }
      secret('providerToken', p, Boolean(tokens[p]));
    }
    for (const p of arr(inventory.searchKeys)) {
      if (!KNOWN_SEARCH_KEYS.has(p)) { add('searchKey', p, 'skip-excluded', `not a search provider key this ${this.where} uses`); continue; }
      secret('searchKey', p, Boolean(settings.webSearch && settings.webSearch[p] && settings.webSearch[p].apiKey));
    }
    for (const p of arr(inventory.imageKeys)) {
      if (!KNOWN_IMAGE_KEYS.has(p)) { add('imageKey', p, 'skip-excluded', `not an image provider key this ${this.where} uses`); continue; }
      secret('imageKey', p, Boolean(settings.imageGeneration && settings.imageGeneration[p] && settings.imageGeneration[p].apiKey));
    }
    const where = this.where;
    for (const k of arr(inventory.vault)) {
      if (isReservedVaultKey(k)) { add('vault', k, 'skip-excluded', reservedVaultNote(k, where)); continue; }
      if (hasPrototypePart(k)) { add('vault', k, 'skip-excluded', `Vault entry ${k} stays on this computer: its name cannot be stored.`); continue; }
      const held = this.context.vault.holds(k);
      const blocker = held ? null : this.context.vault.blockedBy(k);
      if (blocker) add('vault', k, 'needs-attention', vaultBlockedNote(k, blocker, where));
      else if (held) add('vault', k, 'skip-present', `already on this ${where}: the value there was left as it is, and the two were not compared`);
      else secret('vault', k, false);
    }
    if (inventory.anthropicOAuth) {
      const stored = this.context.getStore().get('anthropicOAuth');
      secret('anthropicOAuth', 'anthropicOAuth', Boolean(stored && stored.accessToken));
    }
    for (const p of arr(inventory.channelTokens)) {
      if (!this.personal) { add('channelToken', p, 'skip-excluded', EXCLUDED.channelTokens); continue; }
      if (!CHANNEL_TOKEN_KEYS.includes(p)) { add('channelToken', p, 'skip-excluded', 'not a channel token this node uses'); continue; }
      secret('channelToken', p, Boolean(tokens[p]));
    }
    // Not secret, and a fleet plan does not mention it: a fleet node's bots
    // are set up there, as they always were.
    if (this.personal) {
      const lists = this.context.getStore().get(CHANNEL_ALLOWLISTS_KEY, {}) || {};
      for (const channel of arr(inventory.channelAllowlists)) {
        if (!ALLOWLIST_CHANNELS.includes(channel)) continue;
        const held = lists[channel] || {};
        if (arr(held.users).length || arr(held.groups).length) add('channelAllowlist', channel, 'skip-present', ALLOWLIST_LEFT_BEHIND);
        else add('channelAllowlist', channel, 'new', ALLOWLIST_NOTE);
      }
    }
    for (const key of arr(inventory.excluded)) {
      if (this.personal && PERSONAL_CARRIED.has(key)) continue;
      add('excluded', key, 'skip-excluded', this.excludedNote(key, inventory));
    }

    items.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
    const planId = this.randomId();
    this.plans.set(planId, {
      planId, installId, source, connectionId,
      createdAt: this.now().getTime(),
      items: new Map(items.map((i) => [itemKey(i.category, i.key), i])),
      results: new Map(),
      caseFiles: new Map(),
      caseExpected,
      chatExpected,
      chatParts: new Map(),
      caseIdRemap
    });
    log.info(`planned a desktop import: ${items.length} items`, { planId, source });
    return { planId, items, counts: countActions(items), ...(this.personal ? { chatParts: true } : {}) };
  }

  async apply({ planId, batch } = {}) {
    const plan = this.getPlan(planId);
    if (!Array.isArray(batch)) throw new ImportError('BAD_REQUEST', 'batch must be an array');
    const batchBytes = Buffer.byteLength(JSON.stringify(batch));
    const onePart = this.personal && batch.length === 1 && batch[0] && batch[0].category === 'chat' && batchBytes <= MAX_CHAT_PART_BYTES;
    if (batchBytes > MAX_BATCH_BYTES && !onePart) throw new ImportError('BATCH_TOO_LARGE', 'an import batch is at most 2 MiB');
    const results = [];
    for (const entry of batch) {
      const category = entry && entry.category;
      const key = entry ? String(entry.key) : '';
      const k = itemKey(category, key);
      const item = plan.items.get(k);
      if (!item || (!WRITE_ACTIONS.has(item.action) && item.partial !== true)) {
        results.push({ category, key, ok: false, error: 'not planned for import' });
        continue;
      }
      try {
        const out = (await this.write(plan, item, entry.value)) || {};
        this.noteStartsWithNode(plan, item, out, entry.value);
        if (out.pending) {
          results.push({ category, key, ok: true });
          continue;
        }
        results.push(out.note ? { category, key, ok: true, note: out.note } : { category, key, ok: true });
        if (category !== 'case') plan.results.set(k, { ok: true, note: out.note || null, attention: Boolean(out.attention), incomplete: this.personal && Boolean(out.incomplete), record: out.record || null });
      } catch (err) {
        log.warn(`importing ${category}${SECRET_CATEGORIES.has(category) ? '' : ` ${key}`} failed: ${err.message}`);
        results.push({ category, key, ok: false, error: err.message });
        plan.chatParts.delete(key);
        if (category === 'case') {
          const files = plan.caseFiles.get(key) || { count: 0, bytes: 0, failed: null, seen: new Map() };
          files.failed = files.failed || err.message;
          plan.caseFiles.set(key, files);
        } else {
          plan.results.set(k, { ok: false, error: err.message });
        }
      }
    }
    return { results };
  }

  requireCipher() {
    if (this.cipher && !this.cipher.isEncryptionAvailable()) throw new ImportError('ENCRYPTION_UNAVAILABLE', `Encryption unavailable in the ${this.where}.`);
  }

  requireSecretString(value) {
    if (typeof value !== 'string' || !value) throw new ImportError('BAD_VALUE', 'the secret value is missing');
  }

  async write(plan, item, value) {
    const ctx = this.context;
    switch (item.category) {
      case 'settings': {
        const s = ctx.getSettings();
        if (!this.settingUntouched(item.key, s, mergeSettings(DEFAULT_SETTINGS))) return { note: `already set on the ${this.where}; left unchanged` };
        if (PERSONAL_SETTINGS_KEYS.includes(item.key) && !isPlainObject(value)) throw new ImportError('BAD_VALUE', `settings.${item.key} is not an object`);
        let next = value;
        if (item.key === 'cases') next = { ...withoutRoot(value), ...(s.cases && s.cases.root !== undefined ? { root: s.cases.root } : {}) };
        if (item.key === 'models') {
          // setSettings keeps the stored local server list whatever it is
          // given; off the value too, so nothing downstream ever holds the
          // desktop's. A desktop with no profiles leaves the node its own.
          next = withoutLocalServers(value);
          if (!arr(next.profiles).length) next = { ...next, profiles: s.models.profiles, defaultProfileId: s.models.defaultProfileId };
        }
        ctx.setSettings({ ...s, [item.key]: next });
        return {};
      }
      case 'userProfile': {
        // Written only if the service's profile is still the default one
        // (fix round 1, I4): re-checked here, not just at plan time, since
        // the owner could have filled it in between plan() and apply().
        if (stable(this.targets.userProfile.get()) !== stable(UserProfile.getDefaultProfile())) {
          return { note: `a profile was set on the ${this.where} after the plan was made; not overwritten` };
        }
        this.targets.userProfile.update(value && typeof value === 'object' ? value : {});
        return {};
      }
      case 'permissionRule': {
        const [tool, pattern, action] = item.key.split('|');
        if (!value || value.tool !== tool || (value.pattern || '*') !== pattern || value.action !== action) throw new ImportError('BAD_VALUE', 'the rule does not match the plan');
        // Through the scope (fix round 1, I3), so the desktop owns the
        // imported rule (can later remove it itself) and the scope's own
        // ownership check — never replace a rule the service already
        // holds — applies to an imported rule exactly as it does to one
        // added interactively. 'allow' rules are permitted; spec §8 does
        // not exclude them, only hooks/MCP/channels.
        //
        // The scope can refuse this silently (a race since plan() also
        // matched — the service claimed the key in between); its return
        // value says which, so that refusal is reported rather than
        // appearing to have imported the rule (fix round 2, residual I3).
        const added = this.scope.addPermissionRule({ tool, pattern, action, source: 'desktop-import' });
        return added ? {} : { note: `kept the ${this.where}'s rule` };
      }
      case 'alwaysApprove':
        ctx.setToolAlwaysApprove(item.key, true);
        return {};
      case 'allowedDirectory': {
        const check = await this.checkPath(item.key);
        if (!check.readable || !check.isDirectory) throw new ImportError('PATH_NOT_ACCESSIBLE', `the ${this.where} cannot read ${item.key}`);
        this.scope.addDirectory(item.key);
        return {};
      }
      case 'chat':
        return value && value.chatPart ? this.collectChatPart(plan, item, value) : this.writeChat(plan, item, value);
      case 'memory': {
        if (!value || value.id !== item.key) throw new ImportError('BAD_VALUE', 'the memory entry does not match the plan');
        const out = this.targets.memory.importEntry(value);
        return out.imported ? {} : { note: 'already present' };
      }
      case 'cron': {
        if (!value || value.id !== item.key) throw new ImportError('BAD_VALUE', 'the cron job does not match the plan');
        // System jobs (C2's cases:wakeups) belong to the receiving core, which
        // creates its own. The offline import --from writer adds straight to the
        // cron store, so refuse one here whatever the desktop sent.
        if (value.system === true) throw new ImportError('BAD_VALUE', `a system job is not imported; the ${this.where} makes its own`);
        // Written only if the id is still absent (fix round 1, I4).
        if (this.targets.cron.has(item.key)) {
          return { note: `a cron job with this id was added to the ${this.where} after the plan was made; not overwritten` };
        }
        await this.targets.cron.addJob({ ...value, enabled: false });
        return { note: 'imported disabled' };
      }
      case 'case':
        return this.writeCaseFile(plan, item, value);
      case 'providerToken': {
        this.requireCipher();
        this.requireSecretString(value);
        const tokens = { ...(ctx.getApiTokens() || {}) };
        // Written only if still absent (fix round 1, I4).
        if (tokens[item.key]) {
          return { note: `a token for this provider was added to the ${this.where} after the plan was made; not overwritten` };
        }
        tokens[item.key] = ctx.encryptToken(value);
        ctx.setApiTokens(tokens);
        return {};
      }
      case 'searchKey':
      case 'imageKey': {
        this.requireCipher();
        this.requireSecretString(value);
        const s = ctx.getSettings();
        const section = item.category === 'searchKey' ? 'webSearch' : 'imageGeneration';
        const current = { ...(s[section] || {}) };
        // Written only if still absent (fix round 1, I4).
        if (current[item.key] && current[item.key].apiKey) {
          return { note: `a key for this provider was added to the ${this.where} after the plan was made; not overwritten` };
        }
        current[item.key] = { ...(current[item.key] || {}), apiKey: ctx.encryptToken(value) };
        ctx.setSettings({ ...s, [section]: current });
        return {};
      }
      case 'vault': {
        this.requireCipher();
        this.requireSecretString(value);
        // Written only if still absent (fix round 1, I4).
        if (ctx.vault.holds(item.key) || ctx.vault.blockedBy(item.key)) {
          return { note: `a secret with this name was added to the ${this.where} after the plan was made; not overwritten` };
        }
        ctx.vault.set(item.key, value);
        if (ctx.vault.get(item.key) !== value) throw new ImportError('VERIFY_FAILED', 'the secret did not read back as written');
        return {};
      }
      case 'anthropicOAuth': {
        this.requireCipher();
        if (!value || typeof value.accessToken !== 'string' || !value.accessToken) throw new ImportError('BAD_VALUE', 'the OAuth record is incomplete');
        const store = ctx.getStore();
        // Written only if still absent (fix round 1, I4).
        const stored = store.get('anthropicOAuth');
        if (stored && stored.accessToken) {
          return { note: `an Anthropic OAuth connection was added to the ${this.where} after the plan was made; not overwritten` };
        }
        store.set('anthropicOAuth', {
          accessToken: ctx.encryptToken(value.accessToken),
          refreshToken: value.refreshToken ? ctx.encryptToken(value.refreshToken) : null,
          expiresAt: value.expiresAt ?? null,
          connectedAt: value.connectedAt ?? Date.now()
        });
        if (typeof value.clientId === 'string' && value.clientId) store.set('anthropicOAuthClientId', value.clientId);
        return {};
      }
      case 'channelToken': {
        this.requireCipher();
        this.requireSecretString(value);
        const tokens = { ...(ctx.getApiTokens() || {}) };
        // Written only if still absent, like a provider token.
        if (tokens[item.key]) {
          return { note: 'a token for this channel was added to the node after the plan was made; not overwritten' };
        }
        tokens[item.key] = ctx.encryptToken(value);
        ctx.setApiTokens(tokens);
        return {};
      }
      case 'channelAllowlist': {
        if (!isPlainObject(value)) throw new ImportError('BAD_VALUE', 'the allowlist does not match the plan');
        const store = ctx.getStore();
        const lists = store.get(CHANNEL_ALLOWLISTS_KEY, {}) || {};
        const held = lists[item.key] || {};
        if (arr(held.users).length || arr(held.groups).length) {
          return { note: 'this bot\'s allowlist was set on the node after the plan was made; not overwritten' };
        }
        // Ids only, and always 'deny' for everyone else: a stored allow-all
        // is something AllowlistManager itself refuses to honour.
        store.set(CHANNEL_ALLOWLISTS_KEY, { ...lists, [item.key]: { default: 'deny', users: arr(value.users).map(String), groups: arr(value.groups).map(String) } });
        return {};
      }
      default:
        throw new ImportError('BAD_REQUEST', `unknown category ${item.category}`);
    }
  }

  // Re-checks presence/updatedAt against `liveChats` exactly as write()'s
  // pre-checkPath call did (fix round 1, I4); returns a result to short
  // -circuit on, or null if the write is still safe to make.
  chatRaceCheck(plan, item, value, liveChats) {
    if (item.action === 'new' || item.partial === true) {
      const collision = liveChats.find((c) => c.id === item.targetKey);
      if (collision) {
        return {
          note: `a chat with this id was added to the ${this.where} after the plan was made; not overwritten`,
          record: { sourceUpdatedAt: value.updatedAt || null, targetKey: collision.id, targetUpdatedAt: collision.updatedAt || null }
        };
      }
    } else if (item.action === 'update') {
      const target = liveChats.find((c) => c.id === item.targetKey);
      const expected = plan.chatExpected.get(item.targetKey);
      if (!target || target.updatedAt !== expected) {
        return {
          note: `the chat changed on the ${this.where} after the plan was made; import again to pick up the current version`,
          attention: true,
          incomplete: true
        };
      }
    }
    return null;
  }

  // One part of a chat sent in several (a personal node only). Held under the plan
  // and in memory, so a plan that ends early leaves nothing; the last part lands the
  // whole chat through writeChat, in one transaction with its private mark.
  collectChatPart(plan, item, value) {
    if (!this.personal) throw new ImportError('BAD_VALUE', 'this service takes a chat whole');
    const { index, total } = value.chatPart;
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total || !Array.isArray(value.messages)) {
      throw new ImportError('BAD_VALUE', 'the chat part does not say where it belongs');
    }
    const held = index === 0 ? { next: 0, total, head: null, messages: [], bytes: 0 } : plan.chatParts.get(item.key);
    if (!held || held.next !== index || held.total !== total) throw new ImportError('BAD_OFFSET', 'a part of this chat arrived out of order');
    held.bytes += Buffer.byteLength(JSON.stringify(value));
    if (held.bytes > this.maxChatBytes) throw new ImportError('CHAT_TOO_LARGE', `this chat is larger than the ${this.maxChatBytes} bytes one chat can move in`);
    const { chatPart: _part, messages, ...rest } = value;
    if (index === 0) held.head = rest;
    for (const message of messages) held.messages.push(message);
    held.next += 1;
    plan.chatParts.set(item.key, held);
    if (held.next < total) return { pending: true };
    plan.chatParts.delete(item.key);
    return this.writeChat(plan, item, { ...held.head, messages: held.messages });
  }

  async writeChat(plan, item, value) {
    if (!value || value.id !== item.key || !Array.isArray(value.messages)) throw new ImportError('BAD_VALUE', 'the chat does not match the plan');
    // Fail fast if the race has already happened, before doing any of the
    // work below (in particular the checkPath await).
    const early = this.chatRaceCheck(plan, item, value, this.context.listChats({ messages: false }));
    if (early) return early;

    let note = null;
    let chat = { ...value };
    if (chat.workingDirectory) {
      // This await is exactly where fix round 2 found the gap: liveChats
      // read before it can go stale by the time the upsert below runs, so
      // whatever changed the service's chats during this call — another
      // apply(), a live chat edit — would be silently overwritten by a
      // write built from a snapshot taken before the wait.
      const check = await this.checkPath(chat.workingDirectory);
      if (!check.readable || !check.isDirectory) {
        note = `the ${this.where} cannot read the working directory ${chat.workingDirectory}; it was dropped`;
        chat.workingDirectory = null;
      }
    }
    chat = item.action === 'copy'
      ? { ...chat, id: item.targetKey, title: `${chat.title || 'Chat'}${COPY_SUFFIX}` }
      : { ...chat, id: item.targetKey };
    const secondCase = chat.caseId ? plan.caseIdRemap.get(String(chat.caseId)) : null;
    if (secondCase) chat.caseId = secondCase;

    // Read live state again immediately before writing, with no await
    // between this read and the upsert, and re-run the same check against
    // it (fix round 2, I4): this is the read the upsert below acts on, so
    // it - and the presence/updatedAt decision - must be fresh.
    const liveChats = this.context.listChats({ messages: false });
    const late = this.chatRaceCheck(plan, item, value, liveChats);
    if (late) return late;
    // A copy keeps the source's message ids; the history store gives any id
    // it already holds a fresh one.
    this.landChat(chat, Object.prototype.hasOwnProperty.call(value, 'private') && value.private !== false);
    return {
      note,
      attention: Boolean(note),
      record: { sourceUpdatedAt: value.updatedAt || null, targetKey: chat.id, targetUpdatedAt: chat.updatedAt || null }
    };
  }

  // A private chat lands and is marked in one transaction, so nothing can read
  // or embed it in between, and a chat that cannot be marked does not land.
  landChat(chat, isPrivate) {
    if (!isPrivate) {
      this.context.upsertChat(chat, { position: 'front' });
      return;
    }
    const store = typeof this.context.getHistoryStore === 'function' ? this.context.getHistoryStore() : null;
    if (!store || typeof store.transaction !== 'function') throw new ImportError('PRIVATE_MARK_FAILED', 'this chat is private and the history store here cannot mark it, so it was not imported');
    store.transaction(() => {
      this.context.upsertChat(chat, { position: 'front' });
      store.markPrivate(chat.id);
      const ref = store.chatRef(chat.id);
      if (!ref || ref.private !== true) throw new ImportError('PRIVATE_MARK_FAILED', 'this chat is private and the mark did not hold, so it was not imported');
    });
  }

  // Each chat lands at the head of the list, so in plan order they come out reversed,
  // and a retry lands around what an earlier try left. Set once, when all have landed:
  // the plan's chats in the desktop's order, ahead of the rest. A personal node takes
  // the ones already there too, since a retry plans those as skip-present; anywhere
  // else a chat already landed stays where that host has it. False when it could not.
  placeLandedChats(plan, items) {
    const ids = items.filter((item) => item.category === 'chat').filter((item) => {
      const landed = plan.results.get(itemKey('chat', item.key));
      if (item.action === 'new' || item.action === 'copy' || item.partial === true) return Boolean(landed && landed.ok);
      return this.personal && (item.action === 'update' || item.action === 'skip-present');
    }).map((item) => plan.results.get(itemKey('chat', item.key))?.record?.targetKey || item.targetKey);
    if (!ids.length) return true;
    try {
      this.context.getHistoryStore().placeFirst(ids);
      return true;
    } catch (err) {
      log.warn(`could not put the moved chats in order: ${err.message}`);
      return false;
    }
  }

  // A case the desktop holds as private: its case.yaml normally says so, as it
  // came with the repository. One that does not (the key was lost and its chats
  // were what made it private) is marked by the runtime. Null, or what failed.
  async ensureCasePrivate(dest) {
    try {
      const meta = parseCaseYaml(fs.readFileSync(path.join(dest, 'case.yaml'), 'utf8'));
      if (!meta) return 'its case.yaml names no case';
      if (meta.private === true) return null;
      const runtime = typeof this.context.getCaseRuntime === 'function' ? this.context.getCaseRuntime() : null;
      if (!runtime) return 'no case runtime here can mark it';
      await runtime.markPrivate(meta.id);
      return null;
    } catch (err) {
      return String((err && err.message) || err).split(/\r?\n/)[0];
    }
  }

  ensureRealDirs(root, dir) {
    guardCheck(this.writeGuard, dir);
    // mkdirSync returns the first directory it had to create; that one and
    // every one below it down to the root are new, and reported so the
    // ownership backstop can hand them back (Task 9 fix round 1, I2).
    const first = fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (first) {
      const created = [];
      for (let p = path.resolve(root); ; p = path.dirname(p)) {
        created.unshift(p);
        if (p === path.resolve(first) || path.dirname(p) === p) break;
      }
      for (const p of created) this.onPathWritten(p);
    }
    guardCheck(this.writeGuard, dir);
    const rel = path.relative(root, dir);
    let cur = root;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      let st = null;
      try { st = fs.lstatSync(cur); } catch { st = null; }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new ImportError('BAD_PATH', `${cur} is a link or not a directory`);
      if (!st) {
        fs.mkdirSync(cur, { mode: 0o700 });
        this.onPathWritten(cur);
      }
    }
    guardCheck(this.writeGuard, dir);
  }

  writeCaseFile(plan, item, value) {
    if (!value || typeof value.relPath !== 'string' || typeof value.b64 !== 'string') throw new ImportError('BAD_VALUE', 'a case file needs relPath and b64');
    const rel = safeRelPath(value.relPath);
    // isSkippedCaseFile throws for a path this import refuses outright (a
    // nested .git segment, a bare ".git" file) — that throw must happen
    // before any accounting below, so a refused path is never counted as
    // received (fix round 2, M8: only *accepted* paths — landed or
    // deliberately skipped — count; a refusal is neither).
    const land = !isSkippedCaseFile(rel);
    const offset = Number.isInteger(value.offset) ? value.offset : 0;
    const data = Buffer.from(value.b64, 'base64');

    // Every accepted relPath is counted once, tracked by name rather than
    // by "was this the chunk at offset 0" (fix round 2, M8): a desktop
    // retry that resends a whole file from scratch (offset 0 again, for a
    // relPath already seen) resets that file's byte tally instead of
    // counting it a second time or adding its bytes on top of the earlier,
    // now-superseded attempt.
    const files = plan.caseFiles.get(item.key) || { count: 0, bytes: 0, failed: null, seen: new Map() };
    const prevSize = files.seen.get(rel);
    if (offset === 0) {
      if (prevSize === undefined) files.count += 1;
      else files.bytes -= prevSize;
      files.seen.set(rel, data.length);
      files.bytes += data.length;
    } else {
      if (prevSize === undefined || prevSize !== offset) throw new ImportError('BAD_OFFSET', `${value.relPath}: chunk at ${offset} does not follow the data received`);
      files.seen.set(rel, prevSize + data.length);
      files.bytes += data.length;
    }
    plan.caseFiles.set(item.key, files);

    if (!land) return { note: `not imported: git internals are recreated by the ${this.where}, not carried over` };
    if (unstorableOnHost(rel)) {
      files.unstorable = files.unstorable || new Set();
      files.unstorable.add(rel);
      return { note: "not imported: Windows cannot store a file with ':' in its name" };
    }

    const root = this.casesRoot();
    const caseDir = path.join(root, `.import-${plan.planId}`, item.key);
    const target = path.join(caseDir, ...rel.split('/'));
    if (!isInside(caseDir, target)) throw new ImportError('BAD_PATH', `${value.relPath} escapes the case directory`);
    this.ensureRealDirs(root, path.dirname(target));
    // isSkippedCaseFile judged the spelling the desktop sent; judge the real
    // path too (fix rounds 3 and 4, see assertCanonicalPathAllowed).
    assertCanonicalPathAllowed(caseDir, target, rel);
    guardCheck(this.writeGuard, target);
    let existing = null;
    try { existing = fs.lstatSync(target); } catch { existing = null; }
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new ImportError('BAD_PATH', `${value.relPath} is a link or not a file`);
    if (existing && existing.nlink > 1) throw new ImportError('BAD_PATH', `${value.relPath} has ${existing.nlink} hard links`);
    const mode = Number.isInteger(value.mode) ? ((value.mode & 0o755) | 0o600) : 0o600;
    // Never write through whatever is at the name (Task 9 fix round 1): a
    // first chunk replaces the file with a fresh exclusive create; a later
    // chunk opens without following a link (where the platform can) and
    // appends only if the handle is the very file just checked.
    if (offset === 0) {
      if (existing) fs.rmSync(target, { force: true });
      const fd = fs.openSync(target, 'wx', mode);
      try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
    } else {
      if (!existing || existing.size !== offset) throw new ImportError('BAD_OFFSET', `${value.relPath}: chunk at ${offset} does not follow the data received`);
      const c = fs.constants;
      const fd = fs.openSync(target, c.O_WRONLY | c.O_APPEND | (c.O_NOFOLLOW || 0));
      try {
        const st = fs.fstatSync(fd);
        if (st.ino !== existing.ino || st.dev !== existing.dev || st.nlink > 1 || st.size !== offset) {
          throw new ImportError('BAD_PATH', `${value.relPath} changed while it was being written`);
        }
        fs.writeSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    }
    this.onPathWritten(target);
    return {};
  }

  reportTree(target) {
    this.onPathWritten(target);
    let st;
    try { st = fs.lstatSync(target); } catch { return; }
    if (!st.isDirectory()) return;
    for (const name of fs.readdirSync(target)) this.reportTree(path.join(target, name));
  }

  async finish({ planId } = {}) {
    const plan = this.getPlan(planId);
    const manifest = this.readManifest(plan.installId);
    const needsRestart = this.personal && manifest.restartBoot === this.bootId;
    const at = this.now().toISOString();
    const root = this.casesRoot();
    const staging = path.join(root, `.import-${plan.planId}`);
    // dropPlan (expiry, the connection closing) removes the staging directory
    // and can run at any await below: never rename what it may have half removed.
    const stillOpen = () => {
      if (!this.plans.has(plan.planId)) throw new ImportError('PLAN_EXPIRED', 'The import plan expired; plan the import again.');
    };
    for (const [dir, files] of plan.caseFiles) {
      stillOpen();
      const k = itemKey('case', dir);
      if (files.failed) { plan.results.set(k, { ok: false, error: files.failed }); continue; }
      const stagedDir = path.join(staging, dir);
      const dest = path.join(root, dir);
      try {
        guardCheck(this.writeGuard, stagedDir);
        guardCheck(this.writeGuard, dest);
      } catch (err) {
        plan.results.set(k, { ok: false, error: err.message });
        continue;
      }
      if (fs.existsSync(dest)) {
        plan.results.set(k, { ok: false, error: `a case with this directory appeared on the ${this.where} during the import` });
        continue;
      }
      // The case's own git config is never imported (isSkippedCaseFile's
      // allow-list keeps it out) — recreate it fresh with initRepo's safe
      // settings (fix round 1, C1) rather than leave the landed repo
      // running on whatever default git would pick up. Run while the case
      // is still in staging, before the rename (fix round 2): on failure —
      // git missing, or assertGitDirSafe's ".git must be a directory" check
      // — the half-set-up case never reaches its real location; its staged
      // files are removed and the outcome is reported as attention, not a
      // hard failure, so a later plan() call offers it as 'new' again
      // rather than leaving something broken and unfixable in place.
      try {
        assertGitDirSafe(stagedDir);
        const secondId = plan.caseExpected.get(dir)?.secondId;
        if (secondId) {
          const meta = parseCaseYaml(fs.readFileSync(path.join(stagedDir, 'case.yaml'), 'utf8'));
          if (!meta) throw new ImportError('BAD_VALUE', 'its case.yaml names no case');
          fs.writeFileSync(path.join(stagedDir, 'case.yaml'), yaml.dump({ ...meta, id: secondId, slug: dir }, { noRefs: true }));
        }
        await initRepo(stagedDir);
      } catch (err) {
        stillOpen();
        try {
          fs.rmSync(stagedDir, { recursive: true, force: true });
        } catch (rmErr) {
          log.warn("could not remove a case's staged files after its git setup failed", { dir, error: rmErr.message });
        }
        plan.results.set(k, {
          ok: false,
          attention: true,
          error: err.message,
          note: `the case's git setup failed after landing (${err.message}); its files were removed — import it again`
        });
        continue;
      }
      // The importer brings a case's .git objects, refs and HEAD but never its
      // index, so a landed repository reads every file as deleted and untracked
      // until the index is rebuilt (only .git/index is written). A HEAD that
      // names a commit which is not there is a case that did not land whole.
      // A personal node's move only (attach stage 2 §6.5); a fleet import is as it was.
      stillOpen();
      const headProblem = this.personal ? await rebuildIndexFromHead(stagedDir) : null;
      stillOpen();
      try {
        fs.renameSync(stagedDir, dest);
        // After initRepo (fix round 2), so onPathWritten sees the files
        // initRepo itself just wrote (a freshly-created .git, or its
        // rewritten config), not just what the batch delivered.
        this.reportTree(dest);
        // A short delivery — fewer files or fewer bytes than the inventory
        // promised — is surfaced as attention, not silently reported ok
        // (fix round 1, M8): the batch may have been cut short by a
        // connection drop the caller didn't otherwise notice.
        const expected = plan.caseExpected.get(dir);
        const short = Boolean(expected) && (
          (expected.files !== null && files.count !== expected.files)
          || (expected.bytes !== null && files.bytes !== expected.bytes)
        );
        const notes = [];
        if (short) notes.push(`received ${files.count} file(s)/${files.bytes} byte(s); the inventory listed ${expected.files ?? '?'} file(s)/${expected.bytes ?? '?'} byte(s) — the case may be incomplete`);
        if (headProblem) notes.push(`its git history does not read (${headProblem}) — the case may be incomplete`);
        // On record at once: a cut-off from here on must not leave a landed case
        // with nothing to say what landed, or how whole it was.
        const landedFrom = expected && expected.landedFrom ? expected.landedFrom : null;
        // A private case not marked yet is incomplete until the mark holds: the
        // mark runs git, and this entry must already be there if it never returns.
        const awaitingMark = Boolean(expected && expected.private) && nodeCasePrivate(dest) !== true;
        const wholeBesidesMark = !short && !headProblem;
        if (this.personal) {
          manifest.items[k] = { at, result: 'ok', targetKey: dir, landedFrom, ...(!wholeBesidesMark || awaitingMark ? { incomplete: true } : {}) };
          this.writeManifest(manifest);
        }
        const markProblem = expected && expected.private ? await this.ensureCasePrivate(dest) : null;
        if (this.personal && awaitingMark && !markProblem && wholeBesidesMark) {
          manifest.items[k] = { at, result: 'ok', targetKey: dir, landedFrom };
          this.writeManifest(manifest);
        }
        if (markProblem) notes.push(`it is private on the desktop and could not be marked private here (${markProblem})`);
        // Fix round 4, ruling (c): names Windows can't store were skipped;
        // the rest of the case landed, and the owner is told which.
        if (files.unstorable && files.unstorable.size) {
          notes.push(`${files.unstorable.size} file(s) with ':' in the name were not copied, because Windows cannot store that name: ${[...files.unstorable].join(', ')}`);
        }
        plan.results.set(k, {
          ok: true,
          attention: notes.length > 0,
          note: notes.length ? notes.join('; ') : null,
          incomplete: Boolean(markProblem) || (this.personal && (short || Boolean(headProblem))),
          record: { targetKey: dir, ...(landedFrom ? { landedFrom } : {}) }
        });
      } catch (err) {
        plan.results.set(k, { ok: false, error: err.message });
      }
    }
    stillOpen();
    // Best-effort: a removal failure (e.g. a file still briefly open on
    // Windows) is logged, not thrown — finish() has already recorded every
    // case's outcome above, and cleanupOrphanedStaging() sweeps anything
    // left behind here the next time this importer is constructed (M9).
    try {
      guardCheck(this.writeGuard, staging);
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      log.warn('could not remove the import staging directory', { staging, error: err.message });
    }

    const items = [...plan.items.values()];
    const failures = [];
    const attention = [];
    const incomplete = [];
    const secretsMissing = [];
    let cronDisabled = 0;
    for (const item of items) {
      const k = itemKey(item.category, item.key);
      if (item.action === 'needs-attention') attention.push({ category: item.category, key: item.key, note: item.note });
      // Landed as far as it can be, and on record as not whole. The owner read the
      // line before the press, so a landing that failed is said, and blocks nothing.
      if (item.partial === true) {
        const landed = plan.results.get(k);
        if (landed && landed.ok) manifest.items[k] = { at, result: 'ok', ...(landed.record || {}), incomplete: true };
        else if (landed) attention.push({ category: item.category, key: item.key, note: landed.error });
        continue;
      }
      if (!WRITE_ACTIONS.has(item.action)) continue;
      const r = plan.results.get(k);
      if (!r || !r.ok) {
        const error = r ? r.error : 'not sent by the desktop';
        // A result explicitly marked attention (fix round 2: a case whose
        // git setup failed after landing, cleaned up and retryable) is
        // reported there, not as a failure — it's still unwritten and
        // still gets no manifest entry, so a later plan() offers it again,
        // but it isn't a hard error the caller needs to investigate.
        if (r && r.attention) attention.push({ category: item.category, key: item.key, note: r.note || error });
        else {
          failures.push({ category: item.category, key: item.key, error });
          if (SECRET_CATEGORIES.has(item.category)) secretsMissing.push({ category: item.category, key: item.key });
        }
        continue;
      }
      if (r.attention) attention.push({ category: item.category, key: item.key, note: r.note });
      // Written, but not all of it: a retry must not read this as done.
      if (r.incomplete) incomplete.push({ category: item.category, key: item.key, note: r.note });
      if (item.category === 'cron') cronDisabled += 1;
      manifest.items[k] = { at, result: 'ok', ...(r.record || {}), ...(r.incomplete ? { incomplete: true } : {}) };
    }
    const placed = this.placeLandedChats(plan, items);
    manifest.runs.push({ planId: plan.planId, at, source: plan.source });
    this.writeManifest(manifest);
    this.plans.delete(plan.planId);
    const counts = countActions(items);
    counts.failed = failures.length;
    log.info(`finished a desktop import: ${failures.length} failed`, { planId: plan.planId });
    return {
      planId: plan.planId,
      counts,
      failures,
      attention,
      incomplete,
      secretsMissing,
      cronDisabled,
      ...(needsRestart ? { needsRestart: true } : {}),
      notes: [
        ...(cronDisabled ? [`${cronDisabled} cron job(s) were imported disabled; enable them in Settings > Scheduler.`] : []),
        ...(needsRestart ? [RESTART_NOTE] : []),
        ...(placed ? [] : [chatsOutOfOrder(this.where)])
      ]
    };
  }
}

// Where memory, cron and the user profile are written. The running service
// uses its started core; the CLI (offline) opens the stores directly, so it
// never starts a core (and never launches MCP servers or hooks) as root.
async function buildImportTargets({ context, dataDir, offline = false, writeGuard = null }) {
  if (!offline) {
    const memory = context.getMemoryManager();
    const cron = context.getCronScheduler();
    if (!memory || !cron) throw new Error('the service core is not started');
    return {
      memory: { has: (id) => Boolean(memory.store.getById(id)), importEntry: (entry) => memory.importEntry(entry) },
      cron: { has: (id) => cron.listJobs().some((j) => j.id === id), addJob: (job) => cron.addJob(job) },
      userProfile: { get: () => context.getUserProfile(), update: (profile) => context.updateUserProfile(profile) },
      writtenPaths: []
    };
  }
  const { MemoryStore, MemoryManager } = require('../memory');
  const CronStore = require('../cron/cron-store');
  const memoryFile = path.join(dataDir, 'memory', 'memory-store.json');
  const memory = new MemoryManager({ store: new MemoryStore({ storageFile: memoryFile, writeGuard }) });
  const cronFile = path.join(dataDir, 'cron', 'jobs.json');
  const cronStore = new CronStore(cronFile, { writeGuard });
  await cronStore.load();
  const store = context.getStore();
  return {
    memory: { has: (id) => Boolean(memory.store.getById(id)), importEntry: (entry) => memory.importEntry(entry) },
    cron: { has: (id) => Boolean(cronStore.get(id)), addJob: (job) => cronStore.add(job) },
    userProfile: {
      get: () => store.get('userProfile', UserProfile.getDefaultProfile()),
      update: (profile) => store.set('userProfile', { ...UserProfile.getDefaultProfile(), ...profile })
    },
    writtenPaths: [path.dirname(memoryFile), memoryFile, path.dirname(cronFile), cronFile]
  };
}

module.exports = {
  DesktopImporter,
  ImportError,
  buildImportTargets,
  IMPORTED_SETTINGS_KEYS,
  importedSettingsKeys,
  settingsWouldMove,
  settingDigest,
  userProfileDigest,
  CHANNEL_TOKEN_KEYS,
  CHANNEL_ALLOWLISTS_KEY,
  ALLOWLIST_CHANNELS,
  SECRET_CATEGORIES,
  isReservedVaultKey,
  CATEGORY_ORDER,
  EXCLUDED,
  PLAN_TTL_MS,
  MAX_BATCH_BYTES,
  MAX_CHAT_PART_BYTES,
  MAX_CHAT_BYTES,
  INSTALL_ID_RE,
  CASE_DIR_RE,
  isSkippedCaseFile,
  caseTreeCounted,
  safeRelPath,
  isValidCaseDir
};
