# File shelf

Rouge can hold a file for you while you switch tabs or apps, then hand it back when you drag it out. For example: drag a `.m` file onto the ribbon, switch to MATLAB Online, then drag the file from Rouge into its file area.

## How it works

- Drag a file from Explorer, or from a browser's download list, over the ribbon. The ribbon lights up. Let go and Rouge shows the file beside the ribbon the way Windows shows it under the pointer, with its own icon over its name (up to five, newest first).
- Switch tabs or apps. The chips stay on top.
- Drag a chip onto the page or app that needs the file. The chip goes as the drag starts. Windows does not tell Rouge whether a drop worked, so if one fails, drag the file in again. The × lets go of a chip without dragging it.

Rouge also puts a file on the shelf itself in one case: the smaller copy it makes of a PDF a site refused for size (see `AUTOMATIC_PDF_CAPTURE.md`). Drag that chip onto the site's upload area like any other held file.

## What Rouge does and does not do

- Nothing is watched: no folders, no downloads. It only acts on a file you drop on the ribbon.
- Only the file's name, size and icon are shown. The path stays in the app, and the file is never opened, read, copied or uploaded by Rouge. Dragging out hands the file to the other app the way dragging it from Explorer would.
- Chips live in memory only. They are gone when Rouge quits, and a file deleted or moved in the meantime is dropped with a notice.
- Folders, and things dragged out of a web page (images, links), are refused with a notice.

## How it is built

- The ribbon (`#mark-dock`, or `#strip-slot` in strip mode) is an HTML5 drop target. The preload turns a dropped `File` into a path with `webUtils.getPathForFile` and sends only that path to the main process.
- `src/shelf.js` keeps the held files. `webContents.startDrag` starts the drag out, with the file's own icon.
- The overlay is click-through except over its own UI, so the ribbon takes the mouse while a drag hovers over it, the same way it does for a click.

## To check on Windows

- That the drag reaches the overlay while it switches from click-through to hit-testable as the pointer arrives at the ribbon. If it does not, the fallback is a small dedicated drop window under the ribbon.
- Dropping a held file into a browser page (MATLAB Online's file area, a form's upload zone).
