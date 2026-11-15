#!/usr/bin/env node
'use strict';
/**
 * Picks the model for the help-centre assistant: runs evals/support.jsonl against each candidate model through the
 * real prompt + retrieval (knowledge from evals/support-kb.json), grades every answer with deterministic checks
 * and writes docs/ai/support-model-evals.md. The cheapest model that passes the threshold should become the
 * default in src/lib/ai/models.js (or AI_MODEL_SUPPORT on the server).
 *
 *   node scripts/ai/eval-support.js --retrieval                 # free: checks that the right FAQ/product is found
 *   AI_API_KEY=... node scripts/ai/eval-support.js              # all candidates (models.js SUPPORT_CANDIDATES)
 *   AI_API_KEY=... node scripts/ai/eval-support.js --models claude-haiku-5-5,deepseek-v4.1-flash
 *
 * Checks per case: language, must / mustNot patterns, cites a source when expected, hand-off token when a human
 * must act, admits not knowing when the answer is not in the sources. Prices per 1M tokens are passed with
 * --prices model=in/out,... (USD) to estimate cost per 1,000 questions from the token counts the provider reports.
 */
const fs = require('fs');
const path = require('path');
const { createGateway } = require('../../src/lib/ai/gateway');
const { createSupportAssistant, retrieve, prepare } = require('../../src/lib/ai/support-assistant');
const { SUPPORT_CANDIDATES } = require('../../src/lib/ai/models');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const kb = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'support-kb.json'), 'utf8'));
const cases = fs.readFileSync(path.join(ROOT, 'evals', 'support.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const THRESHOLD = Number(opt('--threshold') || 0.85);

const UNKNOWN = /(اطلاعات[یی]? (در این مورد )?ندارم|اطلاعی ندارم|در منابع .*نیست|پیدا نکردم|don't have (that|this) information|not in (the|my) sources|I don't know|no information)/i;
const isEnglish = s => (s.match(/[A-Za-z]/g) || []).length > (s.match(/[؀-ۿ]/g) || []).length;

function grade(c, r) {
  const fails = [];
  const a = r.answer || '';
  if (r.mode !== 'ai') return ['no AI answer: ' + (r.reason || 'fallback')];
  if (c.lang === 'en' && !isEnglish(a)) fails.push('language');
  if (c.lang === 'fa' && isEnglish(a)) fails.push('language');
  for (const p of c.must || []) if (!new RegExp(p, 'i').test(a)) fails.push(`missing /${p}/`);
  for (const p of c.mustNot || []) if (new RegExp(p, 'i').test(a)) fails.push(`forbidden /${p}/`);
  if (c.cite && !/\[[FP]\d+\]/.test(a)) fails.push('no citation');
  if (c.handoff === true && !r.handoff) fails.push('no hand-off');
  if (c.handoff === false && r.handoff) fails.push('unneeded hand-off');
  if (c.admitUnknown && !UNKNOWN.test(a) && !r.handoff) fails.push('did not admit unknown');
  return fails;
}

async function retrievalOnly() {
  const k = prepare(kb);
  const expectations = { s01: 'F', s04: 'P', s05: 'P', s11: 'F', s14: 'F', s18: 'F', s20: 'P', s26: 'F' };
  let ok = 0;
  for (const [id, kind] of Object.entries(expectations)) {
    const c = cases.find(x => x.id === id);
    const f = retrieve(k, c.q);
    const hit = kind === 'F' ? f.faqs.length > 0 : f.products.length > 0;
    if (hit) ok++;
    console.log(`${hit ? 'ok  ' : 'MISS'} ${id} ${c.q} → ${f.faqs.map(x => 'F' + x.id).join(',')} ${f.products.map(x => 'P' + x.id).join(',')}`);
  }
  console.log(`retrieval ${ok}/${Object.keys(expectations).length}`);
}

async function main() {
  if (args.includes('--retrieval')) return retrievalOnly();
  if (!process.env.AI_API_KEY) { console.error('AI_API_KEY is required for model evals (use --retrieval for the free check).'); process.exit(2); }
  const models = (opt('--models') || SUPPORT_CANDIDATES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const prices = Object.fromEntries((opt('--prices') || '').split(',').filter(Boolean).map(x => { const [m, p] = x.split('='); const [i, o] = p.split('/').map(Number); return [m, { in: i, out: o }]; }));
  const rows = [];
  for (const model of models) {
    const env = { ...process.env, FEATURE_AI_SUPPORT: 'true', AI_MODEL_SUPPORT: model, AI_DAILY_REQUEST_LIMIT: '100000', AI_DAILY_TOKEN_LIMIT: '100000000' };
    const usage = { prompt: 0, completion: 0, n: 0 };
    const base = createGateway({ env });
    const gateway = { ...base, chat: async a => { const r = await base.chat(a); usage.prompt += r.usage.promptTokens; usage.completion += r.usage.completionTokens; usage.n++; return r; } };
    const assistant = createSupportAssistant({ gateway, env, loadRows: async () => kb });
    let pass = 0; const lat = []; const failures = [];
    for (const c of cases) {
      const t0 = Date.now();
      let r;
      try { r = await assistant.ask(c.q, { locale: c.lang }); } catch (err) { r = { mode: 'error', reason: err.message }; }
      lat.push(Date.now() - t0);
      const f = grade(c, r);
      if (!f.length) pass++; else failures.push({ id: c.id, f, answer: (r.answer || '').slice(0, 300) });
      process.stdout.write(f.length ? 'x' : '.');
    }
    // Ticket triage: category must match, priority must be one of the accepted levels.
    const triageCases = fs.readFileSync(path.join(ROOT, 'evals', 'support-triage.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const triEnv = { ...env, AI_MODEL_SUPPORT_TRIAGE: model };
    const tri = createSupportAssistant({ gateway, env: triEnv, loadRows: async () => kb });
    let triPass = 0; const triFail = [];
    for (const c of triageCases) {
      const r = await tri.triage({ subject: c.subject, message: c.message, category: 'other', priority: 'normal' }).catch(err => ({ error: err.message }));
      const cats = [].concat(c.category);
      const ok = r.model && cats.includes(r.category) && c.priority.includes(r.priority);
      if (ok) triPass++; else triFail.push({ id: c.id, f: [`got ${r.category}/${r.priority}${r.model ? '' : ' (rules fallback)'}`], answer: r.summary || '' });
    }
    failures.push(...triFail);
    lat.sort((a, b) => a - b);
    const p = prices[model];
    const per1k = p && usage.n ? ((usage.prompt / usage.n) * p.in + (usage.completion / usage.n) * p.out) / 1000 : null;
    rows.push({ model, triPass, triTotal: triageCases.length, pass, total: cases.length, rate: pass / cases.length, p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)] || lat[lat.length - 1],
      avgIn: usage.n ? Math.round(usage.prompt / usage.n) : 0, avgOut: usage.n ? Math.round(usage.completion / usage.n) : 0, per1k, failures });
    console.log(` ${model}: answers ${pass}/${cases.length}, triage ${triPass}/${triageCases.length}`);
  }
  const passing = rows.filter(r => r.rate >= THRESHOLD && r.triPass / r.triTotal >= 0.8).sort((a, b) => (a.per1k ?? Infinity) - (b.per1k ?? Infinity));
  const md = [
    '# Help-centre assistant — model evals', '',
    `Run: ${new Date().toISOString().slice(0, 10)} · cases: ${cases.length} (evals/support.jsonl) · threshold: ${Math.round(THRESHOLD * 100)}%`, '',
    '| Model | Answers pass | Triage pass | p50 ms | p95 ms | avg tokens in/out | USD per 1,000 questions |', '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.model} | ${r.pass}/${r.total} (${Math.round(r.rate * 100)}%) | ${r.triPass}/${r.triTotal} | ${r.p50} | ${r.p95} | ${r.avgIn}/${r.avgOut} | ${r.per1k == null ? 'n/a (no --prices)' : r.per1k.toFixed(3)} |`), '',
    `**Pick (answers + triage with one model):** ${passing[0] ? passing[0].model : 'none — pick per feature below'}`,
    `**Answers:** ${(rows.filter(r => r.rate >= THRESHOLD).sort((a, b) => (a.per1k ?? Infinity) - (b.per1k ?? Infinity))[0] || {}).model || 'none'} · **Triage:** ${(rows.filter(r => r.triPass / r.triTotal >= 0.8).sort((a, b) => (a.per1k ?? Infinity) - (b.per1k ?? Infinity))[0] || {}).model || 'none'} (cheapest that passes each)`, '',
    '## Failures', ...rows.flatMap(r => [`### ${r.model}`, ...r.failures.map(f => `- ${f.id}: ${f.f.join('; ')} — «${f.answer.replace(/\n/g, ' ')}»`)])
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'docs', 'ai', 'support-model-evals.md'), md + '\n');
  console.log('\nwrote docs/ai/support-model-evals.md');
}

main().catch(err => { console.error(err); process.exit(1); });
