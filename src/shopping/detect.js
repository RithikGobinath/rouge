'use strict';
// Is the browser in front on a product page of a store we know? The window title says
// which store, which is cheap. The address bar says which page, which takes one snapshot
// of the browser through the Windows helper. Nothing here goes to a model.

const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi']);
const BROWSER_NAME = /^(?:Google Chrome|Microsoft\W{0,3}Edge|Mozilla Firefox|Brave|Opera|Vivaldi)\b/i;
const PRIVATE = /\((?:incognito|inprivate|private(?: browsing)?)\)|\[inprivate\]|\bprivate browsing\b|\bincognito\b/i;

// A store's own address for one product. Searches, categories and carts do not match.
// To cover another store, add a line: how it is named in a title, its host, its product path.
const STORES = [
  { name: 'Amazon', names: ['amazon'], host: /(?:^|\.)amazon\.[a-z.]{2,}$/, product: /\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{8,}/i },
  { name: 'eBay', names: ['ebay'], host: /(?:^|\.)ebay\.[a-z.]{2,}$/, product: /\/itm\/(?:[^/]+\/)?\d{6,}/ },
  { name: 'Walmart', names: ['walmart'], host: /(?:^|\.)walmart\.(?:com|ca)$/, product: /\/ip\/(?:[^/]+\/)?\d+/ },
  { name: 'Target', names: ['target'], host: /(?:^|\.)target\.com$/, product: /\/p\/[^/]+/ },
  { name: 'Best Buy', names: ['best buy', 'bestbuy'], host: /(?:^|\.)bestbuy\.(?:com|ca)$/, product: /\/\d{6,}\.p$|\/product\/[^/]+\/[A-Z0-9]{6,}/i },
  { name: 'Costco', names: ['costco', 'costco wholesale'], host: /(?:^|\.)costco\.(?:com|ca)$/, product: /\.product\.\d+\.html$/ },
  { name: 'Home Depot', names: ['home depot', 'the home depot'], host: /(?:^|\.)homedepot\.(?:com|ca)$/, product: /\/p\/(?:[^/]+\/)?\d{6,}/ },
  { name: "Lowe's", names: ["lowe's", 'lowes', "lowe's home improvement"], host: /(?:^|\.)lowes\.(?:com|ca)$/, product: /\/pd\// },
  { name: 'Newegg', names: ['newegg'], host: /(?:^|\.)newegg\.(?:com|ca)$/, product: /\/p\/[A-Z0-9-]{6,}/i },
  { name: 'Etsy', names: ['etsy'], host: /(?:^|\.)etsy\.com$/, product: /\/listing\/\d+/ },
  { name: 'AliExpress', names: ['aliexpress'], host: /(?:^|\.)aliexpress\.(?:com|us)$/, product: /\/item\/\d+/ },
  { name: 'Wayfair', names: ['wayfair'], host: /(?:^|\.)wayfair\.(?:com|ca)$/, product: /\/pdp\// },
  { name: "Macy's", names: ["macy's", 'macys'], host: /(?:^|\.)macys\.com$/, product: /\/shop\/product\// },
  { name: 'B&H', names: ['b&h', 'b&h photo', 'b&h photo video'], host: /(?:^|\.)bhphotovideo\.com$/, product: /\/c\/product\/\d+/ },
  { name: 'Apple', names: ['apple'], host: /(?:^|\.)apple\.com$/, product: /\/shop\/(?:buy-|product\/)/ },
  { name: 'IKEA', names: ['ikea'], host: /(?:^|\.)ikea\.com$/, product: /\/p\/[^/]+-\d{6,}/ },
  { name: 'Nike', names: ['nike'], host: /(?:^|\.)nike\.com$/, product: /\/t\/[^/]+\/[A-Z0-9-]{6,}/i },
];

const isBrowser = (processName) => BROWSERS.has(String(processName || '').toLowerCase().replace(/\.exe$/, ''));
const isPrivateTitle = (title) => PRIVATE.test(String(title || ''));

/** A title segment as a store would be named in it: "Walmart.com" -> "walmart". */
const norm = (s) => String(s).toLowerCase().replace(/^www\./, '').replace(/\.(?:com|ca|co\.uk|com\.au|de|fr|it|es|in|co\.jp|nl)$/, '').trim();

/** The page title without the browser's own name (and, for Edge, the profile before it). */
function stripBrowser(title) {
  const parts = String(title || '').replace(/\p{Cf}/gu, '').split(/\s+[-–—]\s+/);
  const at = parts.findIndex((p, i) => i > 0 && BROWSER_NAME.test(p.trim()));
  let kept = at > 0 ? parts.slice(0, at) : parts;
  const last = kept[kept.length - 1];
  // Edge puts the profile name between the page and itself; a store name there belongs to the page.
  if (at > 1 && /edge/i.test(parts[at]) && last.length <= 24 && !STORES.some((s) => s.names.includes(norm(last)))) kept = kept.slice(0, -1);
  return kept.join(' - ').replace(/\s+and \d+ more pages?$/i, '').trim();
}

/** "Amazon.com: Product : Department" and "Product | Store" both come apart into their pieces. */
function splitTitle(title) {
  let rest = title;
  const parts = [];
  const lead = /^((?:[a-z0-9-]+\.)+[a-z]{2,})\s*:\s+(?=\S)/i.exec(rest);
  if (lead) { parts.push(lead[1]); rest = rest.slice(lead[0].length); }
  return parts.concat(rest.split(/\s+[|\-–—·•]\s+|\s+:\s+|\s*\|\s*/)).map((p) => p.trim()).filter(Boolean);
}

/** Does this window title name a store we know? The cheap check that decides whether the page is worth reading. */
const isStoreTitle = (title) => {
  const names = splitTitle(stripBrowser(title)).map(norm);
  return STORES.some((s) => s.names.some((n) => names.includes(n)));
};

/** The product's name as a shopper would search for it: no browser, no store, no department. */
function productName(title, store) {
  const clean = stripBrowser(title);
  const parts = splitTitle(clean);
  const kept = parts.filter((p) => !store.names.includes(norm(p)));
  let out = kept.length ? kept : parts;
  if (store.name === 'Amazon' && / : /.test(clean) && out.length > 1) out = out.slice(0, -1);
  return out.join(' - ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** The address bar's web address from a helper snapshot. Search text typed there is not one. */
function findUrl(snapshot) {
  const bar = ((snapshot && snapshot.elements) || []).find((e) => e && e.type === 'Edit' && typeof e.value === 'string' && e.value && /address|search or enter|omnibox|urlbar|location/i.test(e.name || ''));
  if (!bar) return null;
  let raw = bar.value.trim();
  if (!raw || /\s/.test(raw)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return null;
  // The query and fragment can carry a search or a session, so they are dropped here and never used.
  return { host: u.hostname.toLowerCase().replace(/^www\./, ''), path: u.pathname, href: `${u.protocol}//${u.host}${u.pathname}` };
}

/**
 * A known store's product page, or null: searches, categories, carts and every other site.
 * @param {{title:string, url:{host:string, path:string, href:string}|null}} page
 * @returns {{name:string, store:string, url:string, key:string}|null}
 */
function classifyPage({ title, url }) {
  const store = url && STORES.find((s) => s.host.test(url.host));
  if (!store || !store.product.test(url.path)) return null;
  const name = productName(title, store);
  return name.length < 3 ? null : { name, store: store.name, url: url.href, key: `${store.name}|${name.toLowerCase()}` };
}

module.exports = { isBrowser, isPrivateTitle, isStoreTitle, findUrl, classifyPage };
