// Checks, for `doctor`, that every program a runbook step starts can be
// started the way the engine starts it: argv only, no shell, in the working
// directory of whichever process hosts the engine. Every host fact (platform,
// env, cwd, euid, spawnSync, fsCheck) is passed in, so each OS's rules can be
// tested on any OS. Pure Node; nothing here runs a runbook command. `sudo -l`
// only lists what sudoers allows.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const SUDO_NAME = /^sudo(\.exe)?$/i;
const SHIM_EXTS = ['.cmd', '.bat'];
const SUDO_TIMEOUT_MS = 5000;

function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

function realIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function realIsExecutable(p) {
  if (!realIsFile(p)) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Default fsCheck: the real filesystem. Callers inject a fake to exercise
// one OS's file-existence rules from another OS (e.g. faking a POSIX `sudo`
// binary as present while running the suite on win32).
const DEFAULT_FS_CHECK = { isFile: realIsFile, isExecutable: realIsExecutable };

function pathDirs(env, platform) {
  const key = Object.keys(env || {}).find((k) => (platform === 'win32' ? k.toUpperCase() === 'PATH' : k === 'PATH'));
  const value = key ? env[key] : '';
  return String(value || '').split(platform === 'win32' ? ';' : ':').filter((d) => d !== '');
}

// libuv's search_path: the exact name only when it already has an extension,
// then the name with .com and .exe appended.
function win32Candidates(dir, name) {
  const out = path.win32.extname(name) ? [path.join(dir, name)] : [];
  out.push(path.join(dir, `${name}.com`), path.join(dir, `${name}.exe`));
  return out;
}

/**
 * Where spawn(argv0, …, { shell: false }) would find the program.
 * Mirrors libuv: on win32 a bare name is looked up in the current directory
 * first, then in each PATH directory; a name with a separator only relative
 * to the current directory. A .cmd/.bat file is never started (spawn needs a
 * shell for it), but one found where an .exe was expected is reported as
 * `cmdShim` so the caller can say why the lookup failed.
 */
function resolveCommand(argv0, {
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
  fsCheck = DEFAULT_FS_CHECK
} = {}) {
  const { isFile, isExecutable } = fsCheck;
  const name = String(argv0);
  if (platform === 'win32') {
    if (path.win32.isAbsolute(name)) {
      const hit = (path.win32.extname(name) ? [name] : []).concat([`${name}.com`, `${name}.exe`]).find(isFile);
      return hit ? { path: hit, via: 'absolute' } : { path: null, via: null };
    }
    const dirs = [{ dir: cwd, via: 'cwd' }];
    if (!/[\\/]/.test(name)) {
      for (const dir of pathDirs(env, 'win32')) dirs.push({ dir, via: 'path' });
    }
    let cmdShim = null;
    for (const { dir, via } of dirs) {
      const hit = win32Candidates(dir, name).find(isFile);
      if (hit) return { path: hit, via };
      if (!cmdShim) cmdShim = SHIM_EXTS.map((ext) => path.join(dir, `${name}${ext}`)).find(isFile) || null;
    }
    return cmdShim ? { path: null, via: null, cmdShim } : { path: null, via: null };
  }

  if (path.posix.isAbsolute(name)) {
    return isExecutable(name) ? { path: name, via: 'absolute' } : { path: null, via: null };
  }
  if (name.includes('/')) {
    const p = path.resolve(cwd, name);
    return isExecutable(p) ? { path: p, via: 'cwd' } : { path: null, via: null };
  }
  for (const dir of pathDirs(env, platform)) {
    const p = path.join(dir, name);
    if (isExecutable(p)) return { path: p, via: 'path' };
  }
  return { path: null, via: null };
}

// argv with every {{param}} replaced by that param's default, or null when a
// placeholder names a param without one (its real value is not known here).
function substituteDefaults(argv, params) {
  let missing = false;
  const out = argv.map((arg) => arg.replace(PLACEHOLDER, (whole, name) => {
    const def = params && params[name];
    if (def && def.default !== undefined) return String(def.default);
    missing = true;
    return whole;
  }));
  return missing ? null : out;
}

function probeSudo({ where, argv, params }, spawnSync, rows) {
  const concrete = substituteDefaults(argv, params);
  if (!concrete) {
    rows.push({ check: where, ok: true, detail: 'not checked: uses parameters without defaults' });
    return;
  }
  const res = spawnSync(concrete[0], ['-n', '-l', ...concrete.slice(2)], { timeout: SUDO_TIMEOUT_MS, encoding: 'utf8' }) || {};
  if (res.status === 0 && !res.error) {
    rows.push({ check: where, ok: true, detail: `permitted: ${concrete.join(' ')}` });
    return;
  }
  const stderr = typeof res.stderr === 'string' ? res.stderr : String(res.stderr || '');
  const first = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    || (res.error && res.error.message)
    || `sudo -l exited with status ${res.status}`;
  rows.push({ check: where, ok: false, detail: `not permitted by sudoers: ${first}` });
}

/**
 * One row per problem, for every `run` step (deduplicated by argv). When no
 * row is a FAIL, the rows end with `runbook commands present (<k> checked)`.
 * @returns {{check: string, ok: boolean, detail: string}[]}
 */
function checkRunbookCommands(runbooks, {
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
  geteuid = null,
  spawnSync = childProcess.spawnSync,
  fsCheck = DEFAULT_FS_CHECK
} = {}) {
  const list = runbooks instanceof Map ? [...runbooks.values()] : [...(runbooks || [])];
  const rows = [];
  const fail = (check, detail) => rows.push({ check, ok: false, detail });
  const seen = new Set();
  const sudoSteps = [];
  let anySudo = false;
  let checked = 0;

  for (const runbook of list) {
    const steps = Array.isArray(runbook && runbook.steps) ? runbook.steps : [];
    steps.forEach((step, i) => {
      if (!step || !Array.isArray(step.run) || step.run.length === 0) return;
      const argv = step.run.map(String);
      const key = JSON.stringify(argv);
      if (seen.has(key)) return;
      seen.add(key);
      checked += 1;
      const where = `runbook ${runbook.name} step ${i + 1}`;
      const argv0 = argv[0];

      if (argv0.includes('{{')) {
        fail(where, 'the program must be fixed, not a parameter');
        return;
      }
      const isSudo = SUDO_NAME.test(baseName(argv0));

      if (platform === 'win32') {
        if (isSudo) {
          fail(where, 'sudo steps run only on Linux and macOS');
          return;
        }
        const resolved = resolveCommand(argv0, { platform, env, cwd, fsCheck });
        if (!path.win32.isAbsolute(argv0)) {
          const found = resolved.path ? `; resolves to ${resolved.path} via ${resolved.via}` : '';
          fail(where, `"${argv0}" is not an absolute path; Windows looks in the current directory (${cwd}) before PATH, so a planted ${argv0}.exe would run. Use the full path${found}`);
        } else if (!resolved.path) {
          fail(where, `${argv0} not found`);
        }
        const lower = argv0.toLowerCase();
        if (SHIM_EXTS.some((ext) => lower.endsWith(ext)) || (!resolved.path && resolved.cmdShim)) {
          fail(where, 'runbook steps run without a shell and cannot start .cmd/.bat files; call the .exe (npm: node.exe npm-cli.js)');
        }
        return;
      }

      const resolved = resolveCommand(argv0, { platform, env, cwd, fsCheck });
      if (!path.posix.isAbsolute(argv0)) {
        if (argv0.includes('/')) {
          fail(where, `"${argv0}" is not an absolute path; it resolves against the current directory (${cwd}). Use the full path`);
        } else if (!resolved.path) {
          fail(where, `${argv0} is not on PATH`);
        }
      } else if (!resolved.path) {
        fail(where, `${argv0} not found`);
      }

      if (!isSudo) return;
      anySudo = true;
      if (argv[1] !== '-n') {
        fail(where, 'sudo without -n would wait for a password');
        return;
      }
      if (!argv[2] || !path.posix.isAbsolute(argv[2])) {
        fail(where, 'sudo target must be absolute to match sudoers');
        return;
      }
      // F15: the program (sudo itself) wasn't found — that already produced
      // its own FAIL row above. Probing sudo -l on a missing binary would
      // only add a second, redundant FAIL for the same root problem.
      if (!resolved.path) return;
      sudoSteps.push({ where, argv, params: runbook.params || {} });
    });
  }

  if (anySudo) {
    const euid = typeof geteuid === 'function' ? geteuid() : -1;
    if (euid === 0) {
      // sudo -l as root lists root's rules, which say nothing about the
      // service account's.
      fail('sudo rules', 'run doctor as the service account (sudo -u <account> …)');
    } else {
      for (const s of sudoSteps) probeSudo(s, spawnSync, rows);
    }
  }

  if (!rows.some((r) => !r.ok)) rows.push({ check: 'runbook commands present', ok: true, detail: `${checked} checked` });
  return rows;
}

module.exports = { checkRunbookCommands, resolveCommand };
