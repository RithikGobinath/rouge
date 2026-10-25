'use strict';
// The image codec for PDF compression: the JPEG decoder, resizer and encoder that Chromium already ships
// inside Electron. Pixels are 8-bit BGRA, as Electron hands them out.

const { nativeImage } = require('electron');

/** @param {Buffer} jpeg  @returns {{ width:number, height:number, bgra:Buffer }|null} */
function decode(jpeg) {
  const img = nativeImage.createFromBuffer(jpeg);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  return { width, height, bgra: img.toBitmap() };
}

/**
 * Scale the picture down and store it as a JPEG.
 * @param {{ width:number, height:number, bgra:Buffer }} pixels
 * @param {{ scale:number, quality:number }} tier
 * @returns {{ jpeg:Buffer, width:number, height:number }}
 */
function encode({ width, height, bgra }, { scale, quality }) {
  let img = nativeImage.createFromBitmap(bgra, { width, height });
  if (scale < 1) {
    img = img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' });
  }
  const size = img.getSize();
  return { jpeg: img.toJPEG(quality), width: size.width, height: size.height };
}

module.exports = { decode, encode };
