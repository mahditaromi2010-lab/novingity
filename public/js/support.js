/* Help centre (/support), new-ticket form and admin ticket page.
   - Chat with «پشتیبان هوشمند»: AI text goes through an escape-first Markdown subset (no raw HTML from the model);
     [F1]/[P1] markers link to the source cards. Without AI the same box shows matching FAQ answers.
   - "Open a ticket with this conversation": the draft goes through sessionStorage (never the URL).
   - New ticket: matching FAQ answers appear while the subject is typed (no AI, no cost).
   - Admin: «پیش‌نویس با هوش مصنوعی» fills the reply box; the agent edits before sending. */
(() => {
  'use strict';
  let ui = {};
  try { ui = JSON.parse(document.getElementById('support-ui')?.textContent || '{}'); } catch { ui = {}; }
  const L = k => ui[k] || k;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const csrfOf = el => el?.querySelector('input[name="_csrf"]')?.value || document.querySelector('input[name="_csrf"]')?.value || '';
  const DRAFT_KEY = 'nv-ticket-draft';
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Help-centre chat ----------
  const form = document.getElementById('spForm');
  if (form) {
    const thread = document.getElementById('spThread');
    const input = document.getElementById('spQuestion');
    const send = document.getElementById('spSend');
    const examples = document.getElementById('spExamples');
    const csrf = csrfOf(form);
    const history = [];
    const transcript = [];
    let turn = 0;

    const inline = (s, prefix) => esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([FP])(\d{1,2})\]/g, (_, k, n) => `<a class="as-cite" href="#${prefix}-${k}${n}" data-cite="${prefix}-${k}${n}">${k === 'F' ? '' : '◆'}${n}</a>`);
    function markdown(text, prefix) {
      const out = []; let list = null;
      String(text).split(/\n/).forEach(raw => {
        const line = raw.trim();
        const li = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
        if (li) { (list = list || []).push(`<li>${inline(li[1], prefix)}</li>`); return; }
        if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
        if (line) out.push(`<p>${inline(line.replace(/^#{1,4}\s+/, ''), prefix)}</p>`);
      });
      if (list) out.push(`<ul>${list.join('')}</ul>`);
      return out.join('');
    }
    function bubble(role, html) {
      const el = document.createElement('article');
      el.className = `as-msg as-msg--${role}`;
      el.innerHTML = html;
      thread.appendChild(el);
      el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
      return el;
    }
    // Only same-site paths are rendered as links (the server builds them, this is a second guard).
    const safePath = u => (typeof u === 'string' && /^\/(?!\/)[\w\-./?=&#%]*$/.test(u) ? u : '#');
    function sourcesHtml(r, prefix, open) {
      const items = (r.sources || []).map(s => `<li id="${prefix}-${esc(s.marker)}" class="as-source"><b>${s.type === 'faq' ? esc(s.marker.slice(1)) : '◆'}</b><div><span class="as-source-label">${esc(s.type === 'faq' ? L('faqLabel') : L('productLabel'))}</span> <a href="${esc(safePath(s.url))}">${esc(s.title)}</a><p>${esc(s.text)}</p></div></li>`).join('');
      return items ? `<details class="as-sources" ${open ? 'open' : ''}><summary>${esc(L(r.mode === 'ai' ? 'sourcesTitle' : 'fallbackTitle'))} (${(r.sources || []).length})</summary><ol>${items}</ol></details>` : '';
    }
    function handoffHtml(r) {
      return `<div class="sp-handoff"><p>${esc(L('handoff'))}</p><button type="button" class="button button-primary button-small" data-handoff>${esc(r.signedIn ? L('handoffButton') : L('handoffLogin'))}</button></div>`;
    }

    async function ask(question) {
      const prefix = `t${++turn}`;
      bubble('user', `<p>${esc(question)}</p>`);
      transcript.push({ who: 'user', text: question });
      if (examples) examples.hidden = true;
      const pending = bubble('bot', `<p class="as-typing"><span></span><span></span><span></span> ${esc(L('sending'))}</p>`);
      thread.setAttribute('aria-busy', 'true'); send.disabled = true;
      try {
        const res = await fetch('/api/support/ask', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _csrf: csrf, question, history }) });
        const r = await res.json().catch(() => ({}));
        if (!res.ok) { pending.innerHTML = `<p class="as-error">${esc(r.error || L('error.generic'))}</p>`; return; }
        let body = '';
        if (r.mode === 'ai' && r.answer) {
          body = `<span class="as-badge">${esc(L('aiLabel'))}</span>${markdown(r.answer, prefix)}`;
          history.push({ role: 'user', content: question }, { role: 'assistant', content: r.answer });
          while (history.length > 4) history.shift();
          transcript.push({ who: 'ai', text: r.answer });
        } else {
          body = (r.sources || []).length ? '' : `<p class="as-fallback">${esc(L('fallbackNone'))}</p>`;
        }
        body += sourcesHtml(r, prefix, r.mode !== 'ai');
        if (r.handoff || r.mode !== 'ai') body += handoffHtml(r);
        if (r.mode === 'ai') body += `<div class="as-actions"><button type="button" data-copy>${esc(L('copy'))}</button><button type="button" data-rate="1" aria-label="${esc(L('helpful'))}">👍</button><button type="button" data-rate="-1" aria-label="${esc(L('notHelpful'))}">👎</button></div>`;
        pending.innerHTML = body;
        pending.dataset.question = question; pending.dataset.answer = r.answer || ''; pending.dataset.model = r.model || '';
      } catch {
        pending.innerHTML = `<p class="as-error">${esc(L('error.generic'))}</p>`;
      } finally {
        thread.setAttribute('aria-busy', 'false'); send.disabled = false; input.focus();
      }
    }

    form.addEventListener('submit', e => {
      e.preventDefault();
      const q = input.value.trim();
      if (q.length < 2) { input.focus(); return; }
      input.value = '';
      ask(q);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    examples?.addEventListener('click', e => { const b = e.target.closest('[data-example]'); if (b) ask(b.textContent.trim()); });

    thread.addEventListener('click', async e => {
      const cite = e.target.closest('[data-cite]');
      if (cite) {
        const li = document.getElementById(cite.dataset.cite);
        if (li) { e.preventDefault(); li.closest('details').open = true; li.scrollIntoView({ block: 'center' }); li.classList.add('is-flash'); setTimeout(() => li.classList.remove('is-flash'), 1200); }
        return;
      }
      if (e.target.closest('[data-handoff]')) {
        const firstQ = transcript.find(x => x.who === 'user')?.text || '';
        const lines = transcript.map(x => `${x.who === 'user' ? '•' : '—'} ${x.text}`).join('\n');
        try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ subject: firstQ.slice(0, 120), message: lines.slice(0, 3800) })); } catch { /* storage blocked: the form opens empty */ }
        location.href = '/account/tickets/new?from=assistant';
        return;
      }
      const msg = e.target.closest('.as-msg');
      if (e.target.closest('[data-copy]')) {
        try { await navigator.clipboard.writeText(msg.dataset.answer); e.target.textContent = L('copied'); } catch { /* clipboard blocked */ }
        return;
      }
      const rate = e.target.closest('[data-rate]');
      if (rate) {
        msg.querySelectorAll('[data-rate]').forEach(b => { b.disabled = true; });
        try {
          await fetch('/api/support/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: csrf, rating: Number(rate.dataset.rate), question: msg.dataset.question, answer: msg.dataset.answer, model: msg.dataset.model }) });
          rate.insertAdjacentHTML('afterend', `<span class="as-thanks">${esc(L('thanks'))}</span>`);
        } catch { /* ignore */ }
      }
    });
  }

  // ---------- FAQ: category filter and "was this helpful?" ----------
  const filter = document.querySelector('[data-faq-filter]');
  if (filter) {
    filter.hidden = false;
    filter.addEventListener('click', e => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      const cat = b.getAttribute('data-cat');
      filter.querySelectorAll('[data-cat]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      document.querySelectorAll('.sp-faq').forEach(d => { d.hidden = !!cat && d.getAttribute('data-cat') !== cat; });
    });
  }
  const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  if (target && target.classList.contains('sp-faq')) target.open = true;
  document.querySelectorAll('[data-faq-vote]').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault();
    const helpful = e.submitter?.value === '1' ? '1' : '0';
    f.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await fetch(f.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrfOf(f), helpful }) });
      f.querySelector('span').textContent = '✓';
    } catch { /* ignore */ }
  }));

  // ---------- New ticket: draft from the chat + FAQ suggestions ----------
  const ticketForm = document.querySelector('[data-ticket-form]');
  if (ticketForm) {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        const subject = ticketForm.elements.subject;
        const message = ticketForm.elements.message;
        if (subject && !subject.value) subject.value = String(d.subject || '').slice(0, 200);
        if (message && !message.value) message.value = String(d.message || '').slice(0, 4000);
        ticketForm.querySelector('[data-ticket-source]').value = 'assistant';
        ticketForm.querySelector('[data-from-assistant]').hidden = false;
        sessionStorage.removeItem(DRAFT_KEY);
      }
    } catch { /* storage unavailable */ }

    const box = ticketForm.querySelector('[data-suggest-box]');
    const list = ticketForm.querySelector('[data-suggest-list]');
    const subjectInput = ticketForm.querySelector('[data-suggest-input]');
    let timer = 0; let last = '';
    const lookup = async () => {
      const q = subjectInput.value.trim();
      if (q === last) return;
      last = q;
      if (q.length < 4) { box.hidden = true; return; }
      try {
        const res = await fetch(`/api/support/suggest?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
        const { items = [] } = await res.json();
        list.replaceChildren(...items.map(it => {
          const li = document.createElement('li');
          const det = document.createElement('details');
          const sum = document.createElement('summary'); sum.textContent = it.question;
          const p = document.createElement('p'); p.textContent = it.answer;
          det.append(sum, p); li.append(det);
          return li;
        }));
        box.hidden = !items.length;
      } catch { box.hidden = true; }
    };
    subjectInput?.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(lookup, 450); });
  }

  // ---------- Admin: AI reply draft ----------
  const draftBtn = document.querySelector('[data-ai-draft]');
  if (draftBtn) {
    const replyForm = draftBtn.closest('form');
    const box = replyForm.querySelector('[data-reply-text]');
    const note = replyForm.querySelector('[data-draft-note]');
    draftBtn.addEventListener('click', async e => {
      e.preventDefault();
      const label = draftBtn.innerHTML;
      draftBtn.disabled = true; draftBtn.textContent = L('drafting');
      try {
        const res = await fetch(draftBtn.getAttribute('formaction'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrfOf(replyForm) }) });
        const r = await res.json().catch(() => ({}));
        if (!res.ok || !r.text) throw new Error(r.error || L('draftError'));
        // Never throw away what the agent already typed: the draft goes under it.
        box.value = box.value.trim() ? `${box.value.trim()}\n\n———\n${r.text}` : r.text;
        replyForm.querySelector('[data-ai-assisted]').value = '1';
        if (note) note.hidden = false;
        box.focus();
      } catch (err) {
        if (note) { note.hidden = false; note.textContent = err.message || L('draftError'); }
      } finally { draftBtn.disabled = false; draftBtn.innerHTML = label; }
    });
  }
})();
