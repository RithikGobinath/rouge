# Rouge — task plan

Last updated: 2026-10-24

## Completed
- [x] 16 audit fixes (security, privacy, safety, helpers) on cursor/audit-fixes-27d8
- [x] Cursor-style Auto model routing (A/B/C pool, goal-only intent, no second routing call)
- [x] Calendar conflict detection with local Qwen3.5-2B vision model (D)
- [x] Streaming responses for model-A answers
- [x] Instant time/date/greeting replies
- [x] Navigation routing to computer agent for 'show me where / open X and show'
- [x] Navigation completion fix for thin-accessibility-tree apps (Windows Settings)
- [x] Auto-wand after navigation: highlights target control automatically
- [x] pickAuto bug fix: use goal utterance not full context for SCREEN detection
- [x] Anthropic key saved in app data

## In progress
- [ ] Look up highlighted text (docs/LOOKUP.md): code and fake-backed tests written on codex/highlight-lookup; tests not run, helper selection call not validated live
- [ ] Rouge frontend UI/UX from ROUGE_BACKEND_HANDOFF.md (3D knot companion, tasks, email)
- [ ] Auto-wand reliability: element name matching and 'cant use wand' error

## Up next
- [ ] Streaming for model B/C answers
- [ ] Local Qwen chat for instant replies (reuse calendar model)
- [ ] ms-settings: deep link support for faster Settings navigation
- [ ] PR #2 review and merge (audit fixes)
- [ ] Model D visual awareness integration with A/B/C routing
