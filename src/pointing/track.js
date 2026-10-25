'use strict';
// Finding the same control again after its window scrolled or resized, so the wand
// stays on what it was sent to and never jumps to some other element.

const MIN_FUZZY = 12;     // a shorter name is too common to match as part of another name
const FUZZY_SHARE = 0.6;  // ... and must make up this much of the longer name
const SIZE_FACTOR = 4;    // the same control keeps roughly its size; anything far off is a different element

const norm = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
const finite = (r) => Boolean(r) && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k])) && r.w > 0 && r.h > 0;
const near = (a, b) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
const similarSize = (a, b) => a.w / b.w <= SIZE_FACTOR && b.w / a.w <= SIZE_FACTOR && a.h / b.h <= SIZE_FACTOR && b.h / a.h <= SIZE_FACTOR;

/** 2 for the same name, 1 for a long name that contains (or is contained in) the other, 0 otherwise. A blank name never matches. */
function nameScore(name, wanted) {
  const a = norm(name); const b = norm(wanted);
  if (!a || !b) return 0;
  if (a === b) return 2;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_FUZZY && short.length / long.length >= FUZZY_SHARE && long.includes(short) ? 1 : 0;
}

/**
 * @param {Array<{name?:string, automationId?:string, rect?:object|null}>} elements a fresh snapshot of the window
 * @param {{name?:string, automationId?:string}} wanted what the wand was sent to
 * @param {{x:number,y:number,w:number,h:number}} last where the wand last pointed
 * @param {{x:number,y:number,w:number,h:number}} [first] the rectangle it was first sent to
 * @returns the matching element, or null when this window no longer shows it
 */
function findTracked(elements, wanted, last, first) {
  const reference = first || last;
  let best = null;
  for (const el of elements || []) {
    if (!el || !finite(el.rect)) continue;
    const score = nameScore(el.name, wanted && wanted.name);
    if (!score) continue;
    if (finite(reference) && !similarSize(el.rect, reference)) continue;
    // The same control often keeps its automation id while its text changes.
    const bonus = wanted && wanted.automationId && el.automationId === wanted.automationId ? 1 : 0;
    const total = score + bonus; const distance = finite(last) ? near(el.rect, last) : 0;
    if (!best || total > best.total || (total === best.total && distance < best.distance)) best = { el, total, distance };
  }
  return best ? best.el : null;
}

module.exports = { findTracked, nameScore, norm };
