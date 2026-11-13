/* «دستیار مبحث ۱۷» — chat UI. AI text is rendered through a tiny escape-first Markdown subset (no raw HTML),
   source markers [S1] become links to the source cards under the answer. */
(() => {
  const form = document.getElementById('asForm');
  if (!form) return;
  const thread = document.getElementById('asThread');
  const input = document.getElementById('asQuestion');
  const send = document.getElementById('asSend');
  const examples = document.getElementById('asExamples');
  let ui = {};
  try { ui = JSON.parse(document.getElementById('assistant-ui').textContent); } catch { /* defaults below */ }
  const L = k => ui[k] || k;
  const csrf = form.querySelector('input[name="_csrf"]').value;
  const history = [];
  let turn = 0;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function inline(s, prefix) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[S(\d{1,2})\]/g, (_, n) => `<a class="as-cite" href="#${prefix}-s${n}" data-cite="${prefix}-s${n}">${n}</a>`);
  }
  function markdown(text, prefix) {
    const out = []; let list = null;
    String(text).split(/\n/).forEach(raw => {
      const line = raw.trim();
      const li = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1], prefix)}</li>`); return; }
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      if (!line) return;
      const h = /^#{1,4}\s+(.*)$/.exec(line);
      out.push(h ? `<h3>${inline(h[1], prefix)}</h3>` : `<p>${inline(line, prefix)}</p>`);
    });
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  }

  function bubble(role, html) {
    const el = document.createElement('article');
    el.className = `as-msg as-msg--${role}`;
    el.innerHTML = html;
    thread.appendChild(el);
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
    return el;
  }

  function sourcesHtml(r, prefix) {
    const src = (r.sources || []).map((s, i) => `<li id="${prefix}-s${i + 1}" class="as-source"><b>${i + 1}</b><div><span class="as-source-label">${esc(s.label)}${s.heading ? ' · ' + esc(s.heading) : ''}</span><p>${esc(s.excerpt)}${s.excerpt && s.excerpt.length >= 400 ? '…' : ''}</p></div></li>`).join('');
    const notes = (r.notes || []).map(n => `<details class="as-note"><summary>${esc(n.question)}</summary><p>${esc(n.answer)}</p></details>`).join('');
    return `${src ? `<details class="as-sources" ${r.mode === 'fallback' ? 'open' : ''}><summary>${esc(L('sourcesTitle'))} (${(r.sources || []).length})</summary><ol>${src}</ol></details>` : ''}${notes ? `<div class="as-notes"><h4>${esc(L('expertTitle'))}</h4>${notes}</div>` : ''}`;
  }

  async function ask(question) {
    const prefix = `t${++turn}`;
    bubble('user', `<p>${esc(question)}</p>`);
    if (examples) examples.hidden = true;
    const pending = bubble('bot', `<p class="as-typing"><span></span><span></span><span></span> ${esc(L('sending'))}</p>`);
    thread.setAttribute('aria-busy', 'true'); send.disabled = true;
    try {
      const res = await fetch('/api/assistant/ask', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ _csrf: csrf, question, history }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { pending.innerHTML = `<p class="as-error">${esc(r.error || L('error.generic'))}</p>`; return; }
      let body = '';
      if (r.mode === 'ai' && r.answer) {
        body = `<span class="as-badge">${esc(L('aiLabel'))}</span>${markdown(r.answer, prefix)}`;
        history.push({ role: 'user', content: question }, { role: 'assistant', content: r.answer });
        while (history.length > 4) history.shift();
      } else {
        body = `<p class="as-fallback">${esc((r.sources || []).length ? L('fallbackNote') : L('noSources'))}</p>`;
      }
      body += sourcesHtml(r, prefix);
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
    if (q.length < 3) { input.focus(); return; }
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
    const msg = e.target.closest('.as-msg');
    if (e.target.closest('[data-copy]')) {
      try { await navigator.clipboard.writeText(msg.dataset.answer); e.target.textContent = L('copied'); } catch { /* clipboard blocked */ }
      return;
    }
    const rate = e.target.closest('[data-rate]');
    if (rate) {
      msg.querySelectorAll('[data-rate]').forEach(b => { b.disabled = true; });
      try {
        await fetch('/api/assistant/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: csrf, rating: Number(rate.dataset.rate), question: msg.dataset.question, answer: msg.dataset.answer, model: msg.dataset.model }) });
        rate.insertAdjacentHTML('afterend', `<span class="as-thanks">${esc(L('thanks'))}</span>`);
      } catch { /* ignore */ }
    }
  });
})();
