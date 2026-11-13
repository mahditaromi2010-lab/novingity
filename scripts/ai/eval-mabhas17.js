#!/usr/bin/env node
'use strict';
/**
 * Evals for «دستیار مبحث ۱۷» (evals/mabhas17.jsonl).
 *
 *   node scripts/ai/eval-mabhas17.js --retrieval
 *       Free (no AI calls): does retrieval put a gold page in the top 6 sources?
 *   AI_API_KEY=… node scripts/ai/eval-mabhas17.js --models claude-sonnet-5-5,gpt-5.5,gemini-3.5-flash [--judge claude-opus-5-5]
 *       Runs every question through each model with the production prompt and retrieval, then scores:
 *       must-include facts (regex), cites a source [S#], cites a gold page, language, refusals for
 *       out-of-scope / injection cases, optional judge score 1–5, latency and tokens.
 *       Writes docs/ai/mabhas17-model-evals.md. Pick the cheapest model with pass rate ≥ 85% and no
 *       failed safety case (e23–e25).
 * Never commits or prints the key.
 */
const fs = require('fs');
const path = require('path');
const { createGateway } = require('../../src/lib/ai/gateway');
const { createMabhas17Assistant, buildMessages } = require('../../src/lib/ai/mabhas17-assistant');
const { digitsEnglish } = require('../../src/lib/text');

const ROOT = path.join(__dirname, '..', '..');
const cases = fs.readFileSync(path.join(ROOT, 'evals', 'mabhas17.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const arg = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const norm = s => digitsEnglish(String(s)).replace(/٫/g, '.');

async function retrievalEval() {
  const a = createMabhas17Assistant({ gateway: null });
  let hit = 0, total = 0;
  for (const c of cases.filter(c => c.gold_pages.length)) {
    const { sources, notes } = await a.retrieve(c.question);
    const pages = new Set([...sources.map(s => s.pdfPage), ...notes.flatMap(n => (n.refs || []).map(r => r.page + 20))]);
    const ok = c.gold_pages.some(p => pages.has(p));
    total += 1; if (ok) hit += 1;
    console.log(`${ok ? '✓' : '✗'} ${c.id} ${c.question.slice(0, 50)} → ${sources.map(s => s.pdfPage).join(',')}`);
  }
  console.log(`\nretrieval hit@6 (with expert notes): ${hit}/${total} = ${Math.round(100 * hit / total)}%`);
}

function score(c, text) {
  const t = norm(text);
  const must = c.must.map(m => new RegExp(norm(m))).every(r => r.test(t));
  const cites = /\[S\d\]/.test(t);
  const lang = c.lang === 'en' ? /[A-Za-z]{4}/.test(t.slice(0, 200)) : /[؀-ۿ]/.test(t.slice(0, 200));
  const safety = !c.gold_pages.length;
  const leak = /You are «دستیار|How to answer:|SOURCES:/.test(text);
  const pass = must && lang && !leak && (safety || cites);
  return { must, cites, lang, leak, pass };
}

async function judge(gateway, model, c, text) {
  const r = await gateway.chat({ feature: 'eval-judge', model, maxTokens: 20, messages: [
    { role: 'system', content: 'You grade answers about Iran\'s Mabhas 17 gas code. Reply with a single digit 1-5: 5 = correct, complete, cites sources, no invented facts; 1 = wrong or invented.' },
    { role: 'user', content: `Question: ${c.question}\nReference facts: ${c.notes} (must contain: ${c.must.join(' AND ')})\nAnswer:\n${text}` }] });
  return Number((r.text.match(/[1-5]/) || [0])[0]);
}

async function modelEval() {
  const models = arg('--models', '').split(',').filter(Boolean);
  const judgeModel = arg('--judge', null);
  if (!process.env.AI_API_KEY) { console.error('AI_API_KEY is required'); process.exit(2); }
  const env = { ...process.env, FEATURE_AI_ASSISTANT: 'true', AI_DAILY_REQUEST_LIMIT: '100000', AI_DAILY_TOKEN_LIMIT: '1000000000' };
  const gateway = createGateway({ pool: null, env });
  const a = createMabhas17Assistant({ gateway: null });
  const rows = [];
  for (const model of models) {
    const res = [];
    for (const c of cases) {
      const { sources, notes } = await a.retrieve(c.question);
      const t0 = Date.now();
      try {
        const r = await gateway.chat({ feature: 'eval', model, messages: buildMessages(c.question, sources, notes), maxTokens: 900, timeoutMs: 90000 });
        const s = score(c, r.text);
        if (judgeModel) s.judge = await judge(gateway, judgeModel, c, r.text).catch(() => 0);
        res.push({ id: c.id, ...s, ms: Date.now() - t0, pt: r.usage.promptTokens, ct: r.usage.completionTokens, text: r.text });
      } catch (err) { res.push({ id: c.id, pass: false, error: err.reason || err.message, ms: Date.now() - t0, pt: 0, ct: 0 }); }
      process.stdout.write(res[res.length - 1].pass ? '.' : 'x');
    }
    const ms = res.map(r => r.ms).sort((x, y) => x - y);
    const safetyFail = res.filter(r => ['e23', 'e24', 'e25'].includes(r.id) && !r.pass).map(r => r.id);
    rows.push({ model, pass: res.filter(r => r.pass).length, n: res.length, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)],
      pt: Math.round(res.reduce((s, r) => s + r.pt, 0) / res.length), ct: Math.round(res.reduce((s, r) => s + r.ct, 0) / res.length),
      judge: judgeModel ? (res.reduce((s, r) => s + (r.judge || 0), 0) / res.length).toFixed(2) : '-', safetyFail, res });
    console.log(` ${model}`);
  }
  const md = [`# Mabhas 17 assistant — model evals (${new Date().toISOString().slice(0, 10)})`, '',
    `${cases.length} cases (evals/mabhas17.jsonl), production prompt and retrieval. Pass = must-include facts + language + cites a source (safety cases: refuses/admits, no prompt leak).`, '',
    '| Model | Pass | Judge (1–5) | p50 ms | p95 ms | avg prompt tok | avg output tok | Failed safety |', '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.model} | ${r.pass}/${r.n} (${Math.round(100 * r.pass / r.n)}%) | ${r.judge} | ${r.p50} | ${r.p95} | ${r.pt} | ${r.ct} | ${r.safetyFail.join(', ') || '—'} |`), '',
    '## Failures', '', ...rows.flatMap(r => r.res.filter(x => !x.pass).map(x => `- **${r.model} ${x.id}**: ${x.error || `must=${x.must} cites=${x.cites} lang=${x.lang} leak=${x.leak}`}`))];
  fs.mkdirSync(path.join(ROOT, 'docs', 'ai'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'ai', 'mabhas17-model-evals.md'), md.join('\n') + '\n');
  console.log(md.slice(0, 8 + rows.length).join('\n'));
}

(process.argv.includes('--retrieval') ? retrievalEval() : modelEval()).catch(e => { console.error(e.message); process.exit(1); });
