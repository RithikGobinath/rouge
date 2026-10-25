'use strict';
const { execFile } = require('node:child_process');

/** One bounded metadata query; the reminder may retry once, without capture or input. */
async function systemClockRect({ platform = process.platform, helper, sidecar, display, workArea, overlayBounds, physicalToDip, run = execFile, log = () => {} }) {
  const fail = (code) => { log(`system clock: ${code}`); return null; };
  const valid = (r) => r && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k])) && r.w > 0 && r.h > 0;
  let rect;
  if (platform === 'darwin') {
    const args = [display.x, display.y, display.width, display.height, workArea ? workArea.y - display.y : 0].map(String);
    rect = await new Promise((resolve) => run(helper, args, { timeout: 1500, maxBuffer: 1024 }, (error, stdout) => {
      try { resolve(error ? null : JSON.parse(stdout)); } catch (_) { resolve(null); }
    }));
  } else if (platform === 'win32') {
    if (!sidecar?.available) return fail('helper_unavailable');
    let result;
    try { result = await sidecar.clock(); }
    catch (error) { return fail(/timed out/i.test(error.message) ? 'lookup_timeout' : 'lookup_failed'); }
    if (result && result.rect) {
      const r = result.rect;
      if (!valid(r)) return fail('invalid_native_bounds');
      try {
        const from = physicalToDip({ x: r.x, y: r.y });
        const to = physicalToDip({ x: r.x + r.w, y: r.y + r.h });
        rect = { x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y };
      } catch (_) { return fail('coordinate_conversion_failed'); }
    } else return fail(['taskbar_missing', 'clock_not_found', 'ambiguous_clock'].includes(result?.status) ? result.status : 'clock_not_found');
  }
  if (!valid(rect)) return fail('invalid_bounds');
  const { x, y, width, height } = display;
  if (rect.x < x || rect.y < y || rect.x + rect.w > x + width + 1 || rect.y + rect.h > y + height + 1) return fail('outside_primary_display');
  log('system clock: ready');
  return { x: rect.x - overlayBounds.x, y: rect.y - overlayBounds.y, w: rect.w, h: rect.h };
}

module.exports = { systemClockRect };
