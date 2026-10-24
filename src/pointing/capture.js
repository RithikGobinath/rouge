'use strict';
// One screenshot of one display, cut down to what a model needs: a close-up
// of the spot. The overlay is kept out of the picture while it is taken, so
// the ribbon never photographs itself. Private field rectangles are blacked
// out before the crop is sent.

const { desktopCapturer, screen, nativeImage } = require('electron');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Take the display that holds a physical-pixel point.
 * @param {{x:number,y:number}} phys
 * @param {{win?: import('electron').BrowserWindow}} [o] the overlay window, hidden from the capture
 */
async function takeDisplay(phys, o = {}) {
  const dip = screen.screenToDipPoint(phys);
  const display = screen.getDisplayNearestPoint(dip);
  const scale = display.scaleFactor || 1;
  const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
  const w = Math.round(display.size.width * scale); const h = Math.round(display.size.height * scale);
  const win = o.win && !o.win.isDestroyed() ? o.win : null;
  if (win) win.setContentProtection(true);
  try {
    await new Promise((r) => setTimeout(r, 40));            // let the exclusion take effect before the grab
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) throw new Error('could not capture the screen');
    return { image: src.thumbnail, display, scale, origin, width: src.thumbnail.getSize().width, height: src.thumbnail.getSize().height };
  } finally { if (win) win.setContentProtection(false); }
}

/**
 * Black out physical-pixel rectangles on a capture (BGRA). Returns a new shot.
 * @param {object} shot
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 */
function maskRegions(shot, rects) {
  if (!shot || !shot.image || !Array.isArray(rects) || !rects.length) return shot;
  const size = shot.image.getSize();
  const buf = Buffer.from(shot.image.getBitmap());
  const stride = size.width * 4;
  for (const rect of rects) {
    if (!rect) continue;
    const x0 = clamp(Math.floor(rect.x - shot.origin.x), 0, size.width);
    const y0 = clamp(Math.floor(rect.y - shot.origin.y), 0, size.height);
    const x1 = clamp(Math.ceil(rect.x + rect.w - shot.origin.x), 0, size.width);
    const y1 = clamp(Math.ceil(rect.y + rect.h - shot.origin.y), 0, size.height);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = y * stride + x * 4;
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
      }
    }
  }
  return { ...shot, image: nativeImage.createFromBitmap(buf, { width: size.width, height: size.height }) };
}

/**
 * Crop around a physical-pixel rectangle: the rectangle plus some context,
 * never smaller than minW x minH, never larger than maxW x maxH, kept on screen.
 * @returns {{dataUrl:string, rect:{x:number,y:number,w:number,h:number}}} rect is in physical screen pixels
 */
function cropAround(shot, rect, { pad = 60, minW = 420, minH = 260, maxW = 1000, maxH = 640 } = {}) {
  const s = shot.scale;
  const cx = rect.x + rect.w / 2 - shot.origin.x; const cy = rect.y + rect.h / 2 - shot.origin.y;
  const w = clamp(rect.w + pad * 2 * s, minW * s, maxW * s); const h = clamp(rect.h + pad * 2 * s, minH * s, maxH * s);
  const x = clamp(Math.round(cx - w / 2), 0, Math.max(0, shot.width - w)); const y = clamp(Math.round(cy - h / 2), 0, Math.max(0, shot.height - h));
  const out = { x, y, width: Math.min(Math.round(w), shot.width - x), height: Math.min(Math.round(h), shot.height - y) };
  const img = shot.image.crop(out);
  return { dataUrl: `data:image/png;base64,${img.toPNG().toString('base64')}`, rect: { x: out.x + shot.origin.x, y: out.y + shot.origin.y, w: out.width, h: out.height } };
}

module.exports = { takeDisplay, cropAround, maskRegions };
