# Rouge browser extension

Connects the Rouge ribbon to pages in Chrome, Edge, Arc and other Chromium browsers: form autofill and PDF upload recovery. It has no interface of its own.

## Load it

1. Open `chrome://extensions` (Edge `edge://extensions`, Arc `arc://extensions`) and turn on Developer mode.
2. Load unpacked → choose this `extension` folder **of the checkout you run Rouge from**. Several checkouts share Rouge's data folder and its port (7432), so the extension talks to whichever Rouge is running.
3. After any change to this folder: reload the extension on that page, then reload the tabs you want it in (open tabs keep the old script).

## Check it

- Open `http://127.0.0.1:7432/api/ping`. `root` is the checkout that is running; `extension` is the extension version that last spoke to it (`1.1.0` or newer is needed for uploads; `unversioned (old build)` means an old copy is loaded).
- Rouge's log (`%APPDATA%\Clippy\logs\app.log`) has one line per start (`rouge … started from <checkout>`) and one when the extension connects.
- After picking a PDF, the same log has `extension saw: …` lines: the PDF chosen, the limits the page announces, any rejection message, and the verdict. A missing line is the step that did not happen.
- The extension's service worker console (extensions page → "service worker") logs `[Rouge] extension 1.1.0 ready` and, for uploads, `[Rouge] upload problem …` and `[Rouge] told Rouge: 200`.

See `docs/AUTOMATIC_PDF_CAPTURE.md` for what it detects.
