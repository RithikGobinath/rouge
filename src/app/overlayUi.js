'use strict';
// The overlay as the voice session sees it: `state`, `transcript`, `say`, and
// the two questions it can ask (Check first, and "save this as a shortcut?").
// Each question is a promise that the overlay settles when a button is
// clicked, and that settles itself ("not now") if nobody answers.

const ASK_TIMEOUT_MS = 45000;
const OFFER_TIMEOUT_MS = 14000;
const REVIEW_TIMEOUT_MS = 120000;   // 2 min — autofill review needs time to read

/** @param {{overlay:{send:(c:string,d:any)=>void}}} deps */
function createOverlayUi({ overlay }) {
  let nextId = 1;
  const asks = new Map();
  const offers = new Map();
  const reviews = new Map();
  let levelAt = 0;

  function question(map, channel, closeChannel, payload, timeoutMs, onTimeout) {
    const id = nextId++;
    return new Promise((resolve) => {
      const finish = (v) => {
        if (!map.delete(id)) return;
        clearTimeout(timer);
        overlay.send(closeChannel, { id });
        resolve(v);
      };
      const timer = setTimeout(() => finish(onTimeout), timeoutMs);
      map.set(id, finish);
      overlay.send(channel, { id, ...payload });
    });
  }

  return {
    state: (state, info = {}) => overlay.send('ui:state', { state, word: info.word || '', line: info.line || '' }),
    transcript: (text, o = {}) => overlay.send('ui:transcript', { text: String(text || ''), final: Boolean(o.final) }),
    level(v) { const t = Date.now(); if (t - levelAt < 33) return; levelAt = t; overlay.send('ui:level', Number(v) || 0); },
    say: (text, o = {}) => overlay.send('ui:say', { text: String(text || ''), kicker: o.kicker || '', sources: (o.sources || []).slice(0, 12) }),
    /** Send growing accumulated text to the overlay while a stream is in progress.
     *  The caller must pass the full accumulated string each time (not a delta).
     *  The final say() call replaces this with the completed bubble. */
    streamChunk: (text) => overlay.send('ui:stream', { text: String(text || '') }),
    notice: (text, o = {}) => { if (text) overlay.send('ui:notice', { text: String(text), tone: o.tone || 'info' }); },
    speak: (text) => overlay.send('ui:speak', { text: String(text || '').slice(0, 600) }),

    /** The Check first card. Resolves true on Yes, false on Not now (or after 45 s of nobody answering). */
    ask: (card) => question(asks, 'ui:ask', 'ui:ask:close', { card }, ASK_TIMEOUT_MS, false),
    answerAsk(id, yes) { const f = asks.get(id); if (f) f(Boolean(yes)); },

    /** "Save that as a shortcut?" Resolves 'keep' or 'skip'. */
    offerRoutine: ({ labels }) => question(offers, 'ui:offer', 'ui:offer:close', { labels: (labels || []).slice(0, 8) }, OFFER_TIMEOUT_MS, 'skip'),
    answerOffer(id, choice) { const f = offers.get(id); if (f) f(choice === 'keep' ? 'keep' : 'skip'); },

    /**
     * Show the per-field autofill confirmation card.
     * Resolves with the accepted [{label,value}] array, or null on cancel/timeout.
     * @param {{fields:Array<{label:string,value:string}>}} payload
     * @returns {Promise<Array|null>}
     */
    review({ fields }) {
      const id = nextId++;
      return new Promise((resolve) => {
        const finish = (accepted) => {
          if (!reviews.delete(id)) return;
          clearTimeout(timer);
          overlay.send('autofill:close', { id });
          resolve(accepted);
        };
        const timer = setTimeout(() => finish(null), REVIEW_TIMEOUT_MS);
        reviews.set(id, finish);
        overlay.send('autofill:review', { id, fields: (fields || []).slice(0, 30) });
      });
    },
    answerReview(id, fields) { const f = reviews.get(id); if (f) f(Array.isArray(fields) && fields.length ? fields : null); },
    cancelReview(id) { const f = reviews.get(id); if (f) f(null); },

    /** Panic: answer everything pending with "no". */
    closeAll() {
      for (const f of [...asks.values()]) f(false);
      for (const f of [...offers.values()]) f('skip');
      for (const f of [...reviews.values()]) f(null);
    },
    pending: () => ({ asks: asks.size, offers: offers.size }),
  };
}

module.exports = { createOverlayUi, ASK_TIMEOUT_MS, OFFER_TIMEOUT_MS };
