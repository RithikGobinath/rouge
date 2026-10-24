'use strict';
// Canonical key names (see voice/keys.js) -> Windows virtual-key codes.

const VK = {
  ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5B,
  enter: 0x0D, escape: 0x1B, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2E,
  home: 0x24, end: 0x23, insert: 0x2D, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  pageup: 0x21, pagedown: 0x22, printscreen: 0x2C, capslock: 0x14,
  '=': 0xBB, '-': 0xBD, '.': 0xBE, ',': 0xBC, '/': 0xBF, ';': 0xBA, "'": 0xDE, '[': 0xDB, ']': 0xDD, '\\': 0xDC, '`': 0xC0,
};

// The keys the media and volume actions press.
const MEDIA_VK = { play_pause: 0xB3, next: 0xB0, prev: 0xB1, mute: 0xAD, vol_down: 0xAE, vol_up: 0xAF };

/** @param {string} key a canonical key name @returns {number|null} */
function vkOf(key) {
  const k = String(key).toLowerCase();
  if (k in VK) return VK[k];
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(k);
  if (f) return 0x6F + Number(f[1]);
  return null;
}

/** @param {string[]} keys @returns {number[]} virtual-key codes, in press order */
function chordVks(keys) {
  const out = keys.map(vkOf);
  if (out.some((v) => v == null)) throw new Error(`unknown key in ${keys.join('+')}`);
  return out;
}

module.exports = { vkOf, chordVks, MEDIA_VK, VK };
