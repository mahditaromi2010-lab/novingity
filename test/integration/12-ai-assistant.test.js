'use strict';
// «دستیار مبحث ۱۷»: hidden behind FEATURE_AI_ASSISTANT; answers through the AI gateway (a local fake
// OpenAI-compatible server here), falls back to clause search when AI is off/down/over budget, records
// usage, stores opt-in feedback without personal data, and never exposes the key.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { skipReason, newPool, resetDatabase, startApp, Client } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const KEY = 'sk-integration-test-key-abc123';

function fakeAi() {
  const seen = [];
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      if (mode === 'down') { res.writeHead(503); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake-model', choices: [{ message: { content: 'ارتفاع لوله جانشین کنتور ۱۸۰ تا ۲۲۰ سانتی‌متر است [S1]. <script>alert(1)</script>' } }], usage: { prompt_tokens: 1200, completion_tokens: 60 } }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1`, setMode: m => { mode = m; } })));
}

async function askJson(c, question, extra = {}) {
  const token = await c.csrf('/assistant');
  const res = await fetch(c.base + '/api/assistant/ask', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookieHeader() }, body: JSON.stringify({ _csrf: token, question, ...extra }) });
  return { status: res.status, json: await res.json().catch(() => null), token };
}

test('Mabhas 17 AI assistant', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  const ai = await fakeAi();
  let srv = await startApp({ pool, env: { FEATURE_AI_ASSISTANT: 'false', AI_API_KEY: KEY, AI_BASE_URL: ai.url } });
  t.after(async () => { await srv.stop(); await pool.end(); ai.server.close(); });

  await t.test('switched off: page, API and menu link are gone', async () => {
    const c = new Client(srv.base);
    assert.equal((await c.get('/assistant')).status, 404);
    assert.doesNotMatch((await c.get('/')).text, /href="\/assistant"/);
    assert.equal(ai.seen.length, 0);
  });

  await srv.stop();
  srv = await startApp({ pool, env: { FEATURE_AI_ASSISTANT: 'true', AI_API_KEY: KEY, AI_BASE_URL: ai.url, AI_DAILY_REQUEST_LIMIT: '3' } });

  await t.test('switched on: page renders with the menu link and no key anywhere', async () => {
    const c = new Client(srv.base);
    const page = await c.get('/assistant');
    assert.equal(page.status, 200);
    assert.match(page.text, /href="\/assistant"/);
    assert.match(page.text, /id="asForm"/);
    assert.doesNotMatch(page.text, new RegExp(KEY));
    const js = await c.get('/public/js/assistant.js');
    assert.doesNotMatch(js.text, new RegExp(KEY));
  });

  await t.test('answers through the gateway with sources; personal data never reaches the provider', async () => {
    const c = new Client(srv.base);
    const r = await askJson(c, 'ارتفاع لوله جانشین کنتور از کف چقدر است؟ شماره من ۰۹۱۲۳۴۵۶۷۸۹');
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'ai');
    assert.match(r.json.answer, /\[S1\]/);
    assert.ok(r.json.sources.some(s => s.pdfPage === 96), 'meter page retrieved');
    const call = ai.seen.find(s => s.url.endsWith('/chat/completions'));
    assert.equal(call.auth, `Bearer ${KEY}`);
    const sent = JSON.stringify(call.body);
    assert.doesNotMatch(sent, /09123456789|۰۹۱۲۳۴۵۶۷۸۹/);
    assert.match(sent, /\[موبایل\]/);
    const usage = (await pool.query("SELECT SUM(requests)::int n, SUM(prompt_tokens)::int p FROM ai_usage WHERE feature='mabhas17-answer'")).rows[0];
    assert.equal(usage.n, 1); assert.equal(usage.p, 1200);
  });

  await t.test('CSRF is required and empty questions are rejected', async () => {
    const c = new Client(srv.base);
    await c.get('/assistant');
    const res = await fetch(c.base + '/api/assistant/ask', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookieHeader() }, body: JSON.stringify({ question: 'سلام سلام' }) });
    assert.equal(res.status, 403);
    assert.equal((await askJson(c, ' ')).status, 422);
  });

  await t.test('provider down → clause-search fallback, never a 500', async () => {
    ai.setMode('down');
    const r = await askJson(new Client(srv.base), 'حداکثر فاصله بست لوله افقی یک اینچ');
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'fallback');
    assert.equal(r.json.answer, null);
    assert.ok(r.json.sources.some(s => s.pdfPage === 125));
    ai.setMode('ok');
  });

  await t.test('daily budget reached → fallback without calling the provider', async () => {
    await pool.query("INSERT INTO ai_usage (day, feature, model, requests) VALUES (CURRENT_DATE, 'mabhas17-answer', 'x', 10) ON CONFLICT (day, feature, model) DO UPDATE SET requests = 10");
    const before = ai.seen.length;
    const r = await askJson(new Client(srv.base), 'ارتفاع کنتور');
    assert.equal(r.json.mode, 'fallback');
    assert.equal(r.json.reason, 'budget');
    assert.equal(ai.seen.length, before);
  });

  await t.test('feedback is stored with the question redacted', async () => {
    const c = new Client(srv.base);
    const token = await c.csrf('/assistant');
    const res = await fetch(c.base + '/api/assistant/feedback', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookieHeader() }, body: JSON.stringify({ _csrf: token, rating: -1, question: 'سؤال من با ایمیل a@b.co', answer: 'x', model: 'fake-model' }) });
    assert.equal(res.status, 200);
    const row = (await pool.query('SELECT rating, question FROM ai_feedback ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(row.rating, -1);
    assert.doesNotMatch(row.question, /a@b\.co/);
  });

  await t.test('anonymous visitors are rate limited', async () => {
    const c = new Client(srv.base);
    let last;
    for (let i = 0; i < 9; i++) last = await askJson(c, `ارتفاع کنتور ${i}`);
    assert.equal(last.status, 429);
  });
});
