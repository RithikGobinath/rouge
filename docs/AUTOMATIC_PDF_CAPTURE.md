# Automatic PDF upload rejection detection

Implemented on `codex/pdf-upload-compression`. Two routes feed the same offer (`src/uploads/offer.js`): the browser extension, which sees the page itself, and a window reader that needs no extension but sees very little.

## 1. Browser extension (the route that works on real sites)

`extension/content.js` runs in **every frame**, so it reaches upload dialogs that live in an iframe (the Google Forms file picker is one). Each frame reports facts to `extension/background.js`; the service worker keeps them per tab in `chrome.storage.session` and asks `decide()` in `extension/evidence.js` whether a PDF will not be taken.

What a frame reports:

- **The PDF the user chose** (name and size only): a `change` on any file input, a drop, or an input the page never attached (`extension/page-hook.js` watches `input.click()` in the page's own world).
- **Limits the page announces**, found in its text when a PDF is chosen: "Upload 1 supported file. Max 10 MB." Several different limits are treated as ambiguous.
- **Messages that appear after the page loaded** and read like a rejection ("File is too large", "exceeds the maximum size", "Upload failed"). Static help text is not an error.

What counts as a rejection (`decide()`):

1. A rejection message after the PDF was chosen, with its limit read from the message (or the single limit the page announces).
2. The PDF is larger than the single limit the page announces, even when the page shows no error yet.
3. A generic failure ("Upload failed") only when the PDF really is over a known limit.
4. A PDF that fits under the limit is never reported, whatever the page says.
5. With no chosen PDF seen (a drag from another window, an odd widget): only an upload widget's explicit message that states its own limit.

The copy: if the PDF is 32 MB or smaller, the frame that holds it hands the bytes to the service worker, which posts them to the bridge (`POST /api/upload-file`) before `POST /api/upload`. Rouge then asks, compresses the copy and saves `name-compressed.pdf` in Downloads, and puts it on the ribbon's file shelf (`docs/SHELF.md`) so it can be dragged straight onto the site's upload area. If the shelf cannot take it, the notice says where the file is. If the copy could not be made (the dialog closed first, or the PDF is larger) Rouge opens its own "Choose the PDF that was rejected" dialog instead.

Limit parsing: decimal units (1 MB = 1,000,000 B) and binary units (1 MiB = 1,048,576 B); `1,000 KB` is a thousand; a decimal comma (`2,5 MB`) is refused rather than guessed; with several sizes in one message the one worded as a limit wins over the file's own size.

### Setting it up and checking it

See `extension/README.md`. The bridge answers `GET http://127.0.0.1:7432/api/ping` with the build that is running; `app.log` records `rouge … started from <checkout>` and `autofill/bridge: extension <version> is talking to this Rouge`.

When an upload is missed, the same log shows what the extension saw, one `autofill/bridge: extension saw: …` line per step: `PDF chosen` (bytes, top or child frame), `limits announced`, `rejection` or `possible message seen` (length only, never the text), and `verdict for the chosen PDF`. The step that is missing is the one that did not happen. Sizes and counts only: no file names or page text.

## 2. Window reader (fallback, no extension)

`createUploadCapture` (`src/uploads/capture.js`) polls the foreground window with `sidecar.uiaList()` every 2 seconds and looks for rejection text, at most once per window per minute. It steps aside for ten minutes after the extension last spoke.

Limit: the helper's `uia.list` returns only **actionable** controls (buttons, links, list items, edit boxes and similar); plain text, which is what most error messages are, is skipped. This route therefore only sees messages that happen to be the name of a control. Making it read text would be a change to `sidecar.ps1` and every feature that uses `uia.list`, so it was not done here.

## Validation

- `test/extension-evidence.test.js` — limit parsing, rejection wording, `decide()` cases.
- `test/upload-offer.test.js` — the ribbon side: no limit, busy ribbon, decline, picker fallback, duplicates, naming.
- `test/upload-capture.test.js` — the window reader.
- A real-browser check (headless Edge, unpacked extension, throwaway profile, the real bridge module) against a page with a cross-origin upload iframe: announced limit, error text in the iframe or the top page, a PDF that fits, a page-detached input, drag and drop, generic failure, help text only, one report per selection, a stopped service worker, a dialog closed before the copy, and the question labels on a real public Google Form. It is not part of the suite.
- Not covered: Google's own upload dialog, which needs a signed-in account. Its exact wording and structure were not observed; detection does not depend on the wording.

## Known limits

- Limit parsing handles English decimal points; aggregate multi-file limits are not parsed.
- A site that shows its limit nowhere and a generic error cannot be helped automatically; the explicit "compress this PDF below 2 MB" path from the plan is not built.
