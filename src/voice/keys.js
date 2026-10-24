'use strict';
// Spoken key names -> canonical key names, and the named shortcuts a person
// says without naming keys ("save", "select all", "new tab").
//
// Canonical key names are lowercase: modifiers `ctrl alt shift win`, letters,
// digits, `f1`..`f24`, and the named keys below. The Windows sidecar maps
// them to virtual-key codes (see src/win/vk.js).

const MODIFIERS = new Map([
  ['control', 'ctrl'], ['ctrl', 'ctrl'], ['alt', 'alt'], ['option', 'alt'], ['shift', 'shift'],
  ['windows', 'win'], ['win', 'win'], ['super', 'win'], ['command', 'win'], ['start', 'win'],
]);

const NAMED = new Map([
  ['enter', 'enter'], ['return', 'enter'], ['escape', 'escape'], ['esc', 'escape'], ['tab', 'tab'],
  ['space', 'space'], ['spacebar', 'space'], ['backspace', 'backspace'], ['delete', 'delete'], ['del', 'delete'],
  ['home', 'home'], ['end', 'end'], ['insert', 'insert'], ['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right'],
]);

const DIGIT_WORDS = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
]);

// What a speech recognizer writes for a spoken single letter.
const LETTER_WORDS = new Map([
  ['ay', 'a'], ['bee', 'b'], ['be', 'b'], ['cee', 'c'], ['see', 'c'], ['sea', 'c'], ['dee', 'd'], ['eee', 'e'],
  ['eff', 'f'], ['gee', 'g'], ['aitch', 'h'], ['eye', 'i'], ['jay', 'j'], ['kay', 'k'], ['ell', 'l'], ['em', 'm'],
  ['en', 'n'], ['oh', 'o'], ['pee', 'p'], ['cue', 'q'], ['queue', 'q'], ['are', 'r'], ['ess', 's'], ['tee', 't'], ['tea', 't'],
  ['you', 'u'], ['vee', 'v'], ['double you', 'w'], ['ex', 'x'], ['why', 'y'], ['zee', 'z'], ['zed', 'z'],
]);

const clean = (w) => String(w || '').toLowerCase().replace(/[.,;:!?'"]/g, '').trim();

// "f five", "f 5", "f twelve": the function-key number after a spoken "f".
const TWELVE = { ten: 10, eleven: 11, twelve: 12 };
function fNumber(words, i) {
  const a = clean(words[i]);
  if (/^\d{1,2}$/.test(a) && Number(a) >= 1 && Number(a) <= 24) return { n: Number(a), used: 1 };
  if (a in TWELVE) return { n: TWELVE[a], used: 1 };
  if (DIGIT_WORDS.has(a) && a !== 'zero') return { n: Number(DIGIT_WORDS.get(a)), used: 1 };
  return null;
}

/** The key a single spoken word names, or null. */
function keyFromWord(word) {
  const w = clean(word);
  if (!w) return null;
  if (NAMED.has(w)) return NAMED.get(w);
  if (/^[a-z]$/.test(w)) return w;
  if (/^[0-9]$/.test(w)) return w;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(w)) return w;
  if (DIGIT_WORDS.has(w)) return DIGIT_WORDS.get(w);
  if (LETTER_WORDS.has(w)) return LETTER_WORDS.get(w);
  return null;
}

/**
 * Parse spoken key words into a chord. Reads as many words as form a chord:
 * modifiers first, then exactly one main key. Returns the canonical keys and
 * how many words were used, or null when the words are not a chord.
 * @param {string[]} words
 * @returns {{keys: string[], used: number} | null}
 */
function parseChord(words) {
  const mods = [];
  let i = 0;
  const w = (k) => clean(words[k]);
  while (i < words.length) {
    const word = w(i);
    if (word === 'plus' || word === '+') { i += 1; continue; }
    if (MODIFIERS.has(word)) { mods.push(MODIFIERS.get(word)); i += 1; continue; }
    break;
  }
  if (i >= words.length) {
    // "press windows" alone is a chord of one modifier.
    return mods.length ? { keys: mods.slice(0, 1), used: i } : null;
  }
  let main = null;
  let used = 0;
  const two = `${w(i)} ${w(i + 1)}`;
  if (two === 'page up') { main = 'pageup'; used = 2; }
  else if (two === 'page down') { main = 'pagedown'; used = 2; }
  else if (two === 'print screen') { main = 'printscreen'; used = 2; }
  else if (two === 'caps lock') { main = 'capslock'; used = 2; }
  else if (two === 'double you') { main = 'w'; used = 2; }
  else if (w(i) === 'f' && fNumber(words, i + 1)) { const n = fNumber(words, i + 1); main = 'f' + n.n; used = 1 + n.used; }
  else {
    const k = keyFromWord(words[i]);
    if (k) { main = k; used = 1; }
  }
  if (!main) return null;
  i += used;
  // An arrow key may be followed by "arrow" or "key".
  while (i < words.length && ['arrow', 'key', 'button'].includes(w(i))) i += 1;
  // Modifier words after the main key are not part of this chord.
  return { keys: [...mods, main], used: i };
}

/** Human label: ['ctrl','shift','t'] -> "Ctrl+Shift+T". */
function labelFor(keys) {
  const pretty = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', enter: 'Enter', escape: 'Esc', tab: 'Tab', space: 'Space',
    backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End', insert: 'Insert', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    pageup: 'Page Up', pagedown: 'Page Down', printscreen: 'Print Screen', capslock: 'Caps Lock' };
  return keys.map((k) => pretty[k] || (k.length === 1 ? k.toUpperCase() : k.toUpperCase())).join('+');
}

// Words a person says instead of naming keys. Longest phrase wins.
const SHORTCUTS = [
  ['select all', ['ctrl', 'a']], ['save as', ['ctrl', 'shift', 's']], ['save', ['ctrl', 's']],
  ['copy', ['ctrl', 'c']], ['cut', ['ctrl', 'x']], ['paste', ['ctrl', 'v']],
  ['undo', ['ctrl', 'z']], ['redo', ['ctrl', 'y']], ['find', ['ctrl', 'f']], ['print', ['ctrl', 'p']],
  ['refresh', ['f5']], ['reload', ['f5']], ['go back', ['alt', 'left']], ['go forward', ['alt', 'right']],
  ['zoom in', ['ctrl', '=']], ['zoom out', ['ctrl', '-']],
  ['bold', ['ctrl', 'b']], ['italic', ['ctrl', 'i']], ['underline', ['ctrl', 'u']],
  ['new tab', ['ctrl', 't']], ['close tab', ['ctrl', 'w']], ['reopen tab', ['ctrl', 'shift', 't']], ['next tab', ['ctrl', 'tab']],
  ['previous tab', ['ctrl', 'shift', 'tab']], ['new line', ['enter']], ['new window', ['ctrl', 'n']],
  ['address bar', ['ctrl', 'l']], ['full screen', ['f11']], ['fullscreen', ['f11']],
];

module.exports = { keyFromWord, parseChord, labelFor, SHORTCUTS, MODIFIERS, NAMED };
