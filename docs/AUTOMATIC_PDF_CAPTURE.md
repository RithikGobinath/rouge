# Automatic PDF upload rejection detection

Implemented on `codex/pdf-upload-compression`. Detects PDF size-rejection errors using the same Windows accessibility sidecar that form autofill uses. No separate native helper process.

## Approach

Instead of a dedicated C# + PowerShell Open-dialog observer, Rouge polls the foreground browser window with the existing `sidecar.uiaList()` call — exactly the same mechanism `createFormWatcher` in `src/calendar/watch.js` uses to detect form fields.

1. Every 2 seconds (while not busy and not stopped), `createUploadCapture` calls `sidecar.fg()` to get the foreground window and `sidecar.uiaList(hwnd, 200)` to read its accessible elements.
2. `detectRejection()` scans those elements for text matching size-rejection phrases such as "File too large. Maximum file size: 2 MB." It checks against `SIZE_ERROR_RE` and rejects strings over 500 characters to avoid matching long document text.
3. If a rejection is found, `parseLimitBytes()` extracts the numeric limit (decimal units: 1 MB = 1 000 000 B; binary units: 1 MiB = 1 048 576 B). A PDF filename visible in the error text is extracted where present.
4. The callback fires at most once per browser window (hwnd) per 60-second cooldown. Stopping and restarting resets the cooldown.
5. File path identification relies on the fallback Electron file picker — "Choose the PDF that was rejected" — rather than native Open-dialog path capture. This correctly handles drag-and-drop, uploads that started before Rouge observed them, and browsers whose accessibility trees do not expose the file chooser path.

## What changed from the previous design

The earlier branch version used a custom `upload-picker.cs` (C#) and `upload-picker.ps1` helper that observed the Windows standard Open dialog to capture the native file path before the rejection. That approach was replaced because:

- The same sidecar already used by form autofill and shopping/lookup watch covers the detection step without an extra process.
- Rejection text in the browser page is the authoritative signal; path capture is a separate concern handled by the consent/compression flow's picker fallback.
- The custom C# helper required a separate JSONL process, native compilation, and UIA event subscriptions not needed elsewhere.

Removed files: `src/win/upload-picker.cs`, `src/win/upload-picker.ps1`, `test/upload-picker-native.test.js`, `test/fixtures/upload-picker-paths.ps1`.

## Current limits

- Detection requires that the browser exposes the error text as accessible text (UIA `Name` property). Sites that render errors as images, canvas elements, or otherwise inaccessible markup are not detected automatically. The plan's manual path — the user asks Rouge to "compress this PDF below 2 MB" — remains supported.
- Limit parsing handles English decimal points. Ambiguous locale separators and aggregate multi-file limits are not parsed in v1.
- File identification without an accessible filename in the error text falls back to an Electron file picker dialog.

## Validation

Authored checks in `test/upload-capture.test.js` cover `parseLimitBytes`, `detectRejection` (multiple phrasings, filename extraction, length guard, edge cases), and `createUploadCapture` (start/stop lifecycle, cooldown, busy guard, sidecar error resilience). Not executed — owner has reserved live test runs.

For owner-authorized live validation, open `test/fixtures/upload-picker.html` in a supported browser while Rouge runs and select a PDF larger than 2 MB. Confirm the log says `upload capture: size rejection detected`. Verify that ordinary help text, network errors, and non-PDF files do not trigger the callback.

```
node --test test/upload-capture.test.js
```

## Next step

Wire `onRejection` in `src/main.js` to a `pdfRecovery` module (planned, not yet implemented) that handles consent, file resolution via picker, compression and result publication per the `PDF_UPLOAD_COMPRESSION_PLAN.md` design.
