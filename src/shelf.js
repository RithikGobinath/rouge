'use strict';
// Holds files you drop on the ribbon while you switch tabs or apps, so you can drag them
// out of Rouge onto whatever needs them: a MATLAB Online upload, a form, a chat. Only the
// name and size reach the overlay. The path stays here, and the file is never opened, read
// or sent anywhere: dragging hands it to the other app the way dragging it from Explorer would.

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 5;

/**
 * @param {{send:(items:{id:number,name:string,size:number}[])=>void, drag:(sender:any, file:string, icon:any)=>void,
 *          iconFor?:(file:string)=>Promise<any>, notice?:(text:string)=>void, log?:Function,
 *          stat?:Function, exists?:(file:string)=>boolean}} deps
 */
function createShelf(deps) {
  const log = deps.log || (() => {});
  const tell = deps.notice || (() => {});
  const stat = deps.stat || fs.promises.stat;
  const exists = deps.exists || fs.existsSync;
  let items = [];
  let seq = 0;

  // The overlay gets what it needs to draw the file as the drag would: its name, size and icon, never its path.
  const publish = () => deps.send(items.map(({ id, name, size, icon }) => ({ id, name, size, icon: icon && typeof icon.toDataURL === 'function' ? icon.toDataURL() : '' })));

  /** Hold the file at this path, as handed over by a drop on the ribbon. True if it is held now. */
  async function hold(file) {
    if (typeof file !== 'string' || file.length > 1000 || !path.isAbsolute(file)) { tell('Rouge can only hold files from this PC.'); return false; }
    if (items.some((i) => i.file === file)) return true;
    let info;
    try { info = await stat(file); } catch (_) { info = null; }
    if (!info || !info.isFile() || info.size === 0) { tell('Rouge can only hold files from this PC.'); return false; }
    let icon = null;
    try { icon = deps.iconFor ? await deps.iconFor(file) : null; } catch (_) { /* the drag falls back to the app's icon */ }
    if (items.some((i) => i.file === file)) return true;
    // Names come from the file system, but control and direction-switching characters could still disguise one.
    const name = path.basename(file).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 120) || 'file';
    items = [{ id: ++seq, file, name, size: info.size, icon }, ...items].slice(0, MAX_ITEMS);
    log('shelf: holding a file');
    publish();
    return true;
  }

  function remove(id) {
    const keep = items.filter((i) => i.id !== id);
    if (keep.length !== items.length) { items = keep; publish(); }
  }

  /** Start dragging a held file out of the window that asked. The chip goes with it. False if it is not held, or the file has gone. */
  function drag(sender, id) {
    const item = items.find((i) => i.id === id);
    if (!item) return false;
    if (!exists(item.file)) { remove(id); tell('That file is gone.'); return false; }
    deps.drag(sender, item.file, item.icon);
    // Windows does not say whether the drop worked, so a failed one means dragging the file in again.
    remove(id);
    return true;
  }

  return { hold, drag, remove };
}

module.exports = { createShelf, MAX_ITEMS };
