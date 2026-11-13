'use strict';
/**
 * Technical SEO helpers, rendered once in views/partials/header.ejs so every page is correct by default.
 *
 * URL policy (bilingual, same paths): Persian is the default at the clean URL; English is the same path with
 * ?lang=en (the i18n middleware reads ?lang without storing a cookie, so the URL alone decides the language).
 * Every public page therefore gets: a self canonical, hreflang fa / en / x-default, Open Graph + Twitter tags,
 * and JSON-LD. Filter/search parameters are dropped from the canonical; ?page=N is kept.
 * Private or thin pages (login, account, checkout, errors, search results) get "noindex, follow".
 */

const NOINDEX_PREFIXES = ['/login', '/account', '/checkout', '/payments', '/admin', '/secure-assets', '/auth', '/assistant'];

function pageParam(query) {
  const n = Number.parseInt(String(query?.page || ''), 10);
  return Number.isSafeInteger(n) && n > 1 ? n : null;
}

/** Absolute URL of `pathname` in a locale (fa = clean URL, en = ?lang=en), keeping only ?page. */
function localeUrl(appUrl, pathname, locale, query = {}) {
  const params = new URLSearchParams();
  const page = pageParam(query);
  if (page) params.set('page', String(page));
  if (locale === 'en') params.set('lang', 'en');
  const qs = params.toString();
  return `${appUrl}${pathname}${qs ? `?${qs}` : ''}`;
}

function seoFor({ appUrl, path: pathname, query, locale }) {
  const canonical = localeUrl(appUrl, pathname, locale, query);
  const filtered = Object.keys(query || {}).some(k => !['page', 'lang'].includes(k));
  const noindexPath = NOINDEX_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
  return {
    canonical,
    alternates: { fa: localeUrl(appUrl, pathname, 'fa', query), en: localeUrl(appUrl, pathname, 'en', query) },
    // Search results and filtered listings: crawlable for links, not indexed as separate pages.
    noindex: noindexPath || (filtered && !!query?.q),
    ogLocale: locale === 'en' ? 'en_US' : 'fa_IR',
    ogLocaleAlternate: locale === 'en' ? 'fa_IR' : 'en_US'
  };
}

const absolute = (appUrl, src) => (!src ? null : /^https?:\/\//.test(src) ? src : `${appUrl}${src.startsWith('/') ? '' : '/'}${src}`);
const isoDate = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined; };
const plain = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function organization(appUrl, siteName, email) {
  return {
    '@type': 'Organization', '@id': `${appUrl}/#organization`, name: siteName, url: `${appUrl}/`,
    logo: { '@type': 'ImageObject', url: `${appUrl}/public/images/nogiti-logo.webp` },
    ...(email ? { email, contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', email, availableLanguage: ['fa', 'en'] } } : {})
  };
}

function website(appUrl, siteName, locale) {
  return { '@type': 'WebSite', '@id': `${appUrl}/#website`, url: `${appUrl}/`, name: siteName, alternateName: 'نوین‌گیتی', inLanguage: locale === 'en' ? 'en' : 'fa', publisher: { '@id': `${appUrl}/#organization` } };
}

function breadcrumbs(items) {
  return { '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })) };
}

/** Product page. Prices are stored in toman; schema.org wants the charged currency (IRR = toman × 10). */
function productLd({ appUrl, canonical, product, title, description, image }) {
  const price = Number(product.price_toman || 0) * 10;
  return {
    '@type': 'Product', name: title, description: plain(description).slice(0, 500) || undefined, url: canonical,
    image: image ? [image] : undefined, sku: String(product.id), category: product.category || undefined,
    brand: { '@id': `${appUrl}/#organization` },
    offers: { '@type': 'Offer', url: canonical, priceCurrency: 'IRR', price: String(price), availability: 'https://schema.org/InStock', seller: { '@id': `${appUrl}/#organization` } }
  };
}

function articleLd({ appUrl, canonical, article, title, description, image, locale }) {
  return {
    '@type': 'BlogPosting', headline: title.slice(0, 110), description: plain(description).slice(0, 300) || undefined,
    mainEntityOfPage: canonical, url: canonical, image: image ? [image] : undefined, inLanguage: locale === 'en' ? 'en' : 'fa',
    datePublished: isoDate(article.published_at || article.created_at), dateModified: isoDate(article.updated_at || article.published_at),
    author: { '@id': `${appUrl}/#organization` }, publisher: { '@id': `${appUrl}/#organization` }
  };
}

/** One JSON-LD @graph; `<` is escaped so the block can never close its <script>. */
function jsonLd(nodes) {
  const graph = nodes.filter(Boolean);
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, (k, v) => (v === undefined ? undefined : v)).replace(/</g, '\\u003c');
}

module.exports = { seoFor, localeUrl, organization, website, breadcrumbs, productLd, articleLd, jsonLd, absolute, plain, NOINDEX_PREFIXES };
