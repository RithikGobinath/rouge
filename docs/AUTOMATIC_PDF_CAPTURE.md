# Automatic PDF path capture

Implemented on `codex/pdf-upload-compression`. This is the file-identity component of PDF upload recovery. It does not compress files or detect size errors yet.

## What happens

Rouge observes the Windows Open dialog the user already uses to select an upload. It does not open a second picker or ask the user to select the PDF again.

1. A dedicated, read-only helper recognizes a standard Open dialog owned by Chrome, Edge, Firefox or Brave. It records the browser document and pre-existing file selections.
2. While the dialog is open, it reads the filename field and canonical local address. Selection/value/invoke events supplement the 100 ms observation interval. It neither types nor clicks.
3. After the dialog closes, the helper requires a new matching PDF in a standard upload control of the same browser document. Dialog closure or an Open-button event alone does not count as acceptance.
4. Only then does the main process retain the full path and file identity in memory, for at most two minutes. An existing filename, multiple matching controls, incomplete evidence, cancellation or an unrelated foreground window cannot create a confirmed selection.
5. Before a future consumer uses the path, `await services.uploads.current({ hwnd, name })` checks the current browser field/document and the PDF's size, modification time and filesystem identity again. It returns the confirmed record or null. Both filters are optional but should be supplied when correlating an upload error.

Paths stay out of provider prompts, settings, renderer IPC and logs. File contents are not read. UNC/network paths, fake paths, alternate streams, non-PDFs, wildcard/multiple selections and missing files are rejected. No drive search or browser-profile/cache access is performed.

The helper uses the existing JSONL process transport, with restart/timeouts, but runs separately from the Windows input helper. It does not create computer snapshots or invalidate the computer agent's control references. Outside picker observation and a brief acceptance window, it only checks foreground-window identity; browser accessibility reads are not an ongoing background page scan.

Pause stops it and clears its state; resume starts it again. Panic stops it until a subsequent tray pause/resume or app restart. Shutdown and helper recovery clear old paths. It does not run in smoke/screenshot mode or off Windows.

## Current limits

- English standard Windows Open dialogs and recognizable standard file-upload controls only. Custom dialogs, unusual labels and inaccessible upload widgets are skipped.
- Very fast selection/closure can outrun accessibility events. Missing evidence fails closed; no guessed path or follow-up picker appears.
- Re-selecting a basename already present before the dialog is conservatively rejected. A changed file selection must be distinguishable from a cancelled dialog.
- Drag-and-drop, multiple files, virtual shell locations, mapped network drives, reparse points (including junctions and some cloud placeholders), and paths longer than 260 characters are not captured.
- Switching away from the browser discards the selection. A future compression flow should resolve the candidate before moving focus to its consent UI, then revalidate the confirmed file before reading it.
- Successful native compilation is not proof of compatibility with the user's Windows/browser UIA providers. Actual dialog/path/value exposure remains for owner validation.

## Validation

Performed: C# compilation of the helper and syntax checks of JavaScript/PowerShell. The observer was not started during development.

Authored checks, not executed:

```powershell
node --test test/upload-capture.test.js test/upload-picker-native.test.js
```

The JavaScript checks use a fake helper and stat provider. The native check compiles the C# and uses temporary synthetic files to check path resolution and new/stale/ambiguous selection matching; it does not open desktop UI.

For owner-authorized live validation, open `test/fixtures/upload-picker.html` in a supported browser while Rouge runs. Choose a synthetic PDF from a local folder using Open, Enter and double-click in separate runs. Confirm the metadata-only log says `upload capture: PDF selection confirmed`. Verify cancellation, a second same-named PDF, multiple upload controls, changed files, browser navigation, expiry, pause/panic and helper recovery never return a stale candidate. A PDF larger than two million bytes makes the fixture show a size error, but that error is not processed by this component yet.

Repository AGENTS.md reserves execution of tests and live desktop validation for an explicit owner instruction. No test, screenshot, model request or native picker interaction was performed for this implementation.

## Native references

- [Microsoft UI Automation event subscriptions](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-eventsforclients)
- [Microsoft AutomationProperty.LookupById](https://learn.microsoft.com/dotnet/api/System.Windows.Automation.AutomationProperty.LookupById)
- [Microsoft UIA property identifiers](https://source.dot.net/System.Windows.Forms.Primitives/Generated/Basic.CompilerLog.Util/Basic.CompilerLog.Util.Impl.BasicGeneratedFilesAnalyzerReference/Windows.Win32.UIA_PROPERTY_ID.g.cs.html)
