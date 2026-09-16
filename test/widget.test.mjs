/**
 * widget.test.mjs — verifies the drag clamp and the corner-anchoring math.
 *
 *   node test/widget.test.mjs
 *
 * Only the pure math is tested — clamping, and the footprint-swap/corner-
 * conversion arithmetic — because that is the only part of dragging that is
 * pure. The rest of the drag is pointer capture and getBoundingClientRect,
 * which a DOM stub would test for agreeing with the stub rather than with a
 * browser; test/widget-preview.html is where that gets exercised for real.
 *
 * What the clamp has to get right is the pair of very different footprints —
 * the 288×~150 panel and the 46×46 bubble share one host — and the case where
 * a saved position is restored into a window that has since shrunk.
 *
 * widget.js is a content script (assigns onto a global `AF`), so it's evaluated
 * here against a stub global rather than imported. Nothing in the module body
 * touches the DOM; `document` and `chrome` are reached only from inside
 * mount() and the drag handlers, which this file never calls.
 */

import { readFile } from 'node:fs/promises';

const AF = {};
const src = await readFile(new URL('../content/widget.js', import.meta.url), 'utf8');
new Function('AF', src)(AF);

const { clampToViewport, keepBottomRightCorner, toCorner, fromCorner } = AF.widget;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${label}` +
      (ok ? '' : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`)
  );
  ok ? passed++ : failed++;
}

/* The two real footprints, and a typical laptop viewport. */
const PANEL = { width: 288, height: 152 };
const BUBBLE = { width: 46, height: 46 };
const VIEW = { width: 1440, height: 900 };

const MARGIN = 6; // EDGE_MARGIN in widget.js — asserted below, not assumed

/* ---------------- the ordinary case ---------------- */

check('a position well inside the viewport is untouched',
  clampToViewport({ left: 400, top: 300 }, PANEL, VIEW), { left: 400, top: 300 });

check('fractional pointer coordinates are rounded',
  clampToViewport({ left: 400.6, top: 299.4 }, PANEL, VIEW), { left: 401, top: 299 });

/* ---------------- each edge ---------------- */

check('dragging past the left edge stops at the margin',
  clampToViewport({ left: -200, top: 300 }, PANEL, VIEW), { left: MARGIN, top: 300 });

check('dragging past the top edge stops at the margin',
  clampToViewport({ left: 400, top: -80 }, PANEL, VIEW), { left: 400, top: MARGIN });

check('dragging past the right edge keeps the whole panel visible',
  clampToViewport({ left: 5000, top: 300 }, PANEL, VIEW),
  { left: VIEW.width - PANEL.width - MARGIN, top: 300 });

check('dragging past the bottom edge keeps the whole panel visible',
  clampToViewport({ left: 400, top: 5000 }, PANEL, VIEW),
  { left: 400, top: VIEW.height - PANEL.height - MARGIN });

check('the margin is respected on every side at once',
  clampToViewport({ left: -1e6, top: 1e6 }, PANEL, VIEW),
  { left: MARGIN, top: VIEW.height - PANEL.height - MARGIN });

/* ---------------- panel vs. bubble ----------------
 * The same left is legal for the bubble and illegal for the panel, which is why
 * the caller measures the host instead of passing a constant. */

const FAR_RIGHT = { left: 1300, top: 300 };
check('the bubble may sit where the panel may not (bubble)',
  clampToViewport(FAR_RIGHT, BUBBLE, VIEW), { left: 1300, top: 300 });
check('the bubble may sit where the panel may not (panel)',
  clampToViewport(FAR_RIGHT, PANEL, VIEW), { left: 1146, top: 300 });

/* Collapsing at the right edge and re-expanding: the panel is pulled back in,
 * it does not grow off screen. */
const collapsedAtEdge = clampToViewport({ left: 5000, top: 5000 }, BUBBLE, VIEW);
check('a bubble dragged into the corner sits at the corner',
  collapsedAtEdge, { left: 1388, top: 848 });
check('re-expanding there pulls the panel back on screen',
  clampToViewport(collapsedAtEdge, PANEL, VIEW), { left: 1146, top: 742 });

/* ---------------- restoring into a smaller window ---------------- */

const SAVED = { left: 1146, top: 742 }; // bottom-right of a 1440×900 window
check('a saved position survives the same window',
  clampToViewport(SAVED, PANEL, VIEW), SAVED);
check('a saved position is pulled in when the window has shrunk',
  clampToViewport(SAVED, PANEL, { width: 1024, height: 600 }),
  { left: 730, top: 442 });

/* ---------------- degenerate viewports ----------------
 * A window narrower than the panel has no legal position at all. The top-left
 * corner wins, because that is the end with the header — the part you need in
 * order to drag the widget back out. */

check('a viewport narrower than the panel pins it to the top-left',
  clampToViewport({ left: 400, top: 300 }, PANEL, { width: 200, height: 100 }),
  { left: MARGIN, top: MARGIN });

check('a zero-sized viewport does not produce NaN',
  clampToViewport({ left: 0, top: 0 }, PANEL, { width: 0, height: 0 }),
  { left: MARGIN, top: MARGIN });

/* ---------------- the margin is a parameter ---------------- */

check('the margin can be overridden',
  clampToViewport({ left: -50, top: 5000 }, BUBBLE, VIEW, 20),
  { left: 20, top: 834 });

/* ---------------- collapse/expand corner anchoring ----------------
 * Fix 2: the widget's bottom-right corner must stay fixed across the
 * footprint swap, not its top-left — collapsing shrinks toward that corner,
 * expanding grows out of it. */

const MOVED = { left: 700, top: 500 }; // some position after a drag, mid-screen

const collapsedPos = keepBottomRightCorner(MOVED, PANEL, BUBBLE);
check('collapsing keeps the bottom-right corner fixed',
  { right: collapsedPos.left + BUBBLE.width, bottom: collapsedPos.top + BUBBLE.height },
  { right: MOVED.left + PANEL.width, bottom: MOVED.top + PANEL.height });

check('expanding restores the original box',
  keepBottomRightCorner(collapsedPos, BUBBLE, PANEL), MOVED);

/* Expanding near the top-left edge wants to grow off-screen; the caller
 * clamps the result exactly as it already does for a drag. */
const nearEdge = { left: 10, top: 10 }; // legal for the bubble, not for the panel
const grown = keepBottomRightCorner(nearEdge, BUBBLE, PANEL);
check('an expand near the top-left edge wants to grow off-screen (unclamped)',
  grown, { left: 10 + 46 - 288, top: 10 + 46 - 152 });
check('...and the caller\'s clamp pulls it back on screen',
  clampToViewport(grown, PANEL, VIEW), { left: MARGIN, top: MARGIN });

/* The round trip panel → bubble → panel, clamping at each step the way
 * setCollapsed does, returns to the starting position. */
const start = { left: 500, top: 400 };
const toBubble = clampToViewport(keepBottomRightCorner(start, PANEL, BUBBLE), BUBBLE, VIEW);
const backToPanel = clampToViewport(keepBottomRightCorner(toBubble, BUBBLE, PANEL), PANEL, VIEW);
check('round trip panel → bubble → panel returns to the starting position',
  backToPanel, start);

/* ---------------- save/restore corner conversion ----------------
 * Fix 2b: storage keys off the bottom-right corner instead of the top-left,
 * so a position saved under one footprint restores correctly under the
 * other — the exact scenario that used to shift the panel on reload. */

check('toCorner/fromCorner round-trip at the same size',
  fromCorner(toCorner(MOVED, PANEL), PANEL), MOVED);

check('the corner conversion agrees with the collapse/expand math',
  fromCorner(toCorner(MOVED, PANEL), BUBBLE), keepBottomRightCorner(MOVED, PANEL, BUBBLE));

/* Saved while collapsed, restored on mount (which always starts expanded) —
 * without Fix 2b this used to land the panel shifted by the footprint
 * difference instead of at the bubble's old bottom-right corner. */
const savedWhileBubble = toCorner(MOVED, BUBBLE);
check('a position saved while collapsed restores footprint-independently as the panel',
  fromCorner(savedWhileBubble, PANEL), keepBottomRightCorner(MOVED, BUBBLE, PANEL));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
