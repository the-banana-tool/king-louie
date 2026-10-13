// src/session/backends/x11.js
// The Linux X11 backend (fleet stage 5 spec §3.3): xdotool and ImageMagick
// `import` per op, from fixed system paths. The checks run in sequence in
// Node (X11 has no single call that checks and injects); _NET_WM_PID is set
// by the client itself and `import -window` can include overlapping pixels
// (§8); there is no human-activity signal, so `limits` says so.
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../../logging');
const { GuiError } = require('../../gui/errors');
const { imageMatches } = require('../../gui/apps');
const { listProcesses, launchDetached, jpegSize, keysym, modifierKeys } = require('./linux-common');

const execFileP = promisify(execFile);
const XDOTOOL = '/usr/bin/xdotool';
const IMPORT = '/usr/bin/import';
const LOGINCTL = '/usr/bin/loginctl';
// xdotool waits this long after each key event (two a character); given
// explicitly so the time limit below is computed from it, not from a default.
const TYPE_DELAY_MS = 12;
// The limit for typing a text: its keys at twice the pace above, plus slack.
// Shorter than the service's wait for the same text (inputTimeoutMs in
// src/gui/broker.js), so xdotool is stopped and the op answers first.
const typeTimeoutMs = (text) => 5000 + 50 * Array.from(String(text)).length;

function parseShell(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Z]+)=(-?\d+)$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function createX11Backend({ env = process.env, log = createLogger('session-helper/x11'), spawnImpl, readlink = fs.readlinkSync, readdir = fs.readdirSync, exists = fs.existsSync,
  execFileImpl = (file, args, opts = {}) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, encoding: opts.encoding || 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 20000 }, (err, stdout) => (err ? reject(err) : resolve({ stdout })));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  }) } = {}) {
  const x = async (args, opts) => (await execFileImpl(XDOTOOL, args, opts)).stdout;
  const pidOf = async (win) => Number(String(await x(['getwindowpid', String(win)])).trim());
  const geometry = async (win) => {
    const g = parseShell(await x(['getwindowgeometry', '--shell', String(win)]));
    return { x: g.X, y: g.Y, w: g.WIDTH, h: g.HEIGHT };
  };
  const imageOf = (pid) => { try { return readlink(`/proc/${pid}/exe`); } catch { return ''; } };

  async function lockedHint() {
    if (!env.XDG_SESSION_ID || !exists(LOGINCTL)) return null;
    try {
      const v = String((await execFileImpl(LOGINCTL, ['show-session', env.XDG_SESSION_ID, '-p', 'LockedHint', '--value'])).stdout).trim();
      return v === 'yes' ? true : v === 'no' ? false : null;
    } catch {
      return null;
    }
  }

  async function foreground() {
    let win;
    try {
      win = String(await x(['getactivewindow'])).trim();
    } catch {
      return null;
    }
    if (!win) return null;
    const pid = await pidOf(win);
    return { handle: win, pid, image: imageOf(pid), bounds: await geometry(win), scale: 1 };
  }

  async function hitTest({ x: px, y: py }) {
    await x(['mousemove', '--sync', String(px), String(py)]);
    const loc = parseShell(await x(['getmouselocation', '--shell']));
    if (!loc.WINDOW) return null;
    const pid = await pidOf(loc.WINDOW);
    return { handle: String(loc.WINDOW), pid, image: imageOf(pid) };
  }

  const button = (b) => (b === 'right' ? '3' : b === 'middle' ? '2' : '1');

  async function input({ expect = {}, action = {} }) {
    const match = expect.match || [];
    const pids = expect.pids || [];
    // Names first: an unknown key or modifier is refused before anything is
    // looked at, moved or pressed.
    const m = modifierKeys(action.mods);
    const sym = action.kind === 'key' ? keysym(action.key) : null;
    if ((await lockedHint()) === true) throw new GuiError('screen_locked', 'the screen is locked');
    const fg = await foreground();
    if (!fg || !pids.includes(fg.pid) || !imageMatches(fg.image, match, 'linux')) {
      throw new GuiError('foreground_mismatch', 'the active window is not a leased app', { info: fg ? { image: fg.image, pid: fg.pid } : {} });
    }
    const points = [];
    if (['click', 'scroll', 'drag'].includes(action.kind)) {
      let b;
      try {
        b = await geometry(action.handle);
      } catch {
        throw new GuiError('stale_screenshot', 'the window is gone');
      }
      for (const [rx, ry] of action.kind === 'drag' ? [action.from, action.to] : [action.rel]) {
        if (rx < 0 || ry < 0 || rx >= b.w || ry >= b.h) throw new GuiError('outside_window', 'the point is outside the window');
        points.push([b.x + rx, b.y + ry]);
      }
      for (const [px, py] of points) {
        const under = await hitTest({ x: px, y: py });
        if (!under || !pids.includes(under.pid)) throw new GuiError('point_obscured', 'another window covers that point');
      }
    }
    const withMods = async (fn) => {
      for (const k of m) await x(['keydown', k]);
      try { await fn(); } finally { for (const k of [...m].reverse()) await x(['keyup', k]); }
    };
    switch (action.kind) {
      case 'type':
        await x(['type', '--clearmodifiers', '--delay', String(TYPE_DELAY_MS), '--file', '-'], { input: String(action.text), timeout: typeTimeoutMs(action.text) });
        break;
      case 'key':
        await x(['key', '--clearmodifiers', '--repeat', String(action.repeat || 1), [...m, sym].join('+')]);
        break;
      case 'click':
        await withMods(() => x(['click', '--repeat', String(action.count || 1), button(action.button)]));
        break;
      case 'scroll': {
        const dy = action.dy || 0;
        const dx = action.dx || 0;
        if (dy) await x(['click', '--repeat', String(Math.abs(dy)), dy > 0 ? '5' : '4']);
        if (dx) await x(['click', '--repeat', String(Math.abs(dx)), dx > 0 ? '7' : '6']);
        break;
      }
      case 'drag': {
        const [[fx, fy], [tx, ty]] = points;
        await x(['mousemove', '--sync', String(fx), String(fy)]);
        await x(['mousedown', button(action.button)]);
        // Always released: a move that fails must not leave the button held.
        try {
          await x(['mousemove', '--sync', String(tx), String(ty)]);
        } finally {
          await x(['mouseup', button(action.button)]);
        }
        break;
      }
      default:
        throw new GuiError('invalid_params', 'unknown action');
    }
    const after = await foreground();
    return { foregroundBefore: { image: fg.image, pid: fg.pid }, foregroundAfter: after ? { image: after.image, pid: after.pid } : null };
  }

  return {
    name: 'x11',
    async probe() {
      const probes = [];
      const caps = [];
      const xOk = Boolean(env.DISPLAY);
      probes.push({ check: 'display', ok: xOk, ...(xOk ? {} : { hint: 'no X display in this session' }) });
      if (xOk) caps.push('gui.launch');
      const importOk = exists(IMPORT);
      probes.push({ check: 'imagemagick_import', ok: importOk, ...(importOk ? {} : { hint: 'install ImageMagick (/usr/bin/import)' }) });
      if (xOk && importOk) caps.push('gui.screenshot');
      let xdoOk = false;
      if (exists(XDOTOOL)) {
        try { await x(['getmouselocation']); xdoOk = true; } catch { xdoOk = false; }
      }
      probes.push({ check: 'xdotool', ok: xdoOk, ...(xdoOk ? {} : { hint: 'install xdotool (/usr/bin/xdotool)' }) });
      if (xOk && xdoOk) caps.push('gui.input');
      const locked = await lockedHint();
      const limits = ['no_human_yield', ...(locked === null ? ['no_lock_detect'] : [])];
      return { capabilities: caps, probes, displays: [], limits, locked: locked === true };
    },
    launch: ({ exe, argv, files }) => launchDetached({ exe, argv, files, ...(spawnImpl ? { spawnImpl } : {}) }),
    processes: async ({ match }) => listProcesses({ match, readdir, readlink }),
    async windows({ pids }) {
      const out = [];
      for (const pid of pids || []) {
        let ids = [];
        try { ids = String(await x(['search', '--onlyvisible', '--pid', String(pid)])).split('\n').filter(Boolean); } catch { ids = []; }
        for (const id of ids) {
          let title = '';
          try { title = String(await x(['getwindowname', id])).trim(); } catch { title = ''; }
          out.push({ handle: id, pid, image: imageOf(pid), title, bounds: await geometry(id), scale: 1, minimized: false });
        }
      }
      return out;
    },
    foreground,
    async focus({ handle }) {
      await x(['windowactivate', '--sync', String(handle)]);
      return { focused: true };
    },
    async close({ pids, force }) {
      const closed = [];
      for (const pid of pids || []) {
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); closed.push(pid); } catch { /* gone */ }
      }
      return { closed };
    },
    async screenshot({ handle, maxWidth, quality }) {
      if ((await lockedHint()) === true) throw new GuiError('screen_locked', 'the screen is locked');
      let bounds;
      try {
        bounds = await geometry(handle);
      } catch {
        throw new GuiError('stale_screenshot', 'the window is gone');
      }
      const { stdout } = await execFileImpl(IMPORT, ['-window', String(handle), '-resize', `${maxWidth}x>`, '-quality', String(quality), 'jpg:-'], { encoding: 'buffer' });
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      const size = jpegSize(buf);
      if (!size) throw new GuiError('backend_failed', 'import returned no JPEG');
      return { mime: 'image/jpeg', width: size.width, height: size.height, data: buf.toString('base64'), transform: { sx: bounds.w / size.width, sy: bounds.h / size.height, unit: 'px' } };
    },
    input,
    async releaseAll() {
      try { await x(['keyup', 'ctrl', 'alt', 'shift', 'super']); } catch { /* nothing held */ }
      for (const b of ['1', '2', '3']) {
        try { await x(['mouseup', b]); } catch { /* nothing held */ }
      }
      return null;
    },
    locked: lockedHint,
    hitTest,
    stop: async () => {}
  };
}

module.exports = { createX11Backend };
