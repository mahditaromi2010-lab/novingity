// Admin «بنرها و تصاویر»: live banner preview, layer rows (add / remove / reorder), time-zone offset for the
// schedule, filter auto-submit. The preview builds DOM nodes with textContent only (no innerHTML from input).
(() => {
  'use strict';

  document.querySelectorAll('[data-autosubmit]').forEach(el => el.addEventListener('change', () => el.form && el.form.submit()));
  document.querySelectorAll('[data-select-on-focus]').forEach(el => el.addEventListener('focus', () => el.select()));
  const summary = document.querySelector('[data-error-summary]');
  if (summary) summary.focus();

  const form = document.querySelector('[data-banner-form]');
  if (!form) return;

  const tz = form.querySelector('[data-tz-offset]');
  if (tz) tz.value = String(new Date().getTimezoneOffset());

  const list = form.querySelector('[data-layers]');
  const template = form.querySelector('[data-layer-template]');
  const root = document.querySelector('[data-preview-root]');
  const banner = document.querySelector('[data-preview-banner]');
  const content = document.querySelector('[data-preview-content]');
  const overlay = document.querySelector('[data-preview-overlay]');
  const media = document.querySelector('[data-preview-media]');
  const img = document.querySelector('[data-preview-img]');
  const bar = document.querySelector('[data-preview-bar]');
  let initial = {};
  try { initial = JSON.parse(document.getElementById('av-i18n')?.textContent || '{}'); } catch { initial = {}; }
  const images = { desktop: initial.desktopPath || '', mobile: initial.mobilePath || '' };
  const objectUrls = {};
  let lang = 'fa';
  let device = 'desktop';

  const val = name => form.elements[name] ? form.elements[name].value : '';
  const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, Number(a) || 0))})`; };

  function overlayCss() {
    const dirName = val('overlay_direction');
    const op = Number(val('overlay_opacity'));
    if (dirName === 'none' || op <= 0) return 'none';
    const c = val('overlay_color');
    if (dirName === 'flat') return rgba(c, op);
    const rtl = lang === 'fa';
    const startSide = rtl ? 'right' : 'left';
    const endSide = rtl ? 'left' : 'right';
    const to = { 'to-start': endSide, 'to-end': startSide, 'to-top': 'bottom', 'to-bottom': 'top' }[dirName] || endSide;
    return `linear-gradient(to ${to}, ${rgba(c, op)} 0%, ${rgba(c, op * 0.55)} 45%, ${rgba(c, 0)} 100%)`;
  }

  function layers() {
    return [...list.querySelectorAll('[data-layer]')].map(li => {
      const f = n => li.querySelector(`[name="${n}"]`)?.value || '';
      return { kind: f('layer_kind'), text: f('layer_text'), text_en: f('layer_text_en'), size: f('layer_size'), hide: f('layer_hide_mobile') === '1', style: f('layer_style') };
    });
  }

  function render() {
    const slotOpt = form.elements.slot?.selectedOptions?.[0];
    const isBar = slotOpt?.dataset.kind === 'bar';
    root.dir = lang === 'fa' ? 'rtl' : 'ltr';
    root.classList.toggle('is-mobile', device === 'mobile');
    form.querySelector('[data-image-section]')?.toggleAttribute('hidden', isBar);
    const ls = layers();
    const textOf = l => (lang === 'en' ? l.text_en || l.text : l.text || l.text_en);

    bar.hidden = !isBar;
    banner.hidden = isBar;
    if (isBar) {
      bar.style.setProperty('--nv-bg', val('bg_color'));
      bar.style.setProperty('--nv-text', val('text_color'));
      bar.querySelector('[data-bar-text]').textContent = ls.filter(l => l.kind !== 'button').map(textOf).filter(Boolean).join(' · ');
      const btn = ls.find(l => l.kind === 'button' && textOf(l));
      const a = bar.querySelector('[data-bar-link]');
      a.textContent = btn ? `${textOf(btn)} ${lang === 'fa' ? '←' : '→'}` : '';
      a.hidden = !btn;
      return;
    }

    banner.className = `nv-banner nv-h-${val('height')} nv-x-${val('content_x')} nv-y-${val('content_y')} nv-align-${val('text_align')}`;
    banner.style.setProperty('--nv-bg', val('bg_color'));
    banner.style.setProperty('--nv-text', val('text_color'));
    banner.style.setProperty('--nv-width', `${val('content_width')}%`);
    overlay.style.background = overlayCss();
    const src = device === 'mobile' ? (images.mobile || images.desktop) : images.desktop;
    media.hidden = !src;
    if (src) { img.src = src; img.className = `nv-fit-${val('fit')}`; }

    content.replaceChildren();
    const actions = document.createElement('div');
    actions.className = 'nv-actions';
    ls.forEach(l => {
      const text = textOf(l);
      if (!text) return;
      let el;
      if (l.kind === 'badge') { el = document.createElement('span'); el.className = 'nv-badge'; }
      else if (l.kind === 'title') { el = document.createElement('h2'); el.className = `nv-title nv-s-${l.size}`; }
      else if (l.kind === 'button') { el = document.createElement('span'); el.className = `button nv-btn nv-btn-${l.style}${l.style === 'primary' ? ' button-primary' : ''}`; }
      else { el = document.createElement('p'); el.className = `nv-${l.kind} nv-s-${l.size}`; }
      if (l.hide) el.classList.add('nv-hide-m');
      el.textContent = l.kind === 'button' ? `${text} ${lang === 'fa' ? '←' : '→'}` : text;
      (l.kind === 'button' ? actions : content).appendChild(el);
    });
    if (actions.childElementCount) content.appendChild(actions);
  }

  form.addEventListener('input', render);
  form.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-preview-file]') && t.files && t.files[0]) {
      const k = t.getAttribute('data-preview-file');
      if (objectUrls[k]) URL.revokeObjectURL(objectUrls[k]);
      objectUrls[k] = URL.createObjectURL(t.files[0]);
      images[k] = objectUrls[k];
    }
    if (t.matches('[data-preview-pick]')) images[t.getAttribute('data-preview-pick')] = t.getAttribute('data-path') || '';
    if (t.matches('[data-layer-kind]')) t.closest('[data-layer]').setAttribute('data-kind', t.value);
    if (t.matches('input[type="range"]')) {
      const out = form.querySelector(`[data-out-for="${t.name}"]`);
      if (out) out.textContent = `${Math.round(t.name === 'overlay_opacity' ? Number(t.value) * 100 : Number(t.value))}%`;
    }
    render();
  });
  form.querySelectorAll('input[type="range"]').forEach(r => r.addEventListener('input', () => r.dispatchEvent(new Event('change', { bubbles: true }))));

  list.addEventListener('click', e => {
    const li = e.target.closest('[data-layer]');
    if (!li) return;
    if (e.target.closest('[data-layer-remove]')) { li.remove(); }
    else if (e.target.closest('[data-layer-up]') && li.previousElementSibling) { li.parentNode.insertBefore(li, li.previousElementSibling); e.target.closest('button').focus(); }
    else if (e.target.closest('[data-layer-down]') && li.nextElementSibling) { li.parentNode.insertBefore(li.nextElementSibling, li); e.target.closest('button').focus(); }
    else return;
    render();
  });
  form.querySelector('[data-add-layer]')?.addEventListener('click', () => {
    if (list.children.length >= 8) return;
    const node = template.content.firstElementChild.cloneNode(true);
    list.appendChild(node);
    node.querySelector('input[name="layer_text"]')?.focus();
    render();
  });

  document.querySelectorAll('[data-device]').forEach(b => b.addEventListener('click', () => {
    device = b.getAttribute('data-device');
    document.querySelectorAll('[data-device]').forEach(x => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    render();
  }));
  document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
    lang = b.getAttribute('data-lang');
    document.querySelectorAll('[data-lang]').forEach(x => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    render();
  }));

  render();
})();
