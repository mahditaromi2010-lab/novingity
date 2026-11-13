'use strict';
/**
 * Server-side AI gateway (OpenAI-compatible HTTP API — GapGPT by default).
 *
 * - The key lives only in the server environment (AI_API_KEY). It is never sent to the browser, logged or
 *   stored; errors are re-thrown without request headers.
 * - Every call has a timeout and at most one retry (network errors / 429 / 5xx).
 * - Kill switch: FEATURE_AI_ASSISTANT must be "true" and AI_API_KEY set, otherwise `enabled()` is false and
 *   callers use their non-AI fallback.
 * - Budget guard: a daily request ceiling (AI_DAILY_REQUEST_LIMIT) and token ceiling (AI_DAILY_TOKEN_LIMIT),
 *   counted in PostgreSQL (ai_usage) so all processes share it. When reached, callers fall back.
 * Models are chosen per feature in src/lib/ai/models.js from evals (docs/ai/mabhas17-model-evals.md).
 */
const DEFAULT_BASE_URL = 'https://api.gapapi.com/v1';

class AiUnavailableError extends Error {
  constructor(reason, detail) { super(`AI unavailable: ${reason}`); this.name = 'AiUnavailableError'; this.reason = reason; this.detail = detail; }
}

function aiConfig(env = process.env) {
  return {
    enabled: env.FEATURE_AI_ASSISTANT === 'true' && !!String(env.AI_API_KEY || '').trim(),
    baseUrl: String(env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    key: String(env.AI_API_KEY || '').trim(),
    dailyRequestLimit: positiveInt(env.AI_DAILY_REQUEST_LIMIT, 500),
    dailyTokenLimit: positiveInt(env.AI_DAILY_TOKEN_LIMIT, 3_000_000)
  };
}
function positiveInt(v, d) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; }

function createGateway({ pool, env = process.env, fetchImpl = globalThis.fetch, logger = null } = {}) {
  const cfg = () => aiConfig(env);

  async function usageToday(feature) {
    if (!pool) return { requests: 0, tokens: 0 };
    const r = await pool.query("SELECT COALESCE(SUM(requests),0)::int AS requests, COALESCE(SUM(prompt_tokens + completion_tokens),0)::bigint AS tokens FROM ai_usage WHERE day = CURRENT_DATE AND ($1::text IS NULL OR feature = $1)", [feature || null]);
    return { requests: Number(r.rows[0].requests), tokens: Number(r.rows[0].tokens) };
  }

  async function record(feature, model, { promptTokens = 0, completionTokens = 0, fallback = false, latencyMs = 0 } = {}) {
    if (!pool) return;
    try {
      await pool.query(`INSERT INTO ai_usage (day, feature, model, requests, prompt_tokens, completion_tokens, fallbacks, latency_ms_total)
        VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (day, feature, model) DO UPDATE SET requests = ai_usage.requests + EXCLUDED.requests,
          prompt_tokens = ai_usage.prompt_tokens + EXCLUDED.prompt_tokens, completion_tokens = ai_usage.completion_tokens + EXCLUDED.completion_tokens,
          fallbacks = ai_usage.fallbacks + EXCLUDED.fallbacks, latency_ms_total = ai_usage.latency_ms_total + EXCLUDED.latency_ms_total`,
        [feature, model || '-', fallback ? 0 : 1, promptTokens, completionTokens, fallback ? 1 : 0, Math.round(latencyMs)]);
    } catch (err) { logger?.warn?.('ai usage not recorded', { error: err.message }); }
  }

  async function assertBudget() {
    const c = cfg();
    if (!c.enabled) throw new AiUnavailableError('disabled');
    let u;
    try { u = await usageToday(null); } catch (err) {
      logger?.warn?.('ai budget check failed', { error: err.message });
      throw new AiUnavailableError('budget_check'); // no usage table / DB hiccup → fall back, never a 500
    }
    if (u.requests >= c.dailyRequestLimit || u.tokens >= c.dailyTokenLimit) throw new AiUnavailableError('budget');
  }

  async function post(path, body, timeoutMs) {
    const c = cfg();
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(`${c.baseUrl}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (res.ok) return await res.json();
        lastErr = new AiUnavailableError(`http_${res.status}`);
        if (!(res.status === 429 || res.status >= 500)) break;
      } catch (err) {
        lastErr = new AiUnavailableError(err.name === 'TimeoutError' ? 'timeout' : 'network', err.message);
      }
      await new Promise(r => setTimeout(r, 600));
    }
    throw lastErr;
  }

  /** Chat completion. Returns { text, model, usage }. Throws AiUnavailableError. */
  async function chat({ feature, model, messages, maxTokens = 1200, temperature = 0.2, timeoutMs = 45000, reasoningEffort }) {
    await assertBudget();
    const started = Date.now();
    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    let d;
    try { d = await post('/chat/completions', body, timeoutMs); } catch (err) { await record(feature, model, { fallback: true }); throw err; }
    const text = d?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) { await record(feature, model, { fallback: true }); throw new AiUnavailableError('empty'); }
    const usage = { promptTokens: Number(d.usage?.prompt_tokens) || 0, completionTokens: Number(d.usage?.completion_tokens) || 0 };
    await record(feature, model, { ...usage, latencyMs: Date.now() - started });
    return { text, model: d.model || model, usage };
  }

  /** Embeddings for one or more texts. Returns Float32Array[]. */
  async function embed({ feature = 'embeddings', model, input, dimensions, timeoutMs = 20000 }) {
    await assertBudget();
    const started = Date.now();
    const body = { model, input };
    if (dimensions) body.dimensions = dimensions;
    let d;
    try { d = await post('/embeddings', body, timeoutMs); } catch (err) { await record(feature, model, { fallback: true }); throw err; }
    const vectors = (d?.data || []).sort((a, b) => a.index - b.index).map(x => Float32Array.from(x.embedding));
    if (!vectors.length) throw new AiUnavailableError('empty');
    await record(feature, model, { promptTokens: Number(d.usage?.prompt_tokens) || 0, latencyMs: Date.now() - started });
    return vectors;
  }

  return { enabled: () => cfg().enabled, chat, embed, usageToday, record, config: () => { const { key, ...rest } = cfg(); return { ...rest, keyConfigured: !!key }; } };
}

module.exports = { createGateway, aiConfig, AiUnavailableError, DEFAULT_BASE_URL };
