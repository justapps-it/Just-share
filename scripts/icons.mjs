// Renders the PNG app icons from the SVGs (run once: node scripts/icons.mjs).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync } from 'node:fs';
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, size] of [
  ['public/icons/just-share.svg', 'public/icons/icon-32.png', 32],
  ['public/icons/just-share.svg', 'public/icons/icon-48.png', 48],
  ['public/icons/just-share.svg', 'public/icons/icon-180.png', 180],
  ['public/icons/just-share.svg', 'public/icons/icon-192.png', 192],
  ['public/icons/just-share.svg', 'public/icons/icon-512.png', 512],
  ['public/icons/just-share-maskable.svg', 'public/icons/icon-maskable-512.png', 512],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${readFileSync(src, 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
  await page.screenshot({ path: out, omitBackground: true });
}
await browser.close();
