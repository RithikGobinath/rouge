'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPointAsk } = require('../src/pointing/pointAsk');
const { sensitiveTarget } = require('../src/pointing/sensitive');

function rig(over = {}) {
  const sent = []; const states = []; const calls = { capture: 0, explain: [], list: 0, masks: 0 };
  let clock = 1000;
  const sidecar = {
    cursor: async () => ({ x: 960, y: 540 }),
    fromPoint: async () => over.hit || { element: { id: 3, name: 'Error: the linked file was not found', type: 'Text', automationId: '', rect: { x: 400, y: 300, w: 380, h: 40 } }, hwnd: 7, window: { title: 'report-draft.docx - Word', pid: 9 } },
    fg: async () => ({ hwnd: 7, title: 'report-draft.docx - Word', process: 'WINWORD' }),
    uiaList: async () => { calls.list += 1; return over.list || { elements: [], truncated: false }; },
  };
  const ai = { explain: async (o) => { calls.explain.push(o); if (over.explain) return over.explain(o); return { kicker: 'Explain', text: 'The link points to a file that moved. Relink it from Insert, then Link.', confidence: 0.9, provider: 'anthropic' }; } };
  const overlay = { send: (c, p) => sent.push([c, p]), physToOverlay: (r) => ({ x: r.x - 100, y: r.y - 50, w: r.w, h: r.h }), win: {} };
  const ui = { state: (s, i) => states.push(s + (i && i.line ? `:${i.line}` : '')), notice: () => {} };
  const capture = {
    takeDisplay: async () => { calls.capture += 1; return { scale: 1, display: { size: { width: 1920, height: 1080 } }, origin: { x: 0, y: 0 }, width: 1920, height: 1080 }; },
    cropAround: (shot, rect) => ({ dataUrl: 'data:image/png;base64,CROP', rect }),
    maskRegions: (shot, rects) => { calls.masks += 1; assert.ok(rects.length); return shot; },
  };
  const p = createPointAsk({ sidecar, ai, overlay, ui, capture, now: () => clock });
  return { p, sent, states, calls, tick: (ms) => { clock += ms; } };
}

const bubbles = (sent) => sent.filter(([c]) => c === 'point:bubble').map(([, b]) => b);

test('looking at an error: the thread goes to it, and the answer lands there', async () => {
  const { p, sent, states, calls } = rig();
  await p.trigger();
  const target = sent.find(([c]) => c === 'point:target')[1];
  assert.deepEqual(target.rect, { x: 300, y: 250, w: 380, h: 40 }, 'the control rectangle, in overlay pixels');
  const b = bubbles(sent).at(-1);
  assert.equal(b.kicker, 'Explain');
  assert.match(b.text, /Relink it from Insert/);
  assert.equal(b.anchor, 'tip');
  assert.deepEqual(b.actions.map((a) => a.id), ['more', 'close']);
  assert.equal(calls.explain.length, 1);
  assert.equal(calls.explain[0].crop, 'data:image/png;base64,CROP');
  assert.equal(calls.explain[0].overview, undefined, 'no whole-screen overview is uploaded');
  assert.equal(calls.explain[0].element.name, 'Error: the linked file was not found');
  assert.equal(calls.explain[0].window.title, 'report-draft.docx - Word');
  assert.equal(calls.list, 1);
  assert.deepEqual(states, ['reading:At that spot', 'thinking', 'ready']);
  assert.ok(sent.findIndex(([c]) => c === 'point:target') < sent.findIndex(([c]) => c === 'point:bubble'), 'the thread leaves before the answer arrives');
});

test('password and card fields are refused before any screenshot', async () => {
  const hit = { element: { id: 1, name: 'Password', type: 'Edit', rect: { x: 10, y: 10, w: 200, h: 30 } } };
  const { p, sent, calls } = rig({ hit });
  await p.trigger();
  assert.equal(calls.capture, 0);
  assert.equal(calls.explain.length, 0);
  assert.match(bubbles(sent)[0].text, /won't look at it/);
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'Card number' }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'SSN' }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'OTP' }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'CVC' }), true);
  assert.equal(sensitiveTarget({ type: 'Button', name: 'Password' }), false);
  const flagged = rig({ hit: { element: { id: 1, name: 'Secret code', type: 'Edit', isPassword: true, rect: { x: 1, y: 1, w: 50, h: 20 } } } });
  await flagged.p.trigger();
  assert.equal(flagged.calls.capture, 0);
});

test('nearby private fields are masked; an incomplete control list refuses capture', async () => {
  const list = {
    elements: [{ name: 'SSN', type: 'Edit', rect: { x: 420, y: 310, w: 80, h: 24 } }],
    truncated: false,
  };
  const { p, calls } = rig({ list });
  await p.trigger();
  assert.equal(calls.capture, 1);
  assert.equal(calls.masks, 1);
  assert.equal(calls.explain.length, 1);

  const refused = rig({ list: { elements: [], truncated: true } });
  await refused.p.trigger();
  assert.equal(refused.calls.capture, 0);
  assert.match(bubbles(refused.sent)[0].text, /could not check nearby private fields/i);
});

test('when Windows names nothing, the thread goes to "your spot"', async () => {
  const { p, sent, calls } = rig({ hit: { element: null, hwnd: 7 } });
  await p.trigger();
  const t = sent.find(([c]) => c === 'point:target')[1];
  assert.equal(t.label, 'Your spot');
  assert.deepEqual([t.rect.w, t.rect.h], [56, 56]);
  assert.equal(calls.explain[0].element, null);
  assert.deepEqual(bubbles(sent).at(-1).actions.map((a) => a.id), ['more', 'close']);
  const big = rig({ hit: { element: { id: 1, name: 'Document', type: 'Pane', rect: { x: 0, y: 0, w: 1800, h: 1000 } } } });
  await big.p.trigger();
  assert.equal(big.sent.find(([c]) => c === 'point:target')[1].label, 'Your spot', 'a window-sized hit is not a control');
});

test('a follow-up uses the same picture and remembers the answer', async () => {
  const { p, sent, calls } = rig();
  await p.trigger();
  assert.equal(await p.followUp('where is Insert?'), true);
  assert.equal(calls.capture, 1, 'no second screenshot');
  assert.equal(calls.explain.length, 2);
  assert.match(calls.explain[1].question, /where is Insert/);
  assert.match(calls.explain[1].question, /Earlier in this chat/);
  assert.equal(bubbles(sent).filter((b) => b.kicker === 'You').length, 1);
});

test('point and ask: with no Anthropic key it uses Claude Code, then Gemini, and says which', async () => {
  const { p, sent } = rig({ explain: async () => ({ kicker: 'Explain', text: 'From Gemini.', confidence: 0.6, provider: 'gemini' }) });
  await p.trigger();
  assert.match(bubbles(sent).at(-1).hint, /Gemini/);
});
