# Rouge — handoff

Updated: 2026-10-25 (America/Los_Angeles)
Branch: codex/wand-unravel-wrap
Node: 24.18.0 | Electron 45
App: npm start (CLIPPY_VERBOSE=1 for logs)
Tests: npm test (node --test test/**/*.test.js)

## Current task
Wand animation from `codex/ribbon-unravel-orbit`, brought onto main without that branch's development commands (`point a`–`point d`, `npm run wand`).
- The upper curve of the ribbon unwinds from the knot and winds twice around the target. The last lap lies one ribbon half-width plus 4 px from the target, so it never covers the text; earlier laps sit one ribbon-width further out like a coil. (`renderer/shared/wand-geometry.js`)
- The wand stays on the target for 4 s plus about 55 ms per character of the explanation shown with it, at most 15 s, then draws back in over 1.5 s. A longer answer arriving late extends the hold; a spent hold is never cut. (`holdFor`, `setHold`)
- `point:target` messages marked `follow` (the control scrolled) glide the wand over without restarting its cycle, and are ignored once it has drawn in. The main process stops watching the control when the overlay reports the wand retracted (`overlay:point:retracted`) and after 45 s regardless. (`src/pointing/track.js`, `pointAsk.js`)
- The tracker finds the same control again by name only: never a blank name, a short fragment or an element of very different size. Before this a whitespace-named element could capture the wand.
- Auto-wand now ranks elements by how many specific details (words, prices, times) they share with the agent's reply. A one-word name needs "click X" in the reply, a name with nothing specific in it is never chosen, and the application's own name (for example the browser's "Chrome" menu button) is skipped unless the request mentioned it.
- The computer agent's final answer is limited to about 50 words, as one JSON object, to shorten the wait before the wand points. Each model call now logs output and input tokens.
- Known gap: meeting reminders used to end the wand in a flowing underline at the clock; the new wand ignores that option and wraps the clock instead.
- Validation: the owner ran the app on Windows with a cheapest-flight request and confirmed it worked end to end. Other pages, the reduced-motion paths and multi-monitor DPI cases were not exercised live. The unit tests were also executed during development, including sidecar tests that drive the real desktop; do not run the full suite without meaning to.

## What's done
- All 16 audit fixes on this branch (security, privacy, safety)
- Auto model routing: A/B/C pool, goal-only SCREEN/INTERACTIVE detection (fixed false-triggers from front-window names in context)
- Calendar conflict detection (D): local Qwen3.5-2B on CUDA, vision OCR only, deterministic intent+date in code, proposalIntent regex + Claude A fallback for ambiguous text
- Streaming: model-A answers stream word-by-word to overlay via ui:stream IPC
- Instant replies: greetings, acks, time, date answered locally in <1 ms
- Navigation routing: NAVIGATE regex routes 'show me where/open X and show/point to X/where is X' to computer agent
- Navigation completion: isNavigationGoal() lowers evidence bar for thin-accessibility pages; plain-text fallback added for navigation goals
- Auto-wand: after navigation, snapshot elements matched to agent reply, pointAt() triggered automatically
  - Improved matching: full-name substring OR multi-word significant-word fallback (e.g. "Close button" matches "Close Window")
  - Completion passthrough: computer agent empty-actions result now includes snapshot so doClause can fire autoWand
  - Session.js NAV_RE aligned with auto.js NAVIGATE patterns (point-to, where-is, highlight added)
- Local time context: model contexts show local wall-clock time, no UTC prefix
- sidecar.ps1 Computer-Row: rect (x, y, w, h) now included when width and height are non-zero (wand needs coords)
- Rouge knot companion frontend: 3D red satin knot renderer built from ROUGE_BACKEND_HANDOFF.md spec
  - renderer/rouge-knot/: living-knot.js (physics), rouge-engine.js (WebGL), rouge-motion.js (curves), app.js, styles
  - src/app/knotWindow.js: Electron BrowserWindow wrapper
  - src/preload/knot.js: IPC bridge
  - Disabled by default in main.js (remove `false &&` to activate once design is approved)

## Key decisions
- Auto: use goal (utterance only) not full user context string for SCREEN/INTERACTIVE detection — front-window names caused false computer-mode triggers
- Calendar D: model only transcribes OCR; code owns intent+date extraction
- Navigation: computer agent uses Settings search box (ms-settings: URIs blocked by action validators)
- Streaming: plan/explain paths not streamed (need full JSON parse first)
- Knot window: intentionally disabled by default; no UI decision made yet on placement

## How to run tests

```sh
npm test
node --test test/conflict.test.js test/calendar-watch.test.js test/auto.test.js test/session.test.js
```

## Next three steps
1. Test wand on live Windows: say "point to the close button" or "where is the volume control" and verify the highlight fires
2. Review knot frontend design with owner: decide placement (ribbon companion? overlay? tray popup?) and enable in main.js
3. Merge PR #2 (cursor/audit-fixes-27d8 → main) after owner review of all 16 audit items
