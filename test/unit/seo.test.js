'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const seo = require('../../src/lib/seo');

test('locale URLs keep only ?page and add ?lang=en for English', () => {
  assert.equal(seo.localeUrl('https://x.ir', '/shop', 'fa', { q: 'a', type: 'course', page: '2' }), 'https://x.ir/shop?page=2');
  assert.equal(seo.localeUrl('https://x.ir', '/shop', 'en', { page: '1' }), 'https://x.ir/shop?lang=en');
});

test('private paths and search results are noindex', () => {
  assert.equal(seo.seoFor({ appUrl: 'https://x.ir', path: '/account/tickets', query: {}, locale: 'fa' }).noindex, true);
  assert.equal(seo.seoFor({ appUrl: 'https://x.ir', path: '/shop', query: { q: 'x' }, locale: 'fa' }).noindex, true);
  assert.equal(seo.seoFor({ appUrl: 'https://x.ir', path: '/shop', query: { type: 'course' }, locale: 'fa' }).noindex, false);
});

test('JSON-LD cannot break out of its script tag and drops undefined fields', () => {
  const out = seo.jsonLd([{ '@type': 'Thing', name: '</script><script>alert(1)</script>', x: undefined }]);
  assert.doesNotMatch(out, /<\/script>/);
  assert.doesNotMatch(out, /"x"/);
  assert.equal(JSON.parse(out)['@graph'][0].name, '</script><script>alert(1)</script>');
});

test('product offer is in IRR with Latin digits', () => {
  const p = seo.productLd({ appUrl: 'https://x.ir', canonical: 'https://x.ir/shop/a', product: { id: 7, price_toman: 125000 }, title: 'T', description: '<b>d</b>' });
  assert.equal(p.offers.price, '1250000');
  assert.equal(p.description, 'd');
});
