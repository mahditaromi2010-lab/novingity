# «دستیار مبحث ۱۷» — AI assistant (runbook)

## What it is
`/assistant` answers questions about Mabhas 17 (5th ed., 1403) **only from the code text**, with numbered source
cards (clause + printed page) and related reviewed expert answers. Retrieval-augmented generation, no fine-tuning:
fine-tuning does not make a model quote regulations reliably, and GapGPT does not offer it. "Training" = the
knowledge base + 54 reviewed expert answers (plan-review checklist) + evals that decide the model.

| Piece | File |
|---|---|
| Gateway (key, timeouts, retry, kill switch, budget guard, usage log) | `src/lib/ai/gateway.js` |
| Model per feature (env-overridable) | `src/lib/ai/models.js` |
| Knowledge base + hybrid search (BM25 + vectors) | `src/lib/ai/knowledge-base.js`, `data/mabhas17/chunks.json`, `vectors.bin` |
| Expert answers (the "training" set) | `data/mabhas17/expert-checklist.jsonl` |
| Prompt | `prompts/mabhas17-assistant.md` |
| Evals | `evals/mabhas17.jsonl`, `scripts/ai/eval-mabhas17.js` |
| Page / API | `views/assistant.ejs`, `public/js/assistant.js`, `POST /api/assistant/ask`, `/api/assistant/feedback` |

## Model choice (so far)
| Job | Tested | Result | Pick |
|---|---|---|---|
| Page transcription (vision) | gpt-5.4-mini, claude-sonnet-5-5, gemini-3.1-pro-preview, gemini-3.5-flash | mini changed words (کلکتور→کنتور) and clause numbers; Sonnet and Gemini Pro near-perfect, Gemini ~30× fewer prompt tokens; Flash returned its reasoning as text | **gemini-3.1-pro-preview** |
| Answers | pending credit | run `eval-mabhas17.js --models …` | provisional **claude-sonnet-5-5** |
| Embeddings | pending credit | `text-embedding-3-large` vs `gemini-embedding-2` on hit@6 | provisional text-embedding-3-large (1024 dims) |

Observed on GapGPT: `claude-haiku-5-5` reported 7–28k prompt tokens for a 30-token message (billing anomaly) — avoid
until clarified. Retrieval without AI: hit@6 = 23/23 on the eval set (keyword search + expert notes).

## Known limitation
The PDF has no usable text layer; the current knowledge base is free OCR (Tesseract). Words are good, but digits can be
misread (e.g. page 50: «۳ متر» read as «۲»). The prompt tells the model to copy numbers from sources and flag
disagreements, the UI shows the page for every source, and the disclaimer asks users to check the cited page.
**Fix:** re-transcribe all pages with the vision model (≈ $10–12 of credit), then rebuild:

```bash
MABHAS17_PDF=Mabhas17-1403.pdf AI_API_KEY=… OUT_DIR=work python3 scripts/ai/transcribe-mabhas17.py 21 259
node scripts/ai/build-mabhas17-chunks.js work/pages --vision work/vis   # work/pages = tesseract output (pdftoppm + tesseract -l fas)
AI_API_KEY=… node scripts/ai/embed-mabhas17.js
AI_API_KEY=… node scripts/ai/eval-mabhas17.js --models claude-sonnet-5-5,gpt-5.5,gemini-3.5-flash,deepseek-v4-pro --judge claude-opus-5-5
```

## Turning it on (server)
In `/opt/nogiti/.env`: `AI_API_KEY=<GapGPT key>` and `FEATURE_AI_ASSISTANT=true`, then `docker compose up -d`.
Without the key (or when credit runs out / budget is reached / GapGPT is down) the page still works and shows the
matching clauses — it never errors.

- Kill switch: `FEATURE_AI_ASSISTANT=false` (page gone) or remove `AI_API_KEY` (clause search only).
- Budget: `AI_DAILY_REQUEST_LIMIT` (default 300), `AI_DAILY_TOKEN_LIMIT` (default 3M). Usage per day/model: table `ai_usage`.
- Rate limit: 8 questions/hour per IP anonymous, 30/hour per signed-in user.
- Rotate the key: create a new key in GapGPT, replace `AI_API_KEY`, `docker compose up -d`, delete the old key.
- Privacy: phones, e-mails, card/ID numbers are removed before a question leaves the server; nothing is stored unless
  the visitor presses 👍/👎 (`ai_feedback`, redacted). Add one line to the privacy page: questions to the assistant are
  sent to an AI provider (GapGPT) to be answered.
- Server reachability: the VPS must reach `api.gapapi.com` (`curl -sI https://api.gapapi.com` on the server).
