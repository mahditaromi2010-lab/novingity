'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
// 2×1 PNG (real IHDR so the size reader sees the dimensions).
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e85d0000000c4944415408d763f8cfc0f01f0005fe02fe0a2b3d6c0000000049454e44ae426082', 'hex');

test('banners and replaceable site images: admin manages them, visitors see them, links stay safe', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'content_vis', PW, 'content');
  await createAdmin(pool, 'orders_vis', PW, 'orders');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const admin = new Client(srv.base);
  assert.equal((await admin.adminLogin('content_vis', PW)).status, 302);
  const multipart = async (url, fields, files = {}, from = url) => {
    const fd = new FormData();
    fd.set('_csrf', await admin.csrf(from));
    for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach(x => fd.append(k, x));
    for (const [k, [buf, name, type]] of Object.entries(files)) fd.set(k, new Blob([buf], { type }), name);
    return admin.request('POST', url, { multipart: fd });
  };
  const visitor = new Client(srv.base);

  let bannerId;
  await t.test('a course promo banner with picture and a button is created and shows on the shop page only when published', async () => {
    const r = await multipart('/admin/visual/banners', {
      name: 'تبلیغ دوره', slot: 'shop.top', status: 'draft', priority: '5', audience: 'all', locale_mode: 'all',
      layer_kind: ['title', 'button'], layer_text: ['دورهٔ طراحی لوله‌کشی گاز', 'ثبت‌نام در دوره'], layer_text_en: ['', ''],
      layer_size: ['lg', 'md'], layer_hide_mobile: ['0', '0'], layer_href: ['', '/shop?type=course'], layer_style: ['primary', 'light'], layer_new_tab: ['0', '0']
    }, { desktop_file: [PNG, 'promo.png', 'image/png'] }, '/admin/visual/banners/new');
    assert.equal(r.status, 302, r.text.slice(0, 300));
    const b = (await pool.query('SELECT * FROM banners')).rows[0];
    bannerId = b.id;
    assert.equal(b.slot, 'shop.top');
    assert.equal(b.layers.length, 2);
    const m = (await pool.query('SELECT * FROM media_images WHERE id=$1', [b.desktop_media_id])).rows[0];
    assert.equal(m.width, 2); assert.equal(m.height, 1);
    assert.ok(fs.existsSync(path.join(srv.uploadDir, 'covers', path.basename(m.path))));
    assert.doesNotMatch((await visitor.get('/shop')).text, /دورهٔ طراحی لوله‌کشی گاز/, 'draft is not shown');
    const pub = await admin.postWithCsrf(`/admin/visual/banners/${bannerId}/status`, { status: 'published' }, '/admin/visual/banners');
    assert.equal(pub.status, 302);
    const shop = await visitor.get('/shop');
    assert.match(shop.text, /دورهٔ طراحی لوله‌کشی گاز/);
    assert.match(shop.text, new RegExp(`href="/go/banner/${bannerId}/0"`));
    assert.match(shop.text, /width="2" height="1"/, 'image dimensions are rendered');
    assert.doesNotMatch((await visitor.get('/')).text, /دورهٔ طراحی لوله‌کشی گاز/, 'other slots stay empty');
  });

  await t.test('the button redirect counts the click and only goes to the saved link', async () => {
    const r = await visitor.get(`/go/banner/${bannerId}/0`);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/shop?type=course');
    assert.equal((await pool.query('SELECT clicks FROM banners WHERE id=$1', [bannerId])).rows[0].clicks, 1);
    assert.equal((await visitor.get(`/go/banner/${bannerId}/9`)).location, '/', 'unknown button goes home');
  });

  await t.test('unsafe links are refused and the form keeps what the admin typed', async () => {
    const r = await multipart('/admin/visual/banners', {
      name: 'بد', slot: 'home.top', layer_kind: ['title', 'button'], layer_text: ['متن تایپ‌شده', 'کلیک'], layer_text_en: ['', ''], layer_size: ['md', 'md'], layer_hide_mobile: ['0', '0'],
      layer_href: ['', 'javascript:alert(1)'], layer_style: ['primary', 'primary'], layer_new_tab: ['0', '0']
    }, {}, '/admin/visual/banners/new');
    assert.equal(r.status, 422);
    assert.match(r.text, /متن تایپ‌شده/);
    for (const href of ['//evil.example', 'data:text/html,x', 'http://plain.example']) {
      const x = await multipart('/admin/visual/banners', { name: 'x', slot: 'home.top', layer_kind: 'button', layer_text: 'b', layer_href: href }, {}, '/admin/visual/banners/new');
      assert.equal(x.status, 422, href);
    }
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM banners')).rows[0].n, 1);
  });

  await t.test('schedule, audience and language rules decide who sees a banner', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await pool.query(`INSERT INTO banners(name,slot,status,starts_at,layers) VALUES('later','home.top','published',$1,'[{"kind":"title","text":"بعدا"}]')`, [future]);
    await pool.query(`INSERT INTO banners(name,slot,status,audience,layers) VALUES('members','home.middle','published','members','[{"kind":"title","text":"فقط اعضا"}]')`);
    await pool.query(`INSERT INTO banners(name,slot,status,locale_mode,layers) VALUES('en','home.bottom','published','en','[{"kind":"title","text":"English only","text_en":"English only"}]')`);
    await pool.query(`INSERT INTO banners(name,slot,status,layers) VALUES('xss','home.top','published','[{"kind":"title","text":"<script>alert(1)</script>"}]')`);
    const fresh = new Client(srv.base);
    // the cache is invalidated by admin actions; rows inserted directly need a status touch through the admin
    await admin.postWithCsrf(`/admin/visual/banners/${bannerId}/status`, { status: 'published' }, '/admin/visual/banners');
    const home = (await fresh.get('/')).text;
    assert.doesNotMatch(home, /بعدا/, 'future banner hidden');
    assert.doesNotMatch(home, /فقط اعضا/, 'members-only hidden from guests');
    assert.doesNotMatch(home, /English only/, 'English-only hidden on Persian page');
    assert.match((await fresh.get('/?lang=en')).text, /English only/);
    assert.doesNotMatch(home, /<script>alert\(1\)<\/script>/, 'banner text is escaped');
    assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  await t.test('site images: the logo is replaced and reset; unknown keys are 404', async () => {
    const r = await multipart('/admin/visual/images/brand.logo', { alt: 'لوگو' }, { file: [PNG, 'logo.png', 'image/png'] }, '/admin/visual/images');
    assert.equal(r.status, 302);
    const page = (await visitor.get('/about')).text;
    const logo = (await pool.query("SELECT m.path FROM site_image_overrides o JOIN media_images m ON m.id=o.media_id WHERE o.slot_key='brand.logo'")).rows[0].path;
    assert.ok(page.includes(`src="${logo}"`), 'header shows the new logo');
    assert.equal((await multipart('/admin/visual/images/not.a.slot', {}, { file: [PNG, 'x.png', 'image/png'] }, '/admin/visual/images')).status, 404);
    await admin.postWithCsrf('/admin/visual/images/brand.logo/reset', {}, '/admin/visual/images');
    assert.match((await visitor.get('/about')).text, /nogiti-logo-96\.webp/);
  });

  await t.test('a page header picture and a default course cover appear where nothing else is set', async () => {
    await multipart('/admin/visual/images/shop.hero', {}, { file: [PNG, 'hero.png', 'image/png'] }, '/admin/visual/images');
    await pool.query("INSERT INTO products(title,slug,price_toman,product_type,status) VALUES('دوره بدون کاور','no-cover',100000,'course','published')");
    await multipart('/admin/visual/images/course.coverFallback', {}, { file: [PNG, 'cover.png', 'image/png'] }, '/admin/visual/images');
    const shop = (await visitor.get('/shop')).text;
    assert.match(shop, /class="page-hero-media"/);
    const cover = (await pool.query("SELECT m.path FROM site_image_overrides o JOIN media_images m ON m.id=o.media_id WHERE o.slot_key='course.coverFallback'")).rows[0].path;
    assert.ok(shop.includes(cover), 'fallback cover used for a course without one');
  });

  await t.test('media in use cannot be deleted; unused media can', async () => {
    const used = (await pool.query("SELECT media_id FROM site_image_overrides WHERE slot_key='shop.hero'")).rows[0].media_id;
    await admin.postWithCsrf(`/admin/visual/media/${used}/delete`, {}, '/admin/visual/media');
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM media_images WHERE id=$1', [used])).rows[0].n, 1);
    const up = await multipart('/admin/visual/media', { alt: 'آزاد' }, { files: [PNG, 'free.png', 'image/png'] }, '/admin/visual/media');
    assert.equal(up.status, 302);
    const free = (await pool.query("SELECT id,path FROM media_images WHERE alt='آزاد'")).rows[0];
    await admin.postWithCsrf(`/admin/visual/media/${free.id}/delete`, {}, '/admin/visual/media');
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM media_images WHERE id=$1', [free.id])).rows[0].n, 0);
    assert.ok(!fs.existsSync(path.join(srv.uploadDir, 'covers', path.basename(free.path))), 'file removed');
  });

  await t.test('an announcement bar shows above every public page', async () => {
    const r = await multipart('/admin/visual/banners', { name: 'اعلان', slot: 'site.announcement', status: 'published', layer_kind: ['title', 'button'], layer_text: ['ثبت‌نام دورهٔ جدید آغاز شد', 'مشاهده'], layer_href: ['', '/shop'], layer_style: ['primary', 'primary'] }, {}, '/admin/visual/banners/new');
    assert.equal(r.status, 302);
    assert.match((await visitor.get('/articles')).text, /class="nv-announce"[\s\S]*ثبت‌نام دورهٔ جدید آغاز شد/);
  });

  await t.test('roles without the content permission cannot reach the visual admin', async () => {
    const other = new Client(srv.base);
    assert.equal((await other.adminLogin('orders_vis', PW)).status, 302);
    assert.equal((await other.get('/admin/visual/banners')).status, 403);
    assert.equal((await other.get('/admin/visual/images')).status, 403);
    assert.equal((await visitor.get('/admin/visual/media')).status, 403);
  });
});
