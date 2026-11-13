-- AI assistant (Mabhas 17 Q&A): daily usage counters for the budget guard and opt-in answer feedback.
CREATE TABLE IF NOT EXISTS ai_usage (
  day DATE NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  fallbacks INTEGER NOT NULL DEFAULT 0,
  latency_ms_total BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, feature, model)
);

-- Stored only when a visitor presses 👍/👎; the question is already redacted (no phones, e-mails, IDs).
CREATE TABLE IF NOT EXISTS ai_feedback (
  id BIGSERIAL PRIMARY KEY,
  feature TEXT NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  question TEXT NOT NULL,
  answer TEXT,
  model TEXT,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_feedback_created_idx ON ai_feedback (created_at DESC);
