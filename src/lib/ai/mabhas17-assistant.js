'use strict';
/**
 * «دستیار مبحث ۱۷» — answers questions about Mabhas 17 with citations (retrieval-augmented generation).
 *
 * Knowledge comes from two places, both in the repo:
 *   data/mabhas17/chunks.json            the code text (page transcriptions), see knowledge-base.js
 *   data/mabhas17/expert-checklist.jsonl expert answers to the plan-review checklist (the "training" set),
 *                                        written and checked against the code pages by a reviewer
 * The model never decides on its own: it answers only from the retrieved sources, cites them, and the
 * page shows the sources so the user can verify. Without AI (flag off, no key, budget reached, provider
 * down) the feature still works: it returns the best-matching clauses and expert notes, no generated text.
 */
const fs = require('fs');
const path = require('path');
const { loadKnowledgeBase, tokenize } = require('./knowledge-base');
const { modelFor } = require('./models');
const { AiUnavailableError } = require('./gateway');
const { digitsEnglish } = require('../text');

/** Remove personal data before a question leaves the server: phones, e-mails, card / national-ID-like numbers. */
function redactText(text) {
  return digitsEnglish(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[ایمیل]')
    .replace(/(?:\+?98|0)?9\d{9}\b/g, '[موبایل]')
    .replace(/\b(?:\d[ -]?){16}\b/g, '[شماره کارت]')
    .replace(/\b\d{10}\b/g, '[شناسه]');
}

const ROOT = path.join(__dirname, '..', '..', '..');
const SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, 'prompts', 'mabhas17-assistant.md'), 'utf8');
const MAX_QUESTION = 600;

function loadExpertNotes(file = path.join(ROOT, 'data', 'mabhas17', 'expert-checklist.jsonl')) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(n => ({ ...n, tokens: new Set(tokenize(n.question + ' ' + n.answer)) }));
}

function topNotes(notes, question, k = 2) {
  const q = new Set(tokenize(question));
  if (!q.size) return [];
  return notes.map(n => { let s = 0; q.forEach(t => { if (n.tokens.has(t)) s += 1; }); return { n, s: s / Math.sqrt(n.tokens.size) }; })
    .filter(x => x.s > 0.12).sort((a, b) => b.s - a.s).slice(0, k).map(x => x.n);
}

const isEnglish = s => (s.match(/[A-Za-z]/g) || []).length > (s.match(/[؀-ۿ]/g) || []).length;

function sourceLabel(c) { return [c.clauses?.[0] ? `بند ${c.clauses[0]}` : null, c.page ? `صفحه ${c.page}` : `صفحهٔ PDF ${c.pdfPage}`].filter(Boolean).join('، '); }

function buildMessages(question, sources, notes, history = []) {
  const src = sources.map((c, i) => `[S${i + 1}] (${sourceLabel(c)}${c.heading ? ` — ${c.heading}` : ''})\n${c.text}`).join('\n\n---\n\n');
  const expert = notes.length ? `\n\nEXPERT NOTES (reviewed answers to similar plan-review questions; cite the code clause they name, not the note):\n${notes.map(n => `- Q: ${n.question}\n  A: ${n.answer}`).join('\n')}` : '';
  const msgs = [{ role: 'system', content: `${SYSTEM_PROMPT}\n\nSOURCES:\n${src || '(no source found)'}${expert}` }];
  history.slice(-4).forEach(h => msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 1500) }));
  msgs.push({ role: 'user', content: question });
  return msgs;
}

/**
 * @param {{ gateway: object, kb?: object, notes?: object[], env?: object }} deps
 */
function createMabhas17Assistant({ gateway, kb = loadKnowledgeBase(), notes = loadExpertNotes(), env = process.env } = {}) {
  async function retrieve(question) {
    let queryVector = null;
    const emb = modelFor('embeddings', env);
    if (gateway?.enabled() && kb?.meta.hasVectors && kb.meta.model === emb.model) {
      try {
        const [v] = await gateway.embed({ feature: 'mabhas17-embed', model: emb.model, input: [question], dimensions: kb.meta.dims });
        let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; queryVector = v.map(x => x / n);
      } catch (err) { if (!(err instanceof AiUnavailableError)) throw err; }
    }
    return { sources: kb ? kb.search(question, { k: 6, queryVector }) : [], notes: topNotes(notes, question), semantic: !!queryVector };
  }

  /** @returns {Promise<{ mode: 'ai'|'fallback', answer: string|null, sources: object[], notes: object[], model?: string, reason?: string }>} */
  async function ask(rawQuestion, { history = [], escalate = false } = {}) {
    const question = redactText(String(rawQuestion || '').replace(/\s+/g, ' ').trim()).slice(0, MAX_QUESTION);
    if (question.length < 3) return { mode: 'fallback', answer: null, sources: [], notes: [], reason: 'empty' };
    const { sources, notes: expert } = await retrieve(question);
    const publicSources = sources.map(c => ({ id: c.id, label: sourceLabel(c), page: c.page, pdfPage: c.pdfPage, clauses: c.clauses, heading: c.heading, excerpt: c.text.slice(0, 420) }));
    const publicNotes = expert.map(n => ({ id: n.id, question: n.question, answer: n.answer, refs: n.refs }));
    if (!gateway?.enabled()) return { mode: 'fallback', answer: null, sources: publicSources, notes: publicNotes, reason: 'disabled' };
    const m = modelFor(escalate ? 'mabhas17Escalate' : 'mabhas17Answer', env);
    try {
      const r = await gateway.chat({ feature: 'mabhas17-answer', model: m.model, messages: buildMessages(question, sources, expert, history), maxTokens: m.maxTokens, timeoutMs: m.timeoutMs });
      return { mode: 'ai', answer: r.text.trim(), sources: publicSources, notes: publicNotes, model: r.model, english: isEnglish(question) };
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
      return { mode: 'fallback', answer: null, sources: publicSources, notes: publicNotes, reason: err.reason };
    }
  }

  return { ask, retrieve, ready: () => !!kb, meta: () => ({ ...(kb?.meta || {}), expertNotes: notes.length }) };
}

module.exports = { createMabhas17Assistant, buildMessages, redactText, loadExpertNotes, topNotes, SYSTEM_PROMPT };
