# Price comparison

When the browser in front is on a product page of a store Rouge knows, a small card offers to compare prices at other stores. Nothing leaves the PC until the card's Compare prices button is clicked.

## How a page is recognised

- Every 1.5 s Rouge checks the window title: no model, no network. A title that names a known store (Amazon, eBay, Walmart, Target, Best Buy and a dozen more, listed in `src/shopping/detect.js`) and stays put for a tick is read once through the Windows helper's browser snapshot.
- The address bar in that snapshot says which page it is. Only a store's own product address matches. Searches, categories, carts and every other site do not. Page text and the address query are not used.
- Private, Incognito and InPrivate windows are skipped. So are the moments when Rouge is busy, another card is open, the ribbon is hidden, Internet access is off, there is no Anthropic key, or Price comparison is off in Preferences.
- A card appears at most once a minute. The same product is not offered again for 30 minutes. The card goes away after 20 seconds, or when the page changes.

## What is sent, and when

After the click: the product's name taken from the page title, the store's name, and the product page's address without its query. Claude (Sonnet, through Auto) searches other stores with the web search and fetch tools described in [INTERNET.md](INTERNET.md). Nothing else from the page goes along.

## What is shown

Up to five other stores, lowest first, in one bubble. A price appears only if Claude saw it in a search result or store page, and a link only if the provider cited that page. If nothing is confirmed, the bubble says so. Prices come from search results and can differ at checkout.

## Limits

- Stores outside the list are not recognised. To add one, add a line to `STORES`: its name as a title shows it, its host, and its product path.
- Reading the address bar from a real Chrome, Edge or Firefox window needs validating on Windows. The development log says `shopping: address bar read` or `not readable` for each page it looks at.
