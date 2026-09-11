/**
 * react-set.js — THE React-safe field writer. This is the single reusable helper.
 *
 * ── Why `el.value = x` does not work on Workday ─────────────────────
 *
 * Workday is React. On every controlled input React installs its own `value`
 * setter directly on the ELEMENT (shadowing the one on HTMLInputElement.prototype)
 * plus a hidden `_valueTracker` object that remembers the last value React knows
 * about.
 *
 * When you assign `el.value = 'x'`, you go through React's element-level setter,
 * which updates the DOM *and* silently updates the tracker. React later compares
 * the incoming event's value against the tracker, sees no difference, and
 * concludes nothing changed — so onChange never fires and component state never
 * updates. The field looks filled and submits empty.
 *
 * The fix is to reach past the shadowing setter and call the ORIGINAL prototype
 * setter. That updates the DOM without touching the tracker, so when we then
 * dispatch an `input` event React compares new-value vs stale-tracker, sees a
 * real change, and runs its onChange handler for real.
 *
 * ── The full sequence, and why each step is here ────────────────────
 *   focus  → Workday shows validation state per-field on focus/blur; some
 *            fields also lazily mount their handlers on first focus.
 *   set    → prototype setter, per the above.
 *   input  → what React actually listens to (it delegates at the root).
 *   change → what non-React listeners and some Workday widgets listen to.
 *   blur   → Workday runs its "this field is required" validation on blur.
 *            Skip it and a correctly-filled field can still show an error.
 *
 * If a future React/Workday change breaks filling, this file is the one to
 * suspect first, and it is small on purpose.
 */

/**
 * Walk the prototype chain to find who really owns a property's setter.
 *
 * More robust than assuming Object.getPrototypeOf(el) — the element might be a
 * subclass, or a custom element, and inputs/textareas/selects each define
 * `value` on a different prototype.
 */
AF.nativeSetterFor = function (el, prop) {
  let proto = Object.getPrototypeOf(el);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc && typeof desc.set === 'function') return desc.set;
    proto = Object.getPrototypeOf(proto);
  }
  return null;
};

/** Dispatch a real bubbling event React will pick up at its delegated root. */
function fire(el, type) {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

/**
 * Write a text value into a React-controlled input/textarea/select.
 * Returns true if the value stuck.
 */
AF.setNativeValue = function (el, value) {
  const setter = AF.nativeSetterFor(el, 'value');
  if (!setter) {
    AF.log('no native value setter for', el);
    return false;
  }

  try {
    el.focus();
  } catch {
    /* detached or hidden — keep going, the write may still land */
  }

  setter.call(el, value);
  fire(el, 'input');
  fire(el, 'change');

  try {
    el.blur();
  } catch {
    /* ignore */
  }

  return el.value === value;
};

/**
 * Checkboxes need the OPPOSITE strategy to text inputs. Click first, not last.
 *
 * ── Why ─────────────────────────────────────────────────────────────
 * React does not listen to `change` for checkboxes and radios. Its
 * ChangeEventPlugin has a `shouldUseClickEvent` branch that routes those two
 * input types onto the CLICK event instead, because old IE fired `change` only
 * on blur. So the text-input recipe — prototype setter, dispatch input/change —
 * updates the DOM but never reaches React, and React silently reverts the box
 * the next time anything re-renders.
 *
 * Measured on the live Workday Create Account page:
 *
 *   setter + input/change  →  DOM true,  React false  →  reverts to false
 *   el.click()             →  DOM true,  React true   →  survives re-render
 *
 * That revert is what made the terms box look ticked and then submit unticked.
 * A real click is the primary path here; the setter is only a fallback.
 */
AF.setNativeChecked = function (el, checked) {
  if (el.checked === checked) return true; // already right — idempotent

  // What a human does. Works even at opacity:0 — .click() does no hit-testing.
  try {
    el.click();
  } catch {
    /* fall through to the synthetic path */
  }
  if (el.checked === checked) return true;

  // Click was swallowed (an overlay, a preventDefault, a disabled ancestor).
  // Set the OPPOSITE and then dispatch a click: a dispatched click still runs
  // the checkbox's activation behaviour, so it toggles to the value we want AND
  // arrives as the click event React is actually listening for. Setting the
  // desired value first would toggle us straight back off.
  const setter = AF.nativeSetterFor(el, 'checked');
  if (setter) {
    setter.call(el, !checked);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  if (el.checked === checked) return true;

  // Last resort: force the value and fire everything. Better than leaving it
  // wrong, though if we get here React probably won't agree with us.
  if (setter) {
    setter.call(el, checked);
    fire(el, 'input');
    fire(el, 'change');
  }
  return el.checked === checked;
};

/**
 * Workday's country / state pickers are frequently NOT <select> — they are
 * button + popup listbox widgets with no `value` property at all. Those need
 * click-then-pick logic, which is site-specific and therefore lives in the
 * adapter (see sites/workday.js → pickFromListbox). This helper only covers
 * genuine <select> elements.
 */
AF.setSelectByText = function (el, text) {
  const wanted = String(text).trim().toLowerCase();
  const option = Array.from(el.options).find(
    (o) =>
      o.textContent.trim().toLowerCase() === wanted ||
      o.value.trim().toLowerCase() === wanted
  );
  if (!option) return false;
  return AF.setNativeValue(el, option.value);
};
