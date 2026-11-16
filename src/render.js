// Step each scene through headless Chrome frame by frame and pipe JPEG frames
// into ffmpeg -> H.264 1080x1920 MP4.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { W, H } from './scenes.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export async function renderVideo(scenes, out, { fps = 30, onlyFrames = null } = {}) {
  const executablePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!executablePath) throw new Error('No Chrome found. Set CHROME_PATH.');
  const browser = await puppeteer.launch({
    executablePath, headless: true,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { window.__driven = true; });

  // Snapshot mode: just grab PNGs at given (scene, t) points.
  if (onlyFrames) {
    for (const [i, t, file] of onlyFrames) {
      await load(page, scenes[i].file);
      await page.evaluate(x => window.__scene.seek(x), t);
      await page.screenshot({ path: file, type: 'png' });
    }
    await browser.close();
    return;
  }

  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-crf', '18', '-preset', 'medium', '-r', String(fps),
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
  const write = buf => new Promise(res => (ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res)));

  const totalFrames = scenes.reduce((s, x) => s + Math.round(x.duration * fps), 0);
  let n = 0;
  const started = Date.now();
  for (const scene of scenes) {
    await load(page, scene.file);
    const frames = Math.round(scene.duration * fps);
    for (let f = 0; f < frames; f++) {
      await page.evaluate(x => window.__scene.seek(x), f / fps);
      await write(await page.screenshot({ type: 'jpeg', quality: 92, optimizeForSpeed: true }));
      if (++n % 30 === 0 || n === totalFrames) {
        if (process.stderr.isTTY || n === totalFrames) process.stderr.write(`\rrendering ${n}/${totalFrames} frames (${Math.round((Date.now() - started) / 1000)}s)`);
      }
    }
  }
  process.stderr.write('\n');
  ff.stdin.end();
  await done;
  await browser.close();
}

async function load(page, file) {
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
}
