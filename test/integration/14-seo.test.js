'use strict';
// Technical SEO: every public page has a self canonical, hreflang fa/en/x-default, Open Graph, valid JSON-LD;
// private, search and error pages are noindex; English-less content is Persian-only; the sitemap lists both
// languages with alternates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const attr = (html, re) => (html.match(re) || [])[1];
const canonical = h => attr(h, /<link rel="canonical" href="([^"]+)"/);
const hreflang = (h, l) => attr(h, new RegExp(`<link rel="alternate" hreflang="${l}" href="([^"]+)"`));
const jsonld = h => { const m = h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/); return m ? JSON.parse(m[1]) : null; };
const types = ld => ld['@graph'].map(n => n['@type']);

test('technical SEO', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await pool.query(`INSERT INTO products (slug,title,product_type,category,short_description,description,price_toman,status,title_en,short_description_en,description_en)
    VALUES ('seo-plugin','QA-TEST افزونه','plugin','اتوکد','توضیح کوتاه فارسی','متن فارسی',250000,'published','QA-TEST Plugin','Short English summary','English body'),
           ('seo-fa-only','QA-TEST فقط فارسی','course','دوره','فقط فارسی','متن',0,'published','','','')`);
  await pool.query(`INSERT INTO articles (slug,title,excerpt,content,status,published_at) VALUES ('seo-article','QA-TEST مقاله','خلاصه مقاله','متن مقاله','published',now())`);
  const srv = await startApp({ pool, env: { APP_URL: 'https://novingity.ir' } });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const c = new Client(srv.base);

  await t.test('public pages: self canonical, full hreflang set, OG, parsable JSON-LD with Organization', async () => {
    for (const path of ['/', '/tools', '/shop', '/articles', '/library', '/about']) {
      const h = (await c.get(path)).text;
      const expected = `https://novingity.ir${path}`;
      assert.equal(canonical(h), expected, path);
      assert.equal(hreflang(h, 'fa'), expected, path);
      assert.equal(hreflang(h, 'en'), `${expected}?lang=en`, path);
      assert.equal(hreflang(h, 'x-default'), expected, path);
      assert.match(h, /<meta property="og:image" content="https:\/\/novingity\.ir\/public\/images\/og-default\.png">/);
      assert.ok(types(jsonld(h)).includes('Organization'), path);
      assert.doesNotMatch(h, /name="robots" content="noindex/);
      assert.equal((h.match(/<h1[\s>]/g) || []).length, 1, `${path} has exactly one h1`);
    }
  });

  await t.test('English URL is self-canonical, lang="en", English title', async () => {
    const h = (await c.get('/tools?lang=en')).text;
    assert.match(h, /<html lang="en" dir="ltr"/);
    assert.equal(canonical(h), 'https://novingity.ir/tools?lang=en');
    assert.match(h, /<title>Building services calculators/);
    assert.match(h, /og:locale" content="en_US"/);
  });

  await t.test('titles and descriptions are unique across key pages', async () => {
    const pages = await Promise.all(['/', '/tools', '/shop', '/articles', '/library', '/about'].map(p => c.get(p)));
    const titles = pages.map(p => attr(p.text, /<title>([^<]+)<\/title>/));
    const descs = pages.map(p => attr(p.text, /<meta name="description" content="([^"]+)"/));
    assert.equal(new Set(titles).size, titles.length, titles.join(' / '));
    assert.equal(new Set(descs).size, descs.length);
  });

  await t.test('product and article pages carry Product / BlogPosting + BreadcrumbList', async () => {
    const p = (await c.get('/shop/seo-plugin')).text;
    const ld = jsonld(p);
    assert.deepEqual(types(ld).sort(), ['BreadcrumbList', 'Organization', 'Product']);
    const product = ld['@graph'].find(n => n['@type'] === 'Product');
    assert.equal(product.offers.priceCurrency, 'IRR');
    assert.equal(product.offers.price, '2500000', 'toman × 10, Latin digits');
    assert.match(p, /<meta name="description" content="توضیح کوتاه فارسی">/);
    const a = (await c.get('/articles/seo-article')).text;
    const art = jsonld(a)['@graph'].find(n => n['@type'] === 'BlogPosting');
    assert.match(art.datePublished, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(a, /og:type" content="article"/);
  });

  await t.test('content without an English version is Persian-only', async () => {
    const h = (await c.get('/shop/seo-fa-only?lang=en')).text;
    assert.equal(canonical(h), 'https://novingity.ir/shop/seo-fa-only');
    assert.equal(hreflang(h, 'en'), undefined);
    const map = (await c.get('/sitemap.xml')).text;
    assert.match(map, /<loc>https:\/\/novingity\.ir\/shop\/seo-plugin\?lang=en<\/loc>/);
    assert.doesNotMatch(map, /seo-fa-only\?lang=en/);
    assert.match(map, /<loc>https:\/\/novingity\.ir\/library<\/loc>/);
    assert.match(map, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  });

  await t.test('login, search results and error pages are noindex without canonical', async () => {
    for (const path of ['/login', '/shop?q=gas', '/no-such-page', '/shop/no-such-product']) {
      const h = (await c.get(path)).text;
      assert.match(h, /<meta name="robots" content="noindex, follow">/, path);
      assert.equal(canonical(h), undefined, path);
    }
    const filtered = (await c.get('/shop?type=course')).text;
    assert.equal(canonical(filtered), 'https://novingity.ir/shop', 'filters canonicalise to the listing');
  });
});
