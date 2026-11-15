'use strict';
/**
 * Banners and replaceable site images — pure rules, no Express or database code.
 *
 * Adapted from Paradigmshift (apps/api/src/visual/rules.ts, resolve.ts, media/site-image-registry.ts):
 *  - slots are code-owned and allow-listed: the admin picks from this list, the browser can never ask for an
 *    arbitrary key;
 *  - banner text and buttons are HTML layers over the picture (readable, translatable, accessible), never
 *    baked into the image;
 *  - the server decides what is live (status + time window + audience + language); the page only renders it;
 *  - button links must be a same-site path, https, mailto or tel (no javascript:, data:, //host).
 */

/** Where banners can be placed. `bar` = thin text strip above the header (no picture). */
const BANNER_SLOTS = [
  { key: 'site.announcement', kind: 'bar', max: 1, fa: 'نوار اعلان بالای همهٔ صفحه‌ها', en: 'Announcement bar above every page' },
  { key: 'home.top', kind: 'banner', max: 5, fa: 'صفحهٔ اصلی — زیر بخش آغازین', en: 'Home — below the opening section' },
  { key: 'home.middle', kind: 'banner', max: 5, fa: 'صفحهٔ اصلی — بین ابزارها و فروشگاه', en: 'Home — between tools and shop' },
  { key: 'home.bottom', kind: 'banner', max: 5, fa: 'صفحهٔ اصلی — پیش از مقاله‌ها', en: 'Home — before the articles' },
  { key: 'shop.top', kind: 'banner', max: 5, fa: 'فروشگاه (دوره‌ها و افزونه‌ها) — بالای فهرست', en: 'Shop (courses and plugins) — above the list' },
  { key: 'product.bottom', kind: 'banner', max: 3, fa: 'صفحهٔ هر محصول — پایین صفحه', en: 'Each product page — bottom' },
  { key: 'tools.top', kind: 'banner', max: 3, fa: 'ابزارهای مهندسی — بالای ماشین‌حساب‌ها', en: 'Engineering tools — above the calculators' },
  { key: 'tools.bottom', kind: 'banner', max: 3, fa: 'ابزارهای مهندسی — پایین صفحه', en: 'Engineering tools — bottom' },
  { key: 'articles.top', kind: 'banner', max: 3, fa: 'مقاله‌ها — بالای فهرست', en: 'Articles — above the list' },
  { key: 'article.bottom', kind: 'banner', max: 3, fa: 'صفحهٔ هر مقاله — پایان متن', en: 'Each article — after the text' },
  { key: 'library.top', kind: 'banner', max: 3, fa: 'کتابخانهٔ فنی — بالای فهرست', en: 'Library — above the list' },
  { key: 'support.top', kind: 'banner', max: 3, fa: 'مرکز پشتیبانی — بالای صفحه', en: 'Help centre — top' },
  { key: 'account.top', kind: 'banner', max: 3, fa: 'حساب کاربری — بالای صفحه', en: 'My account — top' }
];

/**
 * Every built-in image of the site that the admin can replace. `default: null` means the page shows its
 * drawn/typographic artwork until an image is chosen; product, article, team and gallery pictures are
 * already edited on their own forms.
 */
const SITE_IMAGE_SLOTS = [
  { key: 'brand.logo', group: 'brand', default: '/public/images/nogiti-logo-96.webp', ratio: '1:1', fa: 'لوگوی سایت (سرصفحه و پانویس)', en: 'Site logo (header and footer)' },
  { key: 'seo.ogDefault', group: 'brand', default: '/public/images/og-default.png', ratio: '1200×630', fa: 'تصویر پیش‌نمایش لینک‌ها (تلگرام، واتساپ، گوگل)', en: 'Link preview image (Telegram, WhatsApp, Google)' },
  { key: 'home.heroArt', group: 'home', default: null, ratio: '4:3', fa: 'صفحهٔ اصلی — تصویر بخش آغازین (به‌جای نقشهٔ لوله‌کشی)', en: 'Home — opening picture (replaces the piping drawing)' },
  { key: 'shop.hero', group: 'pages', default: null, ratio: '21:9', fa: 'سربرگ فروشگاه', en: 'Shop header' },
  { key: 'tools.hero', group: 'pages', default: null, ratio: '21:9', fa: 'سربرگ ابزارهای مهندسی', en: 'Engineering tools header' },
  { key: 'articles.hero', group: 'pages', default: null, ratio: '21:9', fa: 'سربرگ مقاله‌ها', en: 'Articles header' },
  { key: 'library.hero', group: 'pages', default: null, ratio: '21:9', fa: 'سربرگ کتابخانهٔ فنی', en: 'Library header' },
  { key: 'about.hero', group: 'pages', default: null, ratio: '21:9', fa: 'سربرگ دربارهٔ ما', en: 'About header' },
  { key: 'support.hero', group: 'pages', default: null, ratio: '21:9', fa: 'سربرگ مرکز پشتیبانی', en: 'Help centre header' },
  { key: 'assistant.hero', group: 'pages', default: null, ratio: '21:9', fa: 'سربرگ دستیار مبحث ۱۷', en: 'Part 17 assistant header' },
  { key: 'login.art', group: 'pages', default: null, ratio: '3:4', fa: 'تصویر کنار فرم ورود', en: 'Picture beside the sign-in form' },
  { key: 'course.coverFallback', group: 'covers', default: null, ratio: '16:10', fa: 'کاور پیش‌فرض دوره‌ها (وقتی دوره کاور ندارد)', en: 'Default course cover (when a course has none)' },
  { key: 'plugin.coverFallback', group: 'covers', default: null, ratio: '16:10', fa: 'کاور پیش‌فرض افزونه‌ها', en: 'Default plugin cover' },
  { key: 'article.coverFallback', group: 'covers', default: null, ratio: '16:10', fa: 'کاور پیش‌فرض مقاله‌ها', en: 'Default article cover' },
  { key: 'error.art', group: 'pages', default: null, ratio: '1:1', fa: 'تصویر صفحه‌های خطا و «پیدا نشد»', en: 'Error and “not found” page picture' }
];

const LAYER_KINDS = ['badge', 'title', 'subtitle', 'text', 'button'];
const BUTTON_STYLES = ['primary', 'light', 'outline'];
const SIZES = ['sm', 'md', 'lg', 'xl'];
const MAX_LAYERS = 8;
const MAX_BUTTONS = 3;

const bannerSlot = key => BANNER_SLOTS.find(s => s.key === key) || null;
const siteImageSlot = key => SITE_IMAGE_SLOTS.find(s => s.key === key) || null;

/** Same-site path, https, mailto or tel. Blocks javascript:, data:, protocol-relative //host and control characters. */
function isSafeHref(v) {
  if (typeof v !== 'string' || !v || v.length > 2048) return false;
  if ([...v].some(c => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127 || /\s/u.test(c))) return false;
  if (v.startsWith('/')) return !v.startsWith('//') && !v.startsWith('/\\');
  if (v.startsWith('#')) return v.length > 1;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:') return !!u.hostname;
    if (u.protocol === 'mailto:') return true;
    if (u.protocol === 'tel:') return /^tel:\+?[0-9-]{3,20}$/.test(v);
    return false;
  } catch { return false; }
}

const isHex = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const bool = v => v === true || v === 'true' || v === 'on' || v === '1';

// Iran has no daylight saving time since 2022: the admin's wall clock is UTC+03:30 unless the browser says otherwise.
const TEHRAN_OFFSET_MIN = -210; // Date#getTimezoneOffset() convention: minutes to add to local time to get UTC

/**
 * "2026-11-20T10:00" from <input type="datetime-local"> is the admin's wall-clock time. `tzOffset` is the
 * browser's getTimezoneOffset() (sent by admin-visual.js); without JavaScript, Tehran time is assumed.
 * Strings with an explicit zone ("...Z", "+03:30") are taken as they are.
 */
function parseDate(v, tzOffset = TEHRAN_OFFSET_MIN) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? undefined : d; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) + tzOffset * 60_000;
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Value for <input type="datetime-local"> in Tehran time. */
function toLocalInput(v, tzOffset = TEHRAN_OFFSET_MIN) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - tzOffset * 60_000).toISOString().slice(0, 16);
}

/**
 * Validates the admin banner form. Layers arrive as parallel arrays (layer_kind[], layer_text[], ...).
 * @returns {{ value: object, errors: string[] }} errors are locale keys (adminVisual.err.*).
 */
function normalizeBanner(body = {}) {
  const errors = [];
  const slot = bannerSlot(body.slot);
  if (!slot) errors.push('slot');
  const name = str(body.name, 160);
  if (!name) errors.push('name');
  const tz = Number.parseInt(body.tz_offset, 10);
  const offset = Number.isInteger(tz) && Math.abs(tz) <= 14 * 60 ? tz : TEHRAN_OFFSET_MIN;
  const startsAt = parseDate(body.starts_at, offset);
  const endsAt = parseDate(body.ends_at, offset);
  if (startsAt === undefined || endsAt === undefined) errors.push('date');
  else if (startsAt && endsAt && startsAt >= endsAt) errors.push('dateOrder');
  const opacity = Number(body.overlay_opacity);
  const width = Number.parseInt(body.content_width, 10);
  const priority = Number.parseInt(body.priority, 10);

  const arr = k => (Array.isArray(body[k]) ? body[k] : body[k] === undefined ? [] : [body[k]]);
  const kinds = arr('layer_kind');
  const layers = [];
  kinds.slice(0, MAX_LAYERS * 2).forEach((kind, i) => {
    if (!LAYER_KINDS.includes(kind)) return;
    const layer = {
      kind,
      text: str(arr('layer_text')[i], 300),
      text_en: str(arr('layer_text_en')[i], 300),
      size: pick(arr('layer_size')[i], SIZES, kind === 'title' ? 'lg' : 'md'),
      hide_mobile: bool(arr('layer_hide_mobile')[i])
    };
    if (!layer.text && !layer.text_en) return; // empty rows of the form are ignored
    if (kind === 'button') {
      layer.href = str(arr('layer_href')[i], 2048);
      layer.style = pick(arr('layer_style')[i], BUTTON_STYLES, 'primary');
      layer.new_tab = bool(arr('layer_new_tab')[i]);
      if (!layer.href || !isSafeHref(layer.href)) errors.push('href');
    }
    layers.push(layer);
  });
  if (layers.length > MAX_LAYERS) errors.push('tooManyLayers');
  if (layers.filter(l => l.kind === 'button').length > MAX_BUTTONS) errors.push('tooManyButtons');
  if (slot?.kind === 'bar' && !layers.some(l => l.kind !== 'button')) errors.push('barText');

  const value = {
    name,
    slot: slot?.key || '',
    status: pick(body.status, ['draft', 'published', 'archived'], 'draft'),
    audience: pick(body.audience, ['all', 'guests', 'members'], 'all'),
    locale_mode: pick(body.locale_mode, ['all', 'fa', 'en'], 'all'),
    starts_at: startsAt || null,
    ends_at: endsAt || null,
    priority: Number.isSafeInteger(priority) ? Math.max(-1000, Math.min(1000, priority)) : 0,
    image_alt: str(body.image_alt, 300),
    image_alt_en: str(body.image_alt_en, 300),
    fit: pick(body.fit, ['cover', 'contain'], 'cover'),
    bg_color: isHex(body.bg_color) ? body.bg_color : '#0b261f',
    overlay_color: isHex(body.overlay_color) ? body.overlay_color : '#000000',
    overlay_opacity: Number.isFinite(opacity) ? Math.round(Math.min(1, Math.max(0, opacity)) * 100) / 100 : 0.45,
    overlay_direction: pick(body.overlay_direction, ['to-start', 'to-end', 'to-top', 'to-bottom', 'flat', 'none'], 'to-start'),
    text_color: isHex(body.text_color) ? body.text_color : '#ffffff',
    content_x: pick(body.content_x, ['start', 'center', 'end'], 'start'),
    content_y: pick(body.content_y, ['top', 'center', 'bottom'], 'center'),
    text_align: pick(body.text_align, ['start', 'center', 'end'], 'start'),
    content_width: Number.isInteger(width) ? Math.max(30, Math.min(100, width)) : 60,
    height: pick(body.height, ['sm', 'md', 'lg'], 'md'),
    layers: layers.slice(0, MAX_LAYERS)
  };
  return { value, errors: [...new Set(errors)] };
}

/** Half-open window [starts_at, ends_at). Null bounds are open. */
function inWindow(b, now = new Date()) {
  const t = now.getTime();
  if (b.starts_at && t < new Date(b.starts_at).getTime()) return false;
  if (b.ends_at && t >= new Date(b.ends_at).getTime()) return false;
  return true;
}

/** Display rule only (who sees a promo); paid access stays in the order/entitlement code. */
function audienceAllows(b, viewer) {
  if (b.audience === 'guests') return !viewer.authenticated;
  if (b.audience === 'members') return !!viewer.authenticated;
  return true;
}

function localeAllows(b, locale) {
  if (b.locale_mode === 'fa') return locale !== 'en';
  if (b.locale_mode === 'en') return locale === 'en';
  return true;
}

/** What a viewer sees in a slot right now: live banners, highest priority first, newest first on ties. */
function liveBanners(all, slotKey, { now = new Date(), authenticated = false, locale = 'fa' } = {}) {
  const slot = bannerSlot(slotKey);
  if (!slot) return [];
  return all
    .filter(b => b.slot === slotKey && b.status === 'published' && inWindow(b, now) && audienceAllows(b, { authenticated }) && localeAllows(b, locale))
    .sort((a, b) => (b.priority - a.priority) || (new Date(b.updated_at) - new Date(a.updated_at)) || (b.id - a.id))
    .slice(0, slot.max);
}

/** Human status for the admin list: draft / archived / scheduled / expired / live. */
function bannerState(b, now = new Date()) {
  if (b.status !== 'published') return b.status;
  if (b.starts_at && now < new Date(b.starts_at)) return 'scheduled';
  if (b.ends_at && now >= new Date(b.ends_at)) return 'expired';
  return 'live';
}

/** Text of a layer in the page language (English falls back to Persian, like the rest of the site). */
const layerText = (layer, locale) => (locale === 'en' ? layer.text_en || layer.text : layer.text || layer.text_en) || '';

function rgba(hex, alpha) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
}

/**
 * CSS background for the readability overlay. "start" is the reading-start side (right in Persian, left in
 * English), so the dark side follows the text when the language changes.
 */
function overlayCss(b, dir = 'rtl') {
  if (b.overlay_direction === 'none' || Number(b.overlay_opacity) <= 0) return 'none';
  const strong = rgba(b.overlay_color, b.overlay_opacity);
  const clear = rgba(b.overlay_color, 0);
  if (b.overlay_direction === 'flat') return strong;
  const startSide = dir === 'rtl' ? 'right' : 'left';
  const endSide = dir === 'rtl' ? 'left' : 'right';
  const to = { 'to-start': endSide, 'to-end': startSide, 'to-top': 'bottom', 'to-bottom': 'top' }[b.overlay_direction] || endSide;
  // the gradient runs from the dark side towards `to`
  return `linear-gradient(to ${to}, ${strong} 0%, ${rgba(b.overlay_color, Number(b.overlay_opacity) * 0.55)} 45%, ${clear} 100%)`;
}

module.exports = {
  BANNER_SLOTS, SITE_IMAGE_SLOTS, LAYER_KINDS, BUTTON_STYLES, SIZES, MAX_LAYERS, MAX_BUTTONS,
  bannerSlot, siteImageSlot, isSafeHref, normalizeBanner, inWindow, audienceAllows, localeAllows, liveBanners, bannerState,
  layerText, overlayCss, rgba, parseDate, toLocalInput, TEHRAN_OFFSET_MIN
};
