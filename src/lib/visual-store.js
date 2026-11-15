'use strict';
/**
 * Database side of banners and replaceable site images, with a short in-memory cache so public pages do not
 * query the database on every request. Admin changes call invalidate(), so the admin sees the result at once;
 * other processes (if ever more than one) pick it up within CACHE_MS.
 */
const { SITE_IMAGE_SLOTS, siteImageSlot } = require('./visual');

const CACHE_MS = 30_000;

const BANNER_SELECT = `SELECT b.*, dm.path AS desktop_path, dm.width AS desktop_w, dm.height AS desktop_h,
    mm.path AS mobile_path, mm.width AS mobile_w, mm.height AS mobile_h
  FROM banners b
  LEFT JOIN media_images dm ON dm.id = b.desktop_media_id
  LEFT JOIN media_images mm ON mm.id = b.mobile_media_id`;

function createVisualStore({ pool, logger = null, now = () => Date.now() } = {}) {
  let cache = null; // { at, banners, overrides: Map }
  let loading = null;

  async function load() {
    const [banners, overrides] = await Promise.all([
      pool.query(`${BANNER_SELECT} WHERE b.status = 'published' AND (b.ends_at IS NULL OR b.ends_at > NOW())`),
      pool.query(`SELECT o.slot_key, m.path, m.width, m.height, m.alt, m.alt_en FROM site_image_overrides o JOIN media_images m ON m.id = o.media_id`)
    ]);
    return {
      at: now(),
      banners: banners.rows.map(r => ({ ...r, overlay_opacity: Number(r.overlay_opacity), layers: Array.isArray(r.layers) ? r.layers : [] })),
      overrides: new Map(overrides.rows.map(r => [r.slot_key, r]))
    };
  }

  /** Current snapshot; on a database error the last good snapshot (or an empty one) keeps pages working. */
  async function snapshot() {
    if (cache && now() - cache.at < CACHE_MS) return cache;
    if (!loading) {
      loading = load().then(s => { cache = s; return s; }).catch(err => {
        logger?.warn?.('visual content not loaded', { error: err.message });
        cache = { at: now() - CACHE_MS + 5000, banners: cache?.banners || [], overrides: cache?.overrides || new Map() };
        return cache;
      }).finally(() => { loading = null; });
    }
    return loading;
  }

  function invalidate() { cache = null; }

  /** The image shown in a slot: the admin's choice, else the built-in default (null = drawn artwork). */
  function siteImage(snap, key, locale = 'fa') {
    const slot = siteImageSlot(key);
    if (!slot) return null;
    const o = snap?.overrides?.get(key);
    if (o) return { src: o.path, width: o.width, height: o.height, alt: (locale === 'en' ? o.alt_en || o.alt : o.alt || o.alt_en) || '', custom: true };
    return slot.default ? { src: slot.default, width: null, height: null, alt: '', custom: false } : null;
  }

  return { snapshot, invalidate, siteImage, slots: SITE_IMAGE_SLOTS };
}

module.exports = { createVisualStore, BANNER_SELECT, CACHE_MS };
