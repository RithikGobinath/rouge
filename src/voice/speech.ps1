# Speech sidecar: Windows' own on-device speech recognizer
# (System.Speech, free dictation, no key, nothing leaves the PC) streamed as
# JSON lines. It reports the words as they are heard, so the app can act
# on the first part of a sentence while the person is still saying the rest.
#
#   in : {"id":1,"op":"init","culture":"en"}          load the recognizer once, at startup
#        {"id":2,"op":"start"}                         listen on the default microphone
#        {"id":3,"op":"start","file":"C:\\x.wav"}      listen to a WAV file (used by the tests)
#        {"id":4,"op":"stop"}                          finish the phrase in progress, then stop
#        {"id":5,"op":"cancel"}                        stop now and drop the phrase in progress
#        {"id":6,"op":"quit"}
#   out: {"ev":"hyp","text":"open note"}               a guess that may still change
#        {"ev":"final","text":"open notepad","conf":0.9}  a phrase the recognizer is sure of
#        {"ev":"rejected","text":"..."}                a phrase it heard but would not stand behind
#        {"ev":"level","v":42}                         microphone level, 0 to 100
#        {"ev":"done"}                                 recognition has ended
#        {"ev":"error","message":"..."}
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.Speech

Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

public class SpeechHost {
  static readonly object Gate = new object();
  SpeechRecognitionEngine eng;
  bool running;
  bool cancelled;
  long lastLevel;

  public static void Emit(string json) { lock (Gate) { Console.Out.WriteLine(json); Console.Out.Flush(); } }
  public static string Esc(string s) {
    StringBuilder sb = new StringBuilder();
    if (s == null) s = "";
    foreach (char c in s) {
      if (c == '"') sb.Append("\\\"");
      else if (c == '\\') sb.Append("\\\\");
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') { }
      else if (c == '\t') sb.Append("\\t");
      else if (c < 32) sb.Append("\\u" + ((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.ToString();
  }

  public string Init(string culture) {
    RecognizerInfo info = null;
    foreach (RecognizerInfo ri in SpeechRecognitionEngine.InstalledRecognizers()) {
      if (culture != null && culture.Length > 0 && ri.Culture.Name.StartsWith(culture, StringComparison.OrdinalIgnoreCase)) { info = ri; break; }
      if (info == null) info = ri;
    }
    if (info == null) return null;
    eng = new SpeechRecognitionEngine(info);
    eng.LoadGrammar(new DictationGrammar());
    // Finish a phrase quickly: the app acts on pauses.
    try { eng.EndSilenceTimeout = TimeSpan.FromMilliseconds(450); eng.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(700); } catch (Exception) { }
    try { eng.InitialSilenceTimeout = TimeSpan.Zero; eng.BabbleTimeout = TimeSpan.Zero; } catch (Exception) { }
    // Keep borderline phrases instead of rejecting them: commands are short.
    try { eng.UpdateRecognizerSetting("CFGConfidenceRejectionThreshold", 10); } catch (Exception) { }
    eng.SpeechHypothesized += delegate (object s, SpeechHypothesizedEventArgs e) {
      if (cancelled) return;
      Emit("{\"ev\":\"hyp\",\"text\":\"" + Esc(e.Result.Text) + "\"}");
    };
    eng.SpeechRecognized += delegate (object s, SpeechRecognizedEventArgs e) {
      if (cancelled) return;
      Emit("{\"ev\":\"final\",\"text\":\"" + Esc(e.Result.Text) + "\",\"conf\":" + e.Result.Confidence.ToString("0.00", CultureInfo.InvariantCulture) + "}");
    };
    eng.SpeechRecognitionRejected += delegate (object s, SpeechRecognitionRejectedEventArgs e) {
      if (cancelled) return;
      string t = e.Result != null ? e.Result.Text : "";
      if (t != null && t.Length > 0) Emit("{\"ev\":\"rejected\",\"text\":\"" + Esc(t) + "\"}");
    };
    eng.AudioLevelUpdated += delegate (object s, AudioLevelUpdatedEventArgs e) {
      long now = Environment.TickCount;
      if (now - lastLevel < 50) return;
      lastLevel = now;
      Emit("{\"ev\":\"level\",\"v\":" + e.AudioLevel + "}");
    };
    eng.RecognizeCompleted += delegate (object s, RecognizeCompletedEventArgs e) {
      running = false;
      if (e.Error != null) Emit("{\"ev\":\"error\",\"message\":\"" + Esc(e.Error.Message) + "\"}");
      Emit("{\"ev\":\"done\"}");
    };
    return info.Culture.Name + " | " + info.Description;
  }

  public void Start(string file) {
    if (eng == null) throw new InvalidOperationException("speech is not initialised");
    if (running) return;
    cancelled = false;
    if (file != null && file.Length > 0) eng.SetInputToWaveFile(file); else eng.SetInputToDefaultAudioDevice();
    running = true;
    eng.RecognizeAsync(RecognizeMode.Multiple);
  }
  public void Stop() { if (eng != null && running) eng.RecognizeAsyncStop(); }
  public void Cancel() { cancelled = true; if (eng != null && running) eng.RecognizeAsyncCancel(); }
  public void Dispose() { try { if (eng != null) eng.Dispose(); } catch (Exception) { } }
}
"@

# one line at a time on stdout, even while the recognizer is writing its own from another thread
function Send($thing) { [SpeechHost]::Emit((ConvertTo-Json -InputObject $thing -Compress -Depth 4)) }

$recognizer = New-Object SpeechHost

# what each request does; every one answers with the id it came with
$Ops = @{
  ping   = { param($r) @{ ok = $true; pid = $PID } }
  init   = {
    param($r)
    $name = $recognizer.Init([string]$r.culture)
    if ($null -eq $name) { @{ error = 'no speech recognizer is installed' } } else { @{ ok = $true; recognizer = $name } }
  }
  start  = { param($r) $recognizer.Start([string]$r.file); @{ ok = $true } }
  stop   = { param($r) $recognizer.Stop(); @{ ok = $true } }
  cancel = { param($r) $recognizer.Cancel(); @{ ok = $true } }
  quit   = { param($r) $script:leaving = $true; @{ ok = $true } }
}

$script:leaving = $false
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
Send @{ ev = 'ready'; pid = $PID }
while (-not $script:leaving) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = $req.id
    $op = [string]$req.op
    $answer = if ($Ops.ContainsKey($op)) { & $Ops[$op] $req } else { @{ error = "unknown op $op" } }
    $answer.id = $id
    Send $answer
  } catch {
    Send @{ id = $id; error = [string]$_.Exception.Message }
  }
}
$recognizer.Dispose()
