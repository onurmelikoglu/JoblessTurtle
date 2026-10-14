import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const template = await readFile(`${root}brand/turtle.svg.tpl`, 'utf8');
const turtle = (colors) => template.replace(/{{(\w+)}}/g, (_, key) => colors[key]);

const onLight = { LIMB: '#35A876', EYE: '#07241B', SHELL: '#136243', FLAP: '#D3F0E0' };
const onBrand = { LIMB: '#8AD8B1', EYE: '#0E5138', SHELL: '#FFFFFF', FLAP: '#0E5138' };
const BRAND = '#0E5138';

const svg = (inner, size = 64) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${inner}</svg>\n`;
const mark = svg(turtle(onLight));
const appIcon = svg(`<rect width="64" height="64" rx="14" fill="${BRAND}"/><g transform="translate(8.6 8.2) scale(0.73)">${turtle(onBrand)}</g>`);
const maskable = svg(`<rect width="64" height="64" fill="${BRAND}"/><g transform="translate(13.4 13) scale(0.58)">${turtle(onBrand)}</g>`);

await mkdir(`${root}public/icons`, { recursive: true });
await writeFile(`${root}public/favicon.svg`, appIcon);
await writeFile(`${root}src/brand/turtle-mark.svg`, mark);

const png = (source, size, file) => sharp(Buffer.from(source), { density: 72 * (size / 64) * 4 }).resize(size, size).png().toFile(`${root}public/${file}`);
await Promise.all([
  png(appIcon, 32, 'favicon-32.png'),
  png(appIcon, 180, 'apple-touch-icon.png'),
  png(appIcon, 192, 'icons/icon-192.png'),
  png(appIcon, 512, 'icons/icon-512.png'),
  png(maskable, 192, 'icons/icon-maskable-192.png'),
  png(maskable, 512, 'icons/icon-maskable-512.png'),
]);
console.log('Marka dosyaları üretildi');
