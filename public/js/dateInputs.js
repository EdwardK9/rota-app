/* ─── dd/mm/yyyy date inputs ─────────────────────────────────────────────────
   <input type="date"> shows dates in the *browser's* locale, so a US-locale
   browser renders mm/dd/yyyy no matter what the page says. This app is UK-only,
   so every date input is upgraded here into a text box that always reads and
   writes dd/mm/yyyy, with a calendar icon at its right-hand end that opens the
   native picker.

   Nothing else has to change: each upgraded input's `.value` still reads and
   writes ISO 'YYYY-MM-DD' (and reads '' while the text is incomplete or not a
   real date), so existing code, API calls and `input`/`change` listeners keep
   working. Opt out with the `data-nodate` attribute.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const getRaw = el => desc.get.call(el);
  const setRaw = (el, v) => desc.set.call(el, v);

  const toDisplay = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const toISO = txt => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((txt || '').trim());
    if (!m) return '';
    const d = +m[1], mo = +m[2], y = +m[3];
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  function upgrade(el) {
    if (el.type !== 'date' || el.hasAttribute('data-nodate') || el._ukDate) return;
    el._ukDate = true;
    const iso = getRaw(el);
    el.type = 'text';
    el.placeholder = 'dd/mm/yyyy';
    el.maxLength = 10;
    el.autocomplete = 'off';
    el.inputMode = 'numeric';

    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return toISO(getRaw(el)); },
      set(v) { setRaw(el, /^\d{4}-\d{2}-\d{2}/.test(v || '') ? toDisplay(String(v).slice(0, 10)) : (v || '')); },
    });
    setRaw(el, toDisplay(iso));

    // Auto-insert the slashes as digits are typed (not while deleting).
    el.addEventListener('input', e => {
      el.style.borderColor = '';
      if (e.inputType && e.inputType.startsWith('delete')) return;
      const d = getRaw(el).replace(/\D/g, '').slice(0, 8);
      let out = d.slice(0, 2);
      if (d.length >= 2) out += '/';
      if (d.length > 2) out += d.slice(2, 4);
      if (d.length >= 4) out += '/';
      if (d.length > 4) out += d.slice(4);
      if (d.length === 2 || d.length === 4) { /* trailing slash kept */ }
      setRaw(el, out);
    });
    el.addEventListener('blur', () => {
      const t = getRaw(el).trim();
      el.style.borderColor = t && !toISO(t) ? '#EF4444' : '';
    });

    // Calendar button → native picker, kept out of sight.
    const picker = document.createElement('input');
    picker.type = 'date';
    picker.setAttribute('data-nodate', '');
    picker.tabIndex = -1;
    picker.setAttribute('aria-hidden', 'true');
    picker.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;border:0;padding:0';
    // The calendar icon is drawn inside the right-hand end of the box itself
    // (a background image) rather than being a button next to it: a separate
    // button had nowhere to go beside a full-width box and dropped onto its
    // own line underneath. Tapping that end of the box opens the picker; so
    // does Alt+↓ from the keyboard.
    const ZONE = 36;   // px at the right-hand end that count as "the icon"
    el.classList.add('date-ui');
    el.title = el.title || 'dd/mm/yyyy — tap the calendar to pick a date';
    const openPicker = () => {
      picker.value = el.value || '';
      try { picker.showPicker(); } catch (_) { picker.focus(); picker.click(); }
    };
    const inZone = e => e.clientX >= el.getBoundingClientRect().right - ZONE;
    el.addEventListener('click', e => { if (inZone(e)) { e.preventDefault(); el.blur(); openPicker(); } });
    el.addEventListener('mousemove', e => { el.style.cursor = inZone(e) ? 'pointer' : ''; });
    el.addEventListener('keydown', e => { if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); openPicker(); } });
    picker.addEventListener('change', () => {
      if (!picker.value) return;
      el.value = picker.value;
      el.style.borderColor = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    el.after(picker);
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches && root.matches('input[type="date"]')) upgrade(root);
    root.querySelectorAll && root.querySelectorAll('input[type="date"]').forEach(upgrade);
  }

  const start = () => {
    scan(document.body);
    new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(scan)))
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
