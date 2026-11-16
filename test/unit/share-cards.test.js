'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CARD_PAGES, CARD_TEXT, cardPath, cardExists } = require('../../src/lib/og-cards');
const { PERMISSIONS_POLICY } = require('../../src/lib/security-headers');
const { sizeFromBuffer } = require('../../src/lib/image-size');

const ROOT = path.join(__dirname, '..', '..');

test('every fixed public page has a share card in Persian and English', () => {
  assert.deepEqual(Object.keys(CARD_PAGES).sort(), ['/', '/about', '/articles', '/library', '/shop', '/support', '/tools']);
  for (const key of Object.values(CARD_PAGES)) {
    assert.ok(CARD_TEXT[key], `headline for ${key}`);
    assert.ok(CARD_TEXT[key].fa && CARD_TEXT[key].en, `both languages for ${key}`);
  }
});

test('card paths follow the page and language, and dynamic pages get no fixed card', () => {
  assert.equal(cardPath('/shop', 'en'), '/public/images/og/shop-en.jpg');
  assert.equal(cardPath('/', 'fa'), '/public/images/og/home-fa.jpg');
  assert.equal(cardPath('/shop/some-course', 'fa'), null, 'a course page uses its own cover');
  assert.equal(cardPath('/articles/some-article', 'en'), null);
  assert.equal(cardPath('/no-such-page', 'fa'), null);
});

test('every generated share card is on disk and exactly 1200×630', () => {
  for (const key of Object.values(CARD_PAGES)) {
    for (const locale of ['fa', 'en']) {
      const web = cardPath(Object.keys(CARD_PAGES).find(p => CARD_PAGES[p] === key), locale);
      assert.ok(cardExists(web), `missing ${web}`);
      const size = sizeFromBuffer(fs.readFileSync(path.join(ROOT, web)));
      assert.deepEqual({ w: size.width, h: size.height }, { w: 1200, h: 630 }, web);
    }
  }
});

test('Permissions-Policy turns off sensitive browser features', () => {
  for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'usb=()', 'payment=()']) {
    assert.match(PERMISSIONS_POLICY, new RegExp(feature.replace(/[()]/g, m => '\\' + m)), feature);
  }
});
