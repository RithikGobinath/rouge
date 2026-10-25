'use strict';
// Prices from Google Shopping, through Serper (https://serper.dev). One call returns the
// stores, prices and links, so there is nothing for a model to hunt for or invent. Only the
// product's name is sent, and only after the user clicked Compare prices.

const { postJson } = require('../ai/http');
const { publicWebUrl } = require('../ai/web');

const ENDPOINT = 'https://google.serper.dev/shopping';
const PRICE = /[$£€¥]\s?\d[\d,]*(?:\.\d{1,2})?/;
const FILLER = new Set(['the', 'and', 'with', 'for', 'new', 'newest', 'model', 'pack', 'set']);

const letters = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];

/** A search phrase from a page title: its first dozen words, which carry the brand and the model. */
const queryFor = (name) => String(name).split(/\s+/).slice(0, 12).join(' ').slice(0, 100);

/** Google Shopping's results for a product name. @returns {Promise<object[]>} */
async function searchShopping({ key, query, fetchImpl, signal }) {
  const data = await postJson('serper', ENDPOINT, { 'X-API-KEY': key }, { q: query, gl: 'us', hl: 'en' }, { timeoutMs: 15000, fetchImpl, signal });
  return Array.isArray(data && data.shopping) ? data.shopping : [];
}

/**
 * The offers worth showing: another store than the user's, the same product, one per store,
 * a price, no add-ons, lowest first.
 * @returns {{store:string, price:string, value:number, url:string}[]}
 */
function pick(items, page) {
  const wanted = words(page.name).filter((w) => w.length > 2 && !FILLER.has(w)).slice(0, 6);
  const own = letters(page.store || '');
  const byStore = new Map();
  for (const item of items.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const store = String(item.source || '').split(/\s+[-·|]\s+/)[0].replace(/\.com$/i, '').trim().slice(0, 40);
    const key = letters(store);
    const match = PRICE.exec(String(item.price || ''));
    if (!key || key === own || !match || byStore.has(key)) continue;
    const title = new Set(words(item.title));
    if (wanted.length && wanted.filter((w) => title.has(w)).length / wanted.length < 0.5) continue;
    const price = match[0].replace(/\s+/g, '');
    byStore.set(key, { store, price, value: parseFloat(price.replace(/[^\d.]/g, '')), url: typeof item.link === 'string' ? publicWebUrl(item.link) : '' });
  }
  const offers = [...byStore.values()].sort((a, b) => a.value - b.value);
  // Cases, chargers and other add-ons turn up for the same words at a fraction of the price.
  const median = offers.length ? offers[Math.floor(offers.length / 2)].value : 0;
  return offers.filter((o) => offers.length < 3 || o.value >= median * 0.5).slice(0, 5);
}

module.exports = { searchShopping, pick, queryFor };
