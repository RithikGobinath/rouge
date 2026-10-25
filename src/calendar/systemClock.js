'use strict';
const { execFile } = require('node:child_process');

/** One metadata query per reminder; no capture, input, model or resident helper. */
async function systemClockRect({ platform = process.platform, helper, sidecar, display, overlayBounds, physicalToDip, run = execFile }) {
  let rect;
  if (platform === 'darwin') {
    rect = await new Promise((resolve) => run(helper, [], { timeout: 1500, maxBuffer: 1024 }, (error, stdout) => {
      try { resolve(error ? null : JSON.parse(stdout)); } catch (_) { resolve(null); }
    }));
  } else if (platform === 'win32' && sidecar.available) {
    const result = await sidecar.clock().catch(() => null);
    if (result && result.rect) {
      const r = result.rect;
      const from = physicalToDip({ x: r.x, y: r.y });
      const to = physicalToDip({ x: r.x + r.w, y: r.y + r.h });
      rect = { x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y };
    }
  }
  if (!rect || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(rect[k])) || rect.w <= 0 || rect.h <= 0) return null;
  const { x, y, width, height } = display;
  if (rect.x < x || rect.y < y || rect.x + rect.w > x + width + 1 || rect.y + rect.h > y + height + 1) return null;
  return { x: rect.x - overlayBounds.x, y: rect.y - overlayBounds.y, w: rect.w, h: rect.h };
}

module.exports = { systemClockRect };
