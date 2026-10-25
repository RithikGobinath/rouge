# PDF upload size recovery — feature plan

Status: planning only; no feature implementation.
Branch: `codex/pdf-upload-compression`
Base: `main` at `d7f8a1eabdf8b6f9efa4d4785386339e06bb3b71`
Date: 2026-10-25 (America/Los_Angeles)

## Outcome

When a user tries to upload a PDF and the site rejects it for exceeding its size limit, Rouge notices the error, identifies the PDF and asks whether to compress it. On consent it creates a separate, verified smaller PDF below the site's limit and offers that copy for review and manual re-upload.

Example, illustrative sizes only:
- User selects resume.pdf (4.8 MB); the site says “Maximum file size 2 MB.”
- Rouge: “resume.pdf is too large for this site's 2 MB limit. Want me to compress a copy? Image quality may decrease.”
- Yes: compress locally and verify.
- Rouge: “Ready: 1.7 MB, below the 2 MB limit. Original unchanged.” Offer Preview and Show in folder.
- User selects the compressed copy on the site. Rouge does not upload or submit it automatically.

This plan covers Windows and ordinary static PDFs first. It does not add image/video/Word compression, a browser extension, another model, a dashboard or automatic submission.

## Grounding in the current code

- `src/main.js` owns feature lifecycle and already composes the Windows sidecar, voice session, overlay and IPC.
- `src/win/sidecar.js` and `sidecar.ps1` provide foreground/click activity and UI Automation reads. Watch owners already share a single native watcher.
- `src/app/overlayUi.js` provides confirmation cards, notices and cancellation.
- `src/voice/session.js` supports confirmation by voice or text and owns the shared cancellable request session.
- `src/app/ipc.js` checks renderer senders and input shapes and already uses Electron dialogs.
- `pdfjs-dist` is installed for PDF reading; it is not the compression engine.
- `calendar/watch.js` is gated on a calendar snapshot and local model readiness. Upload recovery must work without either, so do not put it inside the calendar watcher.
- `computerSnapshot()` changes the native snapshot generation. A background upload observer must not call it and invalidate an active computer worker's refs. Use a separate bounded read-only UIA operation.

## 1. Detection and evidence

Use accessibility first; keep PDF bytes, file paths and compression decisions local.

Add a small upload observer using the existing sidecar watch-owner mechanism. Foreground/activity events cause debounced reads of the active browser or native file chooser. Keep one read in flight. After a verified file selection, allow a bounded 30-second observation window with at most one read per second to catch a delayed size error. Cancel on unrelated foreground/page changes, pause, panic, helper loss or expiry. Do not start a permanent screenshot or full-desktop scan.

The observation should return a compact, bounded record: browser/window identity, accessible upload control label or ID where available, displayed filename, visible size-related error text and numeric limit evidence. Treat every field as untrusted data. Native observation must exclude protected fields and must not dump unrelated document text to logs.

A size error needs explicit rejection evidence such as “file too large”, “exceeds maximum file size” or “must be less than 2 MB”, associated with the upload area or a native upload error. A size limit appearing in ordinary help text alone is not a failed upload. Reject unsupported-file-type, network, quota and generic HTTP errors as compression triggers.

Parse the limit in code:
- Accept a positive number with an explicit B/KB/MB/GB or KiB/MiB/GiB unit.
- For decimal labels use 1 KB = 1,000 bytes, 1 MB = 1,000,000 bytes. Preserve explicit binary units.
- Support English decimal points initially. Do not silently interpret an ambiguous comma, locale or unrelated number.
- Distinguish per-file limits from aggregate limits. Multi-file and aggregate upload failures are out of v1 scope.
- If the numeric limit is absent or contradictory, ask for it rather than inventing a target.
- Confirm the actual PDF exceeds the resolved limit before saying it is too large.
- Deduplicate an offer by upload-context ID + source identity + limit; dismissal suppresses repeats for that attempt. A new selection can create a new attempt.

V1 automatically assists only when the error is accessible. If a site renders the error as an inaccessible image/canvas, explain that the limit cannot be read and support the user's explicit “compress this PDF below 2 MB” path through the same file picker and compressor. No OCR dependency is introduced.

## 2. Identify the actual local PDF

This is the main integration constraint. Standard browser file inputs do not expose the real local path; `C:\\fakepath\\name.pdf` is not usable file identity. See [HTML file upload state](https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file)) and [MDN file input documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file).

Preferred automatic evidence:
1. Observe the standard Windows Open dialog while the user selects a file.
2. Read the dialog's actual selected item/path and owning browser using UIA or a narrowly scoped native helper; require selection acceptance, not merely a typed filename or highlighted item.
3. Correlate the accepted selection, returned browser window, filename and subsequent rejection within the short observation window.
4. Keep one candidate in memory for that attempt; expire it after two minutes or sooner on a new/cancelled selection or unrelated navigation.

Automatic path capture is a feasibility gate, not an assumed Windows capability. Some shell dialogs omit a canonical path or close before accessibility can report acceptance. Never move the pointer, intercept arbitrary keystrokes or guess a path to make the automatic route appear to work.

Fallback: after the user accepts the offer, open Electron's PDF picker with “Choose the PDF that was rejected.” This handles drag-and-drop, uploads started before Rouge observed them, inaccessible dialogs, same-name files and ambiguous multi-tab contexts. A mismatch with the displayed filename needs explicit confirmation before proceeding.

Do not search Downloads/Documents/the whole drive by filename. Do not read browser profiles or upload caches. Do not accept a page/model-provided absolute path as authorization to read a local file.

## 3. Consent and task ownership

Use the existing compact confirmation card and complete yes/no handling. Display filename, observed limit and possible image-quality reduction. Compression consent covers creating a local copy of that specific PDF, not uploading it.

Run recovery inside the shared cancellable session:
- Background detection must not overwrite another pending confirmation or overlap a running voice/computer task.
- Detection/notification can be queued briefly; revalidate context before asking.
- A typed stop, panic or decline cancels the offer, dialogs where supported, pending reads and any compression child.
- The source capability stays in the main process. Renderer actions carry an opaque attempt/result ID, never an arbitrary path or executable.
- If the limit is unknown, a pending upload-recovery prompt can consume the user's next explicit size answer before ordinary AI routing. Validate it with the same parser.

After confirmation, a foreground change does not redirect file access; compression remains tied to the confirmed source. A changed/deleted source stops the operation and asks for reselection.

## 4. Local compression

Recommended engine: Ghostscript's `pdfwrite`, invoked as a local child process. It supports image downsampling, but rewrites the document rather than preserving its original internal structure. Nonvisual content can change. See [Ghostscript high-level devices](https://ghostscript.readthedocs.io/en/latest/VectorDevices.html) and [command-line operation](https://ghostscript.readthedocs.io/en/latest/Use.html).

Dependency decision before implementation:
- Verify a maintained Windows build and its distribution/license requirements.
- Development may use a verified installed executable; do not quietly download/install one at runtime.
- A shipped version needs a deliberate packaging solution. Missing engine means a clear “PDF compression is not set up” result; no cloud fallback.
- Do not add a generic plugin/backend abstraction for one engine.

Preflight the actual local file:
- Require a local regular file, .pdf extension, PDF header and successful parser open.
- Reject encrypted/password-protected documents, digital signatures, interactive forms, portfolios/attachments and other structures whose preservation cannot be established in v1. If signature/form status cannot be established, fail safely rather than calling it preserved.
- Proposed resource bounds: 100 MB input, 300 pages, at most three attempts, and a two-minute total deadline. Final limits can be adjusted after owner-authorized fixture validation.
- Check available scratch space. Snapshot the confirmed source to a private job directory and verify identity/size/mtime before and after copying; stop if it changed. Hashes stay local.
- Never reuse `folders/extract.js`'s 2 MB cap: oversized PDFs are the input this feature needs to handle.

Try at most three named quality tiers from highest to lower image quality, always from the source snapshot:
1. Image optimization/downsampling at approximately 150 DPI.
2. Approximately 120 DPI.
3. Approximately 96 DPI; do not keep reducing below the quality floor.

These are proposed starting tiers, not measured quality guarantees. Keep text/vector content where the engine supports it; do not rasterize every page, delete pages, remove text or silently switch to black-and-white to satisfy the target.

Use an absolute, verified executable with `spawn/execFile` and an argument array, shell disabled, hidden window, bounded output and cancellation. Arguments and output paths come from code, not the page or a model. Enable the engine's restricted execution settings and isolate each job; do not describe those flags alone as a complete OS sandbox. Run without elevation, and limit allowed file access to the confirmed scratch input/output as supported.

## 5. Target size, validation and output

The target is below the site's allowed size, not merely smaller than the original.

Use a 5% margin: `budgetBytes = floor(limitBytes * 0.95)`. An acceptable result must satisfy all of:
- It is nonempty and strictly smaller than both `limitBytes` and the original.
- It is at or below the budget.
- It reopens successfully as a PDF.
- Page count and page dimensions/rotation match the original.
- All pages decode/render within bounds. For text PDFs, compare available extracted text and reject obvious missing content. Text checks do not establish visual equivalence.
- Protected/interactive structures were excluded before rewriting.

Visual fidelity needs owner review and representative regression fixtures; a byte-size check or parser open cannot prove legibility. Offer Preview for every successful result.

Write candidates only inside a private temporary job directory. Publish the highest-quality passing tier as a new sibling file, e.g. `resume-compressed.pdf`, with an automatically suffixed name on collision. Never replace the source or an existing file. If the source folder is not writable, use a Save As dialog. For another destination volume, use a temporary destination file, verify it, then publish without overwrite. Clean partial files and scratch copies on failure/cancel and clean abandoned job directories at startup.

Completion message includes actual original size, actual compressed size, interpreted limit and the output filename. Provide Preview and Show in folder using a result ID resolved in the main process. No automatic upload/retry, no success claim about what the website will accept.

If no tier meets both size and quality rules, say so. A valid smaller copy that is still too large may be offered as an explicitly labeled best effort, but it must not appear as the successful under-limit result or be published automatically as one.

## State sketch

```text
idle
  -> observe accepted file selection or accessible rejection
  -> correlate error + limit + source candidate
  -> offer (wait until no other task/confirmation owns the UI)
      no/timeout -> dismiss this attempt
      yes -> resolve file and missing limit through trusted dialogs/text
  -> preflight and private source snapshot
  -> compress bounded tiers
  -> validate PDF and byte budget
      pass -> publish separate copy -> preview/reveal
      exhausted -> clear explanation, no false success
      stop/error -> kill job, clean temporary files, preserve original
```

## Smallest implementation surface

Proposed paths; consolidate if implementation shows that fewer files are clearer.

| Area | Files | Change |
| --- | --- | --- |
| Feature coordinator | new `src/uploads/pdfRecovery.js` | Evidence/limit parser, attempt identity, UIA observation scheduling, consent and file-resolution flow. |
| Compressor | new `src/pdf/compress.js` | Preflight, engine invocation, bounded tiers, validation and safe publication. No general file-conversion framework. |
| Native observation | `src/win/sidecar.js`, `sidecar.ps1` | Bounded upload/dialog evidence without modifying computer snapshot refs. |
| Lifecycle | `src/main.js` | Construct/start/stop observer, dialogs, verified engine location, pause/panic/shutdown cleanup. |
| Task session | `src/voice/session.js` | One cancellable local PDF-recovery task, no overlap, explicit compression command and missing-limit reply. Reuse existing request ownership. |
| UI and IPC | `src/app/ipc.js`, `overlayUi.js`, `src/preload/overlay.js`, `renderer/overlay/overlay.js` | Reuse confirmation card; small result actions/progress; sender checks and opaque result IDs. Extend HTML/CSS only if current bubble cannot hold the needed buttons. |
| Packaging/docs | `package.json` only if needed, setup docs | Declare the chosen engine distribution and missing-engine behavior. |
| Checks/fixtures | focused new tests; relevant session/sidecar tests | Synthetic PDFs and local mock pages/dialog fixtures, no personal documents. |

Do not add compression to the model action schema. The local capability owns file selection, processing and output; page text cannot turn it into arbitrary filesystem access. Do not merge autofill or reminder branches just to implement this feature. Shared `main.js`/session/native-helper changes will need reconciliation when those features are later integrated.

## Acceptance checks to author

1. Size rejection + filename + 2 MB limit produces one relevant offer; ordinary help, network failures and wrong file types do not.
2. Per-file and aggregate errors are distinguished; units, fractions, missing/ambiguous limits and strict byte boundaries are handled.
3. A native-dialog path is used only when acceptance and owning browser are verified; cancelled dialogs, fake paths, duplicate basenames, drag-and-drop and stale contexts use the picker fallback.
4. Exact file identity is revalidated; missing/changed files, denied access, malformed PDFs, encrypted/signed/form PDFs and unsupported structures fail without touching the source.
5. Highest-quality passing candidate wins; all candidates exceeding the limit, bigger-than-source output, empty/corrupt output, missing pages and unusable output cannot count as success.
6. Decline, timeout, typed stop and panic preserve the source, kill processing and clean scratch; overlapping requests/confirmations do not steal the UI.
7. Observer does not alter native computer refs or depend on calendar/Qwen/API keys; repeated rejection cannot spam prompts.
8. Filenames with spaces/Unicode/leading punctuation, path-injection strings, collisions, disk-full, cross-volume publication and read-only source folders are handled safely.
9. Source PDFs/paths, extracted content and raw errors never enter model calls or verbose logs; logs contain bounded stage/status/size/duration diagnostics only.
10. Preview/reveal resolve a valid main-process result ID; arbitrary renderer paths are rejected.
11. Owner-run Windows scenario: native chooser -> accessible size error -> offer -> consent -> valid under-limit copy -> user reselects it. Include a drag-and-drop fallback scenario and an impossible-target scenario.

The plan adds no running app behavior and executes no test/model/desktop action. Repository AGENTS.md reserves live testing for a separately authorized instruction.

## Implementation order and remaining decisions

1. Prove the read-only UIA rejection/dialog evidence surface against synthetic fixtures; retain picker fallback as a supported path even if automatic capture succeeds.
2. Finalize engine distribution and signed/form PDF preflight. Do not promise a dependency-free compressor with only the current reader libraries.
3. Implement local compression + file safety + meaningful unit/fixture checks.
4. Add the shared cancellable consent/session flow, observer and result actions.
5. Perform owner-authorized fidelity and Windows upload validation.

Defaults proposed for review: Windows first; local processing; copy beside the original; manual re-upload; reject protected/interactive PDFs; 5% size margin; a fixed three-tier quality floor. File detection cannot be universal without browser integration, and some PDFs cannot fit an arbitrary limit while remaining readable.
