'use strict';
/**
 * Help-centre AI («پشتیبان هوشمند»): three small jobs, each with a non-AI fallback.
 *
 *  ask(question)        answers visitors from the site's own FAQ + product data, with source markers; offers a
 *                       ticket ([HANDOFF]) when a human must act. Fallback: the best-matching FAQ answers and products.
 *  triage(ticket)       suggests category / priority / one-line summary for a new ticket (JSON, validated).
 *                       Fallback: keyword rules. Suggestions only: the customer's and admin's choices stay in force.
 *  draftReply(ticket)   drafts an answer for the admin to edit before sending. Fallback: none (button says so).
 *
 * Facts (prices, products, policies) come from the database and the prompt's SITE FACTS, never from the model's
 * memory. Personal data is redacted before anything leaves the server (redactText). Models: models.js.
 */
const fs = require('fs');
const path = require('path');
const { tokenize } = require('./knowledge-base');
const { modelFor } = require('./models');
const { AiUnavailableError } = require('./gateway');
const { redactText } = require('./mabhas17-assistant');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf8');
const PROMPTS = { ask: read('support-assistant.md'), triage: read('support-triage.md'), draft: read('support-draft.md') };
const KB_TTL_MS = 60_000;
const HANDOFF = '[HANDOFF]';
const CATEGORIES = ['order', 'product', 'account', 'technical', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const isEnglish = s => (String(s).match(/[A-Za-z]/g) || []).length > (String(s).match(/[؀-ۿ]/g) || []).length;
const money = (toman, en) => Number(toman || 0) === 0 ? (en ? 'Free' : 'رایگان') : `${new Intl.NumberFormat(en ? 'en-US' : 'fa-IR').format(Number(toman))} ${en ? 'Toman' : 'تومان'}`;

/** Small lexical retrieval: share of query tokens found in the item, title matches count double. */
function score(qTokens, item) {
  if (!qTokens.size) return 0;
  let s = 0;
  qTokens.forEach(t => { if (item.titleTokens.has(t)) s += 2; else if (item.tokens.has(t)) s += 1; });
  return s / (qTokens.size + Math.sqrt(item.tokens.size) / 3);
}

function prepare(rows) {
  const faqs = rows.faqs.map(f => ({
    kind: 'faq', id: f.id, category: f.category, question: f.question, question_en: f.question_en, answer: f.answer, answer_en: f.answer_en,
    titleTokens: new Set(tokenize(`${f.question} ${f.question_en}`)), tokens: new Set(tokenize(`${f.question} ${f.question_en} ${f.answer} ${f.answer_en}`))
  }));
  const products = rows.products.map(p => ({
    kind: 'product', id: p.id, slug: p.slug, type: p.product_type, title: p.title, title_en: p.title_en, price: p.price_toman,
    summary: p.short_description || p.subtitle || '', summary_en: p.short_description_en || p.subtitle_en || '', category: p.category || '',
    titleTokens: new Set(tokenize(`${p.title} ${p.title_en || ''} ${p.category || ''}`)),
    tokens: new Set(tokenize(`${p.title} ${p.title_en || ''} ${p.category || ''} ${p.short_description || ''} ${p.subtitle || ''} ${p.product_type === 'course' ? 'دوره آموزش course' : 'افزونه پلاگین plugin اتوکد autocad'}`))
  }));
  return { faqs, products };
}

function retrieve(kb, question, { faqK = 4, productK = 3 } = {}) {
  const q = new Set(tokenize(question));
  const rank = (list, k, min) => list.map(item => ({ item, s: score(q, item) })).filter(x => x.s >= min).sort((a, b) => b.s - a.s).slice(0, k).map(x => x.item);
  return { faqs: rank(kb.faqs, faqK, 0.18), products: rank(kb.products, productK, 0.22) };
}

function sourcesBlock({ faqs, products }, en) {
  const f = faqs.map((x, i) => `[F${i + 1}] Q: ${en ? x.question_en || x.question : x.question}\nA: ${en ? x.answer_en || x.answer : x.answer}`);
  const p = products.map((x, i) => `[P${i + 1}] ${x.type === 'course' ? (en ? 'Course' : 'دوره') : (en ? 'Plugin' : 'افزونه')}: ${en ? x.title_en || x.title : x.title}\n` +
    `${en ? 'Price' : 'قیمت'}: ${money(x.price, en)} · ${en ? 'Page' : 'صفحه'}: /shop/${x.slug}\n${en ? x.summary_en || x.summary : x.summary}`);
  return [...f, ...p].join('\n\n') || '(no matching source)';
}

const publicSources = ({ faqs, products }, en) => [
  ...faqs.map((x, i) => ({ marker: `F${i + 1}`, type: 'faq', id: x.id, title: en ? x.question_en || x.question : x.question, text: en ? x.answer_en || x.answer : x.answer, url: `/support#faq-${x.id}` })),
  ...products.map((x, i) => ({ marker: `P${i + 1}`, type: 'product', id: x.id, title: en ? x.title_en || x.title : x.title, text: `${money(x.price, en)} · ${en ? x.summary_en || x.summary : x.summary}`.slice(0, 300), url: `/shop/${x.slug}` }))
];

/** Keyword rules used when AI is off: good enough to pre-sort the queue. */
function ruleTriage({ subject = '', message = '', category = 'other', priority = 'normal' }) {
  const t = `${subject} ${message}`.toLowerCase();
  const has = re => re.test(t);
  let cat = category;
  if (cat === 'other') {
    if (has(/پرداخت|سفارش|خرید|زرین|درگاه|کسر|واریز|فاکتور|payment|order|paid|charged/)) cat = 'order';
    else if (has(/ورود|کد|پیامک|اس.?ام.?اس|رمز|حساب|login|sign|otp|sms|account/)) cat = 'account';
    else if (has(/دوره|ویدیو|فایل|افزونه|پلاگین|اتوکد|دانلود|نصب|course|video|plugin|download|install/)) cat = 'product';
    else if (has(/خطا|باگ|کار نمی|ماشین.?حساب|محاسبه|error|bug|calculator/)) cat = 'technical';
  }
  let pri = priority;
  if (has(/بوی گاز|نشت|گازگرفتگی|مونوکسید|gas leak|smell of gas|carbon monoxide/)) pri = 'urgent';
  else if (has(/دوبار|دو بار|کسر شد.*(نیامد|ندارم|فعال نشد)|پول.*رفت|charged twice/) && PRIORITIES.indexOf(pri) < 3) pri = 'urgent';
  return { category: cat, priority: pri, summary: null, language: isEnglish(t) ? 'en' : 'fa', model: null };
}

/**
 * @param {{ gateway: object, pool?: import('pg').Pool, env?: object, loadRows?: () => Promise<{faqs: object[], products: object[]}> }} deps
 */
function createSupportAssistant({ gateway, pool, env = process.env, loadRows } = {}) {
  let kb = null;
  let kbAt = 0;
  const load = loadRows || (async () => {
    const [faqs, products] = await Promise.all([
      pool.query('SELECT id,question,question_en,answer,answer_en,category FROM support_faqs WHERE is_published ORDER BY sort_order,id'),
      pool.query("SELECT id,slug,title,title_en,product_type,price_toman,short_description,short_description_en,subtitle,subtitle_en,category FROM products WHERE status='published'")
    ]);
    return { faqs: faqs.rows, products: products.rows };
  });

  async function knowledge() {
    if (!kb || Date.now() - kbAt > KB_TTL_MS) { kb = prepare(await load()); kbAt = Date.now(); }
    return kb;
  }
  const invalidate = () => { kb = null; };

  async function ask(rawQuestion, { history = [], locale = 'fa' } = {}) {
    const question = redactText(String(rawQuestion || '').replace(/\s+/g, ' ').trim()).slice(0, 600);
    if (question.length < 2) return { mode: 'fallback', answer: null, sources: [], reason: 'empty' };
    const en = locale === 'en' || isEnglish(question);
    const found = retrieve(await knowledge(), question);
    const sources = publicSources(found, en);
    if (!gateway?.enabled('support-chat')) return { mode: 'fallback', answer: null, sources, handoff: !found.faqs.length, reason: 'disabled' };
    const m = modelFor('supportChat', env);
    const messages = [{ role: 'system', content: `${PROMPTS.ask}\nSOURCES:\n${sourcesBlock(found, en)}` }];
    history.slice(-4).forEach(h => messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: redactText(String(h.content || '')).slice(0, 1200) }));
    messages.push({ role: 'user', content: question });
    try {
      const r = await gateway.chat({ feature: 'support-chat', model: m.model, messages, maxTokens: m.maxTokens, timeoutMs: m.timeoutMs, temperature: 0.2 });
      const handoff = r.text.includes(HANDOFF);
      const answer = r.text.replace(HANDOFF, '').trim();
      // Only show the sources the answer actually cites (all of them if it cites none).
      const cited = sources.filter(s => answer.includes(`[${s.marker}]`));
      return { mode: 'ai', answer, sources: cited.length ? cited : sources, handoff, model: r.model };
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
      return { mode: 'fallback', answer: null, sources, handoff: !found.faqs.length, reason: err.reason };
    }
  }

  async function triage(ticket) {
    const base = ruleTriage(ticket);
    if (!gateway?.enabled('support-triage')) return base;
    const m = modelFor('supportTriage', env);
    const text = redactText(`SUBJECT: ${ticket.subject}\nCUSTOMER CHOSE: category=${ticket.category}, priority=${ticket.priority}\nMESSAGE:\n${ticket.message}`).slice(0, 3000);
    try {
      const r = await gateway.chat({ feature: 'support-triage', model: m.model, json: true, temperature: 0, maxTokens: m.maxTokens, timeoutMs: m.timeoutMs,
        messages: [{ role: 'system', content: PROMPTS.triage }, { role: 'user', content: text }] });
      const json = JSON.parse((r.text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      return {
        category: CATEGORIES.includes(json.category) ? json.category : base.category,
        // Rules can only raise urgency (a gas-leak keyword stays urgent even if the model says otherwise).
        priority: PRIORITIES.includes(json.priority) ? PRIORITIES[Math.max(PRIORITIES.indexOf(json.priority), base.priority === 'urgent' ? 3 : 0)] : base.priority,
        summary: typeof json.summary === 'string' ? json.summary.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null,
        language: json.language === 'en' ? 'en' : 'fa',
        model: r.model
      };
    } catch (err) {
      if (err instanceof AiUnavailableError || err instanceof SyntaxError) return base;
      throw err;
    }
  }

  /** @returns {Promise<{ text: string, model: string } | { text: null, reason: string }>} */
  async function draftReply({ ticket, messages }) {
    if (!gateway?.enabled('support-draft')) return { text: null, reason: 'disabled' };
    const lastUser = [...messages].reverse().find(x => x.author_type === 'user');
    const found = retrieve(await knowledge(), `${ticket.subject} ${lastUser ? lastUser.body : ''}`);
    const en = isEnglish(`${ticket.subject} ${lastUser ? lastUser.body : ''}`);
    const convo = messages.slice(-10).map(x => `${x.author_type === 'admin' ? 'AGENT' : 'CUSTOMER'}: ${redactText(String(x.body || '')).slice(0, 1500)}`).join('\n\n');
    const m = modelFor('supportDraft', env);
    try {
      const r = await gateway.chat({ feature: 'support-draft', model: m.model, maxTokens: m.maxTokens, timeoutMs: m.timeoutMs, temperature: 0.3,
        messages: [{ role: 'system', content: `${PROMPTS.draft}\nSOURCES:\n${sourcesBlock(found, en)}` },
          { role: 'user', content: `TICKET SUBJECT: ${redactText(ticket.subject)}\nCATEGORY: ${ticket.category}\n\nCONVERSATION:\n${convo}` }] });
      return { text: r.text.replace(HANDOFF, '').trim().slice(0, 4000), model: r.model };
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
      return { text: null, reason: err.reason };
    }
  }

  /** Deterministic FAQ suggestions while the customer types a ticket subject (no AI, no cost). */
  async function suggest(text, locale = 'fa') {
    const q = String(text || '').trim().slice(0, 300);
    if (q.length < 3) return [];
    const en = locale === 'en';
    return retrieve(await knowledge(), q, { faqK: 3, productK: 0 }).faqs.map(x => ({ id: x.id, question: en ? x.question_en || x.question : x.question, answer: en ? x.answer_en || x.answer : x.answer }));
  }

  return { ask, triage, draftReply, suggest, invalidate, enabled: () => !!gateway?.enabled('support-chat') };
}

module.exports = { createSupportAssistant, ruleTriage, retrieve, prepare, sourcesBlock, PROMPTS, HANDOFF, CATEGORIES, PRIORITIES };
