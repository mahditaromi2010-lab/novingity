'use strict';
/**
 * Mabhas 17 knowledge base (Iranian National Building Regulations, Part 17 — natural gas systems, 5th ed. 1403).
 *
 * data/mabhas17/chunks.json   — clause-aware text chunks with printed page numbers (built by
 *                               scripts/ai/build-mabhas17-index.js from the page transcriptions)
 * data/mabhas17/vectors.bin   — Float32 embeddings, one row per chunk (same order), dims in chunks.json
 *
 * Retrieval is hybrid: BM25 keyword scores (works with no AI at all — the fallback) merged with vector
 * similarity by reciprocal-rank fusion, plus an exact boost when the question names a clause number.
 */
const fs = require('fs');
const path = require('path');
const { normalizePersianSearch, digitsEnglish } = require('../text');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data', 'mabhas17');
const STOP = new Set('و در به از که این را با برای است یا تا بر آن هر باید شود می نمی ها های هم اگر چه چند کدام آیا چیست چگونه چطور یک دو نیز شده ای اند بود باشد باشند کند کنند داشته دارد گاز'.split(' '));

/** Clause numbers in any notation → canonical "17-4-10-3-1". Persian-order "۱-۳-۱۰-۴-۱۷" is reversed. */
function canonicalClauses(text) {
  const s = digitsEnglish(text);
  const out = new Set();
  for (const m of s.matchAll(/\b\d{1,2}(?:\s*[-‐–.]\s*\d{1,2}){1,6}\b/g)) {
    const parts = m[0].split(/\s*[-‐–.]\s*/).map(Number);
    if (parts[0] === 17) out.add(parts.join('-'));
    else if (parts[parts.length - 1] === 17) out.add(parts.reverse().join('-'));
  }
  return [...out];
}

// English → Persian code terms, so keyword search (the no-AI fallback) also works for English questions.
const EN_FA = { meter: 'کنتور', meters: 'کنتور', height: 'ارتفاع', valve: 'شیر', valves: 'شیر', pipe: 'لوله', pipes: 'لوله', piping: 'لوله‌کشی',
  chimney: 'دودکش', flue: 'دودکش', vent: 'دودکش', air: 'هوا', combustion: 'احتراق', earthquake: 'زلزله', seismic: 'زلزله', sleeve: 'غلاف',
  support: 'تکیه‌گاه بست', supports: 'تکیه‌گاه بست', bracket: 'بست', floor: 'کف', diameter: 'قطر', sizing: 'تعیین قطر', substitute: 'جانشین',
  detector: 'آشکارساز', carbon: 'مونوکسید', monoxide: 'مونوکسید', heater: 'آبگرمکن بخاری', boiler: 'پکیج', cooker: 'اجاق', stove: 'اجاق',
  parking: 'پارکینگ', window: 'پنجره', opening: 'دریچه بازشو', distance: 'فاصله', isometric: 'ایزومتریک', drawing: 'نقشه', regulator: 'رگولاتور',
  riser: 'علمک', collector: 'کلکتور', building: 'ساختمان', commercial: 'تجاری', bakery: 'نانوایی تجاری', residential: 'مسکونی' };
function expandEnglish(text) {
  return text.replace(/[A-Za-z]+/g, w => EN_FA[w.toLowerCase()] ? `${w} ${EN_FA[w.toLowerCase()]}` : w);
}

function tokenize(text) {
  text = expandEnglish(String(text));
  return normalizePersianSearch(digitsEnglish(text)).toLowerCase()
    .replace(/[‌]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(t => t.length > 1 && !STOP.has(t));
}

function loadKnowledgeBase(dir = DATA_DIR) {
  const file = path.join(dir, 'chunks.json');
  if (!fs.existsSync(file)) return null;
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  const chunks = meta.chunks;
  let vectors = null;
  const vfile = path.join(dir, 'vectors.bin');
  if (meta.dims && fs.existsSync(vfile)) {
    const buf = fs.readFileSync(vfile);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (all.length === chunks.length * meta.dims) vectors = chunks.map((_, i) => all.subarray(i * meta.dims, (i + 1) * meta.dims));
  }
  // BM25 index
  const docs = chunks.map(c => tokenize(`${c.heading || ''} ${c.text}`));
  const df = new Map();
  docs.forEach(toks => new Set(toks).forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(docs.length, 1);
  const tfs = docs.map(toks => { const m = new Map(); toks.forEach(t => m.set(t, (m.get(t) || 0) + 1)); return m; });
  const N = docs.length;

  function bm25(query) {
    const q = [...new Set(tokenize(query))];
    const scores = new Float64Array(N);
    for (const t of q) {
      const n = df.get(t); if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      for (let i = 0; i < N; i++) {
        const f = tfs[i].get(t); if (!f) continue;
        scores[i] += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avgLen));
      }
    }
    return scores;
  }

  function rank(scores) { return [...scores.keys()].filter(i => scores[i] > 0).sort((a, b) => scores[b] - scores[a]); }

  /**
   * @param {string} query
   * @param {{ k?: number, queryVector?: Float32Array|null }} opts
   */
  function search(query, { k = 6, queryVector = null } = {}) {
    const fused = new Map();
    const add = (list, weight) => list.slice(0, 40).forEach((i, r) => fused.set(i, (fused.get(i) || 0) + weight / (60 + r)));
    add(rank(bm25(query)), 1);
    if (queryVector && vectors) {
      const sims = vectors.map(v => { let s = 0; for (let j = 0; j < v.length; j++) s += v[j] * queryVector[j]; return s; });
      add([...sims.keys()].sort((a, b) => sims[b] - sims[a]), 1.3);
    }
    const asked = canonicalClauses(query);
    if (asked.length) chunks.forEach((c, i) => { if ((c.clauses || []).some(cl => asked.some(a => cl === a || cl.startsWith(a + '-')))) fused.set(i, (fused.get(i) || 0) + 0.05); });
    return [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i, score]) => ({ ...chunks[i], score }));
  }

  return { meta: { edition: meta.edition, model: meta.embeddingModel, dims: meta.dims, count: N, hasVectors: !!vectors }, chunks, search };
}

module.exports = { loadKnowledgeBase, canonicalClauses, tokenize, DATA_DIR };
