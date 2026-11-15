-- 0015 help centre: admin-managed FAQ, ticket attachments, read/unread tracking, closing + rating, and the
-- AI triage fields (suggestions only: the customer's and the admin's choices stay authoritative).
-- ROLLBACK: db/migrations/0015_support_center.down.sql (drops support_faqs and the added columns only).

CREATE TABLE IF NOT EXISTS support_faqs (
  id BIGSERIAL PRIMARY KEY,
  question VARCHAR(300) NOT NULL,
  question_en VARCHAR(300) NOT NULL DEFAULT '',
  answer VARCHAR(4000) NOT NULL,
  answer_en VARCHAR(4000) NOT NULL DEFAULT '',
  category VARCHAR(20) NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'order', 'product', 'account', 'technical')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  helpful_yes INTEGER NOT NULL DEFAULT 0,
  helpful_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS support_faqs_list_idx ON support_faqs(is_published, category, sort_order, id);

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'form' CHECK (source IN ('form', 'assistant')),
  ADD COLUMN IF NOT EXISTS last_author VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (last_author IN ('user', 'admin')),
  ADD COLUMN IF NOT EXISTS user_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating IN (-1, 1)),
  ADD COLUMN IF NOT EXISTS rating_comment VARCHAR(500),
  ADD COLUMN IF NOT EXISTS ai_category VARCHAR(40),
  ADD COLUMN IF NOT EXISTS ai_priority VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ai_summary VARCHAR(600),
  ADD COLUMN IF NOT EXISTS ai_model VARCHAR(80),
  ADD COLUMN IF NOT EXISTS ai_at TIMESTAMPTZ;
-- Existing tickets: the newest message decides who spoke last; everything already there counts as seen.
UPDATE tickets tk SET
  last_author = COALESCE((SELECT m.author_type FROM ticket_messages m WHERE m.ticket_id = tk.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1), 'user'),
  user_seen_at = COALESCE(tk.user_seen_at, NOW()),
  admin_seen_at = COALESCE(tk.admin_seen_at, NOW());

ALTER TABLE ticket_messages
  ADD COLUMN IF NOT EXISTS attachment_key VARCHAR(120),
  ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(60),
  ADD COLUMN IF NOT EXISTS attachment_size INTEGER,
  ADD COLUMN IF NOT EXISTS ai_assisted BOOLEAN NOT NULL DEFAULT FALSE;

-- Starter FAQ, written only from how the site actually works (no invented policies); edit or hide in the admin.
INSERT INTO support_faqs (question, question_en, answer, answer_en, category, sort_order)
SELECT * FROM (VALUES
  ('چطور وارد سایت شوم یا حساب بسازم؟', 'How do I sign in or create an account?',
   'روی «ورود» بزنید و شمارهٔ موبایل خود را وارد کنید. یک کد پیامکی برایتان فرستاده می‌شود؛ با وارد کردن آن وارد می‌شوید. حساب جداگانه یا رمز عبور لازم نیست و اولین ورود، حساب شما را می‌سازد.',
   'Choose “Sign in” and enter your mobile number. You will get a text message with a code; enter it to sign in. There is no separate sign-up or password: your first sign-in creates the account.', 'account', 10),
  ('دوره‌ها و فایل‌هایی که خریده‌ام کجا هستند؟', 'Where are the courses and files I bought?',
   'بعد از ورود، به «حساب کاربری» بروید. در بخش «کتابخانهٔ من» همهٔ دوره‌ها و افزونه‌های خریداری‌شده یا رایگان با ویدیوها و فایل‌هایشان دیده می‌شوند.',
   'After signing in, open “My account”. The “My library” section lists every course and plugin you bought or added for free, with its videos and files.', 'order', 20),
  ('پرداخت چطور انجام می‌شود؟', 'How do I pay?',
   'پرداخت از طریق درگاه امن زرین‌پال انجام می‌شود. دسترسی به محصول فقط بعد از تأیید پرداخت توسط درگاه فعال می‌شود. اگر مبلغ کم شد ولی محصول در کتابخانه‌تان نیامد، با شمارهٔ سفارش یک تیکت ثبت کنید.',
   'Payment goes through the secure ZarinPal gateway. Access starts only after the gateway confirms the payment. If you were charged but the product is not in your library, open a ticket with your order number.', 'order', 30),
  ('محصولات رایگان را چطور دریافت کنم؟', 'How do I get free products?',
   'در صفحهٔ محصول رایگان، بعد از ورود به حساب، با یک کلیک به کتابخانهٔ شما اضافه می‌شود و نیازی به پرداخت نیست.',
   'On a free product''s page, after signing in, one click adds it to your library. No payment is needed.', 'product', 40),
  ('پاسخ تیکت را کجا ببینم؟', 'Where do I see the reply to my ticket?',
   'پاسخ‌ها فقط داخل سایت نمایش داده می‌شوند (پیامک یا ایمیل فرستاده نمی‌شود). از «پشتیبانی» یا «حساب کاربری ← تیکت‌های پشتیبانی» تیکت خود را باز کنید؛ تیکت‌هایی که پاسخ جدید دارند علامت‌گذاری می‌شوند.',
   'Replies are shown only on the site (no text message or e-mail is sent). Open your ticket from “Support” or “My account → Support tickets”; tickets with a new reply are marked.', 'general', 50),
  ('ماشین‌حساب‌های مهندسی چقدر قابل اعتمادند؟', 'How reliable are the engineering calculators?',
   'ابزارها بر پایهٔ جداول مبحث ۱۷ مقررات ملی ساختمان ساخته شده‌اند، اما جایگزین طراحی مهندسی نیستند. پیش از اجرا، نتیجه را با بازرس یا شخص مسئول هماهنگ یا بررسی کنید.',
   'The tools are built on the tables of Part 17 of the National Building Regulations, but they do not replace engineering design. Before acting on a result, check it with the inspector or the responsible person.', 'technical', 60),
  ('مبحث ۱۷ و مقررات دیگر را از کجا دانلود کنم؟', 'Where can I download Part 17 and other regulations?',
   'در «کتابخانهٔ فنی» مباحث مقررات ملی ساختمان و راهنماها بر اساس شمارهٔ مبحث و ویرایش فهرست شده‌اند و می‌توانید باز یا دانلود کنید.',
   'The “Library” lists the National Building Regulations parts and guides by part number and edition; you can open or download them there.', 'technical', 70),
  ('در فایل یا ویدیوی دوره مشکل دارم؛ چه کنم؟', 'A course file or video does not work. What should I do?',
   'یک تیکت با دستهٔ «محصول» ثبت کنید، نام دوره و توضیح مشکل را بنویسید و اگر می‌توانید تصویر صفحه (اسکرین‌شات) پیوست کنید تا سریع‌تر بررسی شود.',
   'Open a ticket in the “Product” category, write the course name and what goes wrong, and attach a screenshot if you can so it can be checked faster.', 'product', 80)
) AS seed(question, question_en, answer, answer_en, category, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM support_faqs);
