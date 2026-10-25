# Form Autofill — Design Plan

Branch: `codex/form-autofill`
Updated: 2026-10-24

---

## Overview

When the user puts focus on a window that looks like a form (job application, sign-up page, contact form), Rouge offers to fill it with data from a stored profile JSON.
The profile is seeded once from a résumé; the user can update individual fields by saying "my new email is X".

No new model is introduced. Detection uses the Windows accessibility tree already available through the sidecar. Filling uses the existing computer agent (B/Sonnet) with the profile JSON in context. Profile persistence is a thin JSON file with a `loadProfile / saveProfile / updateProfile` module.

---

## Component 1 — Profile store

**Files**: `src/profile/profile.json`, `src/profile/index.js`

Both are already written on this branch. The module exports:

| Export | Behaviour |
|--------|-----------|
| `loadProfile()` | Synchronous `fs.readFileSync` + `JSON.parse`. Throws on IO or parse error. |
| `saveProfile(profile)` | Atomic write: tmp file in `os.tmpdir()`, then `fs.renameSync` onto the real path. |
| `updateProfile(patch)` | Shallow merge of `patch` into the current profile, then saves. |
| `appendNote(note)` | Pushes `{ text, addedAt }` into `profile.notes` and saves. |

The `notes` array accumulates free-form facts the user states in conversation ("I'm open to remote roles", "I prefer not to list my GPA"). Notes are appended verbatim; the computer agent receives them alongside structured fields so it can apply judgment when a form has no direct mapping.

**Schema** (version 1):
```
personal   – name, email, phone, location, linkedin, github, website
education  – array of school / degree / field / startYear / endYear / gpa
experience – array of company / title / startDate / endDate / location / description
skills     – flat string array
projects   – array of name / description / url / technologies[]
certifications, languages – flat string arrays
publications – array (not in base schema; added as extra field, ignored by autofill)
notes      – array of { text, addedAt }
```

The autofill agent is given only the fields that map naturally to form inputs. Publications and `scholarMetrics` are left out of the fill context unless the form visibly requests them.

---

## Component 2 — Form detection

**File to modify**: `src/calendar/watch.js`

### Why here

`watch.js` already runs a background `setInterval` at 1 s (`pollMs` default 100 ms, `intervalMs` default 1000 ms). Its `tick()` function fires on mouse/keyboard activity while Rouge is idle and the computer agent is not running.

Adding form detection alongside the calendar check keeps both features in one background loop without a second timer or a new module.

### Detection algorithm

The Windows sidecar exposes the focused window's accessibility element tree. The detection reads the UIA list of the focused window and applies a cheap heuristic:

```
FORM if ANY of:
  a) ≥ 3 Edit (or Document) controls are visible in the current window's UIA tree
  b) ≥ 2 Edit controls with names matching a known-field pattern:
       /first\s*name|last\s*name|email|e-mail|phone|address|zip|city|state|
        linkedin|github|website|company|school|degree|gpa|resume/i
```

The UIA list is already fetched for other sidecar operations. A lightweight filter on `controlType === 'Edit'` is sufficient — no screenshot is taken and D is not invoked.

### Cooldown and suppression

```
lastFormKey = hash(hwnd + sorted field names)   // string key for the seen form
lastFormAt  = timestamp of last notice for that key

Suppress if:
  • lastFormAt exists and (now - lastFormAt) < 60_000
  • user recently typed into any field (point.input changed in the last 3 s)
  • Rouge is not idle (deps.busy() returns true)
  • the focused window is the Rouge overlay itself
```

Cooldown is per-form-key so a user switching between two different forms still gets offered both.

### Code sketch — additions to watch.js

```js
// near the top of createCalendarWatch:
let lastFormKey = '';
let lastFormAt = -Infinity;
const FORM_COOLDOWN = 60_000;
const FORM_FIELD_RE = /first\s*name|last\s*name|email|e-mail|phone|address|zip\s*(?:code)?|city|state|linkedin|github|website|url|company|school|degree|gpa|résumé|resume/i;

async function detectForm() {
  if (!deps.sidecar) return;
  const now = deps.now ? deps.now() : Date.now();
  let uia;
  try { uia = await deps.sidecar.uiaList(); } catch (_) { return; }
  if (!Array.isArray(uia)) return;

  const edits = uia.filter((el) => el.controlType === 'Edit' || el.controlType === 'Document');
  const namedEdits = edits.filter((el) => FORM_FIELD_RE.test(String(el.name || '')));
  const isForm = edits.length >= 3 || namedEdits.length >= 2;
  if (!isForm) { lastFormKey = ''; return; }

  // Build a stable key for this form.
  const hwnd = uia[0] && uia[0].hwnd ? String(uia[0].hwnd) : 'x';
  const fieldNames = namedEdits.map((el) => el.name.toLowerCase()).sort().join('|');
  const key = `${hwnd}:${fieldNames || edits.length}`;
  if (key === lastFormKey && now - lastFormAt < FORM_COOLDOWN) return;
  lastFormKey = key; lastFormAt = now;

  deps.onFormDetected && deps.onFormDetected(uia);
}
```

`tick()` gains one line:

```js
async function tick() {
  if (stopped || !ready) return;
  const point = await deps.cursor();
  const clicks = deps.clicks();
  if (deps.busy()) { noteActivity(point, clicks); return; }
  if (noteActivity(point, clicks)) {
    await shoot(false);
    await detectForm();          // ← new
  }
}
```

`deps.onFormDetected` is injected from `src/main.js` (or wherever `createCalendarWatch` is called) and fires the notice.

---

## Component 3 — "Fill it?" prompt

**File to modify**: `src/app/overlayUi.js` (minor) and `renderer/overlay/overlay.js` (minor)

### Option A — reuse the existing `ask()` card (preferred, smallest change)

`overlayUi.ask(card)` shows a "Check first" card with Yes / Not now buttons. This is already built, tested and rendered.

```js
// In main.js callback passed as deps.onFormDetected:
async function offerFormFill(uia) {
  const yes = await ui.ask({
    kicker: 'Form detected',
    title: 'Fill it with your profile?',
    hint: 'I\'ll map your saved info to the visible fields.',
  });
  if (yes) await runFormFill(uia);
}
```

No overlay or IPC changes needed. The user can say "yes" or click Yes.

### Option B — add a `notice` action button

Add a new IPC message `ui:notice:action` that carries an `{ id, label }` action button alongside the notice text. The renderer renders a small inline button in the notice bar. When clicked it sends back `ui:notice:action:click` with the `id`.

This is more work (new IPC channel, new renderer element, new overlay.js handler) for marginal UX gain over Option A. **Defer to a follow-up unless the owner explicitly prefers the notice bar.**

**Decision for this plan: use Option A.**

---

## Component 4 — Form filling with the computer agent

**No new file.** The fill is an ordinary computer-agent request (Model B/Sonnet) assembled in the `onFormDetected` callback.

### Request construction

When the user says yes, the orchestrator assembles:

```
System context (injected alongside the normal computer-agent system prompt):
  "The user wants to fill the visible form with their profile.
   Profile:
   { ...loadProfile() filtered to personal/education/experience/skills/projects/certifications/languages/notes }
   
   Steps:
   1. Use computer_inspect to enumerate all visible Edit/Document controls and their names.
   2. For each control, find the best-matching profile field by name similarity.
   3. Fill each matched control using the fill action. Do not tab-submit.
   4. After filling, report which fields were filled and any you could not match."
```

The existing B/Sonnet computer loop (`src/ai/agent.js`) handles the multi-turn observe/act. No changes to agent.js are needed.

### Field mapping strategy (done by the model, not code)

The model is given the profile JSON and the list of UIA element names. It uses semantic matching:

| Form field name | Profile field |
|-----------------|---------------|
| First Name | `personal.name` split on space, first token |
| Last Name | `personal.name` split on space, last token |
| Email / Email Address | `personal.email` |
| Phone / Mobile | `personal.phone` |
| City / Location | `personal.location` |
| LinkedIn URL | `personal.linkedin` |
| GitHub URL | `personal.github` |
| GPA | `education[0].gpa` |
| School / University | `education[0].school` |
| Degree | `education[0].degree` |
| Major / Field | `education[0].field` |

The model is instructed **not to submit** unless the user explicitly asks.

### Limit

The normal computer agent bounds of 20 turns, 24 tool calls, and 3 minutes (from `src/ai/agent.js`) apply. A typical form fill should complete in 3–6 tool turns.

---

## Component 5 — Profile updates from conversation

**File to modify**: `src/voice/session.js` (inside `askModel`)

### Detection

In `askModel`, before calling `d.ai.answer()` or `d.ai.plan()`, add a fast regex prefilter:

```js
const PROFILE_UPDATE_RE =
  /\bmy\s+(?:new\s+)?(?:email|phone|number|address|location|city|linkedin|github|website|name)\s+(?:is|changed?\s+to|'s)\b|\bi(?:'ve|\s+have)\s+moved\s+to\b|\bupdate\s+my\s+(?:email|phone|address|profile)\b/i;
```

If it matches, pass the text to a small helper `parseProfileUpdate(text)` that returns `{ field, value } | null`. If non-null, call `updateProfile({ [field]: value })` and return an instant reply ("Updated your email to X in your profile.") without a model call.

For ambiguous or multi-field updates ("I moved to Seattle and my new number is 555-1234"), fall through to the model. The model should call a tool or return a structured plan that the executor translates to `updateProfile` calls. A simpler approach: pass the update text along to Model A with an explicit instruction and the current profile in context; A returns the patch as JSON. This avoids a new action type.

**Minimal implementation** (fits Ponytail Full):

```js
// Quick regex path for the most common single-field updates
const FIELD_PATTERNS = [
  { re: /\bmy\s+(?:new\s+)?email(?:\s+address)?\s+is\s+(\S+@\S+)/i,   field: 'email' },
  { re: /\bmy\s+(?:new\s+)?phone(?:\s+number)?\s+is\s+([\d\s\-().+]+)/i, field: 'phone' },
  { re: /\bi(?:'ve|\s+have)\s+moved\s+to\s+(.+?)(?:\.|$)/i,            field: 'location' },
  { re: /\bmy\s+(?:new\s+)?location\s+is\s+(.+?)(?:\.|$)/i,            field: 'location' },
  { re: /\bmy\s+linkedin(?:\s+(?:url|profile|link))?\s+is\s+(\S+)/i,   field: 'linkedin' },
  { re: /\bmy\s+github(?:\s+(?:url|profile|link))?\s+is\s+(\S+)/i,     field: 'github' },
];

function tryParseProfileUpdate(text) {
  for (const { re, field } of FIELD_PATTERNS) {
    const m = re.exec(text);
    if (m) return { field, value: m[1].trim() };
  }
  return null;
}
```

In `askModel`, before the Claude call:

```js
if (d.profile) {
  const upd = tryParseProfileUpdate(text);
  if (upd) {
    try {
      const prev = d.profile.loadProfile().personal[upd.field] || '';
      const next = upd.value;
      d.profile.updateProfile({ personal: { ...d.profile.loadProfile().personal, [upd.field]: next } });
      return instantReply(`Updated your ${upd.field} to ${next} in your profile.${prev ? ` (was: ${prev})` : ''}`);
    } catch (e) {
      log(`profile update: ${e.message}`);
    }
  }
}
```

`d.profile` is injected when `createVoice` is called in `src/main.js` alongside the other deps.

---

## Files to create / modify

| File | Action | Notes |
|------|--------|-------|
| `src/profile/profile.json` | **Created** | Seeded from résumé |
| `src/profile/index.js` | **Created** | loadProfile / saveProfile / updateProfile / appendNote |
| `src/calendar/watch.js` | **Modify** | Add `detectForm()` called from `tick()`; add `lastFormKey/At` state; accept `deps.onFormDetected` |
| `src/voice/session.js` | **Modify** | Accept `d.profile`; add `tryParseProfileUpdate` fast path inside `askModel` |
| `src/main.js` | **Modify** | Pass `deps.onFormDetected` to `createCalendarWatch`; pass `d.profile` to `createVoice` |
| `scripts/extract-resume.mjs` | **Created** | One-time extraction script (not part of the app) |
| `docs/FORM_AUTOFILL_PLAN.md` | **Created** | This document |

`src/app/overlayUi.js` and `renderer/overlay/overlay.js` require **no changes** because Option A (reuse existing `ask()` card) is chosen.

---

## What is explicitly deferred

| Item | Reason |
|------|--------|
| Notice-bar action button (Option B) | Extra IPC + renderer work; Option A is sufficient |
| Auto-submit on command | Safety: never submit without explicit user ask |
| LinkedIn / GitHub URL resolution from PDF | PDF extraction only saw icons (ï, §), not the raw URLs; user can update via voice |
| Profile sync across machines | Out of scope; JSON file lives in the app-data dir |
| Model D (vision) involvement in form detection | Accessibility tree is sufficient and faster; keeps D focused on meeting conflicts |
| Regex-only updates for multi-field voice edits | Fall through to Model A with profile context; avoids a new action type |

---

## Open questions for owner

1. **`sidecar.uiaList()` surface**: Does the sidecar already expose a method that returns all UIA elements for the focused window, or does a new sidecar command need to be added? (Current sidecar usage in `src/win/sidecar.ps1` should be checked.)
2. **Cooldown UX**: 60 s may feel long for power users quickly filling many forms. Expose as a setting?
3. **Profile location**: `src/profile/profile.json` is inside the repository. Should it live in the OS app-data directory (like keys/settings) to avoid committing personal data? If yes, update `PROFILE_PATH` in `index.js` and add `src/profile/profile.json` to `.gitignore`.
4. **Fill scope**: Should the agent attempt to fill a textarea "Cover Letter" box from a project description, or skip long-form text fields by default?
