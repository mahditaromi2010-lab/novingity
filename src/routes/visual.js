'use strict';
/**
 * «بنرها و تصاویر» — admin management of promo banners, replaceable site images and the image library,
 * plus the public click-through redirect for banner buttons. Permission: the 'content' role (see
 * admin-security.js, section "visual"). Every mutation is written to the admin audit log by the generic
 * /admin mutation logger in app.js.
 */
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const { BANNER_SLOTS, SITE_IMAGE_SLOTS, bannerSlot, siteImageSlot, normalizeBanner, bannerState, isSafeHref } = require('../lib/visual');
const { BANNER_SELECT } = require('../lib/visual-store');
const { imageSize } = require('../lib/image-size');

const PAGE_SIZE = 48;

function registerVisualRoutes(app, deps) {
  const { pool, store, requireAdmin, asyncRoute, setFlash, renderError, coverStorage, imageFilter, multipartCsrf, verifyUploads, imagePolicy, removeUploaded, COVERS_DIR } = deps;

  const bannerUpload = multer({ storage: coverStorage, limits: { fileSize: 8 * 1024 * 1024, files: 2, fields: 120 }, fileFilter: imageFilter })
    .fields([{ name: 'desktop_file', maxCount: 1 }, { name: 'mobile_file', maxCount: 1 }]);
  const oneImage = multer({ storage: coverStorage, limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 20 }, fileFilter: imageFilter }).single('file');
  const manyImages = multer({ storage: coverStorage, limits: { fileSize: 8 * 1024 * 1024, files: 20, fields: 20 }, fileFilter: imageFilter }).array('files', 20);

  const t = res => res.locals.t;
  const fileOf = (req, field) => req.files?.[field]?.[0] || null;

  async function insertMedia(file, adminId, alt = '', altEn = '', db = pool) {
    const dims = await imageSize(file.path).catch(() => null);
    const r = await db.query(
      'INSERT INTO media_images(path,original_name,mime,size_bytes,width,height,alt,alt_en,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [`/media/covers/${file.filename}`, String(file.originalname || '').slice(0, 255), file.mimetype, file.size || 0, dims?.width || null, dims?.height || null,
        String(alt || '').slice(0, 300), String(altEn || '').slice(0, 300), adminId]
    );
    return r.rows[0].id;
  }

  async function mediaExists(id) {
    const n = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    const r = await pool.query('SELECT id FROM media_images WHERE id=$1', [n]);
    return r.rowCount ? n : null;
  }

  const recentMedia = () => pool.query('SELECT id,path,original_name,width,height,alt FROM media_images ORDER BY created_at DESC, id DESC LIMIT 60').then(r => r.rows);

  // ───────────── Banners ─────────────
  app.get('/admin/visual', requireAdmin, (_req, res) => res.redirect('/admin/visual/banners'));

  app.get('/admin/visual/banners', requireAdmin, asyncRoute(async (req, res) => {
    const slot = bannerSlot(req.query.slot) ? req.query.slot : '';
    const r = await pool.query(`${BANNER_SELECT} ${slot ? 'WHERE b.slot=$1' : ''} ORDER BY b.slot, (b.status='archived'), b.priority DESC, b.updated_at DESC`, slot ? [slot] : []);
    const now = new Date();
    const banners = r.rows.map(b => ({ ...b, state: bannerState(b, now) }));
    res.render('admin/visual-banners', { title: t(res)('adminVisual.bannersTitle'), banners, slots: BANNER_SLOTS, slot });
  }));

  const renderForm = async (res, { banner, errors = [], status = 200 }) => {
    res.status(status).render('admin/visual-banner-form', { title: banner?.id ? t(res)('adminVisual.editBanner') : t(res)('adminVisual.newBanner'), banner, errors, slots: BANNER_SLOTS, media: await recentMedia() });
  };

  app.get('/admin/visual/banners/new', requireAdmin, asyncRoute(async (req, res) => {
    const slot = bannerSlot(req.query.slot)?.key || 'home.top';
    await renderForm(res, { banner: { slot, status: 'draft', audience: 'all', locale_mode: 'all', priority: 0, fit: 'cover', bg_color: '#0b261f', overlay_color: '#000000', overlay_opacity: 0.45, overlay_direction: 'to-start', text_color: '#ffffff', content_x: 'start', content_y: 'center', text_align: 'start', content_width: 60, height: 'md', layers: [] } });
  }));

  app.get('/admin/visual/banners/:id/edit', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query(`${BANNER_SELECT} WHERE b.id=$1`, [req.params.id]);
    if (!r.rowCount) return renderError(res, 404, t(res)('errorPage.notFoundTitle'), t(res)('errorPage.notFoundMessage'));
    await renderForm(res, { banner: { ...r.rows[0], overlay_opacity: Number(r.rows[0].overlay_opacity) } });
  }));

  /** Shared by create and edit. Invalid input re-renders the form with everything the admin typed. */
  async function saveBanner(req, res, existing) {
    const { value, errors } = normalizeBanner(req.body);
    const isBar = bannerSlot(value.slot)?.kind === 'bar';
    let desktopId = existing?.desktop_media_id || null;
    let mobileId = existing?.mobile_media_id || null;
    if (req.body.desktop_media_id !== undefined) desktopId = req.body.desktop_media_id === 'none' ? null : (await mediaExists(req.body.desktop_media_id)) || desktopId;
    if (req.body.mobile_media_id !== undefined) mobileId = req.body.mobile_media_id === 'none' ? null : (await mediaExists(req.body.mobile_media_id)) || mobileId;
    if (!isBar && !fileOf(req, 'desktop_file') && !desktopId && !value.layers.length) errors.push('empty');
    if (errors.length) {
      removeUploaded(req);
      const draft = { ...(existing || {}), ...value, id: existing?.id, desktop_media_id: desktopId, mobile_media_id: mobileId, desktop_path: existing?.desktop_path, mobile_path: existing?.mobile_path };
      return renderForm(res, { banner: draft, errors, status: 422 });
    }
    const adminId = req.admin.id;
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      if (!isBar) {
        if (fileOf(req, 'desktop_file')) desktopId = await insertMedia(fileOf(req, 'desktop_file'), adminId, value.image_alt, value.image_alt_en, client);
        if (fileOf(req, 'mobile_file')) mobileId = await insertMedia(fileOf(req, 'mobile_file'), adminId, value.image_alt, value.image_alt_en, client);
      } else { desktopId = null; mobileId = null; removeUploaded(req); }
      const cols = ['name', 'slot', 'status', 'audience', 'locale_mode', 'starts_at', 'ends_at', 'priority', 'image_alt', 'image_alt_en', 'fit', 'bg_color', 'overlay_color',
        'overlay_opacity', 'overlay_direction', 'text_color', 'content_x', 'content_y', 'text_align', 'content_width', 'height'];
      const vals = cols.map(c => value[c]);
      if (existing) {
        const set = cols.map((c, i) => `${c}=$${i + 1}`).join(',');
        await client.query(`UPDATE banners SET ${set}, layers=$${cols.length + 1}::jsonb, desktop_media_id=$${cols.length + 2}, mobile_media_id=$${cols.length + 3}, updated_by=$${cols.length + 4}, version=version+1, updated_at=NOW() WHERE id=$${cols.length + 5}`,
          [...vals, JSON.stringify(value.layers), desktopId, mobileId, adminId, existing.id]);
        id = existing.id;
      } else {
        const r = await client.query(`INSERT INTO banners(${cols.join(',')},layers,desktop_media_id,mobile_media_id,created_by,updated_by) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')},$${cols.length + 1}::jsonb,$${cols.length + 2},$${cols.length + 3},$${cols.length + 4},$${cols.length + 4}) RETURNING id`,
          [...vals, JSON.stringify(value.layers), desktopId, mobileId, adminId]);
        id = r.rows[0].id;
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); removeUploaded(req); throw err; } finally { client.release(); }
    store.invalidate();
    setFlash(req, 'success', t(res)(value.status === 'published' ? 'adminVisual.savedLive' : 'adminVisual.saved'));
    return res.redirect(`/admin/visual/banners/${id}/edit`);
  }

  app.post('/admin/visual/banners', requireAdmin, bannerUpload, multipartCsrf, verifyUploads(imagePolicy, '/admin/visual/banners/new'), asyncRoute(async (req, res) => saveBanner(req, res, null)));

  app.post('/admin/visual/banners/:id/edit', requireAdmin, bannerUpload, multipartCsrf, verifyUploads(imagePolicy, req => `/admin/visual/banners/${req.params.id}/edit`), asyncRoute(async (req, res) => {
    const r = await pool.query(`${BANNER_SELECT} WHERE b.id=$1`, [req.params.id]);
    if (!r.rowCount) { removeUploaded(req); return renderError(res, 404, t(res)('errorPage.notFoundTitle'), t(res)('errorPage.notFoundMessage')); }
    return saveBanner(req, res, r.rows[0]);
  }));

  app.post('/admin/visual/banners/:id/status', requireAdmin, asyncRoute(async (req, res) => {
    const status = ['draft', 'published', 'archived'].includes(req.body.status) ? req.body.status : null;
    if (!status) { setFlash(req, 'error', t(res)('adminVisual.err.generic')); return res.redirect('/admin/visual/banners'); }
    const r = await pool.query('UPDATE banners SET status=$1, version=version+1, updated_by=$2, updated_at=NOW() WHERE id=$3 RETURNING id', [status, req.admin.id, req.params.id]);
    if (!r.rowCount) return renderError(res, 404, t(res)('errorPage.notFoundTitle'), t(res)('errorPage.notFoundMessage'));
    store.invalidate();
    setFlash(req, 'success', t(res)(`adminVisual.status.${status}Done`));
    res.redirect(req.body.back === 'edit' ? `/admin/visual/banners/${req.params.id}/edit` : '/admin/visual/banners');
  }));

  app.post('/admin/visual/banners/:id/duplicate', requireAdmin, asyncRoute(async (req, res) => {
    const r = await pool.query(`INSERT INTO banners(name,slot,status,audience,locale_mode,starts_at,ends_at,priority,desktop_media_id,mobile_media_id,image_alt,image_alt_en,fit,bg_color,overlay_color,overlay_opacity,overlay_direction,text_color,content_x,content_y,text_align,content_width,height,layers,created_by,updated_by)
      SELECT LEFT(name || ' (2)', 160),slot,'draft',audience,locale_mode,starts_at,ends_at,priority,desktop_media_id,mobile_media_id,image_alt,image_alt_en,fit,bg_color,overlay_color,overlay_opacity,overlay_direction,text_color,content_x,content_y,text_align,content_width,height,layers,$2,$2
      FROM banners WHERE id=$1 RETURNING id`, [req.params.id, req.admin.id]);
    if (!r.rowCount) return renderError(res, 404, t(res)('errorPage.notFoundTitle'), t(res)('errorPage.notFoundMessage'));
    setFlash(req, 'success', t(res)('adminVisual.duplicated'));
    res.redirect(`/admin/visual/banners/${r.rows[0].id}/edit`);
  }));

  // Deleting a banner never deletes its images: they stay in the library for reuse.
  app.post('/admin/visual/banners/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM banners WHERE id=$1', [req.params.id]);
    store.invalidate();
    setFlash(req, 'success', t(res)('adminVisual.deleted'));
    res.redirect('/admin/visual/banners');
  }));

  // ───────────── Site images ─────────────
  app.get('/admin/visual/images', requireAdmin, asyncRoute(async (req, res) => {
    const [o, media] = await Promise.all([
      pool.query('SELECT o.slot_key,o.updated_at,m.id AS media_id,m.path,m.width,m.height,m.alt,m.alt_en FROM site_image_overrides o JOIN media_images m ON m.id=o.media_id'),
      recentMedia()
    ]);
    const current = Object.fromEntries(o.rows.map(r => [r.slot_key, r]));
    res.render('admin/visual-images', { title: t(res)('adminVisual.imagesTitle'), slots: SITE_IMAGE_SLOTS, current, media });
  }));

  app.post('/admin/visual/images/:key', requireAdmin, oneImage, multipartCsrf, verifyUploads(imagePolicy, '/admin/visual/images'), asyncRoute(async (req, res) => {
    const slot = siteImageSlot(req.params.key);
    if (!slot) { removeUploaded(req); return renderError(res, 404, t(res)('errorPage.notFoundTitle'), t(res)('errorPage.notFoundMessage')); }
    let mediaId = null;
    if (req.file) mediaId = await insertMedia(req.file, req.admin.id, req.body.alt, req.body.alt_en);
    else mediaId = await mediaExists(req.body.media_id);
    if (!mediaId) { setFlash(req, 'error', t(res)('adminVisual.err.noImage')); return res.redirect(`/admin/visual/images#slot-${slot.key}`); }
    if (!req.file && (req.body.alt || req.body.alt_en)) await pool.query('UPDATE media_images SET alt=COALESCE(NULLIF($1,\'\'),alt), alt_en=COALESCE(NULLIF($2,\'\'),alt_en) WHERE id=$3', [String(req.body.alt || '').slice(0, 300), String(req.body.alt_en || '').slice(0, 300), mediaId]);
    await pool.query(`INSERT INTO site_image_overrides(slot_key,media_id,updated_by) VALUES($1,$2,$3)
      ON CONFLICT (slot_key) DO UPDATE SET media_id=EXCLUDED.media_id, updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [slot.key, mediaId, req.admin.id]);
    store.invalidate();
    setFlash(req, 'success', t(res)('adminVisual.imageReplaced'));
    res.redirect(`/admin/visual/images#slot-${slot.key}`);
  }));

  app.post('/admin/visual/images/:key/reset', requireAdmin, asyncRoute(async (req, res) => {
    const slot = siteImageSlot(req.params.key);
    if (!slot) return renderError(res, 404, t(res)('errorPage.notFoundTitle'), t(res)('errorPage.notFoundMessage'));
    await pool.query('DELETE FROM site_image_overrides WHERE slot_key=$1', [slot.key]);
    store.invalidate();
    setFlash(req, 'success', t(res)('adminVisual.imageReset'));
    res.redirect(`/admin/visual/images#slot-${slot.key}`);
  }));

  // ───────────── Image library ─────────────
  app.get('/admin/visual/media', requireAdmin, asyncRoute(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const params = q ? [`%${q}%`] : [];
    const where = q ? 'WHERE m.original_name ILIKE $1 OR m.alt ILIKE $1 OR m.alt_en ILIKE $1' : '';
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM media_images m ${where}`, params)).rows[0].n;
    const r = await pool.query(`SELECT m.*,
        (SELECT COUNT(*) FROM banners b WHERE b.desktop_media_id=m.id OR b.mobile_media_id=m.id)::int
        + (SELECT COUNT(*) FROM site_image_overrides o WHERE o.media_id=m.id)::int AS uses
      FROM media_images m ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params);
    res.render('admin/visual-media', { title: t(res)('adminVisual.mediaTitle'), media: r.rows, q, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total });
  }));

  app.post('/admin/visual/media', requireAdmin, manyImages, multipartCsrf, verifyUploads(imagePolicy, '/admin/visual/media'), asyncRoute(async (req, res) => {
    const files = req.files || [];
    if (!files.length) { setFlash(req, 'error', t(res)('adminVisual.err.noImage')); return res.redirect('/admin/visual/media'); }
    try { for (const f of files) await insertMedia(f, req.admin.id, req.body.alt, req.body.alt_en); } catch (err) { removeUploaded(req); throw err; }
    setFlash(req, 'success', t(res)('adminVisual.uploaded').replace('{n}', String(files.length)));
    res.redirect('/admin/visual/media');
  }));

  app.post('/admin/visual/media/:id', requireAdmin, asyncRoute(async (req, res) => {
    await pool.query('UPDATE media_images SET alt=$1, alt_en=$2 WHERE id=$3', [String(req.body.alt || '').trim().slice(0, 300), String(req.body.alt_en || '').trim().slice(0, 300), req.params.id]);
    store.invalidate();
    setFlash(req, 'success', t(res)('adminVisual.altSaved'));
    res.redirect(`/admin/visual/media${req.body.page ? `?page=${Number.parseInt(req.body.page, 10) || 1}` : ''}#media-${req.params.id}`);
  }));

  app.post('/admin/visual/media/:id/delete', requireAdmin, asyncRoute(async (req, res) => {
    const m = await pool.query('SELECT path FROM media_images WHERE id=$1', [req.params.id]);
    if (!m.rowCount) return res.redirect('/admin/visual/media');
    const used = (await pool.query('SELECT (SELECT COUNT(*) FROM banners WHERE desktop_media_id=$1 OR mobile_media_id=$1) + (SELECT COUNT(*) FROM site_image_overrides WHERE media_id=$1) AS n', [req.params.id])).rows[0].n;
    if (Number(used) > 0) { setFlash(req, 'error', t(res)('adminVisual.err.inUse')); return res.redirect('/admin/visual/media'); }
    await pool.query('DELETE FROM media_images WHERE id=$1', [req.params.id]);
    // The same file may also have been pasted as a product/article cover; only remove it when nothing refers to it.
    const p = m.rows[0].path;
    const elsewhere = await pool.query(`SELECT (SELECT COUNT(*) FROM products WHERE cover_image=$1) + (SELECT COUNT(*) FROM articles WHERE cover_image=$1)
      + (SELECT COUNT(*) FROM article_images WHERE image_path=$1) + (SELECT COUNT(*) FROM product_gallery_images WHERE image_path=$1) AS n`, [p]);
    if (Number(elsewhere.rows[0].n) === 0 && /^\/media\/covers\/[A-Za-z0-9-]+\.(?:jpg|png|webp|gif)$/.test(p)) await fs.promises.rm(path.join(COVERS_DIR, path.basename(p)), { force: true });
    setFlash(req, 'success', t(res)('adminVisual.mediaDeleted'));
    res.redirect('/admin/visual/media');
  }));

  // ───────────── Public: banner button click-through ─────────────
  // Counts the click, then redirects to the link stored in the database (never to a URL from the request).
  app.get('/go/banner/:id/:idx', asyncRoute(async (req, res) => {
    const idx = Number.parseInt(req.params.idx, 10);
    const r = await pool.query("SELECT layers FROM banners WHERE id=$1 AND status='published'", [req.params.id]);
    const buttons = (r.rows[0]?.layers || []).filter(l => l.kind === 'button');
    const href = buttons[idx]?.href;
    if (!href || !isSafeHref(href)) return res.redirect('/');
    await pool.query('UPDATE banners SET clicks=clicks+1 WHERE id=$1', [req.params.id]).catch(() => {});
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.redirect(302, href);
  }));
}

module.exports = { registerVisualRoutes };
