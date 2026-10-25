using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

namespace RougeUploads {
  public sealed class Lines {
    readonly Queue<string> queue = new Queue<string>();
    readonly AutoResetEvent arrived = new AutoResetEvent(false);
    public volatile bool Closed;
    public Lines() { var thread = new Thread(Pump); thread.IsBackground = true; thread.Start(); }
    void Pump() {
      try {
        var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = reader.ReadLine()) != null) { lock (queue) queue.Enqueue(line); arrived.Set(); }
      } catch (Exception) { }
      Closed = true; arrived.Set();
    }
    public string Next(int milliseconds) {
      lock (queue) { if (queue.Count > 0) return queue.Dequeue(); }
      arrived.WaitOne(milliseconds);
      lock (queue) return queue.Count > 0 ? queue.Dequeue() : null;
    }
  }

  public sealed class Observation {
    public string ev;
    public string selectionId;
    public long hwnd;
    public string path;
  }

  public sealed class Picker {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

    readonly object gate = new object();
    IntPtr dialog, browser;
    string candidate, context, field, confirmed, id;
    readonly Stopwatch age = Stopwatch.StartNew();
    long opened, closedAt, selectedAt;
    HashSet<string> before;
    AutomationElement dialogElement;
    AutomationEventHandler invoked, changed;
    AutomationPropertyChangedEventHandler valueChanged;
    int generation;
    bool cancelled;

    static string Class(IntPtr window) { var value = new StringBuilder(128); GetClassName(window, value, value.Capacity); return value.ToString(); }
    static bool Browser(IntPtr window) {
      uint pid; GetWindowThreadProcessId(window, out pid);
      try { using (var process = Process.GetProcessById((int)pid)) return Regex.IsMatch(process.ProcessName, "^(chrome|msedge|firefox|brave)$", RegexOptions.IgnoreCase); }
      catch (Exception) { return false; }
    }
    static string Runtime(AutomationElement element) { return string.Join(".", Array.ConvertAll(element.GetRuntimeId(), n => n.ToString())); }
    static string Value(AutomationElement element) {
      if (element.Current.IsPassword) return "";
      object pattern;
      if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
        string value = ((ValuePattern)pattern).Current.Value;
        if (!string.IsNullOrEmpty(value)) return value;
      }
      // Some Chromium providers expose the file value only through the legacy UIA property.
      var legacy = AutomationProperty.LookupById(30093);
      if (legacy != null) return element.GetCurrentPropertyValue(legacy, true) as string ?? "";
      return "";
    }
    // Only local drive paths from the native dialog; no UNC, ADS, wildcards or multiselect.
    public static string ResolvePath(string folder, string filename) {
      try {
        filename = (filename ?? "").Trim();
        if (filename.StartsWith("\"") && filename.EndsWith("\"") && filename.Length > 2) filename = filename.Substring(1, filename.Length - 2);
        if (filename.Length == 0 || filename.IndexOfAny(new char[] { '"', '*', '?', '\r', '\n', '\0' }) >= 0) return null;
        if (!Path.IsPathRooted(filename) && !Regex.IsMatch(folder ?? "", @"^[A-Za-z]:\\")) return null;
        string full = Path.GetFullPath(Path.IsPathRooted(filename) ? filename : Path.Combine(folder, filename));
        if (!Regex.IsMatch(full, @"^[A-Za-z]:\\") || full.IndexOf(':', 2) >= 0 || full.Length > 260
          || !string.Equals(Path.GetExtension(full), ".pdf", StringComparison.OrdinalIgnoreCase)
          || Regex.IsMatch(full, @"\\fakepath(?:\\|$)", RegexOptions.IgnoreCase)) return null;
        var drive = new DriveInfo(Path.GetPathRoot(full));
        if (drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable) return null;
        string current = Path.GetPathRoot(full);
        foreach (string part in full.Substring(current.Length).Split('\\')) {
          current = Path.Combine(current, part);
          if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return null;
        }
        return File.Exists(full) ? full : null;
      } catch (Exception) { return null; }
    }
    static string DialogPath(IntPtr window) {
      var root = AutomationElement.FromHandle(window);
      var name = root.FindFirst(TreeScope.Descendants, new AndCondition(
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
        new OrCondition(new PropertyCondition(AutomationElement.AutomationIdProperty, "1148"), new PropertyCondition(AutomationElement.AutomationIdProperty, "1001"))));
      if (name == null) return null;
      string filename = Value(name), folder = null;
      if (Regex.IsMatch(filename.Trim(' ', '"'), @"^[A-Za-z]:\\")) return ResolvePath(null, filename);
      var bars = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ToolBar));
      foreach (AutomationElement bar in bars) {
        var match = Regex.Match(bar.Current.Name ?? "", @"[A-Za-z]:\\[^\r\n]*$");
        if (match.Success) { folder = match.Value; break; }
      }
      return folder == null ? null : ResolvePath(folder, filename);
    }
    sealed class BrowserState {
      public string Context;
      public readonly Dictionary<string, string> Files = new Dictionary<string, string>();
    }
    static string PdfName(string text) {
      text = (text ?? "").Trim();
      if (text.Length > 260 || text.IndexOfAny(new char[] { '\r', '\n', '"' }) >= 0) return null;
      if (text.StartsWith(@"C:\fakepath\", StringComparison.OrdinalIgnoreCase)) text = Path.GetFileName(text);
      return !text.Contains("\\") && !text.Contains("/") && text.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? text : null;
    }
    public static string FindNewField(HashSet<string> before, Dictionary<string, string> after, string filename) {
      if (before == null || before.Contains(filename.ToLowerInvariant())) return null;
      string found = null;
      foreach (var entry in after) {
        if (!string.Equals(entry.Value, filename, StringComparison.OrdinalIgnoreCase)) continue;
        if (found != null) return null; // Multiple matching upload controls are ambiguous.
        found = entry.Key;
      }
      return found;
    }
    static BrowserState ScanBrowser(IntPtr window) {
      if (!IsWindow(window) || !Browser(window)) return null;
      var result = new BrowserState();
      var queue = new Queue<AutomationElement>(); queue.Enqueue(AutomationElement.FromHandle(window));
      var clock = Stopwatch.StartNew(); int visited = 0;
      var walker = TreeWalker.ControlViewWalker;
      while (queue.Count > 0) {
        if (++visited > 2400 || clock.ElapsedMilliseconds > 1000) return null;
        var element = queue.Dequeue();
        if (element.Current.IsPassword || element.Current.IsOffscreen) continue;
        var type = element.Current.ControlType;
        if (type == ControlType.Document && result.Context == null) result.Context = Runtime(element) + ":" + element.Current.Name;
        // Restrict evidence to standard upload controls, never arbitrary page prose.
        if (type == ControlType.Button && Regex.IsMatch(element.Current.Name ?? "", @"^(choose files?|browse[.\u2026]*|upload (?:a )?(?:file|pdf|resume|document))$", RegexOptions.IgnoreCase)) {
          string key = Runtime(element);
          string pdf = PdfName(Value(element));
          if (pdf == null) {
            var parent = walker.GetParent(element);
            var child = parent == null ? null : walker.GetFirstChild(parent); int count = 0;
            while (child != null && ++count <= 12) {
              if (child.Current.ControlType == ControlType.Text && !child.Current.IsPassword) {
                var found = PdfName(child.Current.Name);
                if (found != null) { if (pdf != null) { pdf = null; break; } pdf = found; }
              }
              child = walker.GetNextSibling(child);
            }
            if (child != null) pdf = null;
          }
          if (pdf != null) result.Files[key] = pdf;
        }
        var next = walker.GetFirstChild(element);
        while (next != null) { queue.Enqueue(next); next = walker.GetNextSibling(next); if (queue.Count > 2400) return null; }
      }
      return result.Context == null ? null : result;
    }
    void Capture(IntPtr window, int version) {
      if (!IsWindow(window)) return;
      string path = null;
      try { path = DialogPath(window); } catch (Exception) { }
      if (!IsWindow(window)) return;
      lock (gate) { if (version == generation && !cancelled) candidate = path; }
    }
    void Detach() {
      if (dialogElement != null) {
        try { if (invoked != null) Automation.RemoveAutomationEventHandler(InvokePattern.InvokedEvent, dialogElement, invoked); } catch (Exception) { }
        try { if (changed != null) Automation.RemoveAutomationEventHandler(SelectionItemPattern.ElementSelectedEvent, dialogElement, changed); } catch (Exception) { }
        try { if (valueChanged != null) Automation.RemoveAutomationPropertyChangedEventHandler(dialogElement, valueChanged); } catch (Exception) { }
      }
      dialogElement = null; invoked = null; changed = null; valueChanged = null;
    }
    public void Clear() {
      lock (gate) { generation++; candidate = null; cancelled = false; }
      Detach(); dialog = browser = IntPtr.Zero; confirmed = context = field = id = null; before = null;
    }
    public Observation Poll() {
      var front = GetForegroundWindow();
      if (Class(front) == "#32770" && front != dialog) {
        var owner = GetAncestor(GetWindow(front, 4), 2);
        if (owner == IntPtr.Zero || !Browser(owner)) {
          bool hadSelection = dialog != IntPtr.Zero || confirmed != null;
          Clear(); return hadSelection ? new Observation { ev = "upload.pending" } : null;
        }
        var root = AutomationElement.FromHandle(front);
        var open = root.FindFirst(TreeScope.Descendants, new AndCondition(
          new PropertyCondition(AutomationElement.AutomationIdProperty, "1"), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
        // shortcut: English standard Open dialogs only; add verified localized IDs/labels after native fixture coverage.
        if (open == null || !string.Equals((open.Current.Name ?? "").Replace("&", ""), "Open", StringComparison.OrdinalIgnoreCase)) {
          bool hadSelection = dialog != IntPtr.Zero || confirmed != null;
          Clear(); return hadSelection ? new Observation { ev = "upload.pending" } : null;
        }
        Clear(); browser = owner; dialog = front; opened = age.ElapsedMilliseconds;
        var baseline = ScanBrowser(browser);
        if (baseline != null) { context = baseline.Context; before = new HashSet<string>(); foreach (var entry in baseline.Files) before.Add(entry.Value.ToLowerInvariant()); }
        int version = generation; var handle = dialog;
        dialogElement = root;
        invoked = (sender, args) => {
          try {
            var element = sender as AutomationElement;
            if (element != null && element.Current.AutomationId == "2") { lock (gate) { if (version == generation) { cancelled = true; candidate = null; } } }
            else Capture(handle, version);
          } catch (Exception) { }
        };
        changed = (sender, args) => Capture(handle, version);
        valueChanged = (sender, args) => Capture(handle, version);
        Automation.AddAutomationEventHandler(InvokePattern.InvokedEvent, root, TreeScope.Subtree, invoked);
        Automation.AddAutomationEventHandler(SelectionItemPattern.ElementSelectedEvent, root, TreeScope.Subtree, changed);
        Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, valueChanged, ValuePattern.ValueProperty);
        Capture(dialog, version);
        return new Observation { ev = "upload.pending" };
      }
      if (dialog != IntPtr.Zero) {
        if (IsWindow(dialog)) {
          if (age.ElapsedMilliseconds - opened > 300000) { Clear(); return new Observation { ev = "upload.pending" }; }
          Capture(dialog, generation); return null;
        }
        Detach(); dialog = IntPtr.Zero; closedAt = age.ElapsedMilliseconds;
      }
      string path;
      lock (gate) path = cancelled ? null : candidate;
      if (browser != IntPtr.Zero && confirmed == null && (before == null || path == null || age.ElapsedMilliseconds - closedAt > 5000)) {
        Clear(); return new Observation { ev = "upload.pending" };
      }
      if (path != null && confirmed == null && before != null) {
        if (front != browser) { Clear(); return new Observation { ev = "upload.pending" }; }
        var after = ScanBrowser(browser);
        if (after == null || after.Context != context) { Clear(); return new Observation { ev = "upload.pending" }; }
        var matched = FindNewField(before, after.Files, Path.GetFileName(path));
        if (matched != null) {
          confirmed = path; field = matched; id = Guid.NewGuid().ToString("N"); selectedAt = age.ElapsedMilliseconds;
          return new Observation { ev = "upload.selected", selectionId = id, hwnd = browser.ToInt64(), path = path };
        }
      }
      if (confirmed != null && (age.ElapsedMilliseconds - selectedAt >= 120000 || front != browser)) { Clear(); return new Observation { ev = "upload.pending" }; }
      return null;
    }
    public bool Current(string selectionId) {
      if (confirmed == null || id != selectionId || age.ElapsedMilliseconds - selectedAt >= 120000 || GetForegroundWindow() != browser) return false;
      var state = ScanBrowser(browser); string name;
      return state != null && state.Context == context && state.Files.TryGetValue(field, out name)
        && string.Equals(name, Path.GetFileName(confirmed), StringComparison.OrdinalIgnoreCase) && ResolvePath(null, confirmed) == confirmed;
    }
  }
}
