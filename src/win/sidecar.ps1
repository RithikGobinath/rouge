# The Windows helper: one PowerShell process that stays running, looks at the
# controls on the screen and does what a voice action asks (types, presses keys,
# clicks, moves windows), with no native Node module to build. JSON lines come
# in on stdin and JSON lines go out on stdout.
#
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"fg","ignorePid":123}                    the window the person is working in, skipping our own
#   {"id":3,"op":"cursor"}                                 where the pointer is
#   {"id":4,"op":"uia.list","hwnd":123,"max":150}          the controls of a window, top to bottom
#   {"id":5,"op":"uia.frompoint","x":100,"y":200}          the control under a point (and its window)
#   {"id":6,"op":"uia.find","hwnd":123,"name":"Send"}      the control that best matches a name
#   {"id":7,"op":"uia.invoke","name":"Send","ignorePid":1} find it in the front window and activate it
#   {"id":8,"op":"uia.focused"}                            the control with the keyboard (is it a password box?)
#   {"id":9,"op":"input.text","text":"hello","delayMs":4}  type text, any language
#   {"id":10,"op":"input.chord","vks":[17,83]}             press keys together, let go in reverse
#   {"id":11,"op":"input.vk","vk":175,"count":5}           tap one key N times
#   {"id":12,"op":"input.click","x":10,"y":10,"button":"left","double":false}
#   {"id":13,"op":"input.move","x":10,"y":10}
#   {"id":14,"op":"input.hold","vks":[17,18,32],"ms":1500} hold a chord down for a while (end-to-end tests)
#   {"id":15,"op":"win.list"}                              visible windows, front to back
#   {"id":16,"op":"win.focus","title":"notepad","process":"notepad"}
#   {"id":17,"op":"win.op","act":"minimize","ignorePid":1} minimize | maximize | restore | close, on the front window
#   {"id":18,"op":"win.topmost","hwnd":123}                put a window back above everything without activating it
#   {"id":19,"op":"keys.state","vks":[32,17,18]}           which of these keys are down right now
#   {"id":20,"op":"watch.start","keys":[32],"click":true,"fg":true}  /  {"op":"watch.stop"}
#
# Sent on its own while watching: {"ev":"click","x":..,"y":..}, {"ev":"key","vk":..,"down":..}, {"ev":"fg",...}.
# Coordinates are physical screen pixels (the process is per-monitor DPI aware).

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs = @(
  [System.Collections.Generic.HashSet[string]].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location,
  [System.Windows.Point].Assembly.Location
)

# Everything that touches Windows is in C#: PowerShell is too slow to walk a window's controls one at a time.
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Sidecar {

  // ---- synthetic input -------------------------------------------------------------
  public static class Synth {
    [StructLayout(LayoutKind.Sequential)] public struct MouseData { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KeyData { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct HardData { public uint msg; public ushort lo; public ushort hi; }
    [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public MouseData mouse; [FieldOffset(0)] public KeyData key; [FieldOffset(0)] public HardData hard; }
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint kind; public Union u; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] items, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Spot p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] public struct Spot { public int X; public int Y; }

    static void Send(params Input[] items) { SendInput((uint)items.Length, items, Marshal.SizeOf(typeof(Input))); }

    // Extended keys (arrows, Insert, Delete, the Windows keys...) need their flag or they turn into numpad keys.
    static bool Extended(ushort vk) {
      return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0xA3 || vk == 0xA5;
    }
    static Input Key(ushort vk, bool release) {
      Input i = new Input(); i.kind = 1;
      i.u.key.vk = vk; i.u.key.scan = (ushort)MapVirtualKey(vk, 0);
      i.u.key.flags = (release ? 0x0002u : 0u) | (Extended(vk) ? 0x0001u : 0u);
      return i;
    }
    static Input Letter(char c, bool release) {
      Input i = new Input(); i.kind = 1;
      i.u.key.scan = c; i.u.key.flags = 0x0004u | (release ? 0x0002u : 0u);
      return i;
    }
    static Input Button(uint flag) { Input i = new Input(); i.kind = 0; i.u.mouse.flags = flag; return i; }

    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    public static bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
    public static int[] Where() { Spot p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
    public static uint LastInput() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return i.dwTime; }
    public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

    public static void Tap(ushort vk) { Send(Key(vk, false), Key(vk, true)); }
    public static void Chord(ushort[] vks) {
      for (int i = 0; i < vks.Length; i++) { Send(Key(vks[i], false)); Thread.Sleep(6); }
      for (int i = vks.Length - 1; i >= 0; i--) { Send(Key(vks[i], true)); Thread.Sleep(2); }
    }
    public static void Hold(ushort[] vks, int ms) {
      for (int i = 0; i < vks.Length; i++) { Send(Key(vks[i], false)); Thread.Sleep(10); }
      Thread.Sleep(ms);
      for (int i = vks.Length - 1; i >= 0; i--) { Send(Key(vks[i], true)); Thread.Sleep(5); }
    }
    public static void Type(string text, int delayMs) {
      foreach (char c in text) {
        if (c == '\r') continue;
        if (c == '\n') Tap(0x0D);
        else if (c == '\t') Tap(0x09);
        else Send(Letter(c, false), Letter(c, true));
        if (delayMs > 0) Thread.Sleep(delayMs);
      }
    }
    public static void Click(int x, int y, bool right, bool twice) {
      SetCursorPos(x, y); Thread.Sleep(30);
      uint down = right ? 0x0008u : 0x0002u; uint up = right ? 0x0010u : 0x0004u;
      for (int n = twice ? 2 : 1; n > 0; n--) { Send(Button(down)); Thread.Sleep(20); Send(Button(up)); Thread.Sleep(40); }
    }
  }

  // ---- windows ---------------------------------------------------------------------
  public static class Desk {
    [StructLayout(LayoutKind.Sequential)] struct Box { public int L; public int T; public int R; public int B; }
    delegate bool Visit(IntPtr h, IntPtr state);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool EnumWindows(Visit each, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int how);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder into, int room);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Box r);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);

    const int ExStyle = -20;

    public static void SeeEveryPixel() {
      try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
    }

    public static IntPtr Front() { return GetForegroundWindow(); }
    public static string Title(IntPtr h) {
      int n = GetWindowTextLength(h);
      if (n <= 0) return "";
      StringBuilder sb = new StringBuilder(n + 2);
      GetWindowText(h, sb, sb.Capacity);
      return sb.ToString();
    }
    public static uint Owner(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
    public static int[] Bounds(IntPtr h) { Box b; return GetWindowRect(h, out b) ? new int[] { b.L, b.T, b.R, b.B } : null; }
    public static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
    public static bool IsPinned(IntPtr h) { return (GetWindowLong(h, ExStyle) & 0x8) != 0; }

    /// <summary>The name of a process, and where its program is (empty when Windows will not say).</summary>
    public static string[] Program(uint pid) {
      try {
        using (Process p = Process.GetProcessById((int)pid)) {
          string path = "";
          try { path = p.MainModule.FileName; } catch (Exception) { }
          return new string[] { p.ProcessName, path };
        }
      } catch (Exception) { return new string[] { "", "" }; }
    }

    /// <summary>Every visible top-level window, frontmost first.</summary>
    public static List<IntPtr> ZOrder() {
      List<IntPtr> all = new List<IntPtr>();
      EnumWindows(delegate (IntPtr h, IntPtr s) { if (IsWindowVisible(h)) all.Add(h); return true; }, IntPtr.Zero);
      return all;
    }

    /// <summary>The windows a person would name: titled, uncloaked, not tool windows. Frontmost first.</summary>
    public static List<IntPtr> Named() {
      List<IntPtr> some = new List<IntPtr>();
      foreach (IntPtr h in ZOrder()) {
        if (Cloaked(h) || (GetWindowLong(h, ExStyle) & 0x80) != 0) continue;
        if (GetWindowTextLength(h) > 0) some.Add(h);
      }
      return some;
    }

    /// <summary>
    /// The window the person is working in. If one of ours is in front (the overlay
    /// they just clicked to type, or the settings window), it is the first real
    /// window behind it, so a command never lands on ourselves.
    /// </summary>
    public static IntPtr Working(uint ignore, out bool behindUs) {
      behindUs = false;
      IntPtr front = GetForegroundWindow();
      if (ignore == 0 || front == IntPtr.Zero || Owner(front) != ignore) return front;
      behindUs = true;
      foreach (IntPtr h in ZOrder()) {
        if (Owner(h) == ignore || Cloaked(h)) continue;
        string title = Title(h);
        int[] b = Bounds(h);
        if (title.Length > 0 && title != "Program Manager" && b != null && b[2] - b[0] > 120 && b[3] - b[1] > 80) return h;
      }
      return IntPtr.Zero;
    }

    /// <summary>The window under a point, ignoring ours and anything the mouse passes through.</summary>
    public static IntPtr At(int x, int y, uint ignore) {
      foreach (IntPtr h in ZOrder()) {
        if (Owner(h) == ignore || Cloaked(h) || (GetWindowLong(h, ExStyle) & 0x20) != 0) continue;
        int[] b = Bounds(h);
        if (b != null && x >= b[0] && x < b[2] && y >= b[1] && y < b[3]) return h;
      }
      return IntPtr.Zero;
    }

    // Windows only lets the process in front change the front window; tapping Alt first counts as input and lifts that.
    // A key no program uses goes in between, or letting go of Alt would open the menu bar of whatever comes forward.
    public static bool Raise(IntPtr h) {
      if (IsIconic(h)) ShowWindow(h, 9);
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0xE8, 0, 0, UIntPtr.Zero);
      keybd_event(0xE8, 0, 0x0002, UIntPtr.Zero);
      bool ok = SetForegroundWindow(h);
      keybd_event(0x12, 0, 0x0002, UIntPtr.Zero);
      return ok;
    }
    public static void Minimize(IntPtr h) { ShowWindow(h, 6); }
    public static void Maximize(IntPtr h) { ShowWindow(h, 3); }
    public static void Restore(IntPtr h) { ShowWindow(h, 9); }
    public static void Close(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
    /// <summary>Above everything, without taking focus. Chromium will not do this for itself while a monitor-sized window is up.</summary>
    public static bool Pin(IntPtr h) { return SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001u | 0x0002u | 0x0010u); }
  }

  // ---- what the controls are -------------------------------------------------------
  public sealed class Item {
    public int Id { get; set; }
    public string Name { get; set; }
    public string Type { get; set; }
    public string AutomationId { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public int W { get; set; }
    public int H { get; set; }
    public int Pid { get; set; }
    public bool IsPassword { get; set; }
    public bool Fallback { get; set; }
    public AutomationElement Live;
  }

  public sealed class Survey {
    public List<Item> Items = new List<Item>();
    public bool Truncated;
    public int Visited;
    public int Ms;
  }

  public static class Ui {
    // What a person can act on. Everything else (panes, groups, text) is only looked through.
    static readonly HashSet<string> Actionable = new HashSet<string> {
      "Button", "MenuItem", "TabItem", "Hyperlink", "Edit", "ComboBox", "CheckBox", "RadioButton",
      "ListItem", "TreeItem", "Slider", "SplitButton", "Spinner"
    };
    const int MaxDepth = 18;

    static readonly CacheRequest Fetch = MakeFetch();
    static List<AutomationElement> kept = new List<AutomationElement>();

    static CacheRequest MakeFetch() {
      CacheRequest c = new CacheRequest();
      c.Add(AutomationElement.NameProperty);
      c.Add(AutomationElement.ControlTypeProperty);
      c.Add(AutomationElement.AutomationIdProperty);
      c.Add(AutomationElement.BoundingRectangleProperty);
      c.Add(AutomationElement.IsOffscreenProperty);
      c.Add(AutomationElement.ProcessIdProperty);
      c.TreeScope = TreeScope.Element;
      return c;
    }

    static string TypeOf(AutomationElement e, bool cached) {
      try {
        string n = (cached ? e.Cached.ControlType : e.Current.ControlType).ProgrammaticName;
        return n.StartsWith("ControlType.", StringComparison.Ordinal) ? n.Substring(12) : n;
      } catch (Exception) { return ""; }
    }

    /// <summary>A control as a plain record, or null when it has no position on screen.</summary>
    static Item Describe(AutomationElement e, bool cached) {
      try {
        System.Windows.Rect r = cached ? e.Cached.BoundingRectangle : e.Current.BoundingRectangle;
        if (r.IsEmpty || r.Width <= 0 || r.Height <= 0 || double.IsInfinity(r.X) || double.IsInfinity(r.Y)) return null;
        Item it = new Item();
        it.Type = TypeOf(e, cached);
        it.X = (int)Math.Round(r.X); it.Y = (int)Math.Round(r.Y); it.W = (int)Math.Round(r.Width); it.H = (int)Math.Round(r.Height);
        try { it.Name = cached ? e.Cached.Name : e.Current.Name; } catch (Exception) { it.Name = ""; }
        try { it.AutomationId = cached ? e.Cached.AutomationId : e.Current.AutomationId; } catch (Exception) { it.AutomationId = ""; }
        try { it.Pid = cached ? e.Cached.ProcessId : e.Current.ProcessId; } catch (Exception) { }
        it.Live = e;
        return it;
      } catch (Exception) { return null; }
    }

    static void CheckSecret(Item it) {
      if (it == null || it.Type != "Edit" || it.Live == null) return;
      try { it.IsPassword = (bool)it.Live.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty); } catch (Exception) { }
    }

    static AutomationElementCollection ChildrenOf(AutomationElement parent) {
      using (Fetch.Activate()) { return parent.FindAll(TreeScope.Children, Condition.TrueCondition); }
    }

    /// <summary>
    /// The actionable controls of a window, level by level, stopping at a count, a
    /// depth and a time. Sorted top to bottom, left to right, and numbered from 1.
    /// A window nobody has asked about yet answers with its frame buttons before its
    /// content exists, so a small answer is asked for again until it stops growing.
    /// </summary>
    public static Survey Look(IntPtr hwnd, int max, int budgetMs, bool keep) {
      Stopwatch clock = Stopwatch.StartNew();
      Survey s = null; int before = -1;
      for (int pass = 0; pass < 3; pass++) {
        Survey now = Pass(hwnd, max, budgetMs, clock);
        if (s == null || now.Visited > s.Visited) s = now;
        if (s.Visited >= 40 || now.Truncated || clock.ElapsedMilliseconds > budgetMs / 2 || now.Visited <= before) break;
        before = now.Visited;
        Thread.Sleep(150);
      }
      s.Items.Sort(delegate (Item a, Item b) { int d = a.Y.CompareTo(b.Y); return d != 0 ? d : a.X.CompareTo(b.X); });
      for (int i = 0; i < s.Items.Count; i++) s.Items[i].Id = i + 1;
      if (keep) { kept = new List<AutomationElement>(); foreach (Item it in s.Items) kept.Add(it.Live); }
      s.Ms = (int)clock.ElapsedMilliseconds;
      return s;
    }

    static Survey Pass(IntPtr hwnd, int max, int budgetMs, Stopwatch clock) {
      Survey s = new Survey();
      AutomationElement root;
      try { root = AutomationElement.FromHandle(hwnd); } catch (Exception) { return s; }
      List<AutomationElement> level = new List<AutomationElement>();
      level.Add(root);
      bool stop = false;
      for (int depth = 0; depth < MaxDepth && level.Count > 0 && !stop; depth++) {
        List<AutomationElement> below = new List<AutomationElement>();
        foreach (AutomationElement parent in level) {
          if (s.Items.Count >= max || clock.ElapsedMilliseconds > budgetMs) { s.Truncated = true; stop = true; break; }
          AutomationElementCollection kids;
          try { kids = ChildrenOf(parent); } catch (Exception) { continue; }
          foreach (AutomationElement k in kids) {
            s.Visited++;
            bool hidden = false;
            try { hidden = k.Cached.IsOffscreen; } catch (Exception) { }
            if (hidden) continue;
            if (Actionable.Contains(TypeOf(k, true))) { Item it = Describe(k, true); if (it != null) s.Items.Add(it); }
            below.Add(k);
          }
        }
        level = below;
      }
      return s;
    }

    /// <summary>The control at a point: ask Windows what is there, then climb to the control that holds it (a text run inside a button is the button).</summary>
    public static Item At(int x, int y, uint ignore) {
      AutomationElement hit;
      try { hit = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch (Exception) { return null; }
      if (hit == null) return null;
      try { if (hit.Current.ProcessId == (int)ignore) return null; } catch (Exception) { return null; }
      TreeWalker up = TreeWalker.ControlViewWalker;
      AutomationElement cur = hit;
      for (int step = 0; cur != null && step < 8; step++) {
        if (Actionable.Contains(TypeOf(cur, false))) {
          Item it = Describe(cur, false);
          if (it != null) { CheckSecret(it); return it; }
        }
        try { cur = up.GetParent(cur); } catch (Exception) { cur = null; }
      }
      return null;
    }

    /// <summary>Whatever Windows says is at the point, actionable or not, when nothing better turned up.</summary>
    public static Item Anything(int x, int y, uint ignore) {
      try {
        AutomationElement hit = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        if (hit == null) return null;
        Item it = Describe(hit, false);
        if (it == null || it.Pid == (int)ignore) return null;
        it.Fallback = true; CheckSecret(it);
        return it;
      } catch (Exception) { return null; }
    }

    public static Item Focused() {
      try {
        AutomationElement e = AutomationElement.FocusedElement;
        if (e == null) return null;
        Item it = Describe(e, false);
        if (it != null) { try { it.IsPassword = (bool)e.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty); } catch (Exception) { } }
        return it;
      } catch (Exception) { return null; }
    }

    /// <summary>The smallest of these controls that contains the point, or null.</summary>
    public static Item Smallest(List<Item> items, int x, int y) {
      Item best = null; double area = double.MaxValue;
      foreach (Item it in items) {
        if (x < it.X || x >= it.X + it.W || y < it.Y || y >= it.Y + it.H) continue;
        double a = (double)it.W * it.H;
        if (a < area) { best = it; area = a; }
      }
      return best;
    }

    static int Score(string have, string want) {
      if (have.Length == 0 || want.Length == 0) return 0;
      if (have == want) return 100;
      if (have.StartsWith(want, StringComparison.Ordinal)) return 80;
      if (have.Contains(want)) return 60;
      if (have.Length >= 3 && want.Contains(have)) return 40;
      return 0;
    }

    /// <summary>The control whose name is closest to what was asked for. The score says how close: 100 is exact.</summary>
    public static Item Closest(List<Item> items, string name, string type, out int score) {
      Item best = null; score = 0;
      string want = (name ?? "").Trim().ToLowerInvariant();
      foreach (Item it in items) {
        int s = Score((it.Name ?? "").Trim().ToLowerInvariant(), want);
        if (s > 0 && !string.IsNullOrEmpty(type) && it.Type == type) s += 15;
        if (s > score) { best = it; score = s; }
      }
      return best;
    }

    /// <summary>Do what the control is for, by its own action when it has one; otherwise click its middle.</summary>
    public static string Use(int id) {
      if (id < 1 || id > kept.Count) throw new InvalidOperationException("that control is gone");
      AutomationElement e = kept[id - 1];
      object pattern;
      if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return "invoke"; }
      if (e.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return "toggle"; }
      if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return "select"; }
      if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { ((ExpandCollapsePattern)pattern).Expand(); return "expand"; }
      System.Windows.Rect r = e.Current.BoundingRectangle;
      if (r.IsEmpty) throw new InvalidOperationException("control has no position");
      Synth.Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), false, false);
      return "click";
    }

    public static void CheckPassword(Item it) { CheckSecret(it); }
  }

  // ---- lines in -------------------------------------------------------------------
  // Private UIA references for a single observe/act session. No screen contents are persisted.
  public sealed class ComputerRow {
    public string Ref, Name, Type, Value;
    public int X, Y, W, H;
    public bool Focused;
    public AutomationElement Live;
    public string OriginalName;
  }
  public sealed class ComputerView {
    public string SnapshotId, Text;
    public IntPtr Hwnd;
    public List<ComputerRow> Elements = new List<ComputerRow>();
    public bool Truncated;
  }
  public static class Computer {
    static string generation;
    static IntPtr target;
    static AutomationElement root;
    static Dictionary<string, ComputerRow> refs = new Dictionary<string, ComputerRow>();
    static readonly HashSet<string> Controls = new HashSet<string> {
      "Button", "MenuItem", "TabItem", "Hyperlink", "Edit", "ComboBox", "CheckBox", "RadioButton",
      "ListItem", "TreeItem", "Slider", "SplitButton", "Spinner", "Text", "Document", "DataItem", "HeaderItem", "StatusBar"
    };
    static string Clip(string s, int max) { s = s ?? ""; return s.Length > max ? s.Substring(0, max) : s; }
    static string TypeOf(AutomationElement e) { return e.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); }
    static bool Same(AutomationElement a, AutomationElement b) { return a != null && b != null && Automation.Compare(a, b); }
    static bool Within(AutomationElement e, AutomationElement ancestor) {
      for (int n = 0; e != null && n < 48; n++) {
        if (Same(e, ancestor)) return true;
        e = TreeWalker.ControlViewWalker.GetParent(e);
      }
      return false;
    }
    // Keep in sync with src/pointing/private-fields.json / sensitive.js.
    static bool Secret(AutomationElement e) {
      if (e.Current.IsPassword) return true;
      string type = TypeOf(e);
      if (type != "Edit" && type != "ComboBox") return false;
      string label = (e.Current.Name + " " + e.Current.AutomationId).ToLowerInvariant();
      return System.Text.RegularExpressions.Regex.IsMatch(label,
        @"password|passcode|passwd|\bpwd\b|\bpin\b|\botp\b|cvv|cvc|\bcard\b|credit|debit|account|routing|\bssn\b|passport|secret|credential|social\s*security|national\s*id|government\s*id|tax\s*id|security\s*code|verification\s*code|one\s*time\s*code|drivers?\s*licen[cs]e|api\s*key|access\s*token|refresh\s*token");
    }
    static bool Visible(AutomationElement e, IntPtr h) {
      if (e.Current.IsOffscreen) return false;
      System.Windows.Rect r = e.Current.BoundingRectangle;
      int[] b = Desk.Bounds(h);
      return b != null && !r.IsEmpty && r.Width > 0 && r.Height > 0 &&
        !double.IsInfinity(r.X) && !double.IsInfinity(r.Y) && !double.IsNaN(r.X) && !double.IsNaN(r.Y) &&
        r.Right > b[0] && r.Left < b[2] && r.Bottom > b[1] && r.Top < b[3];
    }
    static void Window(IntPtr h, uint ignore, bool activate) {
      if (h == IntPtr.Zero || h.ToInt64() < 0 || Desk.Owner(h) == 0 || Desk.Bounds(h) == null || Desk.Cloaked(h))
        throw new InvalidOperationException("target_unavailable");
      if (Desk.Owner(h) == ignore) throw new InvalidOperationException("own_window");
      bool behind;
      if (Desk.Working(ignore, out behind) != h) throw new InvalidOperationException("foreground_changed");
      if (activate && behind) {
        Desk.Raise(h);
        if (Desk.Front() != h) throw new InvalidOperationException("foreground_changed");
      }
    }
    static void Generation(string id, uint ignore, bool activate) {
      if (string.IsNullOrEmpty(id) || id != generation) throw new InvalidOperationException("stale_snapshot");
      Window(target, ignore, activate);
    }
    static ComputerRow Row(AutomationElement e, string id) {
      if (Secret(e)) return null;
      ComputerRow r = new ComputerRow();
      r.Ref = id; r.Live = e; r.OriginalName = e.Current.Name ?? "";
      r.Name = Clip(r.OriginalName, 500); r.Type = TypeOf(e);
      System.Windows.Rect b = e.Current.BoundingRectangle;
      r.X = (int)Math.Round(b.X); r.Y = (int)Math.Round(b.Y); r.W = (int)Math.Round(b.Width); r.H = (int)Math.Round(b.Height);
      r.Focused = e.Current.HasKeyboardFocus;
      object p;
      if ((r.Type == "Edit" || r.Type == "ComboBox") && e.TryGetCurrentPattern(ValuePattern.Pattern, out p))
        r.Value = Clip(((ValuePattern)p).Current.Value, 2000);
      else if (r.Type == "CheckBox" && e.TryGetCurrentPattern(TogglePattern.Pattern, out p))
        r.Value = ((TogglePattern)p).Current.ToggleState.ToString();
      else if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
        r.Value = ((SelectionItemPattern)p).Current.IsSelected ? "selected" : null;
      return r;
    }
    public static ComputerView Snapshot(IntPtr requested, uint ignore) {
      bool behind;
      IntPtr h = requested == IntPtr.Zero ? Desk.Working(ignore, out behind) : requested;
      Window(h, ignore, false);
      generation = null; refs.Clear(); root = null;
      ComputerView view = new ComputerView();
      view.Hwnd = h; view.SnapshotId = Guid.NewGuid().ToString("N"); view.Text = "";
      target = h; root = AutomationElement.FromHandle(h);
      Queue<AutomationElement> pending = new Queue<AutomationElement>(); pending.Enqueue(root);
      List<AutomationElement> documents = new List<AutomationElement>();
      Stopwatch clock = Stopwatch.StartNew(); int visited = 0; bool sensitive = false;
      CacheRequest cache = new CacheRequest();
      cache.Add(AutomationElement.IsOffscreenProperty); cache.TreeScope = TreeScope.Element;
      while (pending.Count > 0 && visited < 2400 && view.Elements.Count < 320 && clock.ElapsedMilliseconds < 1100) {
        AutomationElement e = pending.Dequeue(); visited++;
        try {
          if (Secret(e)) { sensitive = true; continue; }
          bool visible = Visible(e, h);
          string type = TypeOf(e);
          if (visible && Controls.Contains(type)) {
            ComputerRow row = Row(e, Guid.NewGuid().ToString("N"));
            if (row != null) {
              view.Elements.Add(row); refs.Add(row.Ref, row);
              if (type == "Document" && documents.Count < 2) documents.Add(e);
            }
          }
          // Invisible nodes cannot contribute visible controls; panes with no bounds can still contain children.
          if (e.Current.IsOffscreen) continue;
          AutomationElementCollection children;
          using (cache.Activate()) { children = e.FindAll(TreeScope.Children, Condition.TrueCondition); }
          foreach (AutomationElement child in children) {
            if (pending.Count >= 2400) { view.Truncated = true; break; }
            if (!child.Cached.IsOffscreen) pending.Enqueue(child);
          }
        } catch (ElementNotAvailableException) { } catch (InvalidOperationException) { }
      }
      view.Truncated = view.Truncated || pending.Count > 0;
      // Aggregate document text may contain values; omit it when credential controls are present or the walk is incomplete.
      if (!sensitive && !view.Truncated) {
        foreach (AutomationElement document in documents) {
          try {
            object p;
            if (document.TryGetCurrentPattern(TextPattern.Pattern, out p)) {
              int left = 16000 - view.Text.Length;
              if (left <= 0) break;
              view.Text += ((TextPattern)p).DocumentRange.GetText(left);
            }
          } catch (Exception) { }
        }
      }
      Window(h, ignore, false);
      generation = view.SnapshotId;
      return view;
    }
    static ComputerRow Resolve(string id, string reference, uint ignore, bool activate) {
      Generation(id, ignore, activate);
      ComputerRow old;
      if (string.IsNullOrEmpty(reference) || !refs.TryGetValue(reference, out old)) throw new InvalidOperationException("stale_reference");
      try {
        AutomationElement e = old.Live;
        if (!Visible(e, target) || Secret(e) || e.Current.ProcessId == (int)ignore || !Within(e, root) ||
            e.Current.Name != old.OriginalName || TypeOf(e) != old.Type) throw new InvalidOperationException("stale_reference");
        ComputerRow now = Row(e, reference);
        if (now == null) throw new InvalidOperationException("protected_control");
        return now;
      } catch (ElementNotAvailableException) { throw new InvalidOperationException("stale_reference"); }
    }
    public static ComputerRow Describe(string id, string reference, uint ignore) {
      if (!string.IsNullOrEmpty(reference)) return Resolve(id, reference, ignore, false);
      Generation(id, ignore, false);
      AutomationElement focus = AutomationElement.FocusedElement;
      if (focus == null || !Within(focus, root) || Secret(focus)) throw new InvalidOperationException("protected_control");
      return Row(focus, "");
    }
    static void Deadline(long expiresAt) {
      long now = (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000;
      if (expiresAt <= now || expiresAt > now + 10000) throw new InvalidOperationException("expired_action");
    }
    static void Effect(uint ignore, long expiresAt) {
      Deadline(expiresAt); Window(target, ignore, true); Deadline(expiresAt);
    }
    static void Focus(AutomationElement e, uint ignore, long expiresAt) {
      Effect(ignore, expiresAt);
      e.SetFocus();
      Window(target, ignore, true);
      AutomationElement focused = AutomationElement.FocusedElement;
      if (focused == null || Secret(focused) || !Within(focused, e)) throw new InvalidOperationException("focus_changed");
      Effect(ignore, expiresAt);
    }
    static void Click(AutomationElement e, uint ignore, long expiresAt) {
      object p;
      if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { Effect(ignore, expiresAt); ((InvokePattern)p).Invoke(); return; }
      if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { Effect(ignore, expiresAt); ((SelectionItemPattern)p).Select(); return; }
      if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { Effect(ignore, expiresAt); ((TogglePattern)p).Toggle(); return; }
      if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { Effect(ignore, expiresAt); ((ExpandCollapsePattern)p).Expand(); return; }
      System.Windows.Rect r = e.Current.BoundingRectangle;
      int[] b = Desk.Bounds(target);
      double x = (Math.Max(r.Left, b[0]) + Math.Min(r.Right, b[2])) / 2;
      double y = (Math.Max(r.Top, b[1]) + Math.Min(r.Bottom, b[3])) / 2;
      AutomationElement hit = AutomationElement.FromPoint(new System.Windows.Point(x, y));
      if (!Within(hit, e)) throw new InvalidOperationException("control_obscured");
      Effect(ignore, expiresAt);
      Synth.Click((int)x, (int)y, false, false);
    }
    public static void Act(string id, string kind, string reference, string text, ushort[] keys, int amount, uint ignore, long expiresAt) {
      Deadline(expiresAt);
      Generation(id, ignore, true);
      if (kind == "click" || kind == "fill") {
        ComputerRow r = Resolve(id, reference, ignore, true);
        if (!r.Live.Current.IsEnabled) throw new InvalidOperationException("control_disabled");
        if (kind == "click") { Click(r.Live, ignore, expiresAt); return; }
        if (text == null || text.Length > 4000 || text.IndexOfAny(new char[] { '\r', '\n', '\t', '\0' }) >= 0)
          throw new InvalidOperationException("invalid_text");
        if (r.Type != "Edit" && r.Type != "ComboBox") throw new InvalidOperationException("not_editable");
        object p;
        if (r.Live.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
          ValuePattern value = (ValuePattern)p;
          if (value.Current.IsReadOnly) throw new InvalidOperationException("not_editable");
          Effect(ignore, expiresAt);
          value.SetValue(text); return;
        }
        Focus(r.Live, ignore, expiresAt); Synth.Chord(new ushort[] { 0x11, 0x41 });
        Focus(r.Live, ignore, expiresAt); Synth.Type(text, 0); return;
      }
      AutomationElement focused = AutomationElement.FocusedElement;
      if (focused == null || !Within(focused, root) || Secret(focused)) throw new InvalidOperationException("protected_control");
      if (kind == "key") {
        if (keys == null || keys.Length < 1 || keys.Length > 3) throw new InvalidOperationException("invalid_keys");
        Effect(ignore, expiresAt);
        Synth.Chord(keys); return;
      }
      if (kind == "scroll") {
        if (amount == 0 || amount < -5 || amount > 5) throw new InvalidOperationException("invalid_scroll");
        for (int n = 0; n < Math.Abs(amount); n++) {
          Effect(ignore, expiresAt); Synth.Tap((ushort)(amount > 0 ? 0x22 : 0x21));
        }
        return;
      }
      if (kind == "navigate") {
        string process = Desk.Program(Desk.Owner(target))[0].ToLowerInvariant();
        if (process != "chrome" && process != "msedge" && process != "firefox" && process != "brave") throw new InvalidOperationException("not_browser");
        Uri u;
        if (!Uri.TryCreate(text, UriKind.Absolute, out u) || (u.Scheme != "https" && u.Scheme != "http") || !string.IsNullOrEmpty(u.UserInfo))
          throw new InvalidOperationException("invalid_url");
        Effect(ignore, expiresAt); Synth.Chord(new ushort[] { 0x11, 0x4C });
        Window(target, ignore, true);
        focused = AutomationElement.FocusedElement;
        if (focused == null || !Within(focused, root) || Secret(focused) || TypeOf(focused) != "Edit") throw new InvalidOperationException("address_not_focused");
        string addressName = (focused.Current.Name + " " + focused.Current.AutomationId).ToLowerInvariant();
        if (!(addressName.Contains("address") || addressName.Contains("search or enter") || addressName.Contains("omnibox") || addressName.Contains("urlbar")))
          throw new InvalidOperationException("address_not_focused");
        Effect(ignore, expiresAt); Synth.Type(text, 0);
        Window(target, ignore, true);
        if (!Same(AutomationElement.FocusedElement, focused)) throw new InvalidOperationException("focus_changed");
        Effect(ignore, expiresAt);
        Synth.Tap(0x0D); return;
      }
      throw new InvalidOperationException("unknown_action");
    }
    public static void Release(string id) {
      if (id == generation) { generation = null; refs.Clear(); root = null; target = IntPtr.Zero; }
    }
  }

  /// <summary>Reads stdin on its own thread, so the main loop can wait for a line and still watch the keyboard.</summary>
  public sealed class Lines {
    readonly Queue<string> queue = new Queue<string>();
    readonly AutoResetEvent arrived = new AutoResetEvent(false);
    public volatile bool Closed;

    public Lines() {
      Thread t = new Thread(Pump);
      t.IsBackground = true;
      t.Start();
    }
    void Pump() {
      try {
        StreamReader r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = r.ReadLine()) != null) { lock (queue) queue.Enqueue(line); arrived.Set(); }
      } catch (Exception) { }
      Closed = true;
      arrived.Set();
    }
    /// <summary>The next line, waiting up to `ms` for one; null when none came.</summary>
    public string Next(int ms) {
      lock (queue) { if (queue.Count > 0) return queue.Dequeue(); }
      arrived.WaitOne(ms);
      lock (queue) { return queue.Count > 0 ? queue.Dequeue() : null; }
    }
  }
}
'@

[Sidecar.Desk]::SeeEveryPixel()

# ---- talking ---------------------------------------------------------------------
function Send($thing) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $thing -Compress -Depth 6))
  [Console]::Out.Flush()
}

function As-Rect($x, $y, $w, $h) { @{ x = [int]$x; y = [int]$y; w = [int]$w; h = [int]$h } }

function As-Row($it) {
  if (-not $it) { return $null }
  $row = @{ id = $it.Id; name = [string]$it.Name; type = $it.Type; automationId = [string]$it.AutomationId; rect = (As-Rect $it.X $it.Y $it.W $it.H); pid = $it.Pid }
  if ($it.Type -eq 'Edit') { $row.isPassword = $it.IsPassword }
  if ($it.Fallback) { $row.fallback = $true }
  return $row
}

function Rows($items) { , @($items | ForEach-Object { As-Row $_ }) }

function Pid-Of($req) { if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 } }
function Handle-Of($req) { if ($req.hwnd) { [IntPtr][int64]$req.hwnd } else { [Sidecar.Desk]::Front() } }
function Vks($list) { [uint16[]]@($list | ForEach-Object { [uint16]$_ }) }

function Describe-Front([uint32]$ignore) {
  $behind = $false
  $h = [Sidecar.Desk]::Working($ignore, [ref]$behind)
  if ($h -eq [IntPtr]::Zero) { return @{ hwnd = 0; title = ''; process = ''; exe = ''; pid = 0; rect = $null; behindSelf = $behind } }
  $owner = [Sidecar.Desk]::Owner($h)
  $prog = [Sidecar.Desk]::Program($owner)
  $b = [Sidecar.Desk]::Bounds($h)
  $rect = $null
  if ($b) { $rect = As-Rect $b[0] $b[1] ($b[2] - $b[0]) ($b[3] - $b[1]) }
  return @{ hwnd = [int64]$h; title = [Sidecar.Desk]::Title($h); process = $prog[0]; exe = $prog[1]; pid = [int]$owner; rect = $rect; behindSelf = $behind }
}

# ---- what each operation does ---------------------------------------------------------
$Ops = @{}

$Ops['ping'] = { param($r) @{ ok = $true; pid = $PID; ps = $PSVersionTable.PSVersion.ToString() } }
$Ops['fg'] = { param($r) Describe-Front (Pid-Of $r) }
$Ops['cursor'] = { param($r) $p = [Sidecar.Synth]::Where(); @{ x = $p[0]; y = $p[1]; input = [Sidecar.Synth]::LastInput() } }

$Ops['win.topmost'] = { param($r)
  $h = [IntPtr][int64]$r.hwnd
  $ok = [Sidecar.Desk]::Pin($h)
  @{ ok = [bool]$ok; topmost = [Sidecar.Desk]::IsPinned($h) }
}

$Ops['uia.list'] = { param($r)
  $max = if ($r.max) { [int]$r.max } else { 150 }
  $budget = if ($r.budgetMs) { [int]$r.budgetMs } else { 1200 }
  $h = Handle-Of $r
  $s = [Sidecar.Ui]::Look($h, $max, $budget, $false)
  @{ elements = (Rows $s.Items); truncated = $s.Truncated; visited = $s.Visited; ms = $s.Ms; hwnd = [int64]$h }
}

$Ops['uia.frompoint'] = { param($r)
  $x = [int][double]$r.x; $y = [int][double]$r.y
  $ignore = Pid-Of $r
  $h = [Sidecar.Desk]::At($x, $y, $ignore)
  if ($h -eq [IntPtr]::Zero) { return @{ element = $null; hwnd = 0 } }
  $window = @{ title = [Sidecar.Desk]::Title($h); pid = [int][Sidecar.Desk]::Owner($h) }
  $quick = [Sidecar.Ui]::At($x, $y, $ignore)
  if ($quick) { return @{ element = (As-Row $quick); hwnd = [int64]$h; window = $window; searched = 0; truncated = $false; ms = 0 } }
  # Nothing above the point acts like a control: look through the whole window for the smallest one around it.
  $budget = if ($r.budgetMs) { [int]$r.budgetMs } else { 1500 }
  $s = [Sidecar.Ui]::Look($h, 400, $budget, $true)
  $best = [Sidecar.Ui]::Smallest($s.Items, $x, $y)
  if ($best) { [Sidecar.Ui]::CheckPassword($best) } else { $best = [Sidecar.Ui]::Anything($x, $y, $ignore) }
  @{ element = (As-Row $best); hwnd = [int64]$h; window = $window; searched = $s.Items.Count; truncated = $s.Truncated; ms = $s.Ms }
}

$Ops['uia.find'] = { param($r)
  $s = [Sidecar.Ui]::Look((Handle-Of $r), 400, 1500, $false)
  $score = 0
  $hit = [Sidecar.Ui]::Closest($s.Items, [string]$r.name, [string]$r.type, [ref]$score)
  @{ element = (As-Row $hit); score = $score; searched = $s.Items.Count; truncated = $s.Truncated }
}

$Ops['uia.invoke'] = { param($r)
  $h = if ($r.hwnd) { [IntPtr][int64]$r.hwnd } else { $f = Describe-Front (Pid-Of $r); [IntPtr][int64]$f.hwnd }
  if ($h -eq [IntPtr]::Zero) { return @{ ok = $false; reason = 'no window' } }
  $s = [Sidecar.Ui]::Look($h, 400, 1500, $true)
  $score = 0
  $hit = [Sidecar.Ui]::Closest($s.Items, [string]$r.name, [string]$r.type, [ref]$score)
  if (-not $hit -or $score -lt 40) { return @{ ok = $false; reason = 'no such control'; searched = $s.Items.Count } }
  $how = [Sidecar.Ui]::Use($hit.Id)
  @{ ok = $true; how = $how; element = (As-Row $hit); score = $score }
}

$Ops['uia.focused'] = { param($r) @{ element = (As-Row ([Sidecar.Ui]::Focused())) } }

function Computer-Row($row) {
  if (-not $row) { return $null }
  $out = @{ ref = $row.Ref; name = $row.Name; type = $row.Type }
  if ($row.Focused) { $out.focused = $true }
  if ($null -ne $row.Value) { $out.value = $row.Value }
  return $out
}
function Computer-Failure($fault) {
  $e = $fault.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  $code = [string]$e.Message
  if ($code -notmatch '^(target_unavailable|own_window|foreground_changed|stale_snapshot|stale_reference|protected_control|focus_changed|control_obscured|control_disabled|invalid_text|not_editable|invalid_keys|invalid_scroll|not_browser|invalid_url|address_not_focused|unknown_action|expired_action)$') { $code = 'native_unavailable' }
  return @{ ok = $false; code = $code }
}
$Ops['computer.snapshot'] = { param($r)
  try {
    $h = [IntPtr][int64]$r.hwnd
    $view = [Sidecar.Computer]::Snapshot($h, (Pid-Of $r))
    $owner = [Sidecar.Desk]::Owner($view.Hwnd)
    $window = @{ hwnd = [int64]$view.Hwnd; title = [Sidecar.Desk]::Title($view.Hwnd); process = [Sidecar.Desk]::Program($owner)[0]; pid = [int]$owner }
    @{ ok = $true; snapshot = @{ snapshotId = $view.SnapshotId; window = $window; text = $view.Text; elements = @($view.Elements | ForEach-Object { Computer-Row $_ }); truncated = $view.Truncated } }
  } catch { Computer-Failure $_ }
}
$Ops['computer.describe'] = { param($r)
  try { @{ ok = $true; element = (Computer-Row ([Sidecar.Computer]::Describe([string]$r.snapshotId, [string]$r.ref, (Pid-Of $r)))) } }
  catch { Computer-Failure $_ }
}
$Ops['computer.act'] = { param($r)
  try {
    [Sidecar.Computer]::Act([string]$r.snapshotId, [string]$r.type, [string]$r.ref, [string]$r.text, (Vks $r.vks), [int]$r.amount, (Pid-Of $r), [int64]$r.expiresAt)
    @{ ok = $true }
  } catch { Computer-Failure $_ }
}
$Ops['computer.release'] = { param($r) [Sidecar.Computer]::Release([string]$r.snapshotId); @{ ok = $true } }

$Ops['input.text'] = { param($r)
  $delay = if ($null -ne $r.delayMs) { [int]$r.delayMs } else { 4 }
  [Sidecar.Synth]::Type([string]$r.text, $delay)
  @{ ok = $true; chars = ([string]$r.text).Length }
}
$Ops['input.chord'] = { param($r) [Sidecar.Synth]::Chord((Vks $r.vks)); @{ ok = $true } }
$Ops['input.vk'] = { param($r)
  $n = if ($r.count) { [int]$r.count } else { 1 }
  for ($i = 0; $i -lt $n; $i++) { [Sidecar.Synth]::Tap([uint16]$r.vk); Start-Sleep -Milliseconds 8 }
  @{ ok = $true }
}
$Ops['input.click'] = { param($r) [Sidecar.Synth]::Click([int]$r.x, [int]$r.y, ([string]$r.button -eq 'right'), [bool]$r.double); @{ ok = $true } }
$Ops['input.move'] = { param($r) [Sidecar.Synth]::MoveTo([int]$r.x, [int]$r.y); @{ ok = $true } }
$Ops['input.hold'] = { param($r) [Sidecar.Synth]::Hold((Vks $r.vks), [int]$r.ms); @{ ok = $true } }

$Ops['win.list'] = { param($r)
  $rows = @(foreach ($h in [Sidecar.Desk]::Named()) {
    $owner = [Sidecar.Desk]::Owner($h)
    @{ hwnd = [int64]$h; title = [Sidecar.Desk]::Title($h); process = [Sidecar.Desk]::Program($owner)[0]; pid = [int]$owner }
  })
  @{ windows = $rows }
}

$Ops['win.focus'] = { param($r)
  $wantTitle = ([string]$r.title).ToLowerInvariant(); $wantProc = ([string]$r.process).ToLowerInvariant()
  $ignore = Pid-Of $r
  foreach ($h in [Sidecar.Desk]::Named()) {
    $owner = [Sidecar.Desk]::Owner($h)
    if ($ignore -and $owner -eq $ignore) { continue }
    $proc = ([Sidecar.Desk]::Program($owner)[0]).ToLowerInvariant()
    $title = [Sidecar.Desk]::Title($h)
    if (($wantProc -and $proc -eq $wantProc) -or ($wantTitle -and $title.ToLowerInvariant().Contains($wantTitle))) {
      return @{ ok = $true; focused = [bool][Sidecar.Desk]::Raise($h); hwnd = [int64]$h; title = $title; process = $proc }
    }
  }
  @{ ok = $false; reason = 'no such window' }
}

$Ops['win.op'] = { param($r)
  $f = Describe-Front (Pid-Of $r)
  if (-not $f.hwnd) { return @{ ok = $false; reason = 'no window' } }
  $h = [IntPtr][int64]$f.hwnd
  switch ([string]$r.act) {
    'minimize' { [Sidecar.Desk]::Minimize($h) }
    'maximize' { [Sidecar.Desk]::Maximize($h) }
    'restore'  { [Sidecar.Desk]::Restore($h) }
    'close'    { [Sidecar.Desk]::Close($h) }
    default    { return @{ ok = $false; reason = 'unknown window op' } }
  }
  @{ ok = $true; title = $f.title }
}

$Ops['keys.state'] = { param($r)
  $down = @{}
  foreach ($k in $r.vks) { $down[[string]$k] = [Sidecar.Synth]::IsDown([int]$k) }
  @{ keys = $down }
}

# ---- watching the keyboard and the mouse, for as long as someone asks ---------------------
$script:Watch = $null

$Ops['watch.start'] = { param($r)
  $keys = @(); if ($r.keys) { $keys = @($r.keys | ForEach-Object { [int]$_ }) }
  $w = @{ keys = $keys; clicks = [bool]$r.click; front = [bool]$r.fg; held = @{}; pressedAt = $null; mouseWas = $false; frontWas = [int64][Sidecar.Desk]::Front(); frontAt = 0 }
  foreach ($k in $keys) { $w.held[$k] = [Sidecar.Synth]::IsDown($k) }
  $w.mouseWas = [Sidecar.Synth]::IsDown(1)
  $script:Watch = $w
  @{ ok = $true; watching = $true }
}
$Ops['watch.stop'] = { param($r) $script:Watch = $null; @{ ok = $true; watching = $false } }

function Scan-Inputs {
  $w = $script:Watch
  if (-not $w) { return }
  if ($w.clicks) {
    $down = [Sidecar.Synth]::IsDown(1)
    if ($down -and -not $w.mouseWas) { $w.pressedAt = [Sidecar.Synth]::Where() }
    if ($w.mouseWas -and -not $down) {
      $at = if ($w.pressedAt) { $w.pressedAt } else { [Sidecar.Synth]::Where() }
      Send @{ ev = 'click'; x = $at[0]; y = $at[1]; t = [int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
      $w.pressedAt = $null
    }
    $w.mouseWas = $down
  }
  foreach ($k in $w.keys) {
    $now = [Sidecar.Synth]::IsDown($k)
    if ($now -ne $w.held[$k]) { $w.held[$k] = $now; Send @{ ev = 'key'; vk = $k; down = $now } }
  }
  if ($w.front) {
    $tick = [Environment]::TickCount
    if ($tick - $w.frontAt -ge 500) {
      $w.frontAt = $tick
      $h = [int64][Sidecar.Desk]::Front()
      if ($h -ne $w.frontWas) { $w.frontWas = $h; $f = Describe-Front 0; $f.ev = 'fg'; Send $f }
    }
  }
}

# ---- the loop ------------------------------------------------------------------------
function Answer([string]$line) {
  $id = $null
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = $req.id
    $op = [string]$req.op
    if (-not $Ops.ContainsKey($op)) { Send @{ id = $id; error = "unknown op $op" }; return }
    $res = & $Ops[$op] $req
    if ($res -isnot [hashtable]) { $res = @{ ok = $true } }
    $res.id = $id
    Send $res
  } catch {
    Send @{ id = $id; error = [string]$_.Exception.Message }
  }
}

$lines = New-Object Sidecar.Lines
Send @{ ev = 'ready'; pid = $PID }
while ($true) {
  $line = $lines.Next($(if ($script:Watch) { 15 } else { 250 }))
  if ($line) { if ($line.Trim().Length -gt 0) { Answer $line } }
  elseif ($lines.Closed) { break }
  if ($script:Watch) { try { Scan-Inputs } catch { Send @{ ev = 'error'; message = [string]$_.Exception.Message } } }
}
