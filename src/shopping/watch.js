'use strict';
// Offers a price comparison when the browser in front is on a product page. Every
// couple of seconds the window title is checked, which is cheap. Only a page whose
// title names a known store, once it has stayed put, is read through the Windows
// helper. The offer is a small card the user can ignore; the product's name goes to
// Claude only if they click Compare prices.

const { isBrowser, isPrivateTitle, isStoreTitle, findUrl, classifyPage } = require('./detect');
const { createPriceCompare } = require('./compare');

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{sidecar:any, ui:any, ai?:any, store:any, log?:Function, busy?:()=>boolean, visible?:()=>boolean,
 *          compare?:{run:Function}, now?:()=>number, pollMs?:number, offerMs?:number, gapMs?:number, cooldownMs?:number, settleMs?:number}} deps
 */
function createShoppingWatch(deps) {
  const { sidecar, ui, store } = deps;
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const pollMs = deps.pollMs || 1500;
  const offerMs = deps.offerMs || 20000;                                   // how long the card waits for an answer
  const gapMs = deps.gapMs == null ? 60000 : deps.gapMs;                   // between two cards
  const cooldownMs = deps.cooldownMs || 30 * 60000;                        // before the same product is offered again
  const settleMs = deps.settleMs == null ? 600 : deps.settleMs;
  const compare = deps.compare || createPriceCompare({ ai: deps.ai, store, log });
  let timer = null;
  let stopped = false;
  let checking = false;
  let comparing = false;
  let seen = { key: '', ticks: 0, done: false };
  let lastOfferAt = -Infinity;
  let offer = null;                 // the card on screen: { abort }
  let job = null;                   // AbortController of a comparison in flight
  const handled = new Map();        // product -> when it was offered

  const busy = () => Boolean(deps.busy && deps.busy());
  function enabled() {
    const s = store.settings();
    const keys = store.keyStatus();
    // A Serper key is enough; without one the lookup is Claude's web search, which needs its key and Internet access.
    const source = keys.serper || (keys.anthropic && s.webAccess !== false);
    return s.shoppingOffers !== false && !s.markHidden && Boolean(source) && (!deps.visible || deps.visible());
  }

  function closeOffer() { if (offer) { offer.abort.abort(); offer = null; } }
  function forget() { seen = { key: '', ticks: 0, done: false }; closeOffer(); }
  function release(res) {
    if (res && res.ok && res.snapshot && res.snapshot.snapshotId) Promise.resolve(sidecar.computerRelease(res.snapshot.snapshotId)).catch(() => {});
  }

  /** One look at the browser through the helper; its address bar says which page this is. */
  async function read(fg) {
    const take = () => Promise.resolve(sidecar.computerSnapshot(fg.hwnd)).catch(() => null);
    let res = await take();
    // Chromium builds its accessibility tree on first contact, so a nearly empty answer is asked for again.
    if (res && res.ok && res.snapshot && (res.snapshot.elements || []).length < 12) { release(res); await sleep(settleMs); res = await take(); }
    try {
      const url = findUrl(res && res.ok ? res.snapshot : null);
      log(`shopping: address bar ${url ? 'read' : 'not readable'}`);
      return classifyPage({ title: fg.title, url });
    } finally { release(res); }
  }

  async function inspect(fg) {
    if (!isStoreTitle(fg.title)) { seen.done = true; return; }
    if (now() - lastOfferAt < gapMs) return;                               // too soon after the last card: look again next time
    seen.done = true;
    log('shopping: reading the page');
    const page = await read(fg);
    if (!page) { log('shopping: not a product page'); return; }
    const before = handled.get(page.key);
    if (before !== undefined && now() - before < cooldownMs) return;
    const open = ui.pending();
    if (open.asks || open.offers || busy() || stopped) return;
    present(page);
  }

  function present(page) {
    const t = now();
    handled.set(page.key, t);
    if (handled.size > 200) for (const [k, at] of handled) if (t - at > cooldownMs) handled.delete(k);
    lastOfferAt = t;
    const abort = new AbortController();
    offer = { abort };
    log('shopping: offering a comparison');
    ui.ask({
      kicker: 'Shopping',
      title: `Compare prices for “${short(page.name, 52)}”?`,
      hint: page.store ? `You are on ${page.store}. I will look at other stores.` : 'I will look at other stores.',
      yes: 'Compare prices',
      no: 'Not now',
    }, { timeoutMs: offerMs, signal: abort.signal }).then((yes) => {
      if (offer && offer.abort === abort) offer = null;
      return yes ? run(page) : undefined;
    }).catch((e) => log(`shopping: ${e.message}`));
  }

  async function run(page) {
    if (comparing || stopped) return;
    comparing = true;
    job = new AbortController();
    ui.state('thinking', { word: 'Comparing', line: 'Checking other stores' });
    try {
      const result = await compare.run(page, { signal: job.signal });
      if (stopped || !enabled()) return;
      ui.say(result.text, { kicker: `Prices · ${short(page.name, 30)}`, sources: result.sources });
    } catch (e) {
      if (stopped) return;
      log(`shopping: comparison failed (${e && e.code || 'error'})`);
      ui.notice(e && e.message ? e.message : 'The price comparison did not finish.', { tone: 'error' });
    } finally {
      comparing = false;
      job = null;
      if (!busy()) ui.state('idle');
    }
  }

  async function tick() {
    if (stopped || checking) return;
    checking = true;
    try {
      if (!sidecar.available || !enabled()) { forget(); return; }
      if (busy()) return;
      const fg = await sidecar.fg();
      if (!fg || !fg.hwnd || !isBrowser(fg.process) || isPrivateTitle(fg.title)) { forget(); return; }
      const key = `${fg.hwnd}|${fg.title}`;
      // A new page: any card about the last one goes away, and the title has to hold still for a tick before it is read.
      if (key !== seen.key) { seen = { key, ticks: 1, done: false }; closeOffer(); return; }
      seen.ticks += 1;
      if (seen.done || seen.ticks < 2) return;
      await inspect(fg);
    } catch (e) {
      log(`shopping: ${e.message}`);
    } finally { checking = false; }
  }

  function start() {
    if (timer || stopped) return;
    timer = setInterval(() => { tick().catch((e) => log(`shopping: ${e.message}`)); }, pollMs);
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    closeOffer();
    if (job) job.abort();
  }

  return { start, stop, tick };
}

module.exports = { createShoppingWatch };
