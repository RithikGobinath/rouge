# Audit findings

Historical source audit recorded 2026-10-24. References point to the imported baseline; later edits may move lines. All findings remain open pending review and validation.

Must fix
1. Some private field values are sent to Claude — [sidecar.ps1 (line 491)](../src/win/sidecar.ps1#L491)
   - What this is: The Windows helper filters private fields before returning screen information.
   - Problem: Its filter misses labels such as SSN, OTP and CVC. An ordinary editable field with one of those labels has its value included in the model’s observation.
   - Fix: Match the existing private-field policy in [sensitive.js (line 10)](../src/pointing/sensitive.js#L10). Test that these values never appear in an observation.
   - If we skip it: Personal identifiers and verification codes can leave the computer.
2. Pointing at a harmless control can upload nearby private information — [pointAsk.js (line 100)](../src/pointing/pointAsk.js#L100)
   - What this is: “Look here” sends a close-up and an overview of the whole display.
   - Problem: Only the control under the pointer is checked. Pointing at a normal button still uploads other visible private fields elsewhere on the screen.
   - Fix: Remove the unfiltered overview and mask private regions in the crop before sending it. Refuse capture when those regions cannot be checked.
   - If we skip it: The private-field check gives protection only when the user points directly at the secret.
3. “Stop everything” does not stop shortcuts started from the panel — [main.js (line 118)](../src/main.js#L118)
   - What this is: The panel runs saved shortcuts directly through the executor.
   - Problem: That run has no cancellation signal. The panic shortcut cancels the voice session, so a panel shortcut can continue typing afterward; it can also overlap another task.
   - Fix: Run panel shortcuts through the same cancellable session and reject overlapping computer work.
   - If we skip it: Two tasks can compete for the keyboard, and stopping Clippy may leave actions running.
4. The older executor still acts without a verified target — [executor.js (line 108)](../src/actions/executor.js#L108)
   - What this is: Simple commands, fallback paths and saved shortcuts still use this executor.
   - Problem: When checking the focused field fails, typing proceeds anyway. Clicks also resolve their target after a confirmation without checking that the original window is still selected.
   - Fix: Refuse input when focus cannot be checked. Preserve the intended window and recheck it after waiting or asking for confirmation.
   - If we skip it: Text can reach a password field or another application, and an approved click can hit a different window.
5. The Delete key bypasses deletion confirmation — [safety.js (line 40)](../src/actions/safety.js#L40)
   - What this is: Clicks and keyboard actions share a safety classifier.
   - Problem: Clicking “Delete” requires confirmation, but pressing Delete does not. With a file selected in Explorer, that keyboard action can remove it immediately.
   - Fix: Check destructive keyboard actions against the current application and selection, using the same confirmation rule as equivalent clicks.
   - If we skip it: The same destructive operation has different protections depending on how the model performs it.
6. Conditional answers are treated as unconditional approval — [session.js (line 23)](../src/voice/session.js#L23)
   - What this is: Confirmation replies are recognized from their opening words.
   - Problem: “Yes, but change the recipient first” matches yes. Clippy approves the original action and discards the condition.
   - Fix: Accept complete affirmative phrases only. Treat additional conditions as a changed request.
   - If we skip it: Sending or purchasing can proceed despite the user asking for a correction.
7. Seeing Chrome’s toolbar can count as completing the task — [agent.js (line 52)](../src/ai/agent.js#L52)
   - What this is: The computer worker must receive an observation before returning its final answer.
   - Problem: Any returned controls satisfy that check. If the worker sees only Chrome’s toolbar and returns “Done,” the application accepts it without checking flight dates, airports or results.
   - Fix: Require completion evidence tied to the requested outcome. For flights, check the search constraints and extracted results before accepting completion.
   - If we skip it: Clippy can still confidently report success after completing only part of a request.
8. A frozen Windows query can leave computer control stuck indefinitely — [jsonl.js (line 148)](../src/win/jsonl.js#L148)
   - What this is: Requests to the Windows helper have response timeouts.
   - Problem: A timeout removes the waiting request but leaves the helper running and marked available. If its accessibility query never returns, later requests queue behind it.
   - Fix: Invalidate the session and restart the Windows helper after an operation timeout. Restore its required watches when it becomes ready.
   - If we skip it: Later commands keep timing out until Clippy is restarted.
9. A small Word file can consume huge amounts of memory — [extract.js (line 37)](../src/folders/extract.js#L37)
   - What this is: Word documents are compressed archives that Clippy expands to extract text.
   - Problem: The two-megabyte limit checks the compressed file only. A highly compressed document can expand into hundreds of megabytes during synchronous extraction.
   - Fix: Limit each entry’s uncompressed size and the total extracted size before expansion.
   - If we skip it: Adding one document can freeze or crash the app.
10. Recurring calendar events can shift by an hour — [ics.js (line 143)](../src/folders/ics.js#L143)
    - What this is: The calendar reader expands repeated events into future occurrences.
    - Problem: It loses the original time zone and repeats events using the computer’s local clock. A daily event fixed at 09:00 UTC can change its UTC time when the computer enters daylight saving.
    - Fix: Preserve the event’s original zone and calculate repetitions in that zone. Add a clock-change regression case.
    - If we skip it: Calendar answers can show incorrect meeting times.
11. Speech does not recover correctly after its helper restarts — [speech.js (line 44)](../src/voice/speech.js#L44)
    - What this is: The shared helper manager automatically restarts a crashed speech process.
    - Problem: The recognizer is initialized only during application startup. After restart, the old “ready” name remains in memory, but the new process has no initialized recognizer.
    - Fix: Reinitialize after each helper restart and report speech unavailable until initialization succeeds.
    - If we skip it: Voice appears ready but repeatedly fails until the whole app restarts.
12. Starting from Terminal prevents an otherwise valid browser task — [controller.js (line 107)](../src/computer/controller.js#L107)
    - What this is: Computer tasks inspect the current application before acting.
    - Problem: Terminal and PowerShell are rejected immediately. Asking Clippy to open Chrome and search while either is foreground stops before Chrome can open.
    - Fix: Allow a verified transition to an installed application without reading or operating the blocked source window.
    - If we skip it: Ordinary browser requests fail depending on which application happened to be selected.
13. Hotkey setup rejects number keys and some function keys — [panel.js (line 133)](../renderer/panel/panel.js#L133)
    - What this is: Settings converts pressed keys into a saved shortcut.
    - Problem: The patterns contain literal Digitd and 1d. They do not match normal values such as Digit1 or F10.
    - Fix: Correct the digit patterns and match the function-key range accepted by the settings validator.
    - If we skip it: Users cannot configure valid shortcuts such as Ctrl+1 or Ctrl+F10.
Should fix
14. Existing tests still expect the old model contract — [e2e.test.js (line 53)](../test/e2e.test.js#L53)
    - What this is: End-to-end tests replace Claude with a local mock response.
    - Problem: The mock returns explanation JSON, while A now requires route, mode and response. A session test also still expects the old Gemini-key notice.
    - Fix: Update the mock responses and assertions to match the current routing and messages.
    - If we skip it: Tests fail for obsolete expectations and cannot reliably identify new regressions.
15. The new native safety checks have no direct regression coverage — [controller.test.js (line 16)](../test/controller.test.js#L16)
    - What this is: The controller tests replace the Windows operations with mock functions.
    - Problem: Removing a private-field or action-expiry check from the C# helper would leave these tests passing. Existing real-helper tests exercise the older operations.
    - Fix: Extend the existing Windows fixture to exercise the new snapshot and action methods, including private fields, stale controls and expired actions.
    - If we skip it: The code responsible for preventing unsafe input can break without a failing test.
16. The search-engine preference does nothing — [panel.html (line 95)](../renderer/panel/panel.html#L95)
    - What this is: Settings offers Google, Bing or DuckDuckGo for browser searches.
    - Problem: The value is saved and displayed, but no request or execution path reads it. Selecting Bing does not change search behavior.
    - Fix: Remove the inactive preference until it is connected to search execution. This deletes six lines across the panel and store.
    - If we skip it: Users are offered a setting that has no effect.
Verdict: Fix the privacy, cancellation and confirmation boundaries first. Then strengthen completion checks before expanding computer automation.