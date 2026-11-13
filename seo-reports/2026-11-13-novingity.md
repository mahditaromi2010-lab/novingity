# Technical SEO audit — novingity.ir (2026-11-13)

Scope: technical SEO of the Express/EJS site (fa default, en). Audit run with `seo_audit.py` against a local
production build of `main` (the live site is not reachable from the audit environment). No Search Console access.

## Before → after (local crawl, 40 URLs incl. language-switch redirects)

| | Before | After |
|---|---|---|
| Canonical tags | none on any page | self canonical on every public page; filters → listing |
| hreflang | none (fa/en share URLs, language only via cookie) | fa (clean URL) / en (`?lang=en`) / x-default on every page and in the sitemap |
| Open Graph / Twitter | none | full set + 1200×630 default image, page cover for products/articles |
| JSON-LD | none | Organization (+ WebSite on home), Product (IRR offer), BlogPosting, BreadcrumbList |
| noindex | none | login, account, checkout, payments, search results, all 4xx/5xx pages |
| Titles / descriptions | home "خانه \| Novingity"; one default description on 32 URLs | unique, descriptive titles + descriptions per key page; product/article descriptions from their summary |
| Sitemap | 5 static pages + content, Persian only | + /library, English URLs with xhtml alternates; Persian-only content listed once |
| English-less content | served at `?lang=en` as duplicate Persian | Persian-only: no en alternate, `?lang=en` canonicalises to Persian |

Remaining audit lines are expected: `/lang/...` redirect URLs (blocked in robots.txt), filtered listings canonicalising to
the listing, intentional noindex on login/account, decorative logo `alt=""`, external Mabhas PDF links.

## Ranked issues

| ID | Pri | Area | Problem | Fix | Status |
|---|---|---|---|---|---|
| S1 | P1 | bilingual | No hreflang; English only by cookie → Google sees one language | `?lang=en` URLs + hreflang + sitemap alternates | fixed |
| S2 | P1 | duplicate | No canonicals; `?type=`, `?q=`, `?category=` variants duplicate titles | self canonical, filters → listing, search noindex | fixed |
| S3 | P1 | on-page | Same meta description on home/tools/shop/articles (+ all products/articles) | unique descriptions | fixed |
| S4 | P2 | structured data | No JSON-LD | Organization/WebSite/Product/BlogPosting/BreadcrumbList | fixed |
| S5 | P2 | on-page | No Open Graph — links shared in Telegram/WhatsApp have no preview | OG + Twitter tags, og-default.png | fixed |
| S6 | P2 | indexing | Error pages and login indexable | noindex, follow | fixed |
| S7 | P2 | sitemap | /library missing | added (lastmod = newest file) | fixed |
| S8 | P0? | reachability | **Unverified:** site hosted in Iran (87.107.54.19); Googlebot crawls from abroad. A web search for `site:novingity.ir` returned no pages from the site | owner checks from abroad + Search Console | **owner action** |

## Not checked
- Live reachability from outside Iran, Search Console coverage, field Core Web Vitals (no access).
- Lighthouse was run earlier this month on /tools (TBT fix shipped); not re-run here.

## Content opportunities (suggestions)
1. One article per calculator answering the exact search ("محاسبه قطر لوله گاز"، "محاسبه دریچه هوای پکیج") linking to the tool.
2. "تفاوت ویرایش ۱۴۰۱ و ۱۴۰۳ مبحث ۱۷" — high-intent for engineers; link to the library.
3. Plan-review checklist explained (the 54 items already answered for the assistant) as an article series.
