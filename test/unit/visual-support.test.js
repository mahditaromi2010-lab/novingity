'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const visual = require('../../src/lib/visual');
const { sizeFromBuffer } = require('../../src/lib/image-size');
const { createSupportAssistant, ruleTriage } = require('../../src/lib/ai/support-assistant');
const { AiUnavailableError, aiConfig } = require('../../src/lib/ai/gateway');

test('banner links: only same-site paths, https, mailto and tel are allowed', () => {
  for (const ok of ['/shop?type=course', 'https://novingity.ir/x', 'mailto:a@b.ir', 'tel:+989121234567', '#faq']) assert.ok(visual.isSafeHref(ok), ok);
  for (const bad of ['javascript:alert(1)', '//evil.ir', '/\\evil', 'http://x.ir', 'data:text/html,x', 'https://a b.ir', '', '#']) assert.ok(!visual.isSafeHref(bad), bad);
});

test('banner form: empty rows are ignored, bad links and dates are reported, values are clamped', () => {
  const { value, errors } = visual.normalizeBanner({
    name: ' تبلیغ ', slot: 'shop.top', overlay_opacity: '7', content_width: '5', priority: '99999', bg_color: 'red',
    layer_kind: ['title', 'text', 'button'], layer_text: ['عنوان', '', 'بخر'], layer_href: ['', '', '/shop'], layer_style: ['', '', 'nope'],
    starts_at: '2026-12-01T10:00', ends_at: '2026-11-01T10:00'
  });
  assert.deepEqual(errors, ['dateOrder']);
  assert.equal(value.name, 'تبلیغ');
  assert.equal(value.layers.length, 2);
  assert.equal(value.layers[1].style, 'primary');
  assert.equal(value.overlay_opacity, 1);
  assert.equal(value.content_width, 30);
  assert.equal(value.priority, 1000);
  assert.equal(value.bg_color, '#0b261f');
  assert.deepEqual(visual.normalizeBanner({ name: 'x', slot: 'nowhere' }).errors, ['slot']);
  assert.ok(visual.normalizeBanner({ name: 'x', slot: 'site.announcement' }).errors.includes('barText'));
});

test('schedule times are Iran wall-clock times unless the browser sends its offset', () => {
  assert.equal(visual.parseDate('2026-11-20T10:00').toISOString(), '2026-11-20T06:30:00.000Z');
  assert.equal(visual.parseDate('2026-11-20T10:00', 0).toISOString(), '2026-11-20T10:00:00.000Z');
  assert.equal(visual.parseDate('nonsense'), undefined);
  assert.equal(visual.toLocalInput('2026-11-20T06:30:00Z'), '2026-11-20T10:00');
});

test('live banners: status, window, audience, language and priority order', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const b = (id, extra) => ({ id, slot: 'home.top', status: 'published', audience: 'all', locale_mode: 'all', priority: 0, updated_at: '2026-11-01', layers: [], ...extra });
  const all = [b(1), b(2, { priority: 5 }), b(3, { status: 'draft' }), b(4, { starts_at: '2026-11-21' }), b(5, { ends_at: '2026-11-20T12:00:00Z' }), b(6, { audience: 'members' }), b(7, { locale_mode: 'en' }), b(8, { slot: 'shop.top' })];
  assert.deepEqual(visual.liveBanners(all, 'home.top', { now }).map(x => x.id), [2, 1]);
  assert.deepEqual(visual.liveBanners(all, 'home.top', { now, authenticated: true, locale: 'en' }).map(x => x.id), [2, 7, 6, 1], 'ties: newest id first');
  assert.deepEqual(visual.liveBanners(all, 'unknown.slot', { now }), []);
  assert.equal(visual.bannerState(b(9, { starts_at: '2026-12-01' }), now), 'scheduled');
});

test('the readability shade follows the reading direction', () => {
  const b = { overlay_direction: 'to-start', overlay_color: '#000000', overlay_opacity: 0.5 };
  assert.match(visual.overlayCss(b, 'rtl'), /^linear-gradient\(to left, rgba\(0,0,0,0\.5\)/);
  assert.match(visual.overlayCss(b, 'ltr'), /^linear-gradient\(to right/);
  assert.equal(visual.overlayCss({ ...b, overlay_direction: 'none' }), 'none');
});

test('image size is read from PNG, GIF, JPEG and WebP headers', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000012c000000c8080200000000000000', 'hex');
  assert.deepEqual(sizeFromBuffer(png), { width: 300, height: 200 });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(20)]);
  assert.deepEqual(sizeFromBuffer(gif), { width: 320, height: 240 });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x58]), Buffer.alloc(20)]);
  assert.deepEqual(sizeFromBuffer(jpeg), { width: 600, height: 400 });
  assert.equal(sizeFromBuffer(Buffer.from('not an image at all, really')), null);
});

const rows = {
  faqs: [{ id: 1, question: 'دوره‌هایی که خریده‌ام کجا هستند؟', question_en: '', answer: 'در حساب کاربری، کتابخانهٔ من.', answer_en: '', category: 'order' }],
  products: [{ id: 9, slug: 'gas', title: 'دوره طراحی لوله‌کشی گاز', title_en: '', product_type: 'course', price_toman: 450000, short_description: 'آموزش کامل', category: 'گاز' }]
};
const gatewayStub = reply => {
  const calls = [];
  return { calls, enabled: () => true, chat: async args => { calls.push(args); if (reply instanceof Error) throw reply; return { text: reply, model: 'stub-model' }; } };
};

test('support assistant: answers from sources, redacts personal data, detects hand-off, keeps cited sources', async () => {
  const gw = gatewayStub('در کتابخانهٔ من است [F1].\n[HANDOFF]');
  const a = createSupportAssistant({ gateway: gw, loadRows: async () => rows });
  const r = await a.ask('دوره‌ای که خریدم کجاست؟ شماره‌ام 09121234567 است');
  assert.equal(r.mode, 'ai');
  assert.equal(r.handoff, true);
  assert.doesNotMatch(r.answer, /HANDOFF/);
  assert.deepEqual(r.sources.map(s => s.marker), ['F1']);
  const sent = JSON.stringify(gw.calls[0].messages);
  assert.doesNotMatch(sent, /09121234567/, 'phone number never leaves the server');
  assert.match(sent, /\[F1\]/);
  assert.equal(gw.calls[0].feature, 'support-chat');
});

test('support assistant: provider failure falls back to FAQ results; triage validates JSON and keeps safety rules', async () => {
  const down = createSupportAssistant({ gateway: gatewayStub(new AiUnavailableError('timeout')), loadRows: async () => rows });
  const r = await down.ask('دوره‌ای که خریدم کجاست؟');
  assert.equal(r.mode, 'fallback');
  assert.equal(r.sources[0].type, 'faq');

  const tri = createSupportAssistant({ gateway: gatewayStub('{"category":"product","priority":"low","summary":"کاربر بوی گاز را گزارش داده","language":"fa"}'), loadRows: async () => rows });
  const t1 = await tri.triage({ subject: 'بوی گاز در آشپزخانه', message: 'چه کنم', category: 'other', priority: 'normal' });
  assert.equal(t1.priority, 'urgent', 'a gas-leak keyword stays urgent');
  assert.equal(t1.category, 'product');
  const bad = createSupportAssistant({ gateway: gatewayStub('not json'), loadRows: async () => rows });
  assert.equal((await bad.triage({ subject: 'کد پیامک نمیاد', message: '', category: 'other', priority: 'normal' })).category, 'account');
  assert.equal(ruleTriage({ subject: 'suggestion', message: '', category: 'other', priority: 'low' }).language, 'en');
});

test('AI feature flags: each feature has its own switch, plus a global kill switch', () => {
  const env = { AI_API_KEY: 'k', FEATURE_AI_SUPPORT: 'true', FEATURE_AI_ASSISTANT: 'false' };
  assert.equal(aiConfig(env, 'support-chat').enabled, true);
  assert.equal(aiConfig(env, 'mabhas17-answer').enabled, false);
  assert.equal(aiConfig({ ...env, AI_KILL_SWITCH: 'true' }, 'support-chat').enabled, false);
  assert.equal(aiConfig({ ...env, AI_API_KEY: '' }, 'support-chat').enabled, false);
});
