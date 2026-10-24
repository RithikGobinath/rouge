# Development handoff

Recorded 2026-10-24. Updated after the audit-fix completion pass on `cursor/audit-fixes-27d8`.

## Repository history

main imports the current desktop source, then adds the Rouge product identity and sanitized context. Existing private runtime data is not part of this repository.

codex/audit-fixes preserves the earlier unfinished candidate edits. The active completion work lives on `cursor/audit-fixes-27d8` (Ponytail Full: smallest complete change on the existing Electron/JS/C# stack).

## Audit work status

The 16-item list is in AUDIT.md. Candidate and completed code now cover all items; **none are closed until the owner reviews and validates**. Live tests, model calls and desktop trials were not run in this pass (owner-reserved).

Completed in code (pending validation):

1. Native `Secret()` aligned with `private-fields.json` / `sensitive.js` (SSN, OTP, CVC, …).
2. Point-and-ask: no whole-screen overview; nearby private rects masked; refuse when the control list is truncated.
3. Panel shortcuts run through the cancellable voice session; overlap rejected.
4. Legacy executor verifies window/focus before input and rechecks after confirmation.
5. Delete/Backspace in Explorer require the same confirmation as click-Delete.
6. Conditional “yes, but …” no longer counts as approval.
7. Computer agent requires meaningful observation / flight evidence before accepting completion.
8. Helper operation timeouts restart the JSONL process; watches restore on sidecar availability.
9. DOCX expansion bounds per entry and total.
10. ICS recurrence keeps the event time zone.
11. Speech reinitializes after helper restart.
12. Blocked shells (Terminal/PowerShell/…) stub without reading the tree; `open_app` may leave them.
13. Hotkey digit / F-key patterns corrected.
14. E2E mock and session notice updated to the route/mode/response contract and Anthropic key copy.
15. Controller + Windows fixture coverage authored for private fields / Delete / Terminal transition (Windows tests remain owner-run).
16. Inactive browser search-engine preference removed.

## Resume procedure

1. Read this file, CONTEXT.md and AUDIT.md.
2. Review the PR on `cursor/audit-fixes-27d8` against main.
3. Owner: run `npm test` on Windows (moves focus / sends input) and exercise the flight scenario before merging.
4. Do not treat syntax compilation or authored tests as end-to-end proof.

## Validation record

JavaScript syntax checks were run on touched modules. Native C# embedding was not compiled here (Linux agent host). No tests, model requests, screenshots or desktop task trials were executed in this pass.
