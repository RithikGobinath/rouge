# Rouge

Rouge is an early-stage Windows desktop companion represented by an animated red ribbon. It accepts typed and spoken requests, answers questions, and can use Windows accessibility controls to carry out computer tasks.

**Development status:** Safety and reliability findings in the [audit](docs/AUDIT.md) remain open until the corresponding changes have been reviewed and validated.

## Getting started

Rouge requires Windows, Node.js 22 or later, and an Anthropic API key. Enter the key in the application's settings after launch.

```powershell
npm ci
npm start
```

Keys are stored using Electron's operating-system encryption. Do not put credentials in source files, documentation, command arguments, or commits.

### macOS development

For interface and typed-chat development on macOS, run `npm ci` followed by `npm run dev:mac`. This opt-in mode disables the computer agent, shortcut actions, Windows speech and hotkeys, and background screen and calendar watching. An Anthropic key is still needed for model replies.

The launcher creates a development entry in the installed Electron bundle. Development settings and encrypted keys are stored separately in `../rouge-user-data`. Quit the app before relaunching after backend changes. Running `npm ci` replaces the installed runtime; `npm run dev:mac` recreates the development entry.

## Features

- **Conversation and computer tasks:** Ask questions by text or voice, or request actions using Windows accessibility controls.
- **Pointing:** Ask Rouge to point to a screen position, such as `point to the top left corner` or `point to the center`. These local position requests work without an API key and do not make model calls, take screenshots, or move the mouse. Type `stop` or use the wand's Close button to retract it. The wand can also highlight known controls supplied by the computer agent and follow a control as it moves.
- **Meeting reminders:** Timed events in the local `calendar.json` can trigger a reminder 15 minutes before the event. See [meeting reminder setup](docs/MEETING-REMINDERS.md) for the calendar location and details.

## Architecture

Electron renders the companion and settings interface; Node.js coordinates requests. Model A answers simple questions or routes a request to model B or C in its first response. Delegated computer work continues with the selected model through a bounded observe-and-act loop. A persistent Windows helper provides accessible text and controls and delivers validated input.

The local visual model D and browser-specific integration are planned, not implemented. See [project context](docs/CONTEXT.md) for design decisions and the [handoff](docs/HANDOFF.md) for development details.

Existing installations retain the internal `Clippy` data directory and Windows app identifier for compatibility. Some internal identifiers and older source strings also retain the previous development name.

## Validation

The owner performs live testing. `npm test` includes Windows interaction tests that can move focus and send input, so do not run the full suite casually. The initial GitHub import was not validated through tests, model requests, or desktop tasks. Audit-fix candidates on `cursor/audit-fixes-27d8` remain unvalidated until owner review and Windows testing.
