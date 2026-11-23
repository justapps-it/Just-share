// End-to-end tests against a deployed JustShare (default: share.justapps.it).
//  1. Two browsers on the same network find each other and transfer files/text
//  2. Pairing with a 6-digit code
//  3. Offline camera mode: QR stream recorded from one browser is played to
//     another one as a fake camera, which must rebuild the file.
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const URL = process.env.E2E_URL || 'https://share.justapps.it/';
const dir = mkdtempSync(join(tmpdir(), 'justshare-e2e-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed++;
};

const browser = await chromium.launch();
const open = async (name) => {
  const ctx = await browser.newContext({ locale: 'en-US', acceptDownloads: true, viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  await page.goto(URL);
  // Give each device a recognizable name.
  await page.click('.me-name');
  await page.fill('.name-input', name);
  await page.press('.name-input', 'Enter');
  return page;
};

// ---- 1. pairing + transfers ----------------------------------------------------
// (Same-network discovery groups devices by public IP; CI/cloud runners
// usually leave through several IPs, so devices are paired with a code here.)
const a = await open('Alice');
const b = await open('Bob');
await a.click('button:has-text("Show my code")');
const code = (await a.textContent('.code')).replace(/\s/g, '');
await b.click('button:has-text("Enter a code")');
await b.fill('.code-input', code);
await b.click('button:has-text("Connect")');
await a.waitForSelector('.device:has-text("Bob")', { timeout: 20000 });
await b.waitForSelector('.device:has-text("Alice")', { timeout: 20000 });
check(true, `devices paired with code ${code}`);

const big = randomBytes(5 * 1024 * 1024);
const bigPath = join(dir, 'photo.bin');
writeFileSync(bigPath, big);
await a.click('.device:has-text("Bob")');
const t0 = Date.now();
await a.setInputFiles('.sheet input[type=file]:not([webkitdirectory])', bigPath);
await b.waitForSelector('.incoming', { timeout: 30000 });
const sasB = (await b.textContent('.sas b'))?.trim();
const sasA = (await a.textContent('.transfer .sas-inline'))?.match(/(\d{3} \d{3})/)?.[1];
check(sasA && sasA === sasB, `same verification code on both screens (${sasA} / ${sasB})`);
await b.click('.incoming button:has-text("Accept")');
await b.waitForSelector('.transfer.done', { timeout: 120000 });
const secs = (Date.now() - t0) / 1000;
const route = await b.textContent('.transfer');
const [dl] = await Promise.all([b.waitForEvent('download'), b.click('.transfer .received button:has-text("Save")')]);
const got = readFileSync(await dl.path());
check(sha(got) === sha(big), `5 MB file received intact in ${secs.toFixed(1)} s (${route.match(/direct[^·]*|encrypted relay/)?.[0] ?? '?'})`);
check(/verified/.test(route), 'BLAKE2b checksum verified');
await a.waitForSelector('.transfer.done', { timeout: 20000 });

// Text
await a.click('.device:has-text("Bob")');
await a.fill('.sheet textarea', 'wifi password: correct horse battery staple');
await a.click('.sheet button:has-text("Send text")');
await b.waitForSelector('.incoming', { timeout: 20000 });
await b.click('.incoming button:has-text("Accept")');
await b.waitForSelector('.textbox pre:has-text("correct horse")', { timeout: 20000 });
check(true, 'text received');

// ---- 3. offline camera mode ----------------------------------------------------------
const doc = randomBytes(12 * 1024); // e.g. a small document
const docPath = join(dir, 'contract.pdf');
writeFileSync(docPath, doc);
await a.click('button:has-text("Send with QR codes")');
await a.setInputFiles('.qr-card input[type=file]', docPath);
await a.click('button:has-text("Show QR codes")');
await a.waitForSelector('.qr-stage canvas');
// Record the QR stream as an MJPEG "camera" video.
const frames = [];
let last = -1;
while (frames.length < 70) {
  const f = await a.evaluate(() => {
    const cv = document.querySelector('.qr-stage canvas');
    const frame = document.querySelector('.qr-card .mono')?.textContent;
    // Put the QR on a camera-like 1280x720 frame with some margin.
    const out = document.createElement('canvas');
    out.width = 1280;
    out.height = 720;
    const g = out.getContext('2d');
    g.fillStyle = '#777';
    g.fillRect(0, 0, 1280, 720);
    const s = 640;
    g.drawImage(cv, (1280 - s) / 2, (720 - s) / 2, s, s);
    return { frame, jpg: out.toDataURL('image/jpeg', 0.9) };
  });
  const n = Number(f.frame?.match(/frame (\d+)/)?.[1] ?? -1);
  if (n !== last) {
    frames.push(Buffer.from(f.jpg.split(',')[1], 'base64'));
    last = n;
  }
  await a.waitForTimeout(30);
}
const mjpeg = join(dir, 'camera.mjpeg');
writeFileSync(mjpeg, Buffer.concat(frames));
const camBrowser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${mjpeg}`],
});
const camCtx = await camBrowser.newContext({ locale: 'en-US', acceptDownloads: true, permissions: ['camera'] });
const r = await camCtx.newPage();
await r.goto(URL);
await r.click('button:has-text("Receive with camera")');
const q0 = Date.now();
await r.waitForSelector('.qr-card .ok', { timeout: 90000 }).catch(async () => {
  console.log('progress at timeout:', await r.textContent('.qr-card .mono').catch(() => '?'));
});
const okText = await r.textContent('.qr-card .ok').catch(() => '');
check(/verified/.test(okText), `offline QR transfer: ${frames.length} distinct frames recorded, decoded in ${((Date.now() - q0) / 1000).toFixed(1)} s`);
if (/verified/.test(okText)) {
  const [d2] = await Promise.all([r.waitForEvent('download'), r.click('.qr-card .received button:has-text("Save")')]);
  check(sha(readFileSync(await d2.path())) === sha(doc), 'offline file identical');
}

// Mobile layout
const m = await browser.newPage({ viewport: { width: 375, height: 800 } });
await m.goto(URL);
check(!(await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no horizontal scroll on mobile');
if (process.env.SHOTS) {
  await a.screenshot({ path: `${process.env.SHOTS}/share-a.png`, fullPage: true });
  await b.screenshot({ path: `${process.env.SHOTS}/share-b.png`, fullPage: true });
  await m.screenshot({ path: `${process.env.SHOTS}/share-mobile.png`, fullPage: true });
}

await camBrowser.close();
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
