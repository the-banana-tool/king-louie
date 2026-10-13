# src/session/backends/windows-worker.ps1
# The King Louie session helper's Windows worker (fleet stage 5 spec section 3.3).
# One JSON op per line on stdin, one JSON reply per line on stdout. Op data is
# parsed by the C# below and never becomes script text. Every input call runs
# its checks and the injection in one call: not locked, the foreground is a
# leased process, every point inside the window and over a leased window, no
# human input within yield_ms, inject, read the foreground again.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -ReferencedAssemblies System.Drawing, System.Web.Extensions, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace KingLouie {
  public class OpError : Exception {
    public string Code;
    public Dictionary<string, object> Detail;
    public OpError(string code, string message) : base(message) { Code = code; Detail = new Dictionary<string, object>(); }
    public OpError(string code, string message, Dictionary<string, object> detail) : base(message) { Code = code; Detail = detail ?? new Dictionary<string, object>(); }
  }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }

  public static class Native {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  }

  public static class Worker {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static uint lastInjection = 0;
    static readonly Dictionary<string, ushort> Vk = new Dictionary<string, ushort> {
      { "enter", 0x0D }, { "tab", 0x09 }, { "escape", 0x1B }, { "backspace", 0x08 }, { "delete", 0x2E }, { "insert", 0x2D },
      { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 }, { "up", 0x26 }, { "down", 0x28 },
      { "left", 0x25 }, { "right", 0x27 }, { "space", 0x20 }, { "-", 0xBD }, { "=", 0xBB }, { "[", 0xDB }, { "]", 0xDD },
      { "\\", 0xDC }, { ";", 0xBA }, { "'", 0xDE }, { ",", 0xBC }, { ".", 0xBE }, { "/", 0xBF }, { "`", 0xC0 }
    };

    public static string Handle(string line) {
      object id = null;
      try {
        var req = (Dictionary<string, object>)Json.DeserializeObject(line);
        id = req.ContainsKey("id") ? req["id"] : null;
        var op = (string)req["op"];
        var p = req.ContainsKey("params") && req["params"] is Dictionary<string, object> ? (Dictionary<string, object>)req["params"] : new Dictionary<string, object>();
        return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", Dispatch(op, p) } });
      } catch (OpError e) {
        return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", new Dictionary<string, object> { { "code", e.Code }, { "message", e.Message }, { "detail", e.Detail } } } });
      } catch (Exception e) {
        return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", new Dictionary<string, object> { { "code", "backend_failed" }, { "message", e.Message }, { "detail", new Dictionary<string, object>() } } } });
      }
    }

    static object Dispatch(string op, Dictionary<string, object> p) {
      switch (op) {
        case "probe": return Probe();
        case "processes": return Processes(Strings(p, "match"));
        case "windows": return Windows(Ints(p, "pids"));
        case "foreground": return ForegroundInfo();
        case "focus": return Focus(HandleOf(p, "handle"));
        case "close": return Close(Ints(p, "pids"), Bool(p, "force"));
        case "screenshot": return Screenshot(HandleOf(p, "handle"), Int(p, "maxWidth", 1280), Int(p, "quality", 70));
        case "input": return Input(p);
        case "release_all": ReleaseAll(); return null;
        case "locked": return Locked();
        case "hit_test": return HitTest(new POINT(Int(p, "x", 0), Int(p, "y", 0)));
        default: throw new OpError("unknown_op", op);
      }
    }

    // -- JSON helpers --------------------------------------------------------
    static List<string> Strings(Dictionary<string, object> p, string k) {
      var l = new List<string>();
      if (p.ContainsKey(k) && p[k] is object[]) foreach (var o in (object[])p[k]) if (o is string) l.Add((string)o);
      return l;
    }
    static List<int> Ints(Dictionary<string, object> p, string k) {
      var l = new List<int>();
      if (p.ContainsKey(k) && p[k] is object[]) foreach (var o in (object[])p[k]) if (o is int || o is long || o is decimal) l.Add(Convert.ToInt32(o));
      return l;
    }
    static int Int(Dictionary<string, object> p, string k, int def) { return p.ContainsKey(k) && p[k] != null ? Convert.ToInt32(p[k]) : def; }
    static bool Bool(Dictionary<string, object> p, string k) { return p.ContainsKey(k) && p[k] is bool && (bool)p[k]; }
    static int[] Pair(Dictionary<string, object> p, string k) {
      if (!p.ContainsKey(k) || !(p[k] is object[]) || ((object[])p[k]).Length != 2) throw new OpError("invalid_params", k);
      var a = (object[])p[k];
      return new[] { Convert.ToInt32(a[0]), Convert.ToInt32(a[1]) };
    }
    static IntPtr HandleOf(Dictionary<string, object> p, string k) {
      long v;
      if (!p.ContainsKey(k) || !long.TryParse(Convert.ToString(p[k]), out v)) throw new OpError("stale_screenshot", "no window handle");
      return new IntPtr(v);
    }

    // -- processes and windows -----------------------------------------------
    static string ImageOf(uint pid) {
      IntPtr h = Native.OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return "";
      try { var sb = new StringBuilder(1024); int size = sb.Capacity; return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : ""; }
      finally { Native.CloseHandle(h); }
    }
    static uint PidOf(IntPtr hwnd) { uint pid; Native.GetWindowThreadProcessId(hwnd, out pid); return pid; }
    // UWP apps: the frame belongs to ApplicationFrameHost.exe; the app is the child CoreWindow's process.
    static uint AppPidOf(IntPtr hwnd) {
      uint pid = PidOf(hwnd);
      if (!ImageOf(pid).EndsWith("\\ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return pid;
      uint found = pid;
      Native.EnumChildWindows(hwnd, (child, l) => { uint c = PidOf(child); if (c != pid) { found = c; return false; } return true; }, IntPtr.Zero);
      return found;
    }
    static Dictionary<string, object> Bounds(IntPtr hwnd) {
      RECT r;
      if (Native.DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) throw new OpError("stale_screenshot", "the window is gone");
      return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "w", r.Right - r.Left }, { "h", r.Bottom - r.Top } };
    }
    static double Scale(IntPtr hwnd) { try { uint dpi = Native.GetDpiForWindow(hwnd); return dpi > 0 ? dpi / 96.0 : 1.0; } catch { return 1.0; } }
    static bool Matches(string image, List<string> patterns) {
      if (string.IsNullOrEmpty(image)) return false;
      foreach (var raw in patterns) {
        bool bare = raw.IndexOf('\\') < 0 && raw.IndexOf('/') < 0;
        string target = bare ? Path.GetFileName(image) : image;
        string rx = "^" + Regex.Escape(raw).Replace("\\*", ".*").Replace("\\?", ".") + "$";
        if (Regex.IsMatch(target, rx, RegexOptions.IgnoreCase)) return true;
      }
      return false;
    }
    static List<IntPtr> TopWindows() {
      var l = new List<IntPtr>();
      Native.EnumWindows((h, x) => { if (Native.IsWindowVisible(h) && Native.GetWindow(h, 4) == IntPtr.Zero) l.Add(h); return true; }, IntPtr.Zero);
      return l;
    }
    static object Processes(List<string> match) {
      var list = new List<object>();
      int session = Process.GetCurrentProcess().SessionId;
      foreach (var p in Process.GetProcesses()) {
        try {
          if (p.SessionId != session) continue;
          string image = ImageOf((uint)p.Id);
          if (Matches(image, match)) list.Add(new Dictionary<string, object> { { "pid", p.Id }, { "image", image } });
        } catch { }
      }
      return list;
    }
    static object Windows(List<int> pids) {
      var list = new List<object>();
      foreach (var h in TopWindows()) {
        uint pid = AppPidOf(h);
        if (!pids.Contains((int)pid)) continue;
        Dictionary<string, object> b;
        try { b = Bounds(h); } catch { continue; }
        var sb = new StringBuilder(512);
        Native.GetWindowText(h, sb, 512);
        list.Add(new Dictionary<string, object> { { "handle", h.ToInt64().ToString() }, { "pid", (int)pid }, { "image", ImageOf(pid) }, { "title", sb.ToString() }, { "bounds", b }, { "scale", Scale(h) }, { "minimized", Native.IsIconic(h) } });
      }
      return list;
    }
    static Dictionary<string, object> ForegroundInfo() {
      IntPtr h = Native.GetForegroundWindow();
      if (h == IntPtr.Zero) return null;
      uint pid = AppPidOf(h);
      Dictionary<string, object> b = null;
      try { b = Bounds(h); } catch { }
      return new Dictionary<string, object> { { "handle", h.ToInt64().ToString() }, { "pid", (int)pid }, { "image", ImageOf(pid) }, { "bounds", b }, { "scale", Scale(h) } };
    }
    static Dictionary<string, object> Brief(Dictionary<string, object> w) {
      return w == null ? null : new Dictionary<string, object> { { "image", w["image"] }, { "pid", w["pid"] } };
    }
    static object HitTest(POINT pt) {
      IntPtr under = Native.GetAncestor(Native.WindowFromPoint(pt), 2);
      if (under == IntPtr.Zero) return null;
      uint pid = AppPidOf(under);
      return new Dictionary<string, object> { { "handle", under.ToInt64().ToString() }, { "pid", (int)pid }, { "image", ImageOf(pid) } };
    }
    static object Focus(IntPtr h) {
      if (!Native.IsWindow(h)) throw new OpError("stale_screenshot", "the window is gone");
      if (Native.IsIconic(h)) Native.ShowWindow(h, 9);
      return new Dictionary<string, object> { { "focused", Native.SetForegroundWindow(h) } };
    }
    static object Close(List<int> pids, bool force) {
      var closed = new List<object>();
      foreach (int pid in pids) {
        try {
          if (force) { Process.GetProcessById(pid).Kill(); closed.Add(pid); continue; }
          bool any = false;
          foreach (var h in TopWindows()) if (AppPidOf(h) == (uint)pid) { Native.PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); any = true; }
          if (any) closed.Add(pid);
        } catch { }
      }
      return new Dictionary<string, object> { { "closed", closed } };
    }

    // -- screenshots ---------------------------------------------------------
    static object Screenshot(IntPtr h, int maxWidth, int quality) {
      if (!Native.IsWindow(h)) throw new OpError("stale_screenshot", "the window is gone");
      if (Native.IsIconic(h)) throw new OpError("window_minimized", "restore the window first");
      if (Locked()) throw new OpError("screen_locked", "the screen is locked");
      var b = Bounds(h);
      int w = (int)b["w"], ht = (int)b["h"];
      if (w <= 0 || ht <= 0) throw new OpError("window_minimized", "the window has no size");
      using (var full = new Bitmap(w, ht, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(full)) {
          IntPtr hdc = g.GetHdc();
          try { if (!Native.PrintWindow(h, hdc, 2)) throw new OpError("backend_failed", "PrintWindow failed"); }
          finally { g.ReleaseHdc(hdc); }
        }
        int outW = Math.Min(w, Math.Max(1, maxWidth));
        int outH = Math.Max(1, (int)Math.Round(ht * (double)outW / w));
        using (var scaled = new Bitmap(outW, outH)) {
          using (var g2 = Graphics.FromImage(scaled)) { g2.InterpolationMode = InterpolationMode.HighQualityBicubic; g2.DrawImage(full, 0, 0, outW, outH); }
          var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
          var ps = new EncoderParameters(1);
          ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
          using (var ms = new MemoryStream()) {
            scaled.Save(ms, codec, ps);
            return new Dictionary<string, object> {
              { "mime", "image/jpeg" }, { "width", outW }, { "height", outH }, { "data", Convert.ToBase64String(ms.ToArray()) },
              { "transform", new Dictionary<string, object> { { "sx", (double)w / outW }, { "sy", (double)ht / outH }, { "unit", "px" } } }
            };
          }
        }
      }
    }

    // -- lock and input ------------------------------------------------------
    public static bool Locked() {
      IntPtr d = Native.OpenInputDesktop(0, false, 0x0100);
      if (d == IntPtr.Zero) return true;
      try {
        var sb = new StringBuilder(256);
        int needed;
        if (!Native.GetUserObjectInformation(d, 2, sb, sb.Capacity * 2, out needed)) return true;
        return !string.Equals(sb.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
      } finally { Native.CloseDesktop(d); }
    }

    static Dictionary<string, object> Detail(Dictionary<string, object> fg) {
      return fg == null ? new Dictionary<string, object>() : new Dictionary<string, object> { { "image", fg["image"] }, { "pid", fg["pid"] } };
    }

    static object Input(Dictionary<string, object> p) {
      var expect = p.ContainsKey("expect") && p["expect"] is Dictionary<string, object> ? (Dictionary<string, object>)p["expect"] : new Dictionary<string, object>();
      var match = Strings(expect, "match");
      var pids = Ints(expect, "pids");
      if (!(p.ContainsKey("action") && p["action"] is Dictionary<string, object>)) throw new OpError("invalid_params", "action");
      var action = (Dictionary<string, object>)p["action"];
      int yieldMs = Int(p, "yieldMs", 2000);
      string kind = Convert.ToString(action["kind"]);

      if (Locked()) throw new OpError("screen_locked", "the screen is locked");
      var fg = ForegroundInfo();
      if (fg == null || !pids.Contains((int)fg["pid"]) || !Matches((string)fg["image"], match)) {
        throw new OpError("foreground_mismatch", "the foreground window is not a leased app", Detail(fg));
      }
      var points = new List<POINT>();
      if (kind == "click" || kind == "scroll" || kind == "drag") {
        IntPtr target = HandleOf(action, "handle");
        if (!Native.IsWindow(target)) throw new OpError("stale_screenshot", "the window is gone");
        if (!pids.Contains((int)AppPidOf(target))) throw new OpError("foreground_mismatch", "the target window is not a leased app", Detail(fg));
        var b = Bounds(target);
        int ox = (int)b["x"], oy = (int)b["y"], bw = (int)b["w"], bh = (int)b["h"];
        var rels = kind == "drag" ? new[] { Pair(action, "from"), Pair(action, "to") } : new[] { Pair(action, "rel") };
        foreach (var r in rels) {
          if (r[0] < 0 || r[1] < 0 || r[0] >= bw || r[1] >= bh) throw new OpError("outside_window", "the point is outside the window");
          points.Add(new POINT(ox + r[0], oy + r[1]));
        }
        foreach (var pt in points) {
          IntPtr under = Native.GetAncestor(Native.WindowFromPoint(pt), 2);
          if (under == IntPtr.Zero || !pids.Contains((int)AppPidOf(under))) throw new OpError("point_obscured", "another window covers that point");
        }
      }
      var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
      if (Native.GetLastInputInfo(ref info)) {
        uint now = (uint)Environment.TickCount;
        bool afterUs = lastInjection == 0 || info.dwTime > lastInjection + 50;
        if (afterUs && unchecked(now - info.dwTime) < (uint)yieldMs) throw new OpError("user_active", "someone is using the keyboard or mouse");
      }
      switch (kind) {
        case "click": Click(points[0], action); break;
        case "type": TypeText(Convert.ToString(action["text"])); break;
        case "key": KeyPress(action); break;
        case "scroll": Scroll(points[0], action); break;
        case "drag": Drag(points[0], points[1], action); break;
        default: throw new OpError("invalid_params", "unknown action");
      }
      lastInjection = (uint)Environment.TickCount;
      System.Threading.Thread.Sleep(60);
      return new Dictionary<string, object> { { "foregroundBefore", Brief(fg) }, { "foregroundAfter", Brief(ForegroundInfo()) } };
    }

    static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }
    static INPUT KeyInput(ushort vk, bool up) {
      uint flags = (up ? 0x0002u : 0u) | (Extended(vk) ? 0x0001u : 0u);
      return new INPUT { type = 1, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = flags } } };
    }
    static INPUT UnicodeInput(char c, bool up) {
      return new INPUT { type = 1, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = 0x0004u | (up ? 0x0002u : 0u) } } };
    }
    static INPUT MouseInput(uint flags, uint data) {
      return new INPUT { type = 0, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags, mouseData = data } } };
    }
    static void Send(List<INPUT> inputs) {
      if (inputs.Count == 0) return;
      uint sent = Native.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
      if (sent == 0) throw new OpError("target_elevated", "Windows refused the input (the window may run as administrator)");
    }
    static ushort VkFor(string key) {
      if (Vk.ContainsKey(key)) return Vk[key];
      if (key.Length == 1 && key[0] >= 'a' && key[0] <= 'z') return (ushort)(0x41 + key[0] - 'a');
      if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') return (ushort)(0x30 + key[0] - '0');
      int n;
      if (key.StartsWith("f") && int.TryParse(key.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x70 + n - 1);
      throw new OpError("key_invalid", key);
    }
    static List<ushort> Mods(Dictionary<string, object> a) {
      var l = new List<ushort>();
      foreach (var m in Strings(a, "mods")) l.Add(m == "ctrl" ? (ushort)0x11 : m == "alt" ? (ushort)0x12 : m == "shift" ? (ushort)0x10 : (ushort)0x5B);
      return l;
    }
    static void KeyPress(Dictionary<string, object> a) {
      var mods = Mods(a);
      ushort vk = VkFor(Convert.ToString(a["key"]));
      int repeat = Int(a, "repeat", 1);
      var list = new List<INPUT>();
      foreach (var m in mods) list.Add(KeyInput(m, false));
      for (int i = 0; i < repeat; i++) { list.Add(KeyInput(vk, false)); list.Add(KeyInput(vk, true)); }
      for (int i = mods.Count - 1; i >= 0; i--) list.Add(KeyInput(mods[i], true));
      Send(list);
    }
    static void TypeText(string text) {
      var list = new List<INPUT>();
      foreach (char c in text) {
        if (c == '\n') { list.Add(KeyInput(0x0D, false)); list.Add(KeyInput(0x0D, true)); }
        else if (c == '\t') { list.Add(KeyInput(0x09, false)); list.Add(KeyInput(0x09, true)); }
        else { list.Add(UnicodeInput(c, false)); list.Add(UnicodeInput(c, true)); }
      }
      Send(list);
    }
    static uint[] ButtonFlags(Dictionary<string, object> a) {
      string b = a.ContainsKey("button") ? Convert.ToString(a["button"]) : "left";
      return b == "right" ? new uint[] { 0x0008, 0x0010 } : b == "middle" ? new uint[] { 0x0020, 0x0040 } : new uint[] { 0x0002, 0x0004 };
    }
    static void Click(POINT pt, Dictionary<string, object> a) {
      Native.SetCursorPos(pt.X, pt.Y);
      var mods = Mods(a);
      var f = ButtonFlags(a);
      int count = Int(a, "count", 1);
      var list = new List<INPUT>();
      foreach (var m in mods) list.Add(KeyInput(m, false));
      for (int i = 0; i < count; i++) { list.Add(MouseInput(f[0], 0)); list.Add(MouseInput(f[1], 0)); }
      for (int i = mods.Count - 1; i >= 0; i--) list.Add(KeyInput(mods[i], true));
      Send(list);
    }
    // dy > 0 scrolls down; dx > 0 scrolls right.
    static void Scroll(POINT pt, Dictionary<string, object> a) {
      Native.SetCursorPos(pt.X, pt.Y);
      int dx = Int(a, "dx", 0), dy = Int(a, "dy", 0);
      if (dy != 0) Send(new List<INPUT> { MouseInput(0x0800, unchecked((uint)(-dy * 120))) });
      if (dx != 0) Send(new List<INPUT> { MouseInput(0x1000, unchecked((uint)(dx * 120))) });
    }
    static void Drag(POINT from, POINT to, Dictionary<string, object> a) {
      var f = ButtonFlags(a);
      Native.SetCursorPos(from.X, from.Y);
      Send(new List<INPUT> { MouseInput(f[0], 0) });
      for (int i = 1; i <= 10; i++) { Native.SetCursorPos(from.X + (to.X - from.X) * i / 10, from.Y + (to.Y - from.Y) * i / 10); System.Threading.Thread.Sleep(15); }
      Send(new List<INPUT> { MouseInput(f[1], 0) });
    }
    static void ReleaseAll() {
      var list = new List<INPUT>();
      foreach (ushort m in new ushort[] { 0x11, 0x12, 0x10, 0x5B }) list.Add(KeyInput(m, true));
      foreach (uint up in new uint[] { 0x0004, 0x0010, 0x0040 }) list.Add(MouseInput(up, 0));
      Native.SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }

    // -- probe ---------------------------------------------------------------
    static Dictionary<string, object> Check(string name, bool ok, string hint) {
      var d = new Dictionary<string, object> { { "check", name }, { "ok", ok } };
      if (!ok && hint != null) d["hint"] = hint;
      return d;
    }
    static object Probe() {
      var caps = new List<object>();
      var probes = new List<object>();
      bool interactive = Environment.UserInteractive;
      probes.Add(Check("interactive_session", interactive, "the helper is not running in an interactive desktop session"));
      if (interactive) caps.Add("gui.launch");
      bool shot = false;
      try {
        using (var bmp = new Bitmap(8, 8)) using (var g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { IntPtr w = Native.GetForegroundWindow(); shot = Native.PrintWindow(w != IntPtr.Zero ? w : Native.GetDesktopWindow(), hdc, 2); }
          finally { g.ReleaseHdc(hdc); }
        }
      } catch { shot = false; }
      probes.Add(Check("print_window", shot, "PrintWindow failed in this session"));
      if (shot) caps.Add("gui.screenshot");
      uint sent = Native.SendInput(1, new[] { MouseInput(0x0001, 0) }, Marshal.SizeOf(typeof(INPUT)));
      lastInjection = (uint)Environment.TickCount;
      probes.Add(Check("send_input", sent == 1, "SendInput is blocked in this session"));
      if (sent == 1) caps.Add("gui.input");
      var displays = new List<object>();
      foreach (var s in System.Windows.Forms.Screen.AllScreens) {
        displays.Add(new Dictionary<string, object> { { "id", s.DeviceName }, { "bounds", new Dictionary<string, object> { { "x", s.Bounds.X }, { "y", s.Bounds.Y }, { "w", s.Bounds.Width }, { "h", s.Bounds.Height } } }, { "scale", 1.0 } });
      }
      return new Dictionary<string, object> { { "capabilities", caps }, { "probes", probes }, { "displays", displays }, { "limits", new List<object>() }, { "locked", Locked() } };
    }
  }
}
'@

# Physical pixels everywhere (section 3.5): before any window call. A host that set
# its awareness already makes this return false; that is not an error.
[KingLouie.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  [Console]::Out.WriteLine([KingLouie.Worker]::Handle($line))
  [Console]::Out.Flush()
}
