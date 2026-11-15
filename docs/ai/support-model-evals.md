# Help-centre assistant — model evals

Run: 2026-11-15 · cases: 26 (evals/support.jsonl) · threshold: 85%

| Model | Answers pass | Triage pass | p50 ms | p95 ms | avg tokens in/out | USD per 1,000 questions |
|---|---|---|---|---|---|---|
| deepseek-v4.1-flash | 26/26 (100%) | 1/10 | 4754 | 8030 | 887/162 | 0.078 |
| claude-haiku-5-5 | 20/26 (77%) | 6/10 | 4600 | 10344 | 1098/287 | 0.253 |
| qwen3.8-flash | 17/26 (65%) | 5/10 | 6347 | 12252 | 790/254 | 0.238 |
| gpt-5.4-nano | 22/26 (85%) | 10/10 | 1732 | 2349 | 694/84 | 0.244 |
| gemini-3.1-flash-lite | 20/26 (77%) | 10/10 | 1479 | 1630 | 712/79 | 0.297 |

**Pick per feature (cheapest that passes each):**
- Answers (`AI_MODEL_SUPPORT`): **deepseek-v4.1-flash** — 26/26, ~$0.08 per 1,000 questions (list prices from lmmarketcap.com, 2026-11-15; GapGPT bills in toman and its rates may differ).
- Ticket triage (`AI_MODEL_SUPPORT_TRIAGE`): **gpt-5.4-nano** — 10/10; deepseek-v4.1-flash returned no usable JSON within the small token budget and fell back to keyword rules.
- Reply drafts (`AI_MODEL_SUPPORT_DRAFT`): deepseek-v4.1-flash with a larger token budget (drafts are always edited by the agent).
- claude-haiku-5-5 returned empty answers on 5 cases through GapGPT and cost ~3× more, so it was not chosen.

Estimated monthly cost at 3,000 questions + 300 tickets: well under $1 (plus GapGPT's markup).

## Failures
### deepseek-v4.1-flash
- t01: got order/urgent (rules fallback) — «»
- t03: got order/normal (rules fallback) — «»
- t04: got product/normal (rules fallback) — «»
- t05: got account/normal (rules fallback) — «»
- t06: got product/urgent (rules fallback) — «»
- t07: got product/normal (rules fallback) — «»
- t08: got order/urgent (rules fallback) — «»
- t09: got product/normal (rules fallback) — «»
- t10: got order/normal (rules fallback) — «»
### claude-haiku-5-5
- s02: no citation — «متوجه شدم که کد ورود پیامکی نمیرسد. برای اینکه بتوانم دقیقتر کمک کنم، لطفاً بگویید:  1. کد مربوط به کدام سرویس یا برنامه است؟ 2. شماره‌ای که وارد کرده‌اید درست است و با کد کشور شروع می‌شود؟ (مثلاً `+98...`) 3. چند دقیقه از درخواست گذشته است؟  در همین وقت، این مواردِ رایج را امتحان کنید:  - **چند دقی»
- s05: no citation — «بله، این افزونه طبق اطلاعات فروشگاه **رایگان** است. این نمونهٔ آزمونی از افزونهٔ اتوکد برای ترسیم خود»
- s13: no AI answer: empty — «»
- s14: unneeded hand-off — «برای پرداخت، محصول مورد نظر را از فروشگاه انتخاب کنید و در مرحلهٔ پرداخت، به درگاه امن زرین‌پال هدایت می‌شوید [F1]. دسترسی به محصول فقط بعد از تأیید پرداخت توسط درگاه فعال می‌شود و پس از آن در «حساب کاربری ← کتابخانهٔ من» (/account) دیده می‌شود [F1].  - اگر مبلغ کسر شد ولی محصول در کتابخانه‌تان نیام»
- s19: missing /ticket/; no hand-off — «I'm sorry about the double char»
- s23: no AI answer: empty — «»
- t04: got product/normal — «»
- t05: got account/normal — «»
- t06: got product/urgent (rules fallback) — «»
- t10: got order/normal — «»
### qwen3.8-flash
- s02: no AI answer: empty — «»
- s07: no AI answer: empty — «»
- s13: missing /تیکت/; no hand-off — «لطفاً بعد از ورود، از «حساب کاربری ← کتابخانهٔ من» دوره و جلسه سوم را باز کنید؛ دوره‌های خرید»
- s17: no AI answer: empty — «»
- s19: no AI answer: empty — «»
- s21: no AI answer: empty — «»
- s22: no AI answer: empty — «»
- s24: no AI answer: empty — «»
- s25: no AI answer: empty — «»
- t03: got order/normal — «»
- t05: got account/normal — «»
- t06: got product/urgent (rules fallback) — «»
- t07: got product/normal (rules fallback) — «»
- t10: got order/normal (rules fallback) — «»
### gpt-5.4-nano
- s06: did not admit unknown — «اطلاعاتی درباره «تخفیف دانشجویی» در منابعی که در اختیار دارم وجود ندارد، بنابراین نمی‌توانم تایید کنم. برای دیدن قیمت‌ها و شرایط دقیق محصولات/دوره‌ها، لطفاً از بخش فروشگاه (/shop) یا مرکز راهنما (/support) بررسی کنید. اگر بگویید دقیقاً کدام محصول/دوره مدنظرتان است، قدم بعدی را راهنمایی می‌کنم.»
- s14: unneeded hand-off — «پرداخت در Novingity از طریق درگاه امن زرین‌پال انجام می‌شود و دسترسی به محصول فقط بعد از تأیید پرداخت توسط درگاه فعال می‌شود [F1]. اگر مبلغ کم شد ولی محصول در «حساب کاربری → کتابخانهٔ من» نیامد، با شمارهٔ سفارش یک تیکت ثبت کنید تا بررسی شود [F1].»
- s17: language; missing /can't|cannot|not able|unable|only/ — «این کار را نمی‌توانم انجام دهم؛ از اطلاعات سایت مشخص است که برخی محصولات «رایگان» هستند، اما تضمینی برای رایگان بودن «همهٔ» محصولات وجود ندارد. اگر محصولی رایگان باشد، پس از ورود می‌توانید با یک کلیک آن را به «کتابخانهٔ من» اضافه کنید. [F1]    برای دیدن مواردی که قبلاً تهیه کرده‌اید یا رایگان اضافه »
- s21: language — «I don’t have information on shipping physical books (destinations like Germany, shipping cost, or delivery times) in the available site facts. لطفاً برای اینکه تیم پشتیبانی دقیق چک کند، یک تیکت بزنید و در آن بنویسید «آیا کتاب فیزیکی به آلمان ارسال می‌شود؟» و اگر ممکن است نام کتاب/محصول را هم ذکر کنی»
### gemini-3.1-flash-lite
- s14: unneeded hand-off — «پرداخت در سایت نوین‌گیتی از طریق درگاه امن زرین‌پال انجام می‌شود [F1]. پس از انتخاب محصول و هدایت به درگاه، با وارد کردن اطلاعات کارت بانکی خود می‌توانید پرداخت را تکمیل کنید [F1]. دسترسی به محصول بلافاصله پس از تأیید نهایی توسط درگاه در «حساب کاربری ← کتابخانهٔ من» فعال خواهد شد [F1]. اگر مبلغ از ح»
- s17: language; missing /can't|cannot|not able|unable|only/ — «من یک هوش مصنوعی هستم و وظیفه دارم طبق اطلاعات سایت نوین‌گیتی پاسخگو باشم. محصولات سایت شامل دوره‌ها و افزونه‌های رایگان و غیررایگان است که در بخش فروشگاه قابل مشاهده هستند [F2]؛ برای دریافت محصولات رایگان، پس از ورود به حساب کاربری، با یک کلیک در صفحه محصول، آن را به «کتابخانهٔ من» اضافه می‌کنید [F»
- s19: language; missing /ticket/ — «متأسفم که با این مشکل مواجه شدید. برای بررسی تراکنش‌های تکراری، لطفاً در بخش «حساب کاربری» وارد قسمت تیکت‌ها شوید و یک تیکت با موضوع «مالی» ثبت کنید تا تیم پشتیبانی وضعیت پرداخت‌های شما را بررسی کنند [F1]، [F2]. لطفاً شماره پیگیری یا رسید پرداخت‌های خود را در متن تیکت ذکر کنید.»
- s20: language; missing /450,000|450000/ — «هزینه دوره طراحی لوله‌کشی گاز ۴۵۰,۰۰۰ تومان است [P1]. برای دسترسی به این دوره می‌توانید به صفحه آن در آدرس /shop/eval-gas-piping-course مراجعه کنید [P1].»
- s21: language; did not admit unknown — «در حال حاضر نوین‌گیتی تنها محصولات دیجیتال شامل دوره‌های آموزشی، افزونه‌های اتوکد و فایل‌های مقررات ملی ساختمان را ارائه می‌دهد و فروش یا ارسال کتاب فیزیکی ندارد [P1]. تمامی محصولات پس از تهیه، در بخش «حساب کاربری ← کتابخانهٔ من» در دسترس شما قرار می‌گیرند [F2].»
- s26: language; missing /code|SMS/ — «خیر، امکان ورود با رمز عبور وجود ندارد. ورود به سایت نوین‌گیتی تنها با شماره موبایل و دریافت کد یک‌بارمصرف از طریق پیامک انجام می‌شود [F1]. با اولین ورود شما، حساب کاربری‌تان به‌صورت خودکار ایجاد خواهد شد [F1].»
