#!/usr/bin/env node
'use strict';
/**
 * Adds embeddings to data/mabhas17/chunks.json → data/mabhas17/vectors.bin (Float32, L2-normalised).
 *   AI_API_KEY=… node scripts/ai/embed-mabhas17.js [model] [dims]
 * Default model/dims come from src/lib/ai/models.js (embeddings). ~300k tokens for the whole book.
 * Retrieval works without this file (keyword search); vectors add meaning-based matches (synonyms, English).
 */
const fs = require('fs');
const path = require('path');
const { createGateway } = require('../../src/lib/ai/gateway');
const { modelFor } = require('../../src/lib/ai/models');

const DIR = path.join(__dirname, '..', '..', 'data', 'mabhas17');
(async () => {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'chunks.json'), 'utf8'));
  const def = modelFor('embeddings');
  const model = process.argv[2] || def.model;
  const dims = Number(process.argv[3] || def.dims);
  const gateway = createGateway({ pool: null, env: { ...process.env, FEATURE_AI_ASSISTANT: 'true', AI_DAILY_REQUEST_LIMIT: '100000', AI_DAILY_TOKEN_LIMIT: '1000000000' } });
  const out = new Float32Array(meta.chunks.length * dims);
  for (let i = 0; i < meta.chunks.length; i += 64) {
    const batch = meta.chunks.slice(i, i + 64).map(c => `${c.heading || ''}\n${c.text}`.slice(0, 6000));
    const vecs = await gateway.embed({ model, input: batch, dimensions: dims, timeoutMs: 120000 });
    vecs.forEach((v, j) => {
      if (v.length !== dims) throw new Error(`model returned ${v.length} dims, expected ${dims}`);
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
      out.set(v.map(x => x / n), (i + j) * dims);
    });
    process.stdout.write(`${Math.min(i + 64, meta.chunks.length)}/${meta.chunks.length}\r`);
  }
  fs.writeFileSync(path.join(DIR, 'vectors.bin'), Buffer.from(out.buffer));
  meta.embeddingModel = model; meta.dims = dims;
  fs.writeFileSync(path.join(DIR, 'chunks.json'), JSON.stringify(meta));
  console.log(`\nwrote ${meta.chunks.length} vectors (${model}, ${dims} dims)`);
})().catch(e => { console.error(e.reason || e.message); process.exit(1); });
