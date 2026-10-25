# Meeting reminders

Rouge reads the same local `calendar.json` snapshot used by the calendar-conflict
feature. It never modifies or uploads that file. No model, screen capture,
computer-control helper, browser connection, or new dependency is needed.

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
- Meetings due together share a compact popup. It displays the title and local
  start time; the existing strand wraps around that time, then stops requesting
  animation frames once settled. The popup dismisses after 20 seconds or with
  Dismiss. Existing wand guidance keeps priority; the reminder stays visible and
  borrows the wand once that guidance retracts.
- A small journal in the app-data directory stores occurrence hashes and start
  times, preventing repeated reminders across restarts. It contains no titles.
  Entries are pruned when the journal is next saved. If saving fails, reminders
  continue with in-memory deduplication and Preferences reports the limitation.

This scheduler also runs in Mac development mode, independently of the disabled
vision watcher and computer controls. The local development source includes
the previously added Mac launcher and position-only wand commands.

## Validation

In Rouge's textbox, enter `add meeting to calendar at 11:30 pm on oct 24`.
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
cleanup, journal errors, and animation settling without live input or API calls.
Live notification timing against the owner's actual calendar still depends on
that private snapshot being present at the configured path.
