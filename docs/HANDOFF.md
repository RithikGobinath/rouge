# Rouge — handoff

Updated: 2026-10-24 (America/Los_Angeles)
Branch: cursor/audit-fixes-27d8
Node: 24.18.0 | Electron 45
App: npm start (CLIPPY_VERBOSE=1 for logs)
Tests: npm test (node --test test/**/*.test.js)

## Current task
Implementing Rouge frontend UI/UX from ROUGE_BACKEND_HANDOFF.md — the 3D red satin knot companion with tasks, email, drag-from-anywhere. Source files auth-gated at the live site; building from spec.

## What's done
- All 16 audit fixes on this branch (security, privacy, safety)
- Auto model routing: A/B/C pool, goal-only SCREEN/INTERACTIVE detection (fixed false-triggers from front-window names in context)
- Calendar conflict detection (D): local Qwen3.5-2B on CUDA, vision OCR only, deterministic intent+date in code, proposalIntent regex + Claude A fallback for ambiguous text
- Streaming: model-A answers stream word-by-word to overlay via ui:stream IPC
- Instant replies: greetings, acks, time, date answered locally in <1 ms
- Navigation routing: NAVIGATE regex routes 'show me where/open X and show' to computer agent
- Navigation completion: isNavigationGoal() lowers evidence bar for thin-accessibility pages
- Auto-wand: after navigation, snapshot elements matched to agent reply, pointAt() triggered automatically
- Local time context: model contexts show local wall-clock time, no UTC prefix

## Half-done
- Auto-wand reliability: element matching may be too strict; investigating 'cant use wand' failure
- Rouge frontend: need source bundle or to implement knot renderer from spec math

## Key decisions
- Auto: use goal (utterance only) not full user context string for SCREEN/INTERACTIVE detection — front-window names caused false computer-mode triggers
- Calendar D: model only transcribes OCR; code owns intent+date extraction
- Navigation: computer agent uses Settings search box (ms-settings: URIs blocked by action validators)
- Streaming: plan/explain paths not streamed (need full JSON parse first)

## How to run tests

```sh
npm test
node --test test/conflict.test.js test/calendar-watch.test.js test/auto.test.js
```

## Next three steps
1. Fix auto-wand element matching (case-insensitive partial match, remove 'cant use wand' fallback message)
2. Get Rouge frontend source bundle (auth-gated at https://ribbon-companion-workspace.richvole6.chatgpt.site) and integrate into Electron
3. Push current commits and open PR review
