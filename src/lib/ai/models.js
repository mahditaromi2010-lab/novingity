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
  embeddings: { env: 'AI_MODEL_EMBED', default: 'text-embedding-3-large', dims: 1024 },
  // Help centre (support). Picked by scripts/ai/eval-support.js on 2026-11-16 (docs/ai/support-model-evals.md):
  //  - answers: deepseek-v4.1-flash passed 26/26 cases and was the cheapest (~$0.08 per 1,000 questions);
  //  - triage: it returned no usable JSON (reasoning used the small token budget), so triage uses gpt-5.4-nano
  //    (10/10, cheapest of the models that passed); drafts use the answer model with more room.
  supportChat: { env: 'AI_MODEL_SUPPORT', default: 'deepseek-v4.1-flash', maxTokens: 700, timeoutMs: 30000 },
  supportTriage: { env: 'AI_MODEL_SUPPORT_TRIAGE', default: 'gpt-5.4-nano', maxTokens: 220, timeoutMs: 15000 },
  supportDraft: { env: 'AI_MODEL_SUPPORT_DRAFT', default: 'deepseek-v4.1-flash', maxTokens: 1000, timeoutMs: 40000 }
};

/** Candidates compared by scripts/ai/eval-support.js (all on GapGPT; cheapest first by list price). */
const SUPPORT_CANDIDATES = ['deepseek-v4.1-flash', 'claude-haiku-5-5', 'qwen3.8-flash', 'gpt-5.4-nano', 'gemini-3.1-flash-lite'];

function modelFor(feature, env = process.env) {
  const m = MODELS[feature];
  if (!m) throw new Error(`unknown AI feature ${feature}`);
  return { ...m, model: String(env[m.env] || m.default) };
}

module.exports = { MODELS, modelFor, SUPPORT_CANDIDATES };
