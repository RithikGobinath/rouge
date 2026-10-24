# Audit findings

Historical source audit recorded 2026-10-24. References point to the imported baseline; later edits may move lines. **Implementation candidates exist on `cursor/audit-fixes-27d8`; items stay open until owner review and live validation.**

Must fix
1. Some private field values are sent to Claude — [sidecar.ps1 Secret()](../src/win/sidecar.ps1)
   - Status: Code updated to match [private-fields.json](../src/pointing/private-fields.json). Windows fixture + sidecar test authored; not executed here.
2. Pointing at a harmless control can upload nearby private information — [pointAsk.js](../src/pointing/pointAsk.js)
   - Status: Overview removed; private rects masked via [capture.js](../src/pointing/capture.js); truncated lists refuse capture.
3. “Stop everything” does not stop shortcuts started from the panel — [main.js](../src/main.js) / [session.js](../src/voice/session.js)
   - Status: Panel routines use `voice.runRoutine` with the shared cancellable session.
4. The older executor still acts without a verified target — [executor.js](../src/actions/executor.js)
   - Status: Focus/window verified before input; rechecked after confirmation; guards forwarded to the sidecar.
5. The Delete key bypasses deletion confirmation — [safety.js](../src/actions/safety.js) / [controller.js](../src/computer/controller.js)
   - Status: Delete/Backspace in Explorer ask first, same reason as click-Delete.
6. Conditional answers are treated as unconditional approval — [session.js](../src/voice/session.js)
   - Status: Affirmatives must be complete phrases; conditions cancel and ask for a revised request.
7. Seeing Chrome’s toolbar can count as completing the task — [agent.js](../src/ai/agent.js)
   - Status: Meaningful observation required; flight goals need constraint evidence in the observation/answer.
8. A frozen Windows query can leave computer control stuck indefinitely — [jsonl.js](../src/win/jsonl.js) / [sidecar.js](../src/win/sidecar.js)
   - Status: `restartOnTimeout` retires the helper; watches reapplied on availability.
9. A small Word file can consume huge amounts of memory — [extract.js](../src/folders/extract.js)
   - Status: Per-entry and total uncompressed DOCX limits.
10. Recurring calendar events can shift by an hour — [ics.js](../src/folders/ics.js)
    - Status: Zone + startParts preserved; cache version bumped.
11. Speech does not recover correctly after its helper restarts — [speech.js](../src/voice/speech.js)
    - Status: Re-init on availability; listen waits for a ready recognizer.
12. Starting from Terminal prevents an otherwise valid browser task — [controller.js](../src/computer/controller.js)
    - Status: Blocked processes return a stub without a tree walk; `open_app`/`navigate` may leave them.
13. Hotkey setup rejects number keys and some function keys — [panel.js](../renderer/panel/panel.js)
    - Status: Digit0–9 and F1–F24 patterns corrected.
Should fix
14. Existing tests still expect the old model contract — [e2e.test.js](../test/e2e.test.js) / [session.test.js](../test/session.test.js)
    - Status: Route/mode/response mock and Anthropic key notice updated.
15. The new native safety checks have no direct regression coverage — [controller.test.js](../test/controller.test.js) / [sidecar.test.js](../test/sidecar.test.js)
    - Status: Mocked controller cases + Windows fixture fields authored; owner must run on Windows.
16. The search-engine preference does nothing — panel/store
    - Status: Inactive preference removed.

Verdict: Privacy, cancellation and confirmation boundaries first; then completion checks. Code is ready for owner review — not validated end to end.
