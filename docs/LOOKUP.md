# Look up highlighted text

Highlight a word or phrase in any app and a small Look up button appears at the ribbon. It is only that button: no question and no second button. Nothing leaves the PC until the card's Look up button is clicked.

## How a selection is noticed

- After each mouse click (the Windows helper already reports them) Rouge waits a quarter of a second, then asks the helper for the text selected in the focused control or its document (UI Automation text pattern). No model, no network, no screenshot.
- Only a short, ordinary selection counts: 3 to 400 characters, with letters in it. Anything that looks like a card or phone number, an email address, or a key or token is never offered. Password and other credential fields are never read, and a click on the ribbon itself is ignored.
- Private, Incognito and InPrivate browser windows are skipped. So are the moments when Rouge is busy, another card is open, the ribbon is hidden, there is no Anthropic key, Internet access is off, or Look up highlighted text is off in Preferences.
- A card appears at most every 4 seconds. The same text is not offered again for 10 minutes. The button goes away on its own after 12 seconds, or when the text is deselected or replaced by a different selection.

## The lookup

Clicking Look up sends the highlighted text, and only that, to Claude (Sonnet, through Auto) with the web search and fetch tools described in [INTERNET.md](INTERNET.md). The answer is at most three short sentences with source links. If Claude did not search at all, the bubble says "not checked online".

## Limits

- Only mouse selections are noticed. Selecting with the keyboard (Shift+arrows, Ctrl+A) is not.
- It works in apps that expose their text through UI Automation. Chrome and Edge do so once their accessibility tree exists, so the first highlight in a freshly started browser may not be seen. Apps that draw their own text (some games, remote desktops, PDF canvases) give nothing.
- Reading a selection asks the front app's accessibility tree, which makes Chromium browsers build theirs.
- Not validated live yet: the helper's `uia.selection` call and the card flow were written and unit-tested with fakes only.
