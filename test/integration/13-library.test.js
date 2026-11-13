'use strict';
// Regulations library: admins upload or link files; visitors browse, search and download; unpublished files stay
// hidden; content is sniffed (a renamed file is rejected); deleting removes the stored file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function upload(c, url, fields, file) {
  const token = await c.csrf(url.endsWith('/edit') ? url : '/admin/library/new');
  const fd = new FormData();
  fd.append('_csrf', token);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.data], { type: file.type }), file.name);
  return c.request('POST', url, { multipart: fd });
}

test('regulations library', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'qa_content', PW, 'content');
  await createAdmin(pool, 'qa_orders', PW, 'orders');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const admin = new Client(srv.base);
  await admin.adminLogin('qa_content', PW);

  await t.test('the two Mabhas 17 editions are seeded and listed publicly', async () => {
    const page = await new Client(srv.base).get('/library');
    assert.equal(page.status, 200);
    assert.match(page.text, /id="mabhas-17"/);
    assert.match(page.text, /ویرایش ۱۴۰۳/);
    assert.match(page.text, /ویرایش ۱۴۰۱/);
    assert.match(page.text, /href="\/library"/, 'site menu links to the library');
  });

  await t.test('only content admins manage the library', async () => {
    assert.equal((await new Client(srv.base).get('/admin/library')).status, 403);
    const orders = new Client(srv.base);
    await orders.adminLogin('qa_orders', PW);
    assert.equal((await orders.get('/admin/library')).status, 403);
    assert.equal((await admin.get('/admin/library')).status, 200);
  });

  let id;
  await t.test('admin uploads Mabhas 13 as a PDF; visitors can view and download it', async () => {
    const r = await upload(admin, '/admin/library', { title: 'QA-TEST مبحث سیزدهم', category: 'mabhas', mabhas_number: '۱۳', edition: 'ویرایش ۱۴۰۲', edition_year: '1402', is_published: 'on', is_current: 'on', sort_order: '0' }, { data: PDF, type: 'application/pdf', name: 'mabhas13.pdf' });
    assert.equal(r.status, 302);
    const row = (await pool.query("SELECT * FROM library_documents WHERE title='QA-TEST مبحث سیزدهم'")).rows[0];
    assert.ok(row && row.file_key && row.mabhas_number === 13 && row.file_type === 'pdf');
    id = row.id;
    const list = await new Client(srv.base).get('/library?q=' + encodeURIComponent('مبحث 13'));
    assert.match(list.text, /id="mabhas-13"/);
    assert.doesNotMatch(list.text, /id="mabhas-17"/, 'search filters');
    const view = await fetch(`${srv.base}/library/${id}/file`);
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('content-type'), 'application/pdf');
    assert.match(view.headers.get('content-disposition'), /^inline/);
    assert.ok(Buffer.from(await view.arrayBuffer()).equals(PDF));
    const dl = await fetch(`${srv.base}/library/${id}/file?download=1`);
    assert.match(dl.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''mabhas13\.pdf/);
    assert.equal((await pool.query('SELECT download_count FROM library_documents WHERE id=$1', [id])).rows[0].download_count, 2);
  });

  await t.test('a file whose content is not a real PDF is rejected and not stored', async () => {
    const before = fs.readdirSync(path.join(srv.uploadDir || process.env.UPLOAD_DIR, 'private', 'library')).length;
    const r = await upload(admin, '/admin/library', { title: 'QA-TEST fake', category: 'other', is_published: 'on' }, { data: Buffer.from('<html>not a pdf</html>'), type: 'application/pdf', name: 'fake.pdf' });
    assert.equal(r.status, 302);
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM library_documents WHERE title='QA-TEST fake'")).rows[0].n, 0);
    assert.equal(fs.readdirSync(path.join(srv.uploadDir || process.env.UPLOAD_DIR, 'private', 'library')).length, before);
  });

  await t.test('validation: Mabhas needs a number; a file or https link is required', async () => {
    await upload(admin, '/admin/library', { title: 'QA-TEST no number', category: 'mabhas', external_url: 'https://example.com/a.pdf', is_published: 'on' });
    await upload(admin, '/admin/library', { title: 'QA-TEST no source', category: 'guide', is_published: 'on' });
    await upload(admin, '/admin/library', { title: 'QA-TEST http', category: 'guide', external_url: 'http://example.com/a.pdf', is_published: 'on' });
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM library_documents WHERE title LIKE 'QA-TEST no%' OR title='QA-TEST http'")).rows[0].n, 0);
  });

  await t.test('unpublished files are hidden from visitors but previewable by admins', async () => {
    const r = await upload(admin, `/admin/library/${id}/edit`, { title: 'QA-TEST مبحث سیزدهم', category: 'mabhas', mabhas_number: '13', edition: 'ویرایش ۱۴۰۲', sort_order: '0' });
    assert.equal(r.status, 302);
    assert.doesNotMatch((await new Client(srv.base).get('/library')).text, /id="mabhas-13"/);
    assert.equal((await fetch(`${srv.base}/library/${id}/file`)).status, 404);
    assert.equal((await admin.request('GET', `/library/${id}/file`)).status, 200);
  });

  await t.test('external links redirect; deleting removes the stored file', async () => {
    const seeded = (await pool.query("SELECT id FROM library_documents WHERE external_url IS NOT NULL ORDER BY id LIMIT 1")).rows[0];
    const r = await fetch(`${srv.base}/library/${seeded.id}/file`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^https:\/\/inbr\./);
    const key = (await pool.query('SELECT file_key FROM library_documents WHERE id=$1', [id])).rows[0].file_key;
    const file = path.join(srv.uploadDir || process.env.UPLOAD_DIR, 'private', 'library', key);
    assert.ok(fs.existsSync(file));
    const token = await admin.csrf('/admin/library');
    assert.equal((await admin.post(`/admin/library/${id}/delete`, { _csrf: token })).status, 302);
    assert.equal(fs.existsSync(file), false);
  });
});
