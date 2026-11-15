ALTER TABLE ticket_messages
  DROP COLUMN IF EXISTS attachment_key,
  DROP COLUMN IF EXISTS attachment_name,
  DROP COLUMN IF EXISTS attachment_mime,
  DROP COLUMN IF EXISTS attachment_size,
  DROP COLUMN IF EXISTS ai_assisted;
ALTER TABLE tickets
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS last_author,
  DROP COLUMN IF EXISTS user_seen_at,
  DROP COLUMN IF EXISTS admin_seen_at,
  DROP COLUMN IF EXISTS closed_at,
  DROP COLUMN IF EXISTS rating,
  DROP COLUMN IF EXISTS rating_comment,
  DROP COLUMN IF EXISTS ai_category,
  DROP COLUMN IF EXISTS ai_priority,
  DROP COLUMN IF EXISTS ai_summary,
  DROP COLUMN IF EXISTS ai_model,
  DROP COLUMN IF EXISTS ai_at;
DROP TABLE IF EXISTS support_faqs;
