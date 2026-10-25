# Form Autofill — Feature Plan

Branch: `codex/autofill-profile`
Updated: 2026-10-25

---

## Goal

When Rouge detects that the focused window is a form (job application, sign-up, contact form, etc.), it shows a small popup that says **"Fill it?"**. The user taps yes and Rouge fills the fields using their personal profile, which is seeded from their résumé and can be extended by voice at any time.

---

## Phase 1 — Profile JSON (this session, done)

**Files written:**
- `src/profile/profile.json` — seeded from Rithik's résumé (`.gitignored`, personal data stays local)
- `src/profile/index.js` — `loadProfile / saveProfile / updateProfile / appendNote / profileForAutofill`

**Schema (version 1):**

```
personal        – name, email, phone, location, linkedin, github, website
education[]     – school, degree, field, startYear, endYear, gpa, location, notes
experience[]    – company, title, subtitle, startDate, endDate, location, description[]
skills          – { languages[], ai[], dataScience[], biomedical[], mlopsCloud[] }
projects[]      – name, technologies[], license, url, description
publications[]  – title, journal, year, doi, role, status
scholarMetrics  – citations, hIndex, i10Index, source
notes[]         – { text, addedAt }  ← append-only; grows by voice
```

`profileForAutofill()` returns a trimmed subset (no publications/scholarMetrics) safe to embed in a model prompt.

**"Add new stuff" via voice** — next session:
Route utterances that look like profile updates (`my email is …`, `I now work at …`, `add a note: …`) through `appendNote()` or structured `updateProfile()`. The session layer (or prompt) recognises the intent and calls the profile module directly, no computer agent needed.

---

## Phase 2 — Form Detection

**Where:** Extend `src/calendar/watch.js` (already has a 1 s background tick with activity gating — calendar conflict check runs here).

**How:**
1. On each tick, call `sidecar.snapshot()` on the focused window.
2. Run a cheap heuristic on the UIA element tree:
   - Count `Edit` control-type elements with associated labels.
   - Presence of "Submit", "Apply", "Sign up", "Continue" button text.
   - Score ≥ threshold → treat as form.
3. Debounce: only emit a form-detected event after the same window scores as a form for 2 consecutive ticks (avoids flicker on partial renders).
4. Clear the event when the focused window changes.

**Heuristic thresholds (tunable constants):**

| Signal | Weight |
|--------|--------|
| Edit field with label | +2 |
| Unlabelled Edit field | +1 |
| Submit/Apply/Continue button | +3 |
| Window title contains "apply", "sign up", "register", "contact" | +2 |
| Score ≥ 5 | → form detected |

**Files to change:** `src/calendar/watch.js`

---

## Phase 3 — "Fill it?" Popup

**Mechanism:** Reuse the existing `ask` card already used by the computer agent for confirmation prompts. The overlay already renders Ask cards with yes/no.

**Flow:**
1. Form detected → main process emits `autofill:detected` with `{ windowTitle, fields[] }`.
2. `src/autofill/index.js` calls `voice.ask({ kicker: 'Form detected', title: 'Fill it?' })`.
3. User taps Yes → proceed to Phase 4. User taps No (or ignores) → suppress for this window until focus changes.

**IPC changes:** None new. The `voice.ask` path in `src/voice/session.js` already sends an ask card and waits for overlay reply.

**Files to change / create:**
- `src/autofill/index.js` — `createAutofill({ profile, voice, log })` → `{ fill(formInfo) }`
- `src/main.js` — instantiate autofill, wire to calendar watch tick output

---

## Phase 4 — Filling

**Mechanism:** Build a natural-language fill command and route it through the existing computer agent (Model B / Sonnet). No new model.

**Command template:**
```
Fill the form fields in <windowTitle> using this profile data: <profileForAutofill JSON>.
Fields visible: <field names from snapshot>. Match semantically. Do NOT submit.
```

The computer agent uses `computer_act` to click each field and type the value. It already handles text input on Windows via the sidecar.

**Files to change:** `src/autofill/index.js` (fill command), `src/voice/session.js` (`runText` path already exists)

---

## Phase 5 — Voice Profile Updates

**Intent patterns (handled in session.js or prompt):**

| User says | Action |
|-----------|--------|
| "my email is X" | `updateProfile({ personal: { ...p.personal, email: X } })` |
| "I now work at X as Y" | append to `experience` |
| "add a note: X" | `appendNote(X)` |
| "I'm open to remote" | `appendNote('Open to remote roles')` |
| "update my phone to X" | `updateProfile({ personal: { ...p.personal, phone: X } })` |

Implementation: A small regex/keyword check in the instant-reply layer (`src/voice/reflex.js`) catches obvious patterns before they reach Model A. Ambiguous updates fall through to Model A which can call a new `profile_update` tool.

**Files to change:** `src/voice/reflex.js`, `src/voice/session.js`

---

## Phase 6 — Future: User-editable UI (later)

A settings panel tab where the user can view and edit all profile fields directly. Out of scope for this branch.

---

## File Map

| File | Status | Notes |
|------|--------|-------|
| `src/profile/profile.json` | ✅ Done | .gitignored; seeded from résumé |
| `src/profile/index.js` | ✅ Done | load/save/update/appendNote/profileForAutofill |
| `src/autofill/index.js` | ⬜ Next | createAutofill, fill() |
| `src/calendar/watch.js` | ⬜ Next | add form-detection tick |
| `src/voice/session.js` | ⬜ Next | wire profile-update intents |
| `src/voice/reflex.js` | ⬜ Next | instant profile-update patterns |
| `src/main.js` | ⬜ Next | instantiate autofill, wire sidecar events |
| `src/app/ipc.js` | ⬜ Maybe | autofill:fill IPC handler if needed |

---

## What is NOT in scope

- A browser extension or DOM injection (existing computer agent fills via UIA/keyboard, works on any window)
- A new model for detection (heuristic only)
- Submitting forms (agent explicitly told: do NOT submit)
- Storing profile in the cloud
- Multi-user profiles
