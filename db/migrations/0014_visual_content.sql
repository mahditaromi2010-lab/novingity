-- 0014 visual content: an admin-managed image library, replaceable site images and promo banners.
-- Design adapted from Paradigmshift (apps/api/src/visual + media/site-image-registry): code-owned image slots
-- with built-in defaults, banners whose text and buttons are HTML layers over the picture (never baked in),
-- server-side publication rules (status + time window + audience) and safe button links only.
-- ROLLBACK: db/migrations/0014_visual_content.down.sql (drops the three new tables; no other data touched).

-- Every image uploaded through «بنرها و تصاویر». Files live with the other public images (/media/covers).
CREATE TABLE IF NOT EXISTS media_images (
  id BIGSERIAL PRIMARY KEY,
  path VARCHAR(300) NOT NULL UNIQUE,
  original_name VARCHAR(255) NOT NULL DEFAULT '',
  mime VARCHAR(40) NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  alt VARCHAR(300) NOT NULL DEFAULT '',
  alt_en VARCHAR(300) NOT NULL DEFAULT '',
  uploaded_by BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS media_images_created_idx ON media_images(created_at DESC);

-- A replaced site image (logo, page header pictures, fallback covers ...). No row = the built-in default.
CREATE TABLE IF NOT EXISTS site_image_overrides (
  slot_key VARCHAR(80) PRIMARY KEY,
  media_id BIGINT NOT NULL REFERENCES media_images(id) ON DELETE RESTRICT,
  updated_by BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS banners (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slot VARCHAR(60) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  audience VARCHAR(12) NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'guests', 'members')),
  locale_mode VARCHAR(4) NOT NULL DEFAULT 'all' CHECK (locale_mode IN ('all', 'fa', 'en')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  priority INTEGER NOT NULL DEFAULT 0,
  desktop_media_id BIGINT REFERENCES media_images(id) ON DELETE RESTRICT,
  mobile_media_id BIGINT REFERENCES media_images(id) ON DELETE RESTRICT,
  image_alt VARCHAR(300) NOT NULL DEFAULT '',
  image_alt_en VARCHAR(300) NOT NULL DEFAULT '',
  fit VARCHAR(8) NOT NULL DEFAULT 'cover' CHECK (fit IN ('cover', 'contain')),
  bg_color CHAR(7) NOT NULL DEFAULT '#0b261f',
  overlay_color CHAR(7) NOT NULL DEFAULT '#000000',
  overlay_opacity NUMERIC(3, 2) NOT NULL DEFAULT 0.45 CHECK (overlay_opacity >= 0 AND overlay_opacity <= 1),
  overlay_direction VARCHAR(10) NOT NULL DEFAULT 'to-start' CHECK (overlay_direction IN ('to-start', 'to-end', 'to-top', 'to-bottom', 'flat', 'none')),
  text_color CHAR(7) NOT NULL DEFAULT '#ffffff',
  content_x VARCHAR(6) NOT NULL DEFAULT 'start' CHECK (content_x IN ('start', 'center', 'end')),
  content_y VARCHAR(6) NOT NULL DEFAULT 'center' CHECK (content_y IN ('top', 'center', 'bottom')),
  text_align VARCHAR(6) NOT NULL DEFAULT 'start' CHECK (text_align IN ('start', 'center', 'end')),
  content_width SMALLINT NOT NULL DEFAULT 60 CHECK (content_width BETWEEN 30 AND 100),
  height VARCHAR(4) NOT NULL DEFAULT 'md' CHECK (height IN ('sm', 'md', 'lg')),
  layers JSONB NOT NULL DEFAULT '[]'::jsonb,
  clicks INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  CHECK (jsonb_typeof(layers) = 'array')
);
CREATE INDEX IF NOT EXISTS banners_slot_idx ON banners(slot, status, priority DESC);
