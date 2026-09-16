/**
 * widget.js — the floating button in the corner of the page.
 *
 * Lives entirely inside a shadow root. That matters: Workday ships a lot of
 * aggressive global CSS, and a shadow root means none of it reaches us and none
 * of ours reaches the page. The host element carries the only page-level styles
 * (position + z-index) and nothing else.
 *
 * The widget is pure UI — it renders state and reports clicks. Every decision
 * about what to fill and whether to submit lives in main.js.
 *
 * It is also draggable — by its header strip when expanded; see the
 * "dragging" section below.
 */

AF.widget = (() => {
  let host = null;
  let root = null;
  let els = {};
  let handlers = {}; // { onFill, onUnlock, onOpenOptions }
  let collapsed = false;

  /** {left, top} once the user has moved the widget; null while it still sits
   *  in its default bottom-right corner. */
  let pos = null;
  /** Bookkeeping for the press currently in progress, or null. */
  let drag = null;

  const EDGE_MARGIN = 6;           // px of viewport the widget may never cross
  const DRAG_THRESHOLD = 4;        // px of movement before a press becomes a drag

  /* ── THE FIX FOR "ELEMENTS FLOWING OUT OF BOUNDS" ──────────────────
   * `all: unset` is the right tool for shrugging off Workday's global CSS, but
   * it also resets box-sizing to its initial value, content-box — including on
   * elements that the `*` rule had already set to border-box, because `*` has
   * zero specificity. So `width: 100%` plus horizontal padding measured WIDER
   * than the panel, and the button and input overflowed the rounded corners.
   *
   * Every rule that uses `all: unset` therefore re-declares box-sizing
   * immediately afterwards. Do not remove those lines. */
  const CSS = `
    /* No 'all: initial' on :host — the host's positioning is set inline and an
       'all' reset here would fight it. The shadow boundary already keeps
       Workday's CSS out; everything below sets what it needs explicitly. */
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, sans-serif; }

    .panel {
      width: 288px;
      background: #16161d;
      color: #e8e8ee;
      border: 1px solid #2c2c38;
      border-radius: 14px;
      box-shadow: 0 10px 38px rgba(0,0,0,.5);
      overflow: hidden;
      font-size: 13px;
      line-height: 1.45;
    }

    .head {
      display: flex; align-items: center; gap: 9px;
      padding: 10px 12px;
      background: #1d1d26;
      border-bottom: 1px solid #2c2c38;

      /* The whole strip is the drag handle.
       *   touch-action: none is what actually stops a touch drag from scrolling
       *     the page — by the time a pointermove arrives the browser has already
       *     committed to a scroll and preventDefault() is too late.
       *   user-select: none stops a drag that starts here from painting the
       *     header text blue and leaving the page with a stray selection. It is
       *     unconditional rather than applied during the drag, because a
       *     selection begins on the press, before we know it is a drag. */
      cursor: grab;
      touch-action: none;
      -webkit-user-select: none;
      user-select: none;
    }
    .head.dragging { cursor: grabbing; }
    /* -webkit-user-drag: none because the mark is an <img>, and Chromium's own
       image drag-and-drop would otherwise start on a press and cancel ours —
       the header would stop following the pointer mid-gesture. */
    .mark { width: 20px; height: 20px; border-radius: 6px; flex: none; display: block;
            -webkit-user-drag: none; }
    .title-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
    .title { font-weight: 650; font-size: 12px; letter-spacing: .01em;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ctx { font-size: 10.5px; color: #8a8a9c;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ctx b { color: #b9b9c9; font-weight: 600; }

    .dot { width: 7px; height: 7px; border-radius: 50%; background: #55556a; flex: none; }
    .dot.warn { background: #f0a83c; }
    .dot.err  { background: #ef5f5f; }
    .dot.ok   { background: #46c17f; }

    .icon-btn {
      all: unset;
      box-sizing: border-box;            /* see note above */
      cursor: pointer; color: #7a7a8c;
      width: 22px; height: 22px; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px; line-height: 1; border-radius: 6px;
    }
    .icon-btn:hover { color: #e8e8ee; background: #2c2c38; }

    .body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }

    button.primary {
      all: unset;
      box-sizing: border-box;            /* see note above */
      display: flex; align-items: center; justify-content: center; gap: 7px;
      width: 100%; padding: 10px 14px;
      border-radius: 9px;
      background: #7c5cff; color: #fff;
      font-weight: 600; font-size: 13px; cursor: pointer;
      text-align: center;
    }
    button.primary:hover:not(:disabled) { background: #6a48f5; }
    button.primary:active:not(:disabled) { transform: translateY(1px); }
    button.primary:disabled { background: #34343f; color: #6c6c7e; cursor: default; }

    input {
      all: unset;
      box-sizing: border-box;            /* see note above */
      display: block; width: 100%;
      padding: 9px 11px; border-radius: 8px;
      background: #0f0f15; border: 1px solid #2c2c38; color: #e8e8ee;
      font-size: 13px;
    }
    input::placeholder { color: #55556a; }
    input:focus { border-color: #7c5cff; box-shadow: 0 0 0 3px rgba(124,92,255,.15); }

    .msg {
      font-size: 11.5px; line-height: 1.5;
      border-radius: 8px; padding: 8px 10px;
      overflow-wrap: anywhere;           /* long selector names must not overflow */
    }
    .msg.info { background: #1d2430; color: #9fc2e8; }
    .msg.ok   { background: #16281f; color: #7fd6a6; }
    .msg.warn { background: #2b2314; color: #f0c07a; }
    .msg.err  { background: #2b1717; color: #f09a9a; }

    .hidden { display: none !important; }

    .bubble {
      all: unset;
      box-sizing: border-box;            /* see note above */
      cursor: pointer;
      width: 46px; height: 46px; border-radius: 50%;
      background: #7c5cff;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
    }
    .bubble:hover { background: #6a48f5; }
    .bubble img { width: 24px; height: 24px; display: block; }
  `;

  /* The mark, inline so it needs no web_accessible_resources entry. */
  const MARK = `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
       <rect width="100" height="100" rx="22" fill="#7c5cff"/>
       <path d="M60 7 L25 56 L44 56 L39 93 L76 43 L56 43 Z" fill="#fff"/>
     </svg>`
  )}`;

  const HTML = `
    <div class="panel" part="panel">
      <div class="head">
        <img class="mark" src="${MARK}" alt="" />
        <div class="title-wrap">
          <span class="title" id="title">Autocomplete</span>
          <span class="ctx" id="ctx"></span>
        </div>
        <span class="dot" id="dot"></span>
        <button class="icon-btn" id="collapse" title="Collapse" aria-label="Collapse">−</button>
      </div>
      <div class="body">
        <input id="pass" type="password" placeholder="Passphrase" class="hidden"
               autocomplete="off" />

        <button class="primary" id="action">Fill &amp; Submit</button>

        <div class="msg hidden" id="msg"></div>
      </div>
    </div>

    <button class="bubble hidden" id="bubble" title="Autocomplete" aria-label="Open Autocomplete">
      <img src="${MARK}" alt="" />
    </button>
  `;

  function mount(callbacks) {
    if (host) return; // idempotent — SPA navigations must not stack widgets
    handlers = callbacks;

    host = document.createElement('div');
    host.id = 'af-widget-host';

    /* Order matters: 'all: initial' wipes every property, so it MUST come
     * first — anything declared before it is erased. Everything after is
     * !important because Workday ships broad global rules and we cannot lose
     * a fight over position or z-index. These are the only page-level styles
     * the extension sets; the rest lives inside the shadow root. */
    host.style.cssText = `
      all: initial;
      position: fixed !important;
      right: 18px !important;
      bottom: 18px !important;
      z-index: 2147483647 !important;
      display: block !important;
      width: auto !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
    `;

    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    root.append(wrap);

    els = {
      panel: root.querySelector('.panel'),
      head: root.querySelector('.head'),
      dot: root.getElementById('dot'),
      title: root.getElementById('title'),
      ctx: root.getElementById('ctx'),
      pass: root.getElementById('pass'),
      action: root.getElementById('action'),
      msg: root.getElementById('msg'),
      collapse: root.getElementById('collapse'),
      bubble: root.getElementById('bubble'),
    };

    els.action.addEventListener('click', () => handlers.onAction?.(els.pass.value));
    els.pass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlers.onAction?.(els.pass.value);
    });
    els.collapse.addEventListener('click', () => setCollapsed(true));
    els.bubble.addEventListener('click', () => setCollapsed(false));

    els.head.addEventListener('pointerdown', onPointerDown);
    els.head.addEventListener('pointermove', onPointerMove);
    els.head.addEventListener('pointerup', (e) => endDrag(e.pointerId));
    els.head.addEventListener('pointercancel', (e) => endDrag(e.pointerId));
    /* Belt and braces: capture can be lost without a pointerup — the element
     * being removed does it, and so does the page taking the pointer for a
     * native drag. A drag we never ended would leave the widget stuck to the
     * cursor with no button held, which is the worst way for this to fail. */
    els.head.addEventListener('lostpointercapture', (e) => endDrag(e.pointerId));
    window.addEventListener('resize', keepInView);

    document.documentElement.append(host);
  }

  function setCollapsed(value) {
    collapsed = value;
    els.panel.classList.toggle('hidden', value);
    els.bubble.classList.toggle('hidden', !value);
    keepInView();
  }

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  /* The panel and the bubble share one host and the hidden one is display:none,
   * so the host's shrink-to-fit box is always the footprint of whatever is
   * currently on screen. Measuring it beats hardcoding either size. */
  function hostSize() {
    const r = host.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }

  /**
   * The only part of dragging that is pure, and the only part worth testing —
   * see test/widget.test.mjs. Keeps the widget wholly on screen; when the
   * viewport is smaller than the widget, the top-left corner wins, since that
   * is the end with the header on it.
   */
  function clampToViewport(p, size, view, margin = EDGE_MARGIN) {
    const clamp = (v, extent, span) =>
      Math.round(Math.max(margin, Math.min(v, extent - span - margin)));
    return {
      left: clamp(p.left, view.width, size.width),
      top: clamp(p.top, view.height, size.height),
    };
  }

  /** Move the host to an absolute viewport position. */
  function applyPosition(next) {
    pos = next;
    /* Setting left/top is also what switches the anchor: right/bottom go to
     * auto in the same breath so the two pairs can never fight. setProperty's
     * third argument preserves the !important that every host style carries —
     * these are the only page-level styles the extension sets and Workday's
     * global CSS will win any unweighted contest. */
    host.style.setProperty('left', `${next.left}px`, 'important');
    host.style.setProperty('top', `${next.top}px`, 'important');
    host.style.setProperty('right', 'auto', 'important');
    host.style.setProperty('bottom', 'auto', 'important');
  }

  /** Re-clamp in place. A no-op until the widget has actually been moved —
   *  the default bottom-right anchoring keeps itself on screen. */
  function keepInView() {
    if (!host || !pos) return;
    applyPosition(clampToViewport(pos, hostSize(), viewport()));
  }

  function onPointerDown(e) {
    if (e.button > 0) return; // a right- or middle-press is not a drag

    /* closest() from inside a shadow tree stops at the shadow root, so this
     * asks "did the press land on a control in the header?" without escaping
     * into the page. It keeps the minimize button clickable and covers any
     * interactive control added to the strip later. Not applied to the bubble:
     * it is itself a button, and the whole bubble is meant to drag. */
    if (e.target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;

    const r = host.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: r.left,
      originTop: r.top,
      /* Measured once: the footprint cannot change mid-drag, and re-measuring
       * every pointermove would force a layout on each frame. */
      size: { width: r.width, height: r.height },
      active: false, // flips when the movement threshold is passed
    };
    els.head.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;

    /* The same insurance as lostpointercapture, from the other side: no buttons
     * held means the press is over whether or not we were told. Observed for
     * real — a dropped pointerup left the widget trailing the cursor across the
     * page until the next click. */
    if (e.buttons === 0) return endDrag(e.pointerId);

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.active) {
      // Nearly every click carries a pixel or two of wobble; that is still a click.
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.active = true;
      els.head.classList.add('dragging');
    }

    applyPosition(clampToViewport(
      { left: drag.originLeft + dx, top: drag.originTop + dy },
      drag.size,
      viewport()
    ));
  }

  /** Idempotent on purpose: several events can each legitimately end one drag. */
  function endDrag(pointerId) {
    if (!drag || pointerId !== drag.id) return;
    drag = null;
    els.head.classList.remove('dragging');

    // Throws if the capture is already gone, which pointercancel usually does for us.
    try { els.head.releasePointerCapture(pointerId); } catch { /* already released */ }
  }

  /**
   * The single render entry point.
   *
   * @param {object} s
   *   s.title       header text
   *   s.context     small grey line ("Workday · Create Account")
   *   s.actionLabel button text, or null to hide the button
   *   s.disabled    button disabled
   *   s.needsPass   show the passphrase input
   *   s.message     { kind: 'info'|'ok'|'warn'|'err', text }
   *   s.tone        'ok' | 'warn' | 'err' | null   → the status dot
   */
  function render(s) {
    if (!host) return;

    els.title.textContent = s.title ?? 'Autocomplete';
    els.ctx.innerHTML = s.context ?? '';

    els.dot.className = 'dot' + (s.tone ? ' ' + s.tone : '');

    els.pass.classList.toggle('hidden', !s.needsPass);
    if (!s.needsPass) els.pass.value = '';
    else if (s.focusPass) setTimeout(() => els.pass.focus(), 0);

    if (s.actionLabel === null) {
      els.action.classList.add('hidden');
    } else {
      els.action.classList.remove('hidden');
      els.action.textContent = s.actionLabel ?? 'Fill & Submit';
      els.action.disabled = !!s.disabled;
    }

    if (s.message) {
      els.msg.classList.remove('hidden');
      els.msg.className = 'msg ' + (s.message.kind ?? 'info');
      els.msg.textContent = s.message.text;
    } else {
      els.msg.classList.add('hidden');
    }

    /* A long message can grow the panel by a hundred pixels. While the widget
     * hangs off the bottom-right that just pushes the top edge up, but once it
     * is top-anchored the growth goes downward and can run off screen. */
    keepInView();
  }

  function destroy() {
    window.removeEventListener('resize', keepInView);
    host?.remove();
    host = null;
    root = null;
    els = {};
    drag = null;
  }

  const isMounted = () => !!host;

  // clampToViewport is exported for test/widget.test.mjs, not for callers.
  return {
    mount, render, destroy, isMounted, setCollapsed,
    clampToViewport,
  };
})();
