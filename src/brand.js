'use strict';
// The product's name, in one place: the window titles, the tray, the data
// folder and the Windows app id all come from here. (The three HTML pages and
// package.json carry the name as well; they are static files.)

module.exports = Object.freeze({
  name: 'Clippy',
  appId: 'local.clippy.app',
  dataDir: 'Clippy',
});
