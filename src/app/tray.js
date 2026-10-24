'use strict';
// The tray icon: how to get back to the settings window, and the few
// switches worth reaching without opening it.

const { Tray, Menu } = require('electron');
const brand = require('../brand');

/**
 * @param {{icon:any, tooltip:()=>string, settings:()=>any, on:{open:()=>void, quick:()=>void, set:(patch:object)=>void, pause:(paused:boolean)=>void, quit:()=>void}, paused:()=>boolean}} o
 */
function createTray(o) {
  const tray = new Tray(o.icon);
  tray.setToolTip(o.tooltip());

  function menu() {
    const s = o.settings();
    return Menu.buildFromTemplate([
      { label: `Open ${brand.name}`, click: o.on.open },
      { label: 'Type a command', click: o.on.quick, enabled: !o.paused() },
      { type: 'separator' },
      { label: 'Show the ribbon', type: 'checkbox', checked: !s.markHidden, enabled: !o.paused(), click: (i) => o.on.set({ markHidden: !i.checked }) },
      { label: 'Strip mode', type: 'checkbox', checked: s.strip, enabled: !o.paused(), click: (i) => o.on.set({ strip: i.checked }) },
      { type: 'separator' },
      { label: `${brand.name} is on`, type: 'checkbox', checked: !o.paused(), click: (i) => o.on.pause(!i.checked) },
      { label: 'Quit', click: o.on.quit },
    ]);
  }

  tray.on('click', o.on.open);
  tray.setContextMenu(menu());
  return { update() { tray.setToolTip(o.tooltip()); tray.setContextMenu(menu()); }, destroy() { tray.destroy(); }, tray };
}

module.exports = { createTray };
