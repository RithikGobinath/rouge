# Meeting reminders

Rouge reads the same local `calendar.json` snapshot used by the calendar-conflict
feature. It never modifies or uploads that file. No model, screen capture,
browser connection, or new dependency is needed. Clock targeting reads native
window geometry only and never performs input.

## Calendar location

`CLIPPY_CALENDAR_FILE` overrides the path. Without an override, Windows retains
the calendar-lab path already configured in `src/main.js`; macOS reads
`calendar.json` from the repository root. The snapshot itself is private runtime
data, is ignored by Git, and is not included in this repository.

The existing snapshot format is an object containing `events`. Each event has
`start` and `end` objects with a `dateTime` and, when the timestamp lacks an
offset, a `timeZone`. An event ID, title, and source identify the occurrence.
Existing timezone conversion is reused. Expanded recurring occurrences work;
unexpanded recurrence masters are skipped. Optional `coverageEnd` is checked
for an expired snapshot. Reminders cannot discover meetings absent from this
local copy or update the calendar from its original provider.

Preferences shows whether the snapshot loaded, is missing, is invalid, or has
expired; hover over that line for the resolved path. Missing files cause no
fabricated alerts. Creating or replacing the file in its existing directory
retries loading it automatically.

## Scheduling and presentation

- One directory watcher handles calendar exports, including atomic replacement.
  Reads are debounced by 200 ms. There is no periodic file or screen scan.
- One deadline timer wakes 15 minutes before the next meeting. Extremely distant
  deadlines are capped at Node's timer limit and reevaluated when that timer
  expires. Computer wake reloads the calendar and recomputes the deadline.
- Startup or wake inside the 15-minute window produces one catch-up reminder
  showing the actual remaining minutes. Meetings that have already started,
  cancelled/declined events, and all-day events are skipped.
- Meetings due together share a compact popup with the title, meeting start time,
  and actual minutes remaining. The wand wraps around the **computer's system
  clock**, drawing attention to the current time being 15 minutes before the
  meeting. The popup's start time is never a wand target. The popup dismisses
  after 20 seconds or with Dismiss; the wand retracts with it. Existing guidance
  keeps priority; the reminder borrows the wand once that guidance retracts.
- The overlay covers the full primary display so the wand can reach its menu
  bar or taskbar. Cards and the companion still use the usable work area.
  The clock loop stays within the display and stops animation frames once settled.
- macOS: a tiny native reader queries visible Control Center menu-window bounds
  once per reminder (and again if display geometry changes). It identifies the
  [clock pinned to the right end of the primary menu bar](https://support.apple.com/en-gb/guide/mac-help/mchlp1446/mac) without reading window
  titles, taking screenshots, requesting permissions, or using a model. Electron
  passes the primary display bounds and menu-bar height to the helper: a child
  process cannot reliably discover its own display. If window metadata is absent,
  the helper measures the current time using the Mac's clock preferences and
  menu-bar font, then targets that time at the right edge. This fallback uses
  stock macOS clock alignment and conservative padding; custom clock replacements
  can require different bounds. It never targets or measures the popup time.
  There is no resident process or polling timer. `npm run dev:mac` compiles the helper
  once with Apple's Command Line Tools and reuses it until its source changes;
  its binary stays in the development app-data directory, outside the repo.
- Windows: the existing sidecar reads the native taskbar clock rectangle, with
  UI Automation for the Windows 11 clock. Physical pixels convert to overlay
  coordinates using the existing Electron DPI conversion.
- A hidden, missing, ambiguous or off-display clock produces the popup with
  “System clock unavailable” and no wand target. Rouge never substitutes the popup
  time, moves the mouse, or opens the clock. This geometry
  lookup uses the modern macOS clock placement and needs owner visual validation
  on the actual OS; customized taskbars/menu bars may not expose a usable clock.
- A small journal in the app-data directory stores occurrence hashes and start
  times, preventing repeated reminders across restarts. It contains no titles.
  Entries are pruned when the journal is next saved. If saving fails, reminders
  continue with in-memory deduplication and Preferences reports the limitation.

This scheduler also runs in Mac development mode, independently of the disabled
vision watcher and computer controls. The local development source includes
the previously added Mac launcher and position-only wand commands.

## Validation

In Rouge's textbox, enter `add meeting to calendar at <your time> am on oct 25`.
Replace `<your time>` with the hour or hour:minute you choose. The meeting's
start time is parsed from that input; there is no preset meeting time.
The command accepts a 12-hour AM/PM time, an optional `:MM`, a month name and
day, and an optional year. Without a year it uses the current local year;
past or invalid dates are rejected instead of silently moving to next year.
It uses the computer's local timezone and reports the resolved time.

This adds a 30-minute **Test meeting** to an in-memory test calendar, merged
into the same reminder scheduler. It never writes the real `calendar.json`,
works even when that snapshot is missing, and requires no model or key.
If the start is less than 15 minutes away, the reminder appears immediately
with the actual remaining minutes. Otherwise it fires 15 minutes before the
specified start. Repeating the same time does not add a duplicate. Test events
are removed when Rouge quits; expired events are pruned on the next command
or calendar refresh. No extra watcher or timer is created for this command.

The new scheduler and wrapped-strand checks use synthetic local calendar data,
fake clocks and a canvas stub. They exercise the lead time, simultaneous events,
file changes, restart deduplication, wake recovery, DST, invalid input, watcher
cleanup, journal errors, system-clock coordinate conversion, dismissal races,
priority over the reminder, and edge-safe animation settling without live input
or API calls. The clock reader compiles on this Mac. A live lookup in the running
Rouge process now resolves a valid region at the menu-bar time instead of
returning no target. Native helper checks cover three display sizes and a
hidden menu bar. Those diagnostics used no calendar event or screen capture. Pixel alignment and Windows taskbar placement remain for owner
visual validation.
Live notification timing against the owner's actual calendar still depends on
that private snapshot being present at the configured path.
