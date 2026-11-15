'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e85d0000000c4944415408d763f8cfc0f01f0005fe02fe0a2b3d6c0000000049454e44ae426082', 'hex');

async function loginCustomer(base, phone = '09121234567') {
  const c = new Client(base);
  const token1 = await c.csrf('/login');
  await c.post('/auth/request-code', { _csrf: token1, phone, firstName: 'کاربر', lastName: 'تست' });
  const page = await c.get('/login?step=code');
  const m = page.text.match(/<strong>(\d{6})<\/strong>/);
  const token2 = await c.csrf('/login?step=code');
  await c.post('/auth/verify-code', { _csrf: token2, code: m[1] });
  return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('help centre and upgraded tickets (AI off: FAQ search, rule triage)', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'owner_help', PW, 'owner');
  await createAdmin(pool, 'content_help', PW, 'content');
  const srv = await startApp({ pool, env: { FEATURE_AI_SUPPORT: 'false' } });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const guest = new Client(srv.base);

  await t.test('the help centre is public, lists the starter FAQ and links support from the header', async () => {
    const r = await guest.get('/support');
    assert.equal(r.status, 200);
    assert.match(r.text, /دوره‌ها و فایل‌هایی که خریده‌ام کجا هستند؟/);
    assert.match(r.text, /"@type":"FAQPage"/);
    assert.match((await guest.get('/')).text, /href="\/support"/);
    assert.match((await guest.get('/sitemap.xml')).text, /\/support</);
  });

  await t.test('without AI the assistant answers with matching FAQ entries and offers a ticket', async () => {
    const token = await guest.csrf('/support');
    const res = await fetch(`${srv.base}/api/support/ask`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: guest.cookieHeader() }, body: JSON.stringify({ _csrf: token, question: 'دوره‌ای که خریدم کجاست؟' }) });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.mode, 'fallback');
    assert.ok(j.sources.some(s => s.type === 'faq' && /کتابخانهٔ من/.test(s.text)));
    const sug = await (await fetch(`${srv.base}/api/support/suggest?q=${encodeURIComponent('پرداخت چطور')}`)).json();
    assert.ok(sug.items.length >= 1);
  });

  const user = await loginCustomer(srv.base);
  let id;
  await t.test('a ticket with a screenshot is created; rule triage marks a double charge as urgent', async () => {
    const fd = new FormData();
    fd.set('_csrf', await user.csrf('/account/tickets/new'));
    fd.set('subject', 'پول کسر شد ولی دوره فعال نشد');
    fd.set('message', 'دو بار پرداخت کردم و دوره در کتابخانه نیست. شماره من 09121234567');
    fd.set('category', 'other'); fd.set('priority', 'normal');
    fd.set('attachment', new Blob([PNG], { type: 'image/png' }), 'screen.png');
    const r = await user.request('POST', '/account/tickets', { multipart: fd });
    assert.equal(r.status, 302);
    id = (await pool.query('SELECT id FROM tickets ORDER BY id DESC LIMIT 1')).rows[0].id;
    await wait(150);
    const tk = (await pool.query('SELECT * FROM tickets WHERE id=$1', [id])).rows[0];
    assert.equal(tk.ai_category, 'order');
    assert.equal(tk.ai_priority, 'urgent');
    assert.equal(tk.ai_model, null, 'rules, not AI');
    assert.equal(tk.category, 'other', 'the customer choice is kept');
    const msg = (await pool.query('SELECT * FROM ticket_messages WHERE ticket_id=$1', [id])).rows[0];
    assert.match(msg.attachment_key, /^[0-9a-f-]{36}\.png$/);
    const file = await user.get(`/account/tickets/${id}/files/${msg.id}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    const other = await loginCustomer(srv.base, '09129998877');
    assert.equal((await other.get(`/account/tickets/${id}/files/${msg.id}`)).status, 404, 'other customers cannot read it');
  });

  await t.test('a disguised file is rejected as an attachment', async () => {
    const fd = new FormData();
    fd.set('_csrf', await user.csrf('/account/tickets/new'));
    fd.set('subject', 'x'); fd.set('message', 'y');
    fd.set('attachment', new Blob(['<html><script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
    const r = await user.request('POST', '/account/tickets', { multipart: fd });
    assert.equal(r.status, 302);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM tickets')).rows[0].n, 1);
  });

  const admin = new Client(srv.base);
  await admin.adminLogin('owner_help', PW);
  await t.test('admin desk: unread marker, apply suggestion, reply → customer sees a new-reply badge', async () => {
    const list = await admin.get('/admin/tickets?status=needs-reply');
    assert.match(list.text, /sp-row-unread/);
    await admin.postWithCsrf(`/admin/tickets/${id}/apply-triage`, {}, `/admin/tickets/${id}`);
    const tk = (await pool.query('SELECT category, priority FROM tickets WHERE id=$1', [id])).rows[0];
    assert.deepEqual(tk, { category: 'order', priority: 'urgent' });
    const draft = await admin.request('POST', `/admin/tickets/${id}/ai-draft`, { form: { _csrf: await admin.csrf(`/admin/tickets/${id}`) }, headers: { accept: 'application/json' } });
    assert.equal(draft.status, 503, 'AI draft unavailable when AI is off');
    const fd = new FormData();
    fd.set('_csrf', await admin.csrf(`/admin/tickets/${id}`));
    fd.set('message', 'پرداخت شما بررسی شد و دسترسی فعال است.');
    assert.equal((await admin.request('POST', `/admin/tickets/${id}/reply`, { multipart: fd })).status, 302);
    const head = await user.get('/support');
    assert.match(head.text, /class="nav-badge"/);
    assert.match((await user.get('/account/tickets')).text, /is-unread/);
    await user.get(`/account/tickets/${id}`);
    assert.doesNotMatch((await user.get('/account/tickets')).text, /is-unread/, 'opening the ticket marks it read');
  });

  await t.test('the customer closes and rates the ticket; replies after closing are refused', async () => {
    await user.postWithCsrf(`/account/tickets/${id}/close`, {}, `/account/tickets/${id}`);
    assert.equal((await pool.query('SELECT status FROM tickets WHERE id=$1', [id])).rows[0].status, 'closed');
    await user.postWithCsrf(`/account/tickets/${id}/rate`, { rating: '1', comment: 'عالی' }, `/account/tickets/${id}`);
    assert.equal((await pool.query('SELECT rating FROM tickets WHERE id=$1', [id])).rows[0].rating, 1);
    const page = await user.get(`/account/tickets/${id}`);
    assert.doesNotMatch(page.text, /\/reply"/);
  });

  await t.test('FAQ admin: support role edits, content role is blocked; the change reaches the help centre', async () => {
    const r = await admin.postWithCsrf('/admin/support/faqs', { question: 'آیا فاکتور رسمی می‌دهید؟', answer: 'بله، برای هر سفارش موفق.', category: 'order', sort_order: '1', is_published: 'on' }, '/admin/support/faqs/new');
    assert.equal(r.status, 302);
    assert.match((await guest.get('/support')).text, /آیا فاکتور رسمی می‌دهید؟/);
    const content = new Client(srv.base);
    await content.adminLogin('content_help', PW);
    assert.equal((await content.get('/admin/support/faqs')).status, 403);
  });
});
