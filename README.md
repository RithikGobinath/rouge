# Rouge

Rouge is a minimal Windows desktop companion, shown as an animated red ribbon. It accepts typed or spoken requests, answers questions, and uses Windows accessibility controls for computer tasks.

This is an early development version. The safety and reliability findings in [the audit](docs/AUDIT.md) remain open until the corresponding changes are reviewed and validated.

## Run locally

Requirements: Windows, Node.js 22 or newer, and an Anthropic API key entered through the app's settings.

```powershell
npm ci
npm start
```

Keys are saved using Electron's operating-system encryption. Never put credentials in source files, documentation, command arguments, or commits.

Existing installations keep the internal `Clippy` data directory and Windows app identifier for compatibility. Rouge is the product name; some internal identifiers and older source strings still use the previous development name.

## Wand development

In a development run of Rouge, click the ribbon and type `point a`, `point b`, `point c`, or `point d`. Each command points to a different fixed screen region locally, without a model request. These shortcuts are disabled in packaged releases. `point to A`, `circle A`, and `orbit around A` are also accepted. `retract` brings the ribbon back early.

For a separate view with labelled A/B/C/D targets, run `npm run wand`. It accepts the same commands and has matching buttons; Escape also retracts. This view uses the live renderer and makes no model calls.

The wand releases only the upper U-shaped curve. The front band and lower loop stay fixed. A normal cycle extends for 1.5 seconds, holds a connected open orbit outside the target text for 2 seconds, and retracts for 1.5 seconds. Reduced motion skips travel and shows the target for 2 seconds. The Windows desktop behaviour still needs owner validation.

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
