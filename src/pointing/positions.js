'use strict';

const POSITIONS = {
  'top left': [0, 0], 'top center': [0.5, 0], 'top right': [1, 0],
  'center left': [0, 0.5], center: [0.5, 0.5], 'center right': [1, 0.5],
  'bottom left': [0, 1], 'bottom center': [0.5, 1], 'bottom right': [1, 1],
};

/** Screen positions use overlay CSS pixels, so no capture, DPI conversion or native helper is needed. */
function positionTarget(text, bounds) {
  let name = String(text || '').toLowerCase().trim().replace(/-/g, ' ').replace(/\s+/g, ' ')
    .replace(/^(?:please )?(?:(?:point|aim)(?: (?:the |your )?(?:wand|ribbon))? (?:to|at)|(?:move|send) (?:the |your )?(?:wand|ribbon) to|show me|highlight) /, '')
    .replace(/^the /, '').replace(/[.!?]+$/, '')
    .replace(/(?: (?:of|on) (?:the |my )?(?:screen|display))?(?: please)?$/, '')
    .replace(/ (?:corner|edge)$/, '')
    .replace(/\bupper\b/g, 'top').replace(/\blower\b/g, 'bottom').replace(/\bmiddle\b/g, 'center');
  if (name === 'left' || name === 'right') name = `center ${name}`;
  if (name === 'top' || name === 'bottom') name += ' center';
  const at = Object.hasOwn(POSITIONS, name) ? POSITIONS[name] : null;
  const { width, height } = bounds || {};
  if (!at || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const size = Math.min(40, width, height);
  const padX = Math.min(16, (width - size) / 2); const padY = Math.min(16, (height - size) / 2);
  return {
    label: name.charAt(0).toUpperCase() + name.slice(1),
    rect: { x: (bounds.x || 0) + padX + (width - size - 2 * padX) * at[0], y: (bounds.y || 0) + padY + (height - size - 2 * padY) * at[1], w: size, h: size },
  };
}

module.exports = { positionTarget };
