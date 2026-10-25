# Computer tasks

Clippy routes each released spoken request or typed request through A once. Simple answers stay on A. Interactive browser and desktop work goes directly to B, or C for unusually hard work, with computer tools attached to that worker's first request.

The selected worker reads the active window, uses its actual controls, and observes the result after acting. It continues until it can report an observed result or a clear blocker. Opening the requested app alone does not complete a task that also asks for work inside it. Existing Chrome windows no longer incur the old six-second wait for a different window handle.

The tools use Windows accessibility text and controls. They can open installed apps, navigate public web URLs, replace editable fields, click actual controls, and use a small set of navigation keys, including F5 to reload a page that opened blank or stuck (once, then inspect again). No browser extension, new dependency, screenshot stream, or local D model is involved.

For a flight comparison, the worker must verify origin, destination, trip type, date/year and actual visible results before quoting fares. Flight research does not authorize booking. If a page does not expose usable controls or results, Clippy reports what it could not verify.

Each control reference belongs to one observed window and snapshot. Input is checked again against the live target before delivery; switching to another app stops the task. Password and credential controls are excluded. Existing confirmation cards cover consequential actions. Type `stop` or use the existing panic shortcut to cancel; an already dispatched native operation can finish before cancellation is observed.

Work is bounded to 20 worker turns, 24 tool calls, and three minutes. Up to four short actions can share one tool call; dependent menus and pages require a fresh observation. A is never called again during this loop. Interactive tasks therefore need more than two API requests when the page requires multiple steps.

Development logs retain call counts, durations and status codes, not page text, field values, prompts or keys. New regression checks are authored in the test folder. The live flight scenario and test suite were intentionally left for the user to run.
