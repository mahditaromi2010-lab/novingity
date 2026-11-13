'use strict';
/**
 * Model per feature. Chosen by evals (scripts/ai/eval-mabhas17.js → docs/ai/mabhas17-model-evals.md): the cheapest
 * model that passes the threshold wins. Each value can be overridden by an env var without a code change.
 *
 * Until the evals have run with credit, the defaults are the provisional picks from the transcription test
 * (Persian accuracy): claude-sonnet-5-5 answers, a small fast model rewrites queries, text-embedding-3-large embeds.
 */
const MODELS = {
  mabhas17Answer: { env: 'AI_MODEL_ANSWER', default: 'claude-sonnet-5-5', maxTokens: 900, timeoutMs: 45000 },
  mabhas17Escalate: { env: 'AI_MODEL_ESCALATE', default: 'claude-opus-5-5', maxTokens: 1400, timeoutMs: 70000 },
  embeddings: { env: 'AI_MODEL_EMBED', default: 'text-embedding-3-large', dims: 1024 }
};

function modelFor(feature, env = process.env) {
  const m = MODELS[feature];
  if (!m) throw new Error(`unknown AI feature ${feature}`);
  return { ...m, model: String(env[m.env] || m.default) };
}

module.exports = { MODELS, modelFor };
