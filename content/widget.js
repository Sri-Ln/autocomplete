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
 * It is also draggable — by its header strip when expanded, by the bubble
 * itself when collapsed; see the "dragging" section below.
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

  const POS_KEY = 'af_widget_pos'; // chrome.storage.local
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
      /* The whole bubble is the drag handle (unlike the header, there is no
       * inner control to spare it for) — same cursor/touch-action/user-select
       * treatment as .head, see the note there. */
      cursor: grab;
      touch-action: none;
      -webkit-user-select: none;
      user-select: none;
      width: 46px; height: 46px; border-radius: 50%;
      background: #7c5cff;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
    }
    .bubble:hover { background: #6a48f5; }
    .bubble.dragging { cursor: grabbing; }
    /* Same reasoning as .mark: without this, a press-drag on the image starts a
     * native image drag instead of ours. */
    .bubble img { width: 24px; height: 24px; display: block; -webkit-user-drag: none; }
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
    els.bubble.addEventListener('click', () => {
      /* A click fires right after pointerup even though the drag captured the
       * pointer — without this guard every drag-to-move of the bubble would
       * also re-expand it. Cleared unconditionally the first time it is read,
       * so a dropped pointerup/click pairing can never leave it stuck swallowing
       * a later, unrelated click. */
      if (suppressBubbleClick) { suppressBubbleClick = false; return; }
      setCollapsed(false);
    });

    /* Both handles' listeners live inside the shadow root and are removed with
     * the host, so destroy() has nothing to undo for them. The window listener
     * below is the one that would outlive us. */
    attachDragHandle(els.head, { guardControls: true });
    attachDragHandle(els.bubble, { isBubble: true });
    window.addEventListener('resize', keepInView);

    document.documentElement.append(host);

    restorePosition(host);
  }

  function setCollapsed(value) {
    /* Measured before the footprint swap, and only when the widget has been
     * dragged — in the default corner the host is still right/bottom anchored,
     * which already keeps that corner fixed for free, and keepInView() below is
     * a no-op there (see its own guard). */
    const oldSize = pos ? hostSize() : null;

    collapsed = value;
    els.panel.classList.toggle('hidden', value);
    els.bubble.classList.toggle('hidden', !value);

    if (!pos) return keepInView();

    /* A dragged widget is left/top anchored. Leaving left/top untouched across
     * the footprint swap would hold the TOP-LEFT corner fixed instead, which
     * reads as the whole widget jumping left and up when it collapses — the
     * bug report. Anchor the bottom-right corner instead, matching what the
     * default right/bottom anchoring already does natively. */
    const newSize = hostSize();
    applyPosition(clampToViewport(
      keepBottomRightCorner(pos, oldSize, newSize),
      newSize,
      viewport()
    ));
  }

  /* ── DRAGGING ────────────────────────────────────────────────────────
   * The header strip and the collapsed bubble are both handles. Pointer Events
   * rather than mouse events, because setPointerCapture keeps the drag alive
   * when the pointer outruns the widget or leaves the window, and guarantees a
   * pointerup/pointercancel comes back to us so nothing is left half-dragged.
   *
   * The host starts anchored bottom-right. The first drag switches it to
   * left/top (see applyPosition) so the arithmetic is a plain rect.left + dx.
   *
   * Only one handle can be visible at a time (the other is display:none), but
   * the machinery is shared rather than duplicated per handle: `drag` records
   * which element started the press, and every other function reads it from
   * there instead of being told again. */

  /** True right after a bubble drag ends, for exactly one click — see the
   *  bubble's click listener in mount(). */
  let suppressBubbleClick = false;

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

  /**
   * Re-anchors a left/top position across a footprint change so the box's
   * bottom-right corner stays put — collapsing shrinks toward that corner,
   * expanding grows out of it, instead of both keeping the top-left fixed.
   * Pure and unclamped; callers clamp the result, same as every other raw
   * position (see setCollapsed).
   */
  function keepBottomRightCorner(pos, oldSize, newSize) {
    return {
      left: pos.left + oldSize.width - newSize.width,
      top: pos.top + oldSize.height - newSize.height,
    };
  }

  /** Viewport-coordinate bottom-right corner of a box at `pos` with size
   *  `size`. Storage keys off this corner rather than the top-left so a saved
   *  position is independent of which footprint — panel or bubble — was on
   *  screen when it was saved; see savePosition/loadPosition. */
  function toCorner(pos, size) {
    return { right: pos.left + size.width, bottom: pos.top + size.height };
  }

  /** Inverse of toCorner: the top-left that places a box of `size` at `corner`. */
  function fromCorner(corner, size) {
    return { left: corner.right - size.width, top: corner.bottom - size.height };
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

  /**
   * Wires up one element — .head or .bubble — as a drag handle, sharing the
   * pointerdown/move/up/cancel/lostpointercapture machinery below rather than
   * each handle getting its own copy.
   *
   * @param {boolean} opts.guardControls  skip starting a drag on a press that
   *   landed on a nested control. Only .head needs this — the minimize button
   *   lives inside it. The bubble IS a button and the whole thing is the
   *   handle, so it must not have this guard.
   * @param {boolean} opts.isBubble  mark drags started here so endDrag can
   *   swallow the click-to-expand that follows one.
   */
  function attachDragHandle(el, opts) {
    el.addEventListener('pointerdown', (e) => onPointerDown(e, el, opts));
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', (e) => endDrag(e.pointerId));
    el.addEventListener('pointercancel', (e) => endDrag(e.pointerId));
    /* Belt and braces: capture can be lost without a pointerup — the element
     * being removed does it, and so does the page taking the pointer for a
     * native drag. A drag we never ended would leave the widget stuck to the
     * cursor with no button held, which is the worst way for this to fail. */
    el.addEventListener('lostpointercapture', (e) => endDrag(e.pointerId));
  }

  function onPointerDown(e, handle, opts) {
    if (e.button > 0) return; // a right- or middle-press is not a drag

    /* closest() from inside a shadow tree stops at the shadow root, so this
     * asks "did the press land on a control in the header?" without escaping
     * into the page. It keeps the minimize button clickable and covers any
     * interactive control added to the strip later. Not applied to the bubble:
     * it is itself a button, and the whole bubble is meant to drag. */
    if (opts.guardControls &&
        e.target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;

    /* A fresh press invalidates any suppression left over from a previous
     * bubble drag whose click never arrived (e.g. it ended in pointercancel) —
     * otherwise that stale flag would eat this press's own click instead. */
    if (opts.isBubble) suppressBubbleClick = false;

    const r = host.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      handle,
      isBubble: !!opts.isBubble,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: r.left,
      originTop: r.top,
      /* Measured once: the footprint cannot change mid-drag, and re-measuring
       * every pointermove would force a layout on each frame. */
      size: { width: r.width, height: r.height },
      active: false, // flips when the movement threshold is passed
    };
    handle.setPointerCapture(e.pointerId);
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
      drag.handle.classList.add('dragging');
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
    const moved = drag.active;
    const { handle, isBubble } = drag;
    drag = null;
    handle.classList.remove('dragging');

    // Throws if the capture is already gone, which pointercancel usually does for us.
    try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }

    // The click that follows this pointerup must not re-expand the bubble.
    if (moved && isBubble) suppressBubbleClick = true;

    // One write per drag rather than one per frame.
    if (moved && pos) savePosition(pos);
  }

  /* Both storage directions fail soft. A content script's chrome.* calls start
   * throwing ("Extension context invalidated") the moment the extension is
   * reloaded or updated, and a widget that forgets where it was put is a much
   * smaller problem than one that throws into the page.
   *
   * Saved as a bottom-right corner, not a top-left, so the value is
   * footprint-independent: mount() always restores into the panel, so a
   * position saved while collapsed must still land correctly on the wider
   * box, and vice versa on the next collapse. */
  function savePosition(p) {
    try {
      chrome.storage.local.set({ [POS_KEY]: toCorner(p, hostSize()) })?.catch(() => {});
    } catch { /* no storage, or the context is gone */ }
  }

  async function loadPosition() {
    try {
      const got = await chrome.storage.local.get(POS_KEY);
      const p = got?.[POS_KEY];
      /* Storage is not trusted input. A half-written or hand-edited value must
       * not become `left: NaNpx`, which silently un-positions the host. This
       * also cleanly rejects a pre-corner {left, top} value from before this
       * shape changed — right/bottom are undefined on it, so it falls back to
       * the default corner instead of deriving NaN. The feature is unreleased,
       * so that fallback is the only "migration" this needs. */
      if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) {
        return { right: p.right, bottom: p.bottom };
      }
    } catch { /* no storage, or the context is gone */ }
    return null;
  }

  async function restorePosition(forHost) {
    const corner = await loadPosition();
    /* An SPA navigation can destroy and re-mount the widget while that await is
     * outstanding; applying to a host that is no longer ours would put the
     * position on a detached element. And if the user has already grabbed the
     * header in the meantime, their drag wins. */
    if (host !== forHost || !corner || pos) return;
    // The window may well be smaller than it was when this was saved.
    const size = hostSize();
    applyPosition(clampToViewport(fromCorner(corner, size), size, viewport()));
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
    suppressBubbleClick = false;
    pos = null; // the next mount() re-reads the saved position from storage
  }

  const isMounted = () => !!host;

  // clampToViewport, keepBottomRightCorner, toCorner and fromCorner are
  // exported for test/widget.test.mjs, not for callers.
  return {
    mount, render, destroy, isMounted, setCollapsed,
    clampToViewport, keepBottomRightCorner, toCorner, fromCorner,
  };
})();
