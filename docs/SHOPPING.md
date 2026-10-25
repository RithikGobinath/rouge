# Price comparison

When the browser in front is on a product page of a store Rouge knows, a small card offers to compare prices at other stores. Nothing leaves the PC until the card's Compare prices button is clicked.

## How a page is recognised

- Every 1.5 s Rouge checks the window title: no model, no network. A title that names a known store (Amazon, eBay, Walmart, Target, Best Buy and a dozen more, listed in `src/shopping/detect.js`) and stays put for a tick is read once through the Windows helper's browser snapshot.
- The address bar in that snapshot says which page it is. Only a store's own product address matches. Searches, categories, carts and every other site do not. Page text and the address query are not used, and the address is never sent anywhere.
- Private, Incognito and InPrivate windows are skipped. So are the moments when Rouge is busy, another card is open, the ribbon is hidden, there is no way to look prices up (below), or Price comparison is off in Preferences.
- A card appears at most once a minute. The same product is not offered again for 30 minutes. The card goes away after 20 seconds, or when the page changes.

## Where the prices come from

- **With a Serper key** (Preferences, Your keys): Google Shopping, through [Serper](https://serper.dev). One request returns stores, prices and links. Rouge keeps another store than yours, results whose title shares the product's first words, one offer per store, and drops add-ons priced far below the rest. Only the product's name is sent, to Serper.
- **Without one:** Claude (Sonnet, through Auto) searches other stores, up to five searches, with the web search and fetch tools described in [INTERNET.md](INTERNET.md). It needs the Anthropic key and Internet access. Only the product's name and your store are sent, to Claude. A price appears only if Claude found it in a search result or store page, and a link only if one of its searches returned that site. This found a single store for a niche bundle, so a Serper key is the better setup.

## What is shown

Up to five other stores, lowest first, in one bubble, with a link for each when there is one. If nothing is confirmed, the bubble says so. Prices come from Google Shopping or search results and can differ at checkout.

## Limits

- Stores outside the list are not recognised. To add one, add a line to `STORES`: its name as a title shows it, its host, and its product path.
- Reading the address bar worked in Chrome. Edge, Firefox and others are not validated, and Arc is not supported: its window title is only "Arc" and it has no ordinary address bar.
- Serper's response format was taken from its public sample, not from a live call. `CLIPPY_SHOPPING_DEBUG=1` logs what a lookup returned (field names for Serper; the question, tool calls and reply for Claude). The development log also says `shopping: address bar read` or `not readable` for each page it looks at.
