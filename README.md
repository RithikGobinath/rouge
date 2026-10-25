# Rouge

Rouge is a minimal Windows desktop companion, shown as an animated red ribbon. It accepts typed or spoken requests, answers questions, and uses Windows accessibility controls for computer tasks.

This is an early development version. The safety and reliability findings in [the audit](docs/AUDIT.md) remain open until the corresponding changes are reviewed and validated.

## Run locally

Requirements: Windows, Node.js 22 or newer, and an Anthropic API key entered through the app's settings.

```powershell
npm ci
npm start
```

For UI and typed-chat development on macOS, use `npm run dev:mac`. This opt-in
mode disables the computer agent, all shortcut actions, Windows speech/hotkeys,
and background screen/calendar watching. It does not change Windows startup.
An Anthropic key is still required for model replies.

The Mac launcher prepares a local development entry inside the installed
Electron bundle and opens it through macOS. Development settings and encrypted
keys stay in `../rouge-user-data`, separate from a normal installation. Quit the
Electron app before relaunching after backend edits. `npm ci` replaces the
installed runtime; `npm run dev:mac` recreates its development entry.

The wand can point to screen positions locally, including in Mac development
mode with no API key: type `point to the top left corner`, `point to the bottom
right corner`, `point to the center`, or simply `top left corner`. Corners,
edge midpoints, and the center refer to the primary display's usable area.
These requests make no model calls, screenshots, clicks, or mouse movements.
Type `stop` or click the wand's Close button to retract it. Known control
rectangles supplied by the computer agent also highlight without vision;
the explicit point-and-ask hotkey still uses its existing visual explanation.

Meeting reminders read the existing local `calendar.json` and alert 15 minutes
before timed events, wrapping the wand around the computer's current-time clock. They
also work in Mac development mode without any model. See
[meeting reminder setup and behavior](docs/MEETING-REMINDERS.md) for the calendar
path and validation details.

Keys are saved using Electron's operating-system encryption. Never put credentials in source files, documentation, command arguments, or commits.

Existing installations keep the internal `Clippy` data directory and Windows app identifier for compatibility. Rouge is the product name; some internal identifiers and older source strings still use the previous development name.

## Architecture

- Electron renders the companion and settings panel; Node.js coordinates requests.
- Model A answers simple questions or chooses B/C in its first response.
- Model B handles ordinary delegated work; C handles harder reasoning.
- Interactive work continues with the selected worker through a bounded observe/act loop.
- A persistent Windows helper supplies accessible text and controls and delivers validated input.
- The local visual model D and a browser-specific integration are planned, not implemented.

Read [project context](docs/CONTEXT.md) for decisions and [the handoff](docs/HANDOFF.md) for the precise development state.

## Validation

`npm test` includes real Windows interaction tests. Do not run it casually: some tests move focus and send actual input. The owner has asked to perform live testing personally.

The initial GitHub import was not validated by executing tests, model requests, or desktop tasks. Audit-fix implementation lives on `cursor/audit-fixes-27d8` and must not be treated as validated until the owner reviews and runs the Windows suite.
