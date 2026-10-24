'use strict';
// "Say it, it acts." One hold of the talk key, from the first word to the last.
//
// The recognizer reports words as they are heard. Every update re-parses the
// whole transcript into clauses; a clause is acted on as soon as it is both
// FOLLOWED by another clause and unchanged for a moment, so "open Notepad" runs
// while the rest of the sentence is still being said. Whatever is left runs
// when the key is released. Clauses the grammar does not know go to Jev (if
// there is a TypeSafe key), then to a bigger model on your own key.
//
// This module touches no Electron API: the overlay is `ui`, the PC is
// `executor`, the ears are `speech`.

const { parse } = require('./reflex');
const { QUESTION_START } = require('./vocab');
const { describe } = require('../actions/describe');

const STABLE_MS = 250;            // a clause must read the same this long before it runs
const IDLE_MS = 700;              // after a finished phrase, the last clause runs after this much quiet
const IDLE_TYPING_MS = 1700;      // ...longer for typed text, which people say in pieces
const CHAIN_MS = 90000;           // actions this close together count as "a few in a row"

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|confirm|send it|please do|that's right|correct)\b/i;
const NO = /^(?:no|nope|not now|don't|do not|cancel|stop|never ?mind|leave it)\b/i;
const CANCEL = /^(?:stop|cancel|stop that|stop it|stop listening|never\s*mind|forget it|scratch that)[.!?]*$/i;

/**
 * @typedef {Object} VoiceUi
 * @property {(s:string, info?:{word?:string,line?:string})=>void} state   idle|listening|thinking|acting|speaking|ready
 * @property {(text:string, o?:{final?:boolean})=>void} transcript
 * @property {(level:number)=>void} level
 * @property {(text:string, o?:{sources?:object[], kicker?:string})=>void} say
 * @property {(text:string, o?:{tone?:string})=>void} notice
 * @property {(card:{kicker:string,title:string,hint:string})=>Promise<boolean>} ask
 * @property {(o:{labels:string[]})=>Promise<'keep'|'skip'>} offerRoutine
 * @property {(text:string)=>void} [speak]
 */

/** @param {{speech:any, ui:VoiceUi, executor:any, routines:any, folders?:any, ai?:any, getJev?:()=>any, apps?:any, sidecar?:any, settings:()=>any, now?:()=>number, log?:Function}} d */
function createVoice(d) {
  const now = d.now || Date.now;
  const log = d.log || (() => {});
  const wait = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let run = null;                 // the utterance being carried out
  let hearing = null;             // the one that has the microphone (the same run, or an answer to a Check first card)
  let chain = { actions: [], at: 0, offered: false };
  let pendingAsk = null;          // { settle } while a Check first card is up
  let lastAnswer = [];            // short memory of this chat, for follow-ups

  const parseOpts = () => ({ folders: d.folders ? d.folders.names() : [] });
  const usesClaudeRouting = () => Boolean(d.ai && d.ai.usesClaudeRouting && d.ai.usesClaudeRouting());

  // ----- Check first, answerable by voice -------------------------------------
  function ask(card) {
    return new Promise((resolve) => {
      const settle = (v) => { if (pendingAsk && pendingAsk.settle === settle) pendingAsk = null; resolve(Boolean(v)); };
      pendingAsk = { settle, card };
      d.ui.ask(card).then(settle, () => settle(false));
    });
  }

  // ----- one clause --------------------------------------------------------
  async function front() { try { return d.sidecar ? (await d.sidecar.fg()).title : ''; } catch (_) { return ''; } }

  function showAnswer(text, answer) {
    d.ui.say(answer.say, { sources: answer.sources });
    if (d.settings().speakReplies && d.ui.speak) d.ui.speak(answer.say);
    lastAnswer.push({ role: 'user', text }, { role: 'assistant', text: answer.say });
    lastAnswer = lastAnswer.slice(-8);
  }

  /** Ask a model: a question gets an answer, a request gets a plan of actions. */
  async function askModel(text, ctx) {
    if (!d.ai) return { ok: false };
    if (!d.ai.canAnswer() && !(d.settings().useClaudeCode && await d.ai.claudeCode.available())) { d.ui.notice('Add an Anthropic key under Your keys to use Clippy’s Claude models.', { tone: 'info' }); return { ok: false }; }
    d.ui.state('thinking', { word: 'Working it out' });
    try {
      if (!usesClaudeRouting() && QUESTION_START.test(text)) {
        const a = await d.ai.answer(text, { history: lastAnswer, signal: ctx.signal });
        lastAnswer.push({ role: 'user', text }, { role: 'assistant', text: a.text });
        lastAnswer = lastAnswer.slice(-8);
        d.ui.say(a.text, { sources: a.sources });
        if (d.settings().speakReplies && d.ui.speak) d.ui.speak(a.text);
        return { ok: true, said: true };
      }
      const apps = d.apps ? d.apps.names() : [];
      const plan = await d.ai.plan(text, { front: await front(), apps, history: lastAnswer, signal: ctx.signal });
      if (!plan.actions.length && !plan.say) {
        d.ui.notice('No answer was returned. Please try again.', { tone: 'error' });
        return { ok: false };
      }
      if (ctx.signal && ctx.signal.aborted) return { ok: false, cancelled: true };
      if (plan.actions.length) return { ok: true, actions: plan.actions, completion: plan };
      if (plan.say) showAnswer(text, plan);
      return { ok: true, said: true };
    } catch (e) {
      if (ctx.signal && ctx.signal.aborted) return { ok: false, cancelled: true };
      d.ui.notice(e.message || 'That did not work.', { tone: 'error' });
      return { ok: false };
    }
  }

  async function runActions(actions, ctx) {
    const out = await d.executor.runAll(actions, {
      signal: ctx.signal,
      beforeKeyboard: () => ctx.keysUp,
      onStep: (s) => {
        if (s.phase === 'start') d.ui.state('acting', { word: 'Doing it', line: s.label });
        else if (s.phase === 'error') d.ui.notice(s.label, { tone: 'error' });
      },
    });
    for (const r of out.results || []) {
      if (!r.ok) continue;
      if (r.deferred === 'save_routine') { await saveRoutine(r.action.name); continue; }
      if (!['run_routine', 'cancel', 'save_routine', 'say', 'wait'].includes(r.action.type)) { ctx.did.push(r.action); noteChain(r.action); }
    }
    if (!out.ok && out.note && !out.declined && !out.cancelled) d.ui.notice(out.note, { tone: 'error' });
    return out;
  }

  async function doClause(clause, ctx) {
    if (ctx.signal.aborted) return false;
    if (clause.action && clause.action.type === 'cancel') { cancel(); return false; }
    let actions = clause.action ? [clause.action] : null;
    let completion = null;
    if (usesClaudeRouting()) {
      // One Haiku request owns the complete request; no other model runs first.
      const m = await askModel(clause.text, ctx);
      if (!m.ok || !m.actions) return m.ok !== false;
      actions = m.actions;
      completion = m.completion;
    } else if (!actions) {
      const jev = d.getJev && d.getJev();
      if (jev) {
        try {
          const plan = await jev.plan(clause.text, { apps: d.apps ? d.apps.names() : [], folders: d.folders ? d.folders.names() : [], front: await front() });
          if (plan.actions.length) actions = plan.actions;
        } catch (e) { log(`jev: ${e.message}`); if (e.status === 401 || e.status === 403) d.ui.notice('TypeSafe did not accept your key. Check it under Your keys.', { tone: 'error' }); }
      }
    }
    if (!actions) {
      const m = await askModel(clause.text, ctx);
      if (!m.ok || !m.actions) return m.ok !== false;
      actions = m.actions;
      completion = m.completion;
    }
    if (actions.some((a) => a.type === 'cancel')) { cancel(); return false; }
    const out = await runActions(actions, ctx);
    if (out.ok && !ctx.signal.aborted && completion && completion.say) showAnswer(clause.text, completion);
    return out.ok;
  }

  // ----- the chain of actions, and the offer to keep it ---------------------
  function noteChain(action) {
    const t = now();
    if (t - chain.at > CHAIN_MS) chain = { actions: [], at: t, offered: false };
    chain.actions.push(action); chain.at = t;
  }

  async function saveRoutine(name) {
    const items = chain.actions.slice();
    const r = d.routines.save({ name, actions: items });
    if (!r.ok) { d.ui.notice(r.error, { tone: 'error' }); return false; }
    chain.offered = true;
    d.ui.say(`Saved as “${r.routine.name}”. Say “run my shortcut” any time.`, { kicker: 'Shortcut' });
    return true;
  }

  async function maybeOffer() {
    if (chain.offered || chain.actions.length < 2 || now() - chain.at > CHAIN_MS) return;
    chain.offered = true;
    const labels = chain.actions.map((a) => describe(a).present);
    const choice = await d.ui.offerRoutine({ labels });
    if (choice === 'keep') {
      const r = d.routines.save({ name: '', actions: chain.actions.slice() });
      if (r.ok) d.ui.say(`Saved as “${r.routine.name}”. Say “run my shortcut” any time.`, { kicker: 'Shortcut' });
      else d.ui.notice(r.error, { tone: 'error' });
    }
  }

  // ----- an utterance, live ------------------------------------------------
  function newRun(source) {
    const ac = new AbortController();
    let releaseKeys; const keysUp = new Promise((res) => { releaseKeys = res; });
    if (source === 'text') releaseKeys();      // typing a command holds no keys
    return { source, ac, signal: ac.signal, keysUp, releaseKeys, executed: 0, queue: Promise.resolve(), seen: [], seenAt: [], released: false, did: [], idleTimer: null, text: '', failed: false };
  }

  function enqueue(r, clause) {
    r.queue = r.queue.then(async () => {
      if (r.signal.aborted || r.failed) return;
      log(`clause: ${clause.action ? clause.action.type : 'ask'}`);
      const ok = await doClause(clause, r);
      log(`clause done: ${ok}`);
      if (!ok) r.failed = true;           // a failed or declined step ends the rest of this sentence
    }).catch((e) => { log(`clause: ${e.message}`); r.failed = true; });
  }

  /** Run every clause that is ready. `all` runs the last one too. */
  function commit(r, all) {
    if (usesClaudeRouting()) {
      const text = r.text.trim();
      const clauses = text ? [{ text, action: null }] : [];
      // Wait for the talk key to be released. Streaming partial clauses through
      // the router would make several A calls for a single spoken request.
      if (!all || !r.released || r.executed || !text) return clauses;
      const local = parse(text, parseOpts());
      const immediateCancel = CANCEL.test(text) || local.length === 1 && local[0].action && local[0].action.type === 'cancel';
      enqueue(r, immediateCancel ? { text, action: { type: 'cancel' } } : clauses[0]);
      r.executed = 1;
      return clauses;
    }
    const clauses = parse(r.text, parseOpts());
    const limit = all ? clauses.length : clauses.length - 1;
    const t = now();
    for (let i = r.executed; i < limit; i += 1) {
      const same = r.seen[i] === clauses[i].text;
      if (!all) {
        if (!same) { r.seen[i] = clauses[i].text; r.seenAt[i] = t; break; }
        if (t - r.seenAt[i] < STABLE_MS) break;
      }
      enqueue(r, clauses[i]);
      r.executed = i + 1;
    }
    clauses.forEach((c, i) => { if (r.seen[i] !== c.text) { r.seen[i] = c.text; r.seenAt[i] = t; } });
    return clauses;
  }

  function onUpdate(r, u) {
    if ((run !== r && hearing !== r) || r.signal.aborted) return;
    r.text = u.text;
    d.ui.transcript(u.text, { final: u.kind === 'final' });
    clearTimeout(r.idleTimer);
    if (pendingAsk) return;
    const clauses = commit(r, false);
    // Re-check after the stability window, so a clause that stopped changing runs without waiting for more words.
    clearTimeout(r.stableTimer);
    r.stableTimer = setTimeout(() => { if (run === r && !r.released && !r.signal.aborted) commit(r, false); }, STABLE_MS + 30);
    if (u.kind === 'final' && clauses.length) {
      const last = clauses[clauses.length - 1];
      const typing = last.action && last.action.type === 'type_text';
      r.idleTimer = setTimeout(() => { if (run === r && !r.released && !r.signal.aborted) commit(r, true); }, typing ? IDLE_TYPING_MS : IDLE_MS);
    }
  }

  async function finish(r) {
    clearTimeout(r.idleTimer); clearTimeout(r.stableTimer);
    try {
      if (r.signal.aborted) return;
      const text = r.text.trim();
      if (r.answerOnly && !pendingAsk) { d.ui.state('idle'); return; }   // the card was answered by a click meanwhile
      if (pendingAsk && text) {
        const p = pendingAsk;
        if (YES.test(text)) { p.settle(true); d.ui.state('ready'); return; }
        if (NO.test(text)) { p.settle(false); d.ui.state('idle'); return; }
        if (r.answerOnly) { d.ui.notice('Say yes, or not now.', { tone: 'info' }); d.ui.state('ready'); return; }
      }
      if (!text) { d.ui.state('idle'); d.ui.notice(source(r) === 'voice' ? 'I did not catch that. Hold the keys and try again.' : '', { tone: 'info' }); return; }
      d.ui.state('thinking', { word: 'Working it out' });
      commit(r, true);
      await r.queue;
      if (r.signal.aborted) return;
      if (run === r) run = null;                  // free for the next command; the offer does not hold it up
      maybeOffer().catch((e) => log(`offer: ${e.message}`));
      d.ui.state('ready');
      await wait(900);
      if (!run && !hearing) d.ui.state('idle');
    } finally {
      // Empty speech and exceptional exits must release the busy slot too.
      // An older finishing command must never clear a newer command.
      if (run === r) run = null;
      clearTimeout(r.idleTimer); clearTimeout(r.stableTimer);
    }
  }
  const source = (r) => r.source;

  // ----- what the app calls ------------------------------------------------
  async function begin(src = 'voice') {
    if (hearing || (run && !pendingAsk)) return false;
    const r = newRun(src);
    log(`listening (${src})`);
    hearing = r;
    r.answerOnly = Boolean(pendingAsk);       // heard only to settle the Check first card
    if (!r.answerOnly) run = r;
    r.off = d.speech.on('update', (u) => onUpdate(r, u));
    r.offLevel = d.speech.on('level', (v) => d.ui.level(v));
    r.offErr = d.speech.on('error', (e) => d.ui.notice(e.message, { tone: 'error' }));
    d.ui.state('listening', { word: 'Listening', line: 'You:' });
    r.starting = d.speech.listen(d.listenFile ? d.listenFile() : undefined);
    try { await r.starting; } catch (e) {
      if (run === r) run = null;
      if (hearing === r) hearing = null;
      r.off(); r.offLevel(); r.offErr();
      d.ui.state('idle');
      d.ui.notice(`I can't listen: ${e.message}`, { tone: 'error' });
      return false;
    }
    return true;
  }

  async function release() {
    const r = hearing;
    if (!r || r.released) return;
    r.released = true;
    r.releaseKeys();                              // the keys are up: queued typing and shortcuts may go
    try {
      try { await r.starting; } catch (_) { return; }  // begin() reports start failures
      if (r.signal.aborted) return;
      const t = await d.speech.finish(2500);
      if (r.signal.aborted) return;
      if (hearing === r) hearing = null;
      r.off(); r.offLevel(); r.offErr();
      r.text = t.text || r.text;
      log(`voice transcript received; empty=${!r.text.trim()}`);
      d.ui.transcript(r.text, { final: true });
      await finish(r);
    } catch (e) {
      if (!r.signal.aborted) {
        log(`voice finish: ${e.message}`);
        d.ui.notice(e.message || 'I could not finish listening. Please try again.', { tone: 'error' });
      }
    } finally {
      // Speech/helper failures cannot leave the microphone session blocking chat.
      r.releaseKeys();
      if (r.off) r.off();
      if (r.offLevel) r.offLevel();
      if (r.offErr) r.offErr();
      clearTimeout(r.idleTimer); clearTimeout(r.stableTimer);
      if (hearing === r) hearing = null;
      if (run === r) run = null;
      if (!run && !hearing) d.ui.state('idle');
    }
  }

  /** A typed command goes the same way a spoken one does. */
  async function runText(text) {
    text = String(text || '').trim();
    if (!text) return true;
    if (CANCEL.test(text)) { cancel(); return true; }
    if (pendingAsk && (YES.test(text) || NO.test(text))) { pendingAsk.settle(YES.test(text)); return true; }
    if (run || hearing) return false;
    const r = newRun('text');
    run = r; r.text = text; r.released = true;
    try {
      d.ui.transcript(r.text, { final: true });
      await finish(r);
      return true;
    } finally {
      if (run === r) run = null;
      clearTimeout(r.idleTimer); clearTimeout(r.stableTimer);
      if (!run && !hearing) d.ui.state('idle');
    }
  }

  function cancel() {
    if (pendingAsk) pendingAsk.settle(false);
    if (d.ui.closeAll) d.ui.closeAll();
    for (const r of new Set([run, hearing])) {
      if (!r) continue;
      r.ac.abort(); r.releaseKeys(); clearTimeout(r.idleTimer); clearTimeout(r.stableTimer);
      if (r.off) { r.off(); r.offLevel(); r.offErr(); }
    }
    if (hearing) d.speech.cancel();
    run = null; hearing = null;
    d.ui.state('idle');
  }

  return {
    begin, release, cancel, runText, saveRoutine,
    get active() { return Boolean(run || hearing); },
    get listening() { return Boolean(hearing && !hearing.released); },
    get asking() { return Boolean(pendingAsk); },
    ask,
    chain: () => ({ ...chain, actions: chain.actions.slice() }),
    resetChat() { lastAnswer = []; },
    _commit: (text, all) => { const r = run || newRun('test'); r.text = text; return commit(r, all); },
  };
}

module.exports = { createVoice, STABLE_MS, IDLE_MS, YES, NO };
