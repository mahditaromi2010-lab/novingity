#!/usr/bin/env node
'use strict';
/**
 * Builds data/mabhas17/chunks.json from per-page transcriptions of Mabhas 17 (5th ed., 1403).
 *
 *   node scripts/ai/build-mabhas17-chunks.js <pages-dir> [--vision <vision-dir>]
 *
 * <pages-dir>   Tesseract output, one file per PDF page: p-001.txt … (free OCR, always available)
 * --vision      Optional AI transcriptions (pNNN.json from scripts/ai/transcribe-pages.py). When a page has
 *               one, it replaces the OCR text (clean clause numbers and tables).
 *
 * Each page is split at clause starts into chunks of ~350–900 characters; every chunk keeps its PDF page,
 * printed page number, the chapter/section heading in force and the clause numbers it contains.
 * Embeddings are added separately (scripts/ai/embed-mabhas17.js) because that step needs AI credit.
 */
const fs = require('fs');
const path = require('path');
const { digitsEnglish } = require('../../src/lib/text');

const args = process.argv.slice(2);
const pagesDir = args[0];
const visionDir = args.includes('--vision') ? args[args.indexOf('--vision') + 1] : null;
if (!pagesDir) { console.error('usage: build-mabhas17-chunks.js <pages-dir> [--vision <dir>]'); process.exit(2); }
const OUT = path.join(__dirname, '..', '..', 'data', 'mabhas17', 'chunks.json');

/** Tesseract reads "۱۷-۴-۱۰-۳-۱" right-to-left and often loses the "1" of 17 or the dashes: repair it. */
function repairClause(raw) {
  let parts = digitsEnglish(raw).replace(/\s+/g, '').split(/-+/).filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (/^1?7$/.test(last)) parts[parts.length - 1] = '17';
  else if (/7$/.test(last) && last.length >= 3) {
    // merged tail such as "1047" = "10-4-17" or "47" = "4-17": the digit before 7 (or 17) is the chapter
    const rest = last.replace(/1?7$/, '');
    parts.splice(parts.length - 1, 1, ...(rest.length > 1 ? [rest.slice(0, -1), rest.slice(-1)] : [rest]), '17');
  } else return null;
  parts = parts.reverse();
  if (parts.length < 2 || parts.some(p => !/^\d{1,2}$/.test(p))) return null;
  return parts.join('-');
}

function pageInfo(n) {
  const vf = visionDir && path.join(visionDir, `p${String(n).padStart(3, '0')}.json`);
  if (vf && fs.existsSync(vf)) {
    const t = JSON.parse(fs.readFileSync(vf, 'utf8')).text.replace(/^```\w*\n?|```$/gm, '').trim();
    const m = /^PAGE:\s*(\S+)/m.exec(t);
    return { source: 'vision', printed: m && /^\d+$/.test(m[1]) ? Number(m[1]) : null, text: t.replace(/^PAGE:.*$/m, '').trim() };
  }
  const f = path.join(pagesDir, `p-${String(n).padStart(3, '0')}.txt`);
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split('\n').map(l => l.replace(/\s+$/, ''));
  // printed page number: the last short all-digit line
  let printed = null;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    const d = digitsEnglish(lines[i]).trim();
    if (/^\d{1,3}$/.test(d)) { printed = Number(d); lines.splice(i, 1); break; }
  }
  const out = lines.map(l => {
    const m = /^\s*([۰-۹0-9][۰-۹0-9\s-]*[۰-۹0-9])(\s+)(.*)$/.exec(l);
    if (!m || !/-/.test(m[1])) return l;
    const c = repairClause(m[1]);
    return c ? `${c} ${m[3]}` : l;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { source: 'ocr', printed, text: out };
}

const CLAUSE_AT_LINE = /^(?:#+\s*)?(17(?:-\d{1,2}){1,6})\b/;
const chunks = [];
let heading = '';
const total = fs.readdirSync(pagesDir).filter(f => /^p-\d{3}\.txt$/.test(f)).length;
for (let n = 1; n <= total; n++) {
  const p = pageInfo(n);
  // PDF pages 1–20 are the cover, preface and table of contents: they only add noise to retrieval.
  if (n <= 20) continue;
  if (!p || p.text.length < 40 || /^EMPTY$/m.test(p.text)) continue;
  const lines = p.text.split('\n');
  let buf = []; let bufClauses = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text.length >= 40) chunks.push({ id: `p${n}-${chunks.length}`, pdfPage: n, page: p.printed, heading, clauses: [...new Set(bufClauses)], text, source: p.source });
    buf = []; bufClauses = [];
  };
  for (const line of lines) {
    const m = CLAUSE_AT_LINE.exec(line.trim());
    const isHeading = m && m[1].split('-').length <= 3 && line.trim().length < 90;
    if (m && buf.join('\n').length > 550) flush();
    if (isHeading) heading = line.replace(/^#+\s*/, '').trim();
    if (m) bufClauses.push(m[1]);
    buf.push(line);
    if (buf.join('\n').length > 1100) flush();
  }
  flush();
}
// merge tiny neighbours on the same page
const merged = [];
for (const c of chunks) {
  const prev = merged[merged.length - 1];
  if (prev && prev.pdfPage === c.pdfPage && prev.text.length + c.text.length < 700) { prev.text += '\n' + c.text; prev.clauses = [...new Set([...prev.clauses, ...c.clauses])]; }
  else merged.push(c);
}
// Printed page numbers read by OCR are noisy (lost or misread digits). The book's body (PDF page 21 onwards,
// checked on pages 95, 140, 165, 230 and 255) is numbered continuously with printed page = PDF page − 20; the
// front matter has no usable number.
const PAGE_OFFSET = 20;
merged.forEach(c => { c.page = c.pdfPage > PAGE_OFFSET ? c.pdfPage - PAGE_OFFSET : null; });
merged.forEach((c, i) => { c.id = `m17-${String(i + 1).padStart(4, '0')}`; });
const meta = { edition: 'مبحث هفدهم مقررات ملی ساختمان — ویرایش پنجم ۱۴۰۳ (سامانه گاز طبیعی در ساختمان)', builtAt: new Date().toISOString().slice(0, 10), embeddingModel: null, dims: 0, chunks: merged };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(meta, null, 0));
const bySource = merged.reduce((m, c) => { m[c.source] = (m[c.source] || 0) + 1; return m; }, {});
console.log(`chunks: ${merged.length}`, bySource, `avg chars: ${Math.round(merged.reduce((s, c) => s + c.text.length, 0) / merged.length)}`, `with clauses: ${merged.filter(c => c.clauses.length).length}`);
