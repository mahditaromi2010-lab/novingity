#!/usr/bin/env node
'use strict';
// Renders the share cards (1200×630 PNG) for the fixed public pages, in Persian and English.
// Run once after changing CARD_TEXT in src/lib/og-cards.js, then commit public/images/og/*.png:
//   node scripts/og/generate-cards.js
// Needs Playwright with Chromium (pre-installed in this workspace; otherwise: npx playwright install chromium).
const fs = require('node:fs');
const path = require('node:path');
const { CARD_TEXT, cardFile } = require('../../src/lib/og-cards');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'public', 'images', 'og');
const FONT = path.join(ROOT, 'public', 'fonts', 'Vazirmatn-Variable.woff2');
const LOGO = path.join(ROOT, 'public', 'images', 'nogiti-logo.webp');
// Embedded as data URIs: a page loaded with setContent cannot read file:// assets.
const dataUri = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cardHtml({ text, locale }) {
  const dir = locale === 'en' ? 'ltr' : 'rtl';
  const family = 'Vazirmatn, system-ui, sans-serif';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8">
<style>
  @font-face { font-family: Vazirmatn; src: url("${dataUri(FONT, 'font/woff2')}") format("woff2"); font-weight: 100 900; }
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body { font-family: ${family}; background: linear-gradient(135deg, #0f4d50 0%, #17696a 62%, #0f2b25 100%); color: #f8faf8; position: relative; }
  .frame { position: absolute; inset: 44px; border: 2px solid rgba(215,167,82,.55); border-radius: 28px; }
  .bar { position: absolute; top: 96px; ${dir === 'rtl' ? 'right' : 'left'}: 110px; width: 120px; height: 8px; background: #d7a752; border-radius: 4px; }
  .text { position: absolute; top: 150px; ${dir === 'rtl' ? 'right' : 'left'}: 110px; ${dir === 'rtl' ? 'left' : 'right'}: 110px; font-size: 76px; line-height: 1.35; font-weight: 800; text-align: ${dir === 'rtl' ? 'right' : 'left'}; }
  .brand { position: absolute; bottom: 92px; ${dir === 'rtl' ? 'right' : 'left'}: 110px; display: flex; align-items: center; gap: 22px; font-size: 40px; font-weight: 700; color: #d7a752; }
  .brand img { width: 84px; height: 84px; background: #f8faf8; border-radius: 18px; padding: 8px; box-sizing: border-box; }
  .host { position: absolute; bottom: 102px; ${dir === 'rtl' ? 'left' : 'right'}: 110px; font-size: 30px; color: rgba(248,250,248,.8); direction: ltr; }
</style></head><body>
  <div class="frame"></div><div class="bar"></div>
  <div class="text">${escapeHtml(text)}</div>
  <div class="brand"><img src="${dataUri(LOGO, 'image/webp')}" alt="">${locale === 'en' ? 'Novingity' : 'نوگیتی'}</div>
  <div class="host">novingity.ir${locale === 'en' ? '/?lang=en' : ''}</div>
</body></html>`;
}

async function main() {
  const { chromium } = require('playwright');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    for (const [key, texts] of Object.entries(CARD_TEXT)) {
      for (const locale of ['fa', 'en']) {
        await page.setContent(cardHtml({ text: texts[locale], locale }), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const out = path.join(ROOT, cardFile(key, locale));
        await page.screenshot({ path: out, type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1200, height: 630 } });
        console.log('wrote', path.relative(ROOT, out));
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
