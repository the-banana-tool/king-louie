// src/session/backends/macos-worker.js
// The macOS GUI worker for the King Louie session helper (fleet stage 5 spec
// §3.3), run as /usr/bin/osascript -l JavaScript <this file>. One JSON op per
// line on stdin, one JSON reply per line on stdout. JXA, not Node: no
// require, no console. Op data never becomes script text.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');

var lastInjection = 0;
var automationOk = null;
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var buffer = '';

function OpError(code, message, detail) { this.code = code; this.message = message || code; this.detail = detail || {}; }
function nowS() { return $.NSDate.date.timeIntervalSince1970; }

function nextLine() {
  for (;;) {
    var i = buffer.indexOf('\n');
    if (i >= 0) { var line = buffer.slice(0, i); buffer = buffer.slice(i + 1); return line; }
    var data = stdin.availableData;
    if (data.length === 0) return null;
    buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  }
}
function write(obj) { stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }

function app(pid) { var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid); return a && !a.isNil() ? a : null; }
function imageOf(pid) { var a = app(pid); if (!a || a.executableURL.isNil()) return ''; return a.executableURL.path.js; }

// Layer-0 windows, front to back. onscreenOnly: 1 | 16 (exclude desktop); all: 16.
function windowList(onscreenOnly) {
  var raw = $.CGWindowListCopyWindowInfo(onscreenOnly ? (1 | 16) : 16, 0);
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  return list.filter(function (w) { return w.kCGWindowLayer === 0; });
}
function boundsOf(w) { var b = w.kCGWindowBounds; return { x: b.X, y: b.Y, w: b.Width, h: b.Height }; }
function contains(b, p) { return p.x >= b.x && p.y >= b.y && p.x < b.x + b.w && p.y < b.y + b.h; }
function backingScale() { var s = $.NSScreen.mainScreen; return s && !s.isNil() ? s.backingScaleFactor : 1; }

function globMatch(image, patterns) {
  if (!image) return false;
  var img = image.toLowerCase();
  for (var k = 0; k < patterns.length; k++) {
    var p = String(patterns[k]).toLowerCase();
    var bare = p.indexOf('/') < 0;
    var target = bare ? img.slice(img.lastIndexOf('/') + 1) : img;
    var rx = new RegExp('^' + p.split('').map(function (c) { return c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('') + '$');
    if (rx.test(target)) return true;
    if (/\.app$/.test(p) && p.indexOf('*') < 0 && img.indexOf(p + '/') === 0) return true;
  }
  return false;
}

function foreground() {
  var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!a || a.isNil()) return null;
  var pid = a.processIdentifier;
  var win = windowList(true).filter(function (w) { return w.kCGWindowOwnerPID === pid; })[0];
  return { handle: win ? String(win.kCGWindowNumber) : null, pid: pid, image: imageOf(pid), bounds: win ? boundsOf(win) : null, scale: backingScale() };
}
function brief(f) { return f ? { image: f.image, pid: f.pid } : null; }
function hitTest(p) {
  var under = windowList(true).filter(function (w) { return contains(boundsOf(w), p); })[0];
  return under ? { handle: String(under.kCGWindowNumber), pid: under.kCGWindowOwnerPID, image: imageOf(under.kCGWindowOwnerPID) } : null;
}
function isLocked() {
  var d = ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary()));
  return Boolean(d && d.CGSSessionScreenIsLocked);
}

// ── input ────────────────────────────────────────────────────────────────
var KEYCODES = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32,
  '[': 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47,
  tab: 48, space: 49, '`': 50, backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, insert: 114,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90 };
var SHIFTED = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
var FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 };
var MODKEY = { shift: 56, ctrl: 59, alt: 58, meta: 55 };

function post(e) { $.CGEventPost(0, e); }
function flagsOf(mods) { var f = 0; (mods || []).forEach(function (m) { f |= FLAG[m] || 0; }); return f; }
function keyEvent(code, down, flags) { var e = $.CGEventCreateKeyboardEvent(null, code, down); if (flags) $.CGEventSetFlags(e, flags); post(e); }
function tap(code, flags) { keyEvent(code, true, flags); keyEvent(code, false, flags); }
function mouseEvent(type, p, button, clickState, flags) {
  var e = $.CGEventCreateMouseEvent(null, type, { x: p.x, y: p.y }, button);
  if (clickState) $.CGEventSetIntegerValueField(e, 1, clickState);
  if (flags) $.CGEventSetFlags(e, flags);
  post(e);
}
var BUTTON = { left: [0, 1, 2], right: [1, 3, 4], middle: [2, 25, 26] }; // button, down type, up type

function typeAscii(ch) {
  if (ch === '\n') { tap(36, 0); return; }
  if (ch === '\t') { tap(48, 0); return; }
  if (ch === ' ') { tap(49, 0); return; }
  var lower = ch.toLowerCase();
  if (KEYCODES[lower] !== undefined && lower.length === 1) { tap(KEYCODES[lower], ch !== lower ? FLAG.shift : 0); return; }
  if (SHIFTED[ch] !== undefined) { tap(KEYCODES[SHIFTED[ch]], FLAG.shift); return; }
  throw new OpError('invalid_text', 'a character cannot be typed');
}
// Deviation 27: non-ASCII runs through System Events (Automation permission).
function typeText(text) {
  var run = '';
  var flush = function () {
    if (!run) return;
    if (automationOk === false) throw new OpError('invalid_text', 'non-ASCII text needs the Automation permission for System Events');
    Application('System Events').keystroke(run);
    run = '';
  };
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    var code = c.charCodeAt(0);
    if (code < 128) { flush(); typeAscii(c); } else run += c;
  }
  flush();
}

function input(p) {
  var expect = p.expect || {}; var match = expect.match || []; var pids = expect.pids || [];
  var action = p.action || {}; var yieldMs = p.yieldMs || 0; var kind = action.kind;
  if (isLocked()) throw new OpError('screen_locked', 'the screen is locked');
  var fg = foreground();
  if (!fg || pids.indexOf(fg.pid) < 0 || !globMatch(fg.image, match)) throw new OpError('foreground_mismatch', 'the frontmost app is not a leased app', fg ? brief(fg) : {});
  var points = [];
  if (kind === 'click' || kind === 'scroll' || kind === 'drag') {
    var win = windowList(true).filter(function (w) { return String(w.kCGWindowNumber) === String(action.handle); })[0];
    if (!win) throw new OpError('stale_screenshot', 'the window is gone');
    if (pids.indexOf(win.kCGWindowOwnerPID) < 0) throw new OpError('foreground_mismatch', 'the target window is not a leased app', brief(fg));
    var b = boundsOf(win);
    var rels = kind === 'drag' ? [action.from, action.to] : [action.rel];
    rels.forEach(function (r) {
      if (r[0] < 0 || r[1] < 0 || r[0] >= b.w || r[1] >= b.h) throw new OpError('outside_window', 'the point is outside the window');
      points.push({ x: b.x + r[0], y: b.y + r[1] });
    });
    points.forEach(function (pt) {
      // The window the screenshot was of, not just any window of a leased
      // app (review finding 8): a sheet, a menu or a second window of the
      // same process over that point is something the model never saw.
      var under = hitTest(pt);
      if (!under || under.handle !== String(action.handle)) throw new OpError('point_obscured', 'another window covers that point');
    });
  }
  var since = $.CGEventSourceSecondsSinceLastEventType(1, 4294967295);
  var lastEvent = nowS() - since;
  if ((lastInjection === 0 || lastEvent > lastInjection + 0.05) && since * 1000 < yieldMs) throw new OpError('user_active', 'someone is using the keyboard or mouse');
  var flags = flagsOf(action.mods);
  if (kind === 'click') {
    var bt = BUTTON[action.button || 'left'];
    mouseEvent(5, points[0], 0, 0, 0);
    for (var n = 1; n <= (action.count || 1); n++) { mouseEvent(bt[1], points[0], bt[0], n, flags); mouseEvent(bt[2], points[0], bt[0], n, flags); }
  } else if (kind === 'type') {
    typeText(String(action.text));
  } else if (kind === 'key') {
    var code = KEYCODES[action.key];
    if (code === undefined) throw new OpError('key_invalid', action.key);
    for (var r = 0; r < (action.repeat || 1); r++) tap(code, flags);
  } else if (kind === 'scroll') {
    mouseEvent(5, points[0], 0, 0, 0);
    post($.CGEventCreateScrollWheelEvent2(null, 1, 2, -(action.dy || 0), -(action.dx || 0), 0));
  } else if (kind === 'drag') {
    var db = BUTTON[action.button || 'left'];
    mouseEvent(5, points[0], 0, 0, 0);
    mouseEvent(db[1], points[0], db[0], 1, 0);
    for (var s = 1; s <= 10; s++) {
      mouseEvent(db[0] === 0 ? 6 : 7, { x: points[0].x + (points[1].x - points[0].x) * s / 10, y: points[0].y + (points[1].y - points[0].y) * s / 10 }, db[0], 0, 0);
      delay(0.015);
    }
    mouseEvent(db[2], points[1], db[0], 1, 0);
  } else {
    throw new OpError('invalid_params', 'unknown action');
  }
  lastInjection = nowS();
  delay(0.06);
  return { foregroundBefore: brief(fg), foregroundAfter: brief(foreground()) };
}

function releaseAll() {
  ['shift', 'ctrl', 'alt', 'meta'].forEach(function (m) { keyEvent(MODKEY[m], false, 0); });
  var loc = $.CGEventGetLocation($.CGEventCreate(null));
  [[0, 2], [1, 4], [2, 26]].forEach(function (pair) { mouseEvent(pair[1], { x: loc.x, y: loc.y }, pair[0], 0, 0); });
  return null;
}

// ── the rest of the ops ──────────────────────────────────────────────────
function running() { return ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications) || []; }
function processes(p) {
  var out = [];
  running().forEach(function (a) {
    var pid = a.processIdentifier;
    var image = imageOf(pid);
    if (globMatch(image, p.match || [])) out.push({ pid: pid, image: image });
  });
  return out;
}
function windows(p) {
  var pids = p.pids || [];
  return windowList(false).filter(function (w) { return pids.indexOf(w.kCGWindowOwnerPID) >= 0; }).map(function (w) {
    return { handle: String(w.kCGWindowNumber), pid: w.kCGWindowOwnerPID, image: imageOf(w.kCGWindowOwnerPID), title: w.kCGWindowName || '', bounds: boundsOf(w), scale: backingScale(), minimized: !w.kCGWindowIsOnscreen };
  });
}
function windowInfo(p) {
  var win = windowList(false).filter(function (w) { return String(w.kCGWindowNumber) === String(p.handle); })[0];
  if (!win) throw new OpError('stale_screenshot', 'the window is gone');
  if (!win.kCGWindowIsOnscreen) throw new OpError('window_minimized', 'restore the window first');
  if (isLocked()) throw new OpError('screen_locked', 'the screen is locked');
  return { windowNumber: win.kCGWindowNumber, bounds: boundsOf(win) };
}
function focus(p) {
  var win = windowList(false).filter(function (w) { return String(w.kCGWindowNumber) === String(p.handle); })[0];
  if (!win) throw new OpError('stale_screenshot', 'the window is gone');
  var a = app(win.kCGWindowOwnerPID);
  return { focused: Boolean(a && a.activateWithOptions(2)) };
}
function close(p) {
  var closed = [];
  (p.pids || []).forEach(function (pid) { var a = app(pid); if (a && (p.force ? a.forceTerminate : a.terminate)) closed.push(pid); });
  return { closed: closed };
}
function pidForApp(p) {
  var best = null;
  running().forEach(function (a) {
    var bundle = a.bundleURL && !a.bundleURL.isNil() ? a.bundleURL.path.js : '';
    var exe = a.executableURL && !a.executableURL.isNil() ? a.executableURL.path.js : '';
    if (bundle === p.path || exe === p.path) {
      var t = a.launchDate && !a.launchDate.isNil() ? a.launchDate.timeIntervalSince1970 : 0;
      if (!best || t >= best.t) best = { pid: a.processIdentifier, t: t };
    }
  });
  return best ? best.pid : null;
}
function check(name, ok, hint) { var d = { check: name, ok: ok }; if (!ok) d.hint = hint; return d; }
function probe(p) {
  var node = p.nodeBinary || 'the node binary';
  var screen = Boolean($.CGPreflightScreenCaptureAccess());
  var ax = Boolean($.AXIsProcessTrusted());
  var caps = ['gui.launch'];
  if (screen) caps.push('gui.screenshot');
  if (ax) caps.push('gui.input');
  var displays = (ObjC.unwrap($.NSScreen.screens) || []).map(function (s, i) {
    var f = s.frame;
    return { id: String(i + 1), bounds: { x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height }, scale: s.backingScaleFactor };
  });
  return {
    capabilities: caps,
    probes: [
      check('screen_recording', screen, 'grant Screen Recording to ' + node + ' in System Settings > Privacy & Security'),
      check('accessibility', ax, 'grant Accessibility to ' + node + ' in System Settings > Privacy & Security'),
      check('automation', automationOk !== false, 'allow ' + node + ' to control System Events to type non-ASCII text')
    ],
    displays: displays, limits: [], locked: isLocked()
  };
}
function requestPermissions() {
  $.CGRequestScreenCaptureAccess();
  $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
  try { Application('System Events').processes.length; automationOk = true; } catch (e) { automationOk = false; }
  return null;
}

var OPS = {
  probe: probe, processes: processes, windows: windows, foreground: foreground, focus: focus, close: close,
  window_info: windowInfo, input: input, release_all: releaseAll, locked: isLocked, pid_for_app: pidForApp,
  hit_test: hitTest, request_permissions: requestPermissions
};

function run() {
  for (;;) {
    var line = nextLine();
    if (line === null) return;
    if (!line.trim()) continue;
    var req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    try {
      if (!Object.prototype.hasOwnProperty.call(OPS, req.op)) throw new OpError('unknown_op', String(req.op));
      var result = OPS[req.op](req.params || {});
      write({ id: req.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof OpError) write({ id: req.id, ok: false, error: { code: e.code, message: e.message, detail: e.detail } });
      else write({ id: req.id, ok: false, error: { code: 'backend_failed', message: String(e), detail: {} } });
    }
  }
}
