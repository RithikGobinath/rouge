# Rouge: product and architecture context

Recorded 2026-10-24. This is a sanitized project summary, not a conversation transcript.

## Product

Rouge is a Windows desktop companion represented by a smooth animated red ribbon. The owner wants a small, minimal question box and reliable operation of the existing computer. Avoid tours and unnecessary UI. Source inherited the development name Clippy; the product name is now Rouge.

An example target task is: open Chrome, use Google Flights, compare one-way flights from SFO to MSN on October 30, and report the best observed options. Opening Chrome alone does not satisfy that request. Flight research does not authorize booking.

## Current implementation

The application is Electron with ordinary JavaScript, HTML and CSS. src/main.js creates the store, overlay, panel, speech helper, AI router, Windows helper, executor and request session.

Typed input and released voice input enter src/voice/session.js. With an Anthropic key configured, the complete request goes to A once. src/ai/router.js chooses the final responder using a structured decision containing route, mode and response.

Configured model defaults:

| Role | Model ID | Purpose |
| --- | --- | --- |
| A | claude-haiku-5-5 | Direct answers and routing |
| B | claude-sonnet-5-5 | Ordinary delegated work and computer tasks |
| C | claude-opus-5-5 | Hard reasoning |
| D | Not selected or connected | Planned local visual context |

A direct answer uses one application request. A delegated ordinary answer normally uses A plus the selected worker. Interactive work uses A once and then the selected B/C worker's tool continuations. Preserve complete assistant content, thinking signatures and matched tool results between those turns.

src/ai/agent.js currently bounds computer work to 20 turns, 24 tool calls and three minutes. src/computer/controller.js exposes computer_inspect and computer_act. Actions include opening apps, public web navigation, filling controls, clicking, navigation keys, scrolling and short waits. Controls have snapshot-scoped opaque references.

src/win/sidecar.ps1 contains the C# Windows accessibility/input helper, launched through a persistent PowerShell process. src/win/jsonl.js handles request/response transport. Windows speech recognition uses a separate persistent helper. Settings and keys live in the operating-system application-data directory; saved keys use Electron safeStorage encryption.

Read-only public research uses Anthropic search/fetch tools. This is separate from controlling the user's Chrome session. The current computer loop does not have a browser extension, Playwright connection, DOM adapter, screenshot fallback, or local D watcher.

Folder retrieval uses a local BM25 index for selected folders and sends relevant excerpts with a request. Current conversation memory is short and in-process; it is not a durable task database.

## Agreed direction, not completed implementation

Keep the Electron foundation and A/B/C routing. Improve browser-specific control, completion evidence and local visual context. A browser extension connected to the desktop through native messaging was recommended for the user's existing Chrome session; a dedicated Playwright browser is an alternative with a separate-profile tradeoff. Neither approach has been implemented or approved as an incidental audit fix.

Completion must eventually be checked against the requested result, not merely the presence of a toolbar or a successful click. For flights this includes route, one-way setting, date/year and observed fares. Prefer compact observations, local condition-based waits and short validated batches to unnecessary model round trips.

D is intended to check for screen changes each second while the screen is active and Rouge is idle. A proposed optimization is cheap local change detection before visual inference. Hardware/model selection, privacy behavior, capture scope and integration remain future work.

## Important compatibility decisions

Rouge branding must not silently strand an existing encrypted key. Internal Clippy data-directory, app ID, environment-variable and fixture names may remain until a deliberate migration. Never upload application-data files or the raw chat transcript: the original conversation contained a credential.
