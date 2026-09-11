/* ============================================================================
 *  tools/harvest.js — PASTE THIS INTO THE DEVTOOLS CONSOLE ON A LIVE WORKDAY PAGE
 *
 *  It is not loaded by the extension. It exists so you never have to hunt
 *  through the Elements panel by hand.
 *
 *  Usage:
 *    1. Open the Workday Create Account page.
 *    2. DevTools → Console → paste this whole file → Enter.
 *    3. Read the table. Copy the ids you need into sites/workday.js.
 *
 *  Extras once it has run:
 *    __afHarvest()             re-scan (after the form changes)
 *    __afHarvest(true)         include off-screen / hidden elements too
 *    __afCopy()                copy a ready-made fields:{} block to the clipboard
 *    __afWhat($0)              what is the automation-id of the element I selected?
 * ========================================================================= */

(() => {
  const visible = (el) => el.getClientRects().length > 0;

  /** Best-effort human label, so you can tell which field is which. */
  function labelFor(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (text) return text;
    }

    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }

    const wrapped = el.closest('label');
    if (wrapped) return wrapped.textContent.trim().slice(0, 60);

    if (el.placeholder) return `(placeholder) ${el.placeholder}`;

    // For buttons and headings, their own text is the best label there is.
    const own = el.textContent?.trim();
    if (own && own.length <= 60) return own;

    return '';
  }

  function scan(includeHidden = false) {
    const nodes = [...document.querySelectorAll('[data-automation-id]')];
    const rows = [];

    for (const el of nodes) {
      if (!includeHidden && !visible(el)) continue;

      // The interesting element is the input, if this node wraps one.
      const field = el.matches('input, select, textarea')
        ? el
        : el.querySelector('input, select, textarea');

      rows.push({
        'automation-id': el.getAttribute('data-automation-id'),
        tag: el.tagName.toLowerCase(),
        type: field?.type ?? (el.tagName === 'BUTTON' ? 'button' : ''),
        fillable: field ? '✓' : '',
        label: labelFor(field ?? el),
      });
    }

    return rows;
  }

  window.__afHarvest = (includeHidden = false) => {
    const rows = scan(includeHidden);
    console.clear();
    console.log(
      `%c${rows.length} data-automation-id elements${includeHidden ? ' (incl. hidden)' : ' on screen'}`,
      'color:#7c5cff;font-weight:bold;font-size:13px'
    );
    console.table(rows);
    console.log(
      '%cNext: __afCopy() puts a fields:{} block on your clipboard.',
      'color:#8a8a9c'
    );
    return rows;
  };

  /** Build a paste-ready fields block from the fillable elements on screen. */
  window.__afCopy = () => {
    const rows = scan().filter((r) => r.fillable);

    const lines = rows.map((r) => {
      const key = (r.label || r['automation-id'])
        .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
        .replace(/[^a-zA-Z0-9]/g, '')
        .replace(/^./, (c) => c.toLowerCase())
        .slice(0, 28);
      return `  ${key}: '[data-automation-id="${r['automation-id']}"]',  // ${r.type} — ${r.label}`;
    });

    const block = `fields: {\n${lines.join('\n')}\n},`;
    console.log(block);
    copy(block); // DevTools built-in
    console.log('%cCopied to clipboard.', 'color:#46c17f');
    return block;
  };

  /** Select an element in the Elements panel, then run __afWhat($0). */
  window.__afWhat = (el) => {
    if (!el) return console.warn('Pass an element, e.g. __afWhat($0)');
    const owner = el.closest('[data-automation-id]');
    if (!owner) return console.warn('No data-automation-id on this element or its ancestors.');
    const id = owner.getAttribute('data-automation-id');
    console.log(`%c[data-automation-id="${id}"]`, 'color:#7c5cff;font-weight:bold');
    return `[data-automation-id="${id}"]`;
  };

  __afHarvest();
})();
