# Form Autofill — Revised Plan

Branch: `codex/autofill-profile`
Updated: 2026-10-25 (after research pass)

---

## What the research found

Three production implementations were studied:

| App | Approach | Key insight |
|-----|----------|-------------|
| **FillWright** (Chrome ext, open-source) | Scan → Plan → Execute → Correct loop; Gemini Nano on-device; MCP tool surface; per-field confirmation overlay | Don't send a big profile blob to the model — extract a typed *field schema* first, then map profile keys to fields deterministically. Only use AI for the ambiguous remainder. |
| **FormMind AI** (Windows desktop, WPF) | Screenshot → UI-DETR-1 vision model for element detection → RapidOCR for text → LLM for field-label pairing → UIA execution | For Windows apps use UIA patterns (ValuePattern, TogglePattern, SelectionItemPattern) not keyboard input — no mouse movement, no focus steal, works on background windows. |
| **agent-win / Chromium autofill** | UIA FocusChanged events (not polling); resolve labels via LabeledBy → Name → HelpText → nearby StaticText by bounding-box distance | Use event-driven detection, not a 1 s timer. UIA address by RuntimeId/AutomationId so refs survive layout changes. |

---

## What was wrong with the original plan

| Original plan | Problem |
|--------------|---------|
| Form detection in `watch.js` (1 s poll) | Laggy; pollutes the calendar module; misses React/dynamic forms that render in <1 s |
| Score heuristic only (count Edit fields + button text) | No actual field schema extracted — can't build a fill plan |
| Send full profile JSON as a giant prompt to Model B (Sonnet) | Slow (~2 s API round-trip) and expensive for every detected form — most fields map trivially |
| Single yes/no confirm for the whole form | Unsafe — one bad mapping ruins the form with no recovery |
| Mouse + keyboard actions via computer agent | Focus-stealing, DPI-sensitive, breaks if window moves; UIA patterns are reliable and invisible to the user |
| `src/profile/profile.json` in-repo (even gitignored) | Wrong location — should live in the OS userData dir alongside `keys.json`, never in source tree |
| No multi-step form handling | Most job applications are 3–5 pages |

---

## Revised architecture

```
Focus-change event (UIA, instant)
        │
        ▼
src/autofill/detector.js
  — Field extractor:  LabeledBy → Name → HelpText → nearby StaticText
  — Form scorer:      edit count + submit button + title keywords
  — Debounce (2 consecutive ticks of the same window)
        │ formInfo = { windowTitle, fields: [{ref, label, type, autocomplete}] }
        ▼
src/autofill/index.js   createAutofill({ profile, voice, log })
  — "Fill it?" Ask card (existing overlay ask mechanism)
  — User says Yes → Plan
        │
        ▼
src/autofill/planner.js
  — Deterministic matcher:  field.label / field.autocomplete → profileKey map
  — If ≥ 80 % matched → skip AI entirely → go to Execute
  — If < 80 % matched → send field schema (labels only, NOT full profile) to Model A (Haiku)
  — Model A returns: [{fieldRef, profileKey, value}]
        │ fillPlan = [{ref, label, value}]
        ▼
src/autofill/executor.js
  — Per pattern: ValuePattern.SetValue (text), TogglePattern (checkbox),
    SelectionItemPattern.Select (radio/combo), ExpandCollapse (dropdown)
  — Coordinate + SendInput fallback for elements without UIA patterns
  — Returns [{ref, label, value, ok, error}]
        │
        ▼
Confirmation overlay  (NEW small UI in existing overlay)
  — List of {field → value} pairs
  — User can reject individual fields or confirm all
  — Only confirmed fields get written
```

---

## Phase 1 — Profile store ✅ done

**Files:**
- `src/profile/profile.json` — seeded from Rithik's résumé, **`.gitignored`**
- `src/profile/index.js` — `loadProfile / saveProfile / updateProfile / appendNote / profileForAutofill`

**Remaining fix (Phase 1b):** Move `PROFILE_PATH` from `src/profile/` to the OS userData dir
(`path.join(app.getPath('userData'), 'profile.json')`) so it lives alongside `keys.json`.
Profile module needs `init(userDataDir)` called from `main.js`.

---

## Phase 2 — Event-driven form detector

**File: `src/autofill/detector.js`**

Uses the sidecar's existing `snapshot()` on the **currently focused window** — no new timer needed.

```
createDetector({ sidecar, onFormDetected, log })
  .start()   // subscribes to sidecar focus-change notifications
  .stop()
```

**Field extraction order (matching LabelAutofinderCore / agent-win approach):**

1. UIA `LabeledBy` relation → use that element's Name
2. UIA `Name` on the field itself (if non-empty and not a placeholder guess)
3. UIA `HelpText`
4. Nearest `StaticText` element within 150 px horizontally, 100 px vertically — prefer left/top first

**Form score:**

| Signal | Points |
|--------|--------|
| Edit field with resolved label | +2 |
| Edit field without label | +1 |
| ComboBox / CheckBox / RadioButton with label | +1 |
| Button with text matching `submit|apply|sign.?up|continue|next|register` | +3 |
| Window title matching `apply|sign.?up|register|contact|form|application` | +2 |
| Score ≥ 6 → form detected |

**Debounce:** Same window must score ≥ 6 twice consecutively (≈ 2 ticks of the existing
sidecar activity-poll at 100 ms each). Clear on window change.

**No new timer.** Detector hooks into the sidecar's `focus-change` event already emitted
when the foreground window changes, plus the existing background tick for re-scoring.

---

## Phase 3 — "Fill it?" popup

Reuses the existing `voice.ask()` mechanism unchanged:

```js
const yes = await voice.ask({
  kicker: 'Form detected',
  title: 'Fill it?',
  hint: formInfo.windowTitle,
});
```

No new IPC, no new UI primitives.

---

## Phase 4 — Planner (deterministic first, AI fallback)

**File: `src/autofill/planner.js`**

Deterministic matcher table (label text → profile path):

```js
const LABEL_MAP = [
  // personal
  [/^(full\s*)?name$/i,                'personal.name'],
  [/^(first|given)\s*name$/i,          'personal.firstName'],   // derived
  [/^(last|family|sur)\s*name$/i,      'personal.lastName'],    // derived
  [/^e[-\s]?mail/i,                    'personal.email'],
  [/^phone|mobile|cell/i,              'personal.phone'],
  [/^(city|location|address)/i,        'personal.location'],
  [/^linkedin/i,                       'personal.linkedin'],
  [/^github/i,                         'personal.github'],
  [/^website|portfolio|url/i,          'personal.website'],
  // education
  [/^(university|school|institution)/i,'education.0.school'],
  [/^degree/i,                         'education.0.degree'],
  [/^major|field of study/i,           'education.0.field'],
  [/^gpa/i,                            'education.0.gpa'],
  [/^graduation|expected.*(grad|year)/i,'education.0.endYear'],
  // experience
  [/^(current\s*)?(company|employer|organization)/i, 'experience.0.company'],
  [/^(job\s*)?(title|position|role)/i, 'experience.0.title'],
  [/^start\s*date/i,                   'experience.0.startDate'],
  // skills
  [/^skills?/i,                        'skills._flat'],         // flat join
];
```

If ≥ 80 % of fields matched → build `fillPlan` from the table, skip AI.

Otherwise → call Model A (Haiku, fast + cheap) with only the list of field labels and profile *keys*
(not values) and ask it to produce a mapping. Values are resolved from the profile after AI returns.

This means **the user's actual data (email, phone, address) never goes in the AI prompt**.

---

## Phase 5 — Executor (UIA patterns, no mouse)

**File: `src/autofill/executor.js`**

The sidecar already has `computer_act` actions. We add three thin wrappers:

| Field type | UIA call | Fallback |
|-----------|----------|----------|
| Text (`Edit`) | `ValuePattern.SetValue(value)` | Focus + `SendInput` chars |
| Checkbox | `TogglePattern.Toggle()` to reach desired state | Click at bounding-box centre |
| Radio / ComboBox | `SelectionItemPattern.Select()` | Click at bounding-box centre |
| Dropdown | `ExpandCollapsePattern.Expand()` then `SelectionItemPattern.Select()` | Click + SendInput |

Key property: **no mouse movement, no focus steal** — the user can keep working while fill happens.

---

## Phase 6 — Per-field confirmation overlay (NEW)

Small addition to the existing overlay HTML. When a fill plan is ready:

1. Overlay shows a compact list: `[Name] Rithik Gobinath  ✓  ✗`
2. User can tap ✗ on any row to skip that field.
3. "Fill confirmed fields" button triggers executor for the accepted set only.

This is the single biggest safety upgrade over the original plan. FillWright showed this is essential — users don't trust an autofiller that can ruin a form silently.

IPC: new `autofill:review` send from main → overlay, `autofill:confirm` reply from overlay → main.

---

## Phase 7 — Voice profile updates

**Intent patterns in `src/voice/reflex.js`** (before it reaches Model A):

```
/my (?:new )?(?:email|e-mail) is (.+)/i         → updateProfile personal.email
/my (?:new )?phone (?:is|number is) (.+)/i      → updateProfile personal.phone
/add (?:a )?note[:\s]+(.+)/i                    → appendNote
/i(?:'m| am) (?:now )?(?:working|employed) at (.+)/i  → appendNote (structured later)
/i(?:'m| am) open to (.+)/i                     → appendNote
```

Anything not matched by the reflex layer falls through to Model A which can call a `profile_update`
tool (to be added to the tool schema).

---

## Phase 8 — Multi-step forms (future)

After executing a fill plan on page N, detect "Next / Continue / Page 2 of 4" buttons.
If found, emit a `multiStep:detected` event. User sees "There's a next page — keep going?".
Continue filling each page with the same profile. Stop before any Submit button.

---

## File map

| File | Status | What it does |
|------|--------|--------------|
| `src/profile/profile.json` | ✅ Phase 1 | Resume data, gitignored, in userData dir (Phase 1b fix) |
| `src/profile/index.js` | ✅ Phase 1 | load/save/update/appendNote/profileForAutofill |
| `src/autofill/detector.js` | ⬜ Phase 2 | UIA focus-event listener + field extractor + form scorer |
| `src/autofill/planner.js` | ⬜ Phase 4 | Deterministic LABEL_MAP + Haiku fallback (labels only, not values) |
| `src/autofill/executor.js` | ⬜ Phase 5 | ValuePattern / TogglePattern / SelectionItemPattern fills |
| `src/autofill/index.js` | ⬜ Phase 3 | Orchestrates: ask → plan → confirm → execute |
| `src/main.js` | ⬜ Phase 3 | init profile with userData dir; mount detector; wire IPC |
| `src/voice/reflex.js` | ⬜ Phase 7 | Profile-update instant patterns |
| Overlay HTML | ⬜ Phase 6 | Per-field confirmation list UI |
| `src/app/ipc.js` | ⬜ Phase 6 | autofill:review / autofill:confirm handlers |

---

## What is NOT in scope

- Browser DOM injection (Chrome/Edge UIA accessibility tree is available but limited; browser extension is a separate future project as noted in CONTEXT.md)
- Submitting forms (executor never invokes Submit — always gated)
- Cloud profile sync
- Vision model for form detection (FormMind AI's UI-DETR approach is better but requires a local model; sticking to UIA for now since sidecar already exposes it)
- Multi-user profiles
