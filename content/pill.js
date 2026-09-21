/**
 * pill.js — the little "use my saved answer" chip that appears under a field.
 *
 * Deliberately NOT part of widget.js. That one is a fixed-position panel in the
 * corner with its own dragging, collapsing and saved position; this one tracks
 * a moving element through scrolls, resizes and React re-renders. Merging them
 * would mean one component with two incompatible positioning models.
 *
 * Same shadow-root treatment and the same reasoning: Workday ships aggressive
 * global CSS, and the boundary keeps it out.
 *
 * The pill only ever OFFERS. Clicking it is what fills the field — nothing here
 * writes on its own. That is the whole point of the feature: the visa
 * explanation is a personal legal statement, so it goes in when you say so.
 */

AF.pill = (() => {
  let host = null;
  let root = null;
  let els = {};

  /** The field the pill is currently offering itself to, or null. */
  let target = null;
  /** Called with the target element when the pill is clicked. */
  let onAccept = null;

  const GAP = 6;        // px between the field's bottom edge and the pill
  const MIN_WIDTH = 90; // below this the field is too narrow to sit under

  const CSS = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, sans-serif; }

    .pill {
      all: unset;
      /* all: unset resets box-sizing to content-box even where the * rule above
         already set border-box — the * rule has zero specificity. Same trap as
         widget.js; re-declare it. */
      box-sizing: border-box;
      display: inline-flex; align-items: center; gap: 6px;
      max-width: 100%;
      padding: 6px 11px;
      border-radius: 999px;
      background: #16161d;
      border: 1px solid #7c5cff;
      color: #e8e8ee;
      font-size: 12px; line-height: 1.3; font-weight: 550;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,.45);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pill:hover { background: #22222c; }
    .pill:active { transform: translateY(1px); }

    .bolt { color: #7c5cff; font-size: 12px; flex: none; }

    .pill.done { border-color: #46c17f; cursor: default; }
    .pill.done .bolt { color: #46c17f; }
    .pill.warn { border-color: #f0a83c; cursor: default; }
    .pill.warn .bolt { color: #f0a83c; }
  `;

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'af-pill-host';
    /* 'all: initial' first — it wipes everything declared before it. Everything
     * after is !important for the same reason widget.js does it: Workday's
     * global rules will win any unweighted contest over position or z-index.
     * One below the widget, so the two can never cover each other. */
    host.style.cssText = `
      all: initial;
      position: absolute !important;
      z-index: 2147483646 !important;
      display: none !important;
      margin: 0 !important;
      padding: 0 !important;
    `;

    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.type = 'button';
    btn.innerHTML = `<span class="bolt">⚡</span><span class="label"></span>`;

    root.append(style, btn);
    els = { btn, label: root.querySelector('.label') };

    /* pointerdown, not click: the field is focused, and a click would first fire
     * blur on it. Several of the hide paths key off focus moving away, so by the
     * time click arrived the pill could already be gone. */
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (target && onAccept) onAccept(target);
    });

    /* Stops the pill itself taking focus off the field. pointerdown's
     * preventDefault does not cover this for mouse input — moving focus is
     * mousedown's default action — and the button is focusable, so without this
     * the press lands on the pill before the handler above reads `target`.
     *
     * Note this does NOT keep the field focused after a fill. AF.setNativeValue
     * blurs deliberately, because Workday runs its "this field is required"
     * validation on blur; see the sequence note in content/react-set.js. The
     * field ends up blurred and validated, which is what we want. */
    btn.addEventListener('mousedown', (e) => e.preventDefault());

    document.documentElement.append(host);
  }

  /**
   * Put the pill under `el`.
   *
   * Document coordinates, not viewport: the host is position:absolute, so it
   * scrolls with the page for free instead of needing a scroll handler to keep
   * up. reposition() then only has to run when the layout actually moves.
   */
  function place(el) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN_WIDTH || !r.height) return false;

    host.style.setProperty('left', `${r.left + window.scrollX}px`, 'important');
    host.style.setProperty('top', `${r.bottom + window.scrollY + GAP}px`, 'important');
    host.style.setProperty('max-width', `${Math.max(r.width, 180)}px`, 'important');
    return true;
  }

  /**
   * Offer `text` on `el`.
   *
   * @param {object} opts
   *   opts.label  pill text
   *   opts.state  null | 'done' | 'warn'  — 'done'/'warn' are not clickable
   */
  function show(el, { label, state = null } = {}) {
    build();
    target = el;

    els.label.textContent = label ?? 'Use my saved answer';
    els.btn.className = 'pill' + (state ? ' ' + state : '');
    els.btn.disabled = !!state;
    els.btn.title = label ?? '';

    if (!place(el)) return hide();
    host.style.setProperty('display', 'block', 'important');
  }

  function hide() {
    target = null;
    if (host) host.style.setProperty('display', 'none', 'important');
  }

  /** Re-place on the current target. Cheap enough to call from scroll/resize. */
  function reposition() {
    if (!host || !target) return;
    /* The field can be removed by a React re-render while the pill still points
     * at it — offering to fill a detached node would do nothing and look broken. */
    if (!target.isConnected) return hide();
    if (!place(target)) hide();
  }

  function destroy() {
    host?.remove();
    host = null;
    root = null;
    els = {};
    target = null;
  }

  return {
    show, hide, reposition, destroy,
    setAcceptHandler: (fn) => { onAccept = fn; },
    currentTarget: () => target,
    isShowing: () => !!host && host.style.display !== 'none' && !!target,
  };
})();
