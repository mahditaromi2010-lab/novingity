'use strict';
/**
 * Help centre and support tickets.
 *
 * Public:   /support — FAQ (admin-managed), the AI help assistant (falls back to FAQ search without AI), links to
 *           tickets and the Part 17 assistant. JSON: /api/support/ask, /api/support/feedback, /api/support/suggest.
 * Customer: /account/tickets… — tickets with an optional screenshot/PDF, unread markers, close and rate.
 * Admin:    /admin/tickets… (permission "support") — queue with unread markers and AI/rule triage suggestions,
 *           AI reply drafts the agent edits before sending; /admin/support/faqs for the FAQ.
 * No e-mail or SMS is sent for tickets (product decision kept from 0005); replies show on the site.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { CATEGORIES, PRIORITIES } = require('../lib/ai/support-assistant');
const { redactText } = require('../lib/ai/mabhas17-assistant');
const seo = require('../lib/seo');

const TICKET_STATUSES = ['open', 'pending', 'answered', 'closed'];
const FAQ_CATEGORIES = ['general', 'order', 'product', 'account', 'technical'];
const ATTACH_MB = 5;
const ATTACH_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

function registerSupportRoutes(app, deps) {
  const { pool, gateway, supportAI, requireAuth, requireAdmin, asyncRoute, setFlash, renderError, normalizeText, multipartCsrf, verifyUploads, removeUploaded,
    PRIVATE_DIR, buildWhere, parsePage, pagination, logger, aiAssistantPage } = deps;
  const TICKET_DIR = path.join(PRIVATE_DIR, 'tickets');
  fs.mkdirSync(TICKET_DIR, { recursive: true });
  const t = res => res.locals.t;
  const notFound = res => renderError(res, 404, t(res)('errorPage.notFoundTitle'), t(res)('tickets.notFound'));

  const attachUpload = multer({
    storage: multer.diskStorage({ destination: (_req, _f, cb) => cb(null, TICKET_DIR), filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${ATTACH_TYPES[file.mimetype] || '.bin'}`) }),
    limits: { fileSize: ATTACH_MB * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (_req, file, cb) => cb(ATTACH_TYPES[file.mimetype] ? null : new Error('File type rejected'), !!ATTACH_TYPES[file.mimetype])
  }).single('attachment');
  const attachPolicy = () => ({ allowedKinds: ['image', 'pdf'], renameToDetected: true });
  const attachmentOf = req => (req.file ? { key: req.file.filename, name: String(req.file.originalname || 'file').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200), mime: req.file.mimetype, size: req.file.size } : null);

  async function insertMessage(db, ticketId, authorType, authorId, body, attach, aiAssisted = false) {
    await db.query('INSERT INTO ticket_messages(ticket_id,author_type,author_id,body,attachment_key,attachment_name,attachment_mime,attachment_size,ai_assisted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [ticketId, authorType, authorId, body, attach?.key || null, attach?.name || null, attach?.mime || null, attach?.size || null, aiAssisted]);
  }

  /** Runs after the response: rule or AI triage, stored as suggestions next to the ticket. Never blocks the customer. */
  function triageLater(ticket) {
    setImmediate(async () => {
      try {
        const r = await supportAI.triage(ticket);
        await pool.query('UPDATE tickets SET ai_category=$1, ai_priority=$2, ai_summary=$3, ai_model=$4, ai_at=NOW() WHERE id=$5', [r.category, r.priority, r.summary, r.model, ticket.id]);
      } catch (err) { logger?.warn?.('ticket triage failed', { ticketId: ticket.id, error: err.message }); }
    });
  }

  function sendAttachment(res, row) {
    if (!row?.attachment_key || !/^[a-f0-9-]{36}\.(jpg|png|webp|gif|pdf)$/.test(row.attachment_key)) return false;
    const file = path.join(TICKET_DIR, row.attachment_key);
    if (!fs.existsSync(file)) return false;
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.type(row.attachment_mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.attachment_name || 'file')}`);
    res.sendFile(file);
    return true;
  }

  // ───────────── Help centre ─────────────
  const askLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, standardHeaders: 'draft-7', legacyHeaders: false,
    limit: req => (req.user ? 40 : 12),
    keyGenerator: req => (req.user ? `su:${req.user.id}` : `sip:${req.ip}`),
    handler: (req, res) => res.status(429).json({ error: res.locals.t('support.error.rate') })
  });
  const suggestLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: req => `sg:${req.ip}`, handler: (_req, res) => res.status(429).json({ items: [] }) });

  app.get('/support', asyncRoute(async (req, res) => {
    const faqs = (await pool.query('SELECT * FROM support_faqs WHERE is_published ORDER BY sort_order,id')).rows;
    let myTickets = null;
    if (req.user) myTickets = (await pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status<>'closed')::int AS open FROM tickets WHERE user_id=$1", [req.user.id])).rows[0];
    const en = res.locals.locale === 'en';
    // FAQPage structured data from the same published answers shown on the page.
    const faqLd = faqs.length ? { '@type': 'FAQPage', inLanguage: en ? 'en' : 'fa', mainEntity: faqs.slice(0, 30).map(f => ({ '@type': 'Question', name: en ? f.question_en || f.question : f.question, acceptedAnswer: { '@type': 'Answer', text: en ? f.answer_en || f.answer : f.answer } })) } : null;
    res.render('support', {
      title: t(res)('support.pageTitle'), metaDescription: t(res)('support.metaDescription'),
      structuredData: [faqLd, seo.breadcrumbs([{ name: t(res)('tools.breadcrumbHome'), url: seo.localeUrl(res.locals.appUrl, '/', res.locals.locale) }, { name: t(res)('nav.support'), url: res.locals.seo.canonical }])],
      faqs, categories: FAQ_CATEGORIES, aiLive: supportAI.enabled(), myTickets, assistantLink: aiAssistantPage
    });
  }));

  app.post('/api/support/ask', askLimiter, asyncRoute(async (req, res) => {
    const question = normalizeText(req.body.question, 600);
    if (!question || question.length < 2) return res.status(422).json({ error: t(res)('support.error.empty') });
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-4).map(h => ({ role: h && h.role === 'assistant' ? 'assistant' : 'user', content: normalizeText(h && h.content, 1200) })) : [];
    const r = await supportAI.ask(question, { history, locale: res.locals.locale });
    res.set('Cache-Control', 'no-store');
    res.json({ ...r, signedIn: !!req.user });
  }));

  app.post('/api/support/feedback', askLimiter, asyncRoute(async (req, res) => {
    const rating = Number(req.body.rating);
    const question = normalizeText(req.body.question, 600);
    if (![1, -1].includes(rating) || !question) return res.status(422).json({ error: 'invalid' });
    await pool.query('INSERT INTO ai_feedback (feature, rating, question, answer, model, user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      ['support', rating, redactText(question), normalizeText(req.body.answer, 4000) || null, normalizeText(req.body.model, 80) || null, req.user ? req.user.id : null]);
    res.json({ ok: true });
  }));

  app.get('/api/support/suggest', suggestLimiter, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ items: await supportAI.suggest(req.query.q, res.locals.locale) });
  }));

  app.post('/support/faq/:id/vote', asyncRoute(async (req, res) => {
    const col = req.body.helpful === '1' ? 'helpful_yes' : 'helpful_no';
    await pool.query(`UPDATE support_faqs SET ${col}=${col}+1 WHERE id=$1 AND is_published`, [req.params.id]);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
    setFlash(req, 'success', t(res)('support.voteThanks'));
    res.redirect(`/support#faq-${req.params.id}`);
  }));

  // ───────────── Customer tickets ─────────────
  app.get('/account/tickets', requireAuth, asyncRoute(async (req, res) => {
    const r = await pool.query(`SELECT tk.*, (tk.last_author='admin' AND tk.status<>'closed' AND (tk.user_seen_at IS NULL OR tk.user_seen_at < tk.updated_at)) AS unread
      FROM tickets tk WHERE tk.user_id=$1 ORDER BY (tk.status='closed'), tk.updated_at DESC`, [req.user.id]);
    res.render('tickets', { title: t(res)('page.tickets'), tickets: r.rows });
  }));

  app.get('/account/tickets/new', requireAuth, (req, res) => res.render('ticket-new', { title: t(res)('page.ticketNew'), draft: {}, fromAssistant: req.query.from === 'assistant' }));

  app.post('/account/tickets', requireAuth, attachUpload, multipartCsrf, verifyUploads(attachPolicy, '/account/tickets/new'), asyncRoute(async (req, res) => {
    const subject = normalizeText(req.body.subject, 200);
    const message = normalizeText(req.body.message, 4000);
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'other';
    const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal';
    const source = req.body.source === 'assistant' ? 'assistant' : 'form';
    if (!subject || !message) {
      removeUploaded(req);
      setFlash(req, 'error', t(res)('flash.tickets.subjectMessageRequired'));
      return res.status(422).render('ticket-new', { title: t(res)('page.ticketNew'), draft: { subject, message, category, priority }, fromAssistant: source === 'assistant' });
    }
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const created = await client.query("INSERT INTO tickets(user_id,subject,category,priority,status,source,last_author,user_seen_at) VALUES($1,$2,$3,$4,'open',$5,'user',NOW()) RETURNING id", [req.user.id, subject, category, priority, source]);
      id = created.rows[0].id;
      await insertMessage(client, id, 'user', req.user.id, message, attachmentOf(req));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); removeUploaded(req); throw error; } finally { client.release(); }
    triageLater({ id, subject, message, category, priority });
    setFlash(req, 'success', t(res)('flash.tickets.created'));
    res.redirect(`/account/tickets/${id}`);
  }));

  app.get('/account/tickets/:id', requireAuth, asyncRoute(async (req, res) => {
    const tk = await pool.query('SELECT * FROM tickets WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!tk.rowCount) return notFound(res);
    const messages = await pool.query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at,id', [req.params.id]);
    await pool.query('UPDATE tickets SET user_seen_at=NOW() WHERE id=$1', [req.params.id]);
    res.render('ticket', { title: tk.rows[0].subject, ticket: tk.rows[0], messages: messages.rows });
  }));

  app.get('/account/tickets/:id/files/:mid', requireAuth, asyncRoute(async (req, res) => {
    const m = await pool.query('SELECT m.attachment_key,m.attachment_name,m.attachment_mime FROM ticket_messages m JOIN tickets tk ON tk.id=m.ticket_id WHERE m.id=$1 AND tk.id=$2 AND tk.user_id=$3',
      [Number.parseInt(req.params.mid, 10) || 0, req.params.id, req.user.id]);
    if (!sendAttachment(res, m.rows[0])) return notFound(res);
  }));

  app.post('/account/tickets/:id/reply', requireAuth, attachUpload, multipartCsrf, verifyUploads(attachPolicy, req => `/account/tickets/${req.params.id}`), asyncRoute(async (req, res) => {
    const tk = await pool.query('SELECT * FROM tickets WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!tk.rowCount) { removeUploaded(req); return notFound(res); }
    if (tk.rows[0].status === 'closed') { removeUploaded(req); setFlash(req, 'error', t(res)('flash.tickets.closedCannotReply')); return res.redirect(`/account/tickets/${req.params.id}`); }
    const message = normalizeText(req.body.message, 4000);
    if (!message) { removeUploaded(req); setFlash(req, 'error', t(res)('flash.tickets.replyRequired')); return res.redirect(`/account/tickets/${req.params.id}`); }
    await insertMessage(pool, req.params.id, 'user', req.user.id, message, attachmentOf(req));
    await pool.query("UPDATE tickets SET status='pending', last_author='user', user_seen_at=NOW(), updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.redirect(`/account/tickets/${req.params.id}#latest`);
  }));

  app.post('/account/tickets/:id/close', requireAuth, asyncRoute(async (req, res) => {
    const r = await pool.query("UPDATE tickets SET status='closed', closed_at=NOW(), updated_at=NOW(), user_seen_at=NOW() WHERE id=$1 AND user_id=$2 AND status<>'closed' RETURNING id", [req.params.id, req.user.id]);
    setFlash(req, r.rowCount ? 'success' : 'error', t(res)(r.rowCount ? 'support.closed' : 'tickets.notFound'));
    res.redirect(`/account/tickets/${req.params.id}`);
  }));

  app.post('/account/tickets/:id/rate', requireAuth, asyncRoute(async (req, res) => {
    const rating = req.body.rating === '1' ? 1 : req.body.rating === '-1' ? -1 : null;
    if (!rating) { setFlash(req, 'error', t(res)('adminVisual.err.generic')); return res.redirect(`/account/tickets/${req.params.id}`); }
    const r = await pool.query("UPDATE tickets SET rating=$1, rating_comment=$2 WHERE id=$3 AND user_id=$4 AND status IN ('answered','closed') RETURNING id",
      [rating, normalizeText(req.body.comment, 500) || null, req.params.id, req.user.id]);
    setFlash(req, r.rowCount ? 'success' : 'error', t(res)(r.rowCount ? 'support.rated' : 'tickets.notFound'));
    res.redirect(`/account/tickets/${req.params.id}`);
  }));

  // ───────────── Admin: tickets ─────────────
  app.get('/admin/tickets', requireAdmin, asyncRoute(async (req, res) => {
    const status = TICKET_STATUSES.includes(req.query.status) || req.query.status === 'needs-reply' ? req.query.status : '';
    const priority = PRIORITIES.includes(req.query.priority) ? req.query.priority : '';
    const base = status === 'needs-reply' ? ["tk.status IN ('open','pending')"] : [];
    const { where, params, q } = buildWhere({ q: req.query.q, searchColumns: ['tk.subject', 'tk.ai_summary', 'u.phone'], filters: [['tk.status', status === 'needs-reply' ? '' : status], ['tk.priority', priority]], base });
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM tickets tk JOIN users u ON u.id=tk.user_id ${where}`, params)).rows[0].n;
    const pg = pagination(parsePage(req.query.page), 30, total);
    const r = await pool.query(`SELECT tk.*,u.phone,u.first_name,u.last_name,
        (tk.last_author='user' AND tk.status<>'closed' AND (tk.admin_seen_at IS NULL OR tk.admin_seen_at < tk.updated_at)) AS unread,
        (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=tk.id AND m.attachment_key IS NOT NULL)::int AS files
      FROM tickets tk JOIN users u ON u.id=tk.user_id ${where}
      ORDER BY (tk.status IN ('open','pending')) DESC, CASE tk.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, tk.updated_at DESC, tk.id DESC
      LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, params);
    const counts = (await pool.query("SELECT COUNT(*) FILTER (WHERE status IN ('open','pending'))::int AS needs, COUNT(*) FILTER (WHERE status IN ('open','pending') AND priority='urgent')::int AS urgent FROM tickets")).rows[0];
    res.render('admin/tickets', { title: t(res)('admin.tickets.title'), tickets: r.rows, filters: { q, status, priority }, pg, counts });
  }));

  async function loadAdminTicket(id) {
    const tk = await pool.query('SELECT tk.*,u.phone,u.first_name,u.last_name FROM tickets tk JOIN users u ON u.id=tk.user_id WHERE tk.id=$1', [id]);
    if (!tk.rowCount) return null;
    const messages = (await pool.query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at,id', [id])).rows;
    const history = (await pool.query('SELECT id,subject,status,created_at FROM tickets WHERE user_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 5', [tk.rows[0].user_id, id])).rows;
    return { ticket: tk.rows[0], messages, history };
  }

  app.get('/admin/tickets/:id', requireAdmin, asyncRoute(async (req, res) => {
    const data = await loadAdminTicket(req.params.id);
    if (!data) return notFound(res);
    await pool.query('UPDATE tickets SET admin_seen_at=NOW() WHERE id=$1', [req.params.id]);
    res.render('admin/ticket-detail', { title: data.ticket.subject, ...data, aiDraftAvailable: gateway.enabled('support-draft'), draft: null });
  }));

  app.get('/admin/tickets/:id/files/:mid', requireAdmin, asyncRoute(async (req, res) => {
    const m = await pool.query('SELECT attachment_key,attachment_name,attachment_mime FROM ticket_messages WHERE id=$1 AND ticket_id=$2', [Number.parseInt(req.params.mid, 10) || 0, req.params.id]);
    if (!sendAttachment(res, m.rows[0])) return notFound(res);
  }));

  app.post('/admin/tickets/:id/reply', requireAdmin, attachUpload, multipartCsrf, verifyUploads(attachPolicy, req => `/admin/tickets/${req.params.id}`), asyncRoute(async (req, res) => {
    const tk = await pool.query('SELECT id,status FROM tickets WHERE id=$1', [req.params.id]);
    if (!tk.rowCount) { removeUploaded(req); return notFound(res); }
    const message = normalizeText(req.body.message, 4000);
    if (!message) { removeUploaded(req); setFlash(req, 'error', t(res)('flash.tickets.replyRequired')); return res.redirect(`/admin/tickets/${req.params.id}`); }
    await insertMessage(pool, req.params.id, 'admin', req.admin.id, message, attachmentOf(req), req.body.ai_assisted === '1');
    const nextStatus = req.body.close === '1' ? 'closed' : 'answered';
    await pool.query(`UPDATE tickets SET status=$1, last_author='admin', admin_seen_at=NOW(), updated_at=NOW()${nextStatus === 'closed' ? ', closed_at=NOW()' : ''} WHERE id=$2`, [nextStatus, req.params.id]);
    setFlash(req, 'success', t(res)('tickets.replied'));
    res.redirect(`/admin/tickets/${req.params.id}`);
  }));

  app.post('/admin/tickets/:id/status', requireAdmin, asyncRoute(async (req, res) => {
    const status = TICKET_STATUSES.includes(req.body.status) ? req.body.status : null;
    const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : null;
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : null;
    if (!status || !priority) { setFlash(req, 'error', t(res)('adminVisual.err.generic')); return res.redirect(`/admin/tickets/${req.params.id}`); }
    const r = await pool.query(`UPDATE tickets SET status=$1, priority=$2, category=COALESCE($3, category), updated_at=NOW(), closed_at=CASE WHEN $1='closed' THEN COALESCE(closed_at, NOW()) ELSE NULL END WHERE id=$4 RETURNING id`,
      [status, priority, category, req.params.id]);
    setFlash(req, r.rowCount ? 'success' : 'error', t(res)(r.rowCount ? 'admin.tickets.updated' : 'tickets.notFound'));
    res.redirect(`/admin/tickets/${req.params.id}`);
  }));

  app.post('/admin/tickets/:id/apply-triage', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query(`UPDATE tickets SET category=COALESCE(NULLIF(ai_category,''), category), priority=COALESCE(NULLIF(ai_priority,''), priority), updated_at=NOW()
      WHERE id=$1 AND ai_category = ANY($2) AND ai_priority = ANY($3) RETURNING id`, [req.params.id, CATEGORIES, PRIORITIES]);
    setFlash(req, r.rowCount ? 'success' : 'error', t(res)(r.rowCount ? 'admin.tickets.updated' : 'adminVisual.err.generic'));
    res.redirect(`/admin/tickets/${req.params.id}`);
  }));

  app.post('/admin/tickets/:id/retriage', requireAdmin, asyncRoute(async (req, res) => {
    const data = await loadAdminTicket(req.params.id);
    if (!data) return notFound(res);
    const first = data.messages.find(m => m.author_type === 'user');
    const r = await supportAI.triage({ id: data.ticket.id, subject: data.ticket.subject, message: first ? first.body : '', category: data.ticket.category, priority: data.ticket.priority });
    await pool.query('UPDATE tickets SET ai_category=$1, ai_priority=$2, ai_summary=$3, ai_model=$4, ai_at=NOW() WHERE id=$5', [r.category, r.priority, r.summary, r.model, data.ticket.id]);
    setFlash(req, 'success', t(res)('admin.tickets.retriaged'));
    res.redirect(`/admin/tickets/${req.params.id}`);
  }));

  // AI draft: JSON for the page script; without JavaScript the detail page is re-rendered with the draft filled in.
  app.post('/admin/tickets/:id/ai-draft', requireAdmin, asyncRoute(async (req, res) => {
    const data = await loadAdminTicket(req.params.id);
    if (!data) return notFound(res);
    const r = await supportAI.draftReply({ ticket: data.ticket, messages: data.messages });
    const wantsJson = req.accepts(['html', 'json']) === 'json';
    if (!r.text) {
      const msg = t(res)(r.reason === 'disabled' ? 'admin.tickets.aiOff' : 'admin.tickets.aiFailed');
      if (wantsJson) return res.status(503).json({ error: msg });
      setFlash(req, 'error', msg);
      return res.redirect(`/admin/tickets/${req.params.id}`);
    }
    if (wantsJson) return res.json({ text: r.text, model: r.model });
    res.render('admin/ticket-detail', { title: data.ticket.subject, ...data, aiDraftAvailable: true, draft: r.text });
  }));

  // ───────────── Admin: FAQ ─────────────
  app.get('/admin/support/faqs', requireAdmin, asyncRoute(async (req, res) => {
    const faqs = (await pool.query('SELECT * FROM support_faqs ORDER BY category, sort_order, id')).rows;
    const usage = await gateway.usageToday('support-chat').catch(() => ({ requests: 0, tokens: 0 }));
    const feedback = (await pool.query("SELECT COUNT(*) FILTER (WHERE rating=1)::int AS up, COUNT(*) FILTER (WHERE rating=-1)::int AS down FROM ai_feedback WHERE feature='support' AND created_at > NOW() - INTERVAL '30 days'")).rows[0];
    const recentDown = (await pool.query("SELECT question, answer, created_at FROM ai_feedback WHERE feature='support' AND rating=-1 ORDER BY created_at DESC LIMIT 5")).rows;
    const ratings = (await pool.query("SELECT COUNT(*) FILTER (WHERE rating=1)::int AS up, COUNT(*) FILTER (WHERE rating=-1)::int AS down FROM tickets WHERE rating IS NOT NULL")).rows[0];
    res.render('admin/support-faqs', { title: t(res)('adminSupport.title'), faqs, categories: FAQ_CATEGORIES, ai: { live: supportAI.enabled(), config: gateway.config('support-chat'), usage, feedback, recentDown, models: deps.supportModels }, ratings });
  }));
  const faqForm = (res, faq, status = 200) => res.status(status).render('admin/support-faq-form', { title: faq?.id ? t(res)('adminSupport.editFaq') : t(res)('adminSupport.newFaq'), faq, categories: FAQ_CATEGORIES });
  app.get('/admin/support/faqs/new', requireAdmin, (req, res) => faqForm(res, { category: 'general', sort_order: 0, is_published: true }));
  app.get('/admin/support/faqs/:id/edit', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT * FROM support_faqs WHERE id=$1', [req.params.id]);
    if (!r.rowCount) return notFound(res);
    faqForm(res, r.rows[0]);
  }));
  const faqValues = body => ({
    question: normalizeText(body.question, 300), question_en: normalizeText(body.question_en, 300),
    answer: String(body.answer || '').replace(/\r\n/g, '\n').trim().slice(0, 4000), answer_en: String(body.answer_en || '').replace(/\r\n/g, '\n').trim().slice(0, 4000),
    category: FAQ_CATEGORIES.includes(body.category) ? body.category : 'general',
    sort_order: Math.max(-10000, Math.min(10000, Number.parseInt(body.sort_order, 10) || 0)), is_published: body.is_published === 'on' || body.is_published === '1'
  });
  app.post('/admin/support/faqs', requireAdmin, asyncRoute(async (req, res) => {
    const v = faqValues(req.body);
    if (!v.question || !v.answer) { setFlash(req, 'error', t(res)('adminSupport.required')); return faqForm(res, v, 422); }
    await pool.query('INSERT INTO support_faqs(question,question_en,answer,answer_en,category,sort_order,is_published) VALUES($1,$2,$3,$4,$5,$6,$7)', [v.question, v.question_en, v.answer, v.answer_en, v.category, v.sort_order, v.is_published]);
    supportAI.invalidate();
    setFlash(req, 'success', t(res)('adminSupport.saved'));
    res.redirect('/admin/support/faqs');
  }));
  app.post('/admin/support/faqs/:id/edit', requireAdmin, asyncRoute(async (req, res) => {
    const v = faqValues(req.body);
    if (!v.question || !v.answer) { setFlash(req, 'error', t(res)('adminSupport.required')); return faqForm(res, { ...v, id: req.params.id }, 422); }
    const r = await pool.query('UPDATE support_faqs SET question=$1,question_en=$2,answer=$3,answer_en=$4,category=$5,sort_order=$6,is_published=$7,updated_at=NOW() WHERE id=$8 RETURNING id',
      [v.question, v.question_en, v.answer, v.answer_en, v.category, v.sort_order, v.is_published, req.params.id]);
    if (!r.rowCount) return notFound(res);
    supportAI.invalidate();
    setFlash(req, 'success', t(res)('adminSupport.saved'));
    res.redirect('/admin/support/faqs');
  }));
  app.post('/admin/support/faqs/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM support_faqs WHERE id=$1', [req.params.id]);
    supportAI.invalidate();
    setFlash(req, 'success', t(res)('adminSupport.deleted'));
    res.redirect('/admin/support/faqs');
  }));
}

module.exports = { registerSupportRoutes, TICKET_STATUSES, FAQ_CATEGORIES };
