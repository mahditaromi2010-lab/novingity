-- Regulations library (مقررات و منابع): files such as the Mabhas of the National Building Regulations,
-- uploaded or linked from the admin panel. Uploaded files live in UPLOAD_DIR/private/library and are served
-- by /library/:id/file (never by express.static).
CREATE TABLE IF NOT EXISTS library_documents (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  title_en TEXT,
  description TEXT,
  description_en TEXT,
  category TEXT NOT NULL DEFAULT 'mabhas' CHECK (category IN ('mabhas', 'standard', 'guide', 'form', 'other')),
  mabhas_number SMALLINT CHECK (mabhas_number BETWEEN 1 AND 30),
  edition TEXT,
  edition_year SMALLINT CHECK (edition_year BETWEEN 1300 AND 1500),
  file_key TEXT,
  file_name TEXT,
  file_size BIGINT,
  file_type TEXT,
  external_url TEXT,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT library_documents_has_source CHECK (file_key IS NOT NULL OR external_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS library_documents_list_idx ON library_documents (is_published, category, mabhas_number, sort_order);

-- The two Mabhas 17 editions that were linked from the tools page become the first library entries.
INSERT INTO library_documents (title, title_en, description, category, mabhas_number, edition, edition_year, external_url, file_type, is_current, sort_order)
SELECT * FROM (VALUES
  ('مبحث هفدهم مقررات ملی ساختمان — لوله‌کشی گاز طبیعی', 'Part 17 — Natural gas piping', 'ویرایش جاری؛ طراحی، اجرا و بازرسی سامانه گاز طبیعی ساختمان‌ها.', 'mabhas', 17, 'ویرایش ۱۴۰۳', 1403,
   'https://inbr.s3.ir-thr-at1.arvanstorage.ir/mabahse%2Fmabahse17%2Fmabhas17-watermark-1403-02.pdf?versionId=', 'pdf', TRUE, 0),
  ('مبحث هفدهم مقررات ملی ساختمان — لوله‌کشی گاز طبیعی', 'Part 17 — Natural gas piping', 'ویرایش قبلی، برای مراجعه به پروژه‌های قدیمی‌تر.', 'mabhas', 17, 'ویرایش ۱۴۰۱', 1401,
   'https://inbr.s3.ir-thr-at1.arvanstorage.ir/mabahse%2Fmabahse17%2Fmabhas17-1401-07.pdf?versionId=', 'pdf', FALSE, 1)
) AS v(title, title_en, description, category, mabhas_number, edition, edition_year, external_url, file_type, is_current, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM library_documents);
