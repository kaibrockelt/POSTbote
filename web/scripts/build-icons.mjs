// Renders all app icons from desktop/icons/src/glyph.svg into desktop/icons.
//   cd web && npm run icons        (macOS: iconutil is needed for icon.icns)
// macOS icons follow Apple's grid: the tile is 824/1024 with transparent margin;
// Windows/Linux/favicon use a full-bleed rounded tile.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../desktop/icons');
const glyph = readFileSync(join(dir, 'src/glyph.svg'), 'utf8').replace(/<!--.*?-->/s, '');
const BLUE = '#1169f7';
// the glyph is drawn on a tile at 125…1130 (1005 units) with corner radius 250
const TILE = 1005;
const place = (x, size) => `translate(${x} ${x}) scale(${size / TILE}) translate(-125 -125)`;

const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="${(250 * 1024) / TILE}" fill="${BLUE}"/>
  <g transform="${place(0, 1024)}">${glyph}</g></svg>`;

const macos = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
      <feOffset dy="12"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="${(250 * 824) / TILE}" fill="${BLUE}" filter="url(#shadow)"/>
  <g transform="${place(100, 824)}">${glyph}</g>
</svg>`;

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

const out = (name, data) => writeFileSync(join(dir, name), data);
writeFileSync(join(dir, '../../web/public/favicon.svg'), fullBleed + '\n');

// macOS (.icns + icon.png used by the dock in dev builds) and Linux pngs
out('icon.png', png(macos, 1024));
out('32x32.png', png(fullBleed, 32));
out('128x128.png', png(macos, 128));
out('128x128@2x.png', png(macos, 256));

try {
  const set = join(dir, 'icon.iconset');
  mkdirSync(set, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${s}x${s}.png`), png(macos, s));
    writeFileSync(join(set, `icon_${s}x${s}@2x.png`), png(macos, s * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(dir, 'icon.icns')]);
  rmSync(set, { recursive: true });
} catch (e) {
  console.warn('icon.icns not updated (iconutil is only available on macOS):', e.message);
}

// Windows .ico with PNG-encoded entries (16–256 px), full-bleed tile
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(fullBleed, s));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s === 256 ? 0 : s, e);
  header.writeUInt8(s === 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
out('icon.ico', Buffer.concat([header, ...images]));
console.log('icons written to', dir);
