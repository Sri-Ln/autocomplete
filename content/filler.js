/**
 * filler.js — resolve a selector to a real field, then write it safely.
 *
 * Two jobs, both about not being brittle:
 *
 *  1. RESOLUTION. Workday puts data-automation-id on a wrapper <div> about as
 *     often as on the <input> itself. A selector that matches the wrapper is
 *     still the right selector — so if what we matched isn't fillable, we look
 *     for a fillable descendant before giving up. This alone removes most of the
 *     "my selector is correct but nothing fills" confusion.
 *
 *  2. ISOLATION. Every write is wrapped. A missing field, a detached node, a
 *     thrown listener inside Workday's own code — none of it aborts the run. You
 *     get a report at the end saying exactly which keys landed and which didn't.
 */

const FILLABLE = 'input, textarea, select';

/** Visible in the layout sense — Workday keeps hidden duplicates in the DOM. */
function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.disabled || el.readOnly) return false;
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/**
 * Selector → the element we can actually type into.
 *
 * Prefers a visible match. Falls back to the first match so that a field inside
 * a not-yet-measured container still resolves.
 */
AF.resolveField = function (selector, root = document) {
  // A selector may be a list of alternatives: tenants name the same field
  // differently, and the first one that resolves wins.
  if (Array.isArray(selector)) {
    for (const alt of selector) {
      const hit = AF.resolveField(alt, root);
      if (hit) return hit;
    }
    return null;
  }

  let matches;
  try {
    matches = Array.from(root.querySelectorAll(selector));
  } catch (err) {
    AF.log('bad selector', selector, err);
    return null;
  }
  if (matches.length === 0) return null;

  const candidates = [];
  for (const m of matches) {
    // The match itself is fillable, or it's a wrapper holding the real field.
    if (m.matches(FILLABLE)) candidates.push(m);
    else candidates.push(...m.querySelectorAll(FILLABLE));
  }
  if (candidates.length === 0) return null;

  return candidates.find(isVisible) ?? candidates[0];
};

/**
 * Fill one field.
 *
 * Returns one of: 'filled' | 'already' | 'missing' | 'failed' | 'empty-value'
 * 'already' is what makes the whole run idempotent — clicking the widget twice
 * is harmless, and a partially-filled form finishes cleanly on a second click.
 */
AF.fillField = function (key, selector, value, opts = {}) {
  if (value === undefined || value === null || value === '') return 'empty-value';

  const el = AF.resolveField(selector);
  if (!el) {
    AF.log(`✗ ${key}: no element for ${selector}`);
    return 'missing';
  }

  try {
    if (opts.type === 'checkbox' || el.type === 'checkbox') {
      const want = value === true || value === 'true';
      if (el.checked === want) return 'already';
      return AF.setNativeChecked(el, want) ? 'filled' : 'failed';
    }

    if (el.tagName === 'SELECT') {
      if (el.value === value) return 'already';
      return AF.setSelectByText(el, value) ? 'filled' : 'failed';
    }

    if (el.value === value) return 'already';
    return AF.setNativeValue(el, value) ? 'filled' : 'failed';
  } catch (err) {
    // Workday's own change handlers can throw. That is their problem, not a
    // reason to stop filling the remaining nine fields.
    AF.log(`✗ ${key}: threw`, err);
    return 'failed';
  }
};

/**
 * Fill a whole page's worth of fields.
 *
 * @param fieldMap  { key: selector }         from the site adapter
 * @param values    { key: value }            resolved profile + credential
 * @param types     { key: 'checkbox'|... }   optional per-field hints
 */
AF.fillAll = function (fieldMap, values, types = {}) {
  const report = { filled: [], already: [], missing: [], failed: [], skipped: [] };

  for (const [key, selector] of Object.entries(fieldMap)) {
    // A selector still holding its placeholder is not a failure to report as a
    // bug — it's a to-do. Surface it distinctly so you know what to harvest.
    if (AF.isPlaceholder(selector)) {
      report.skipped.push(key);
      continue;
    }

    const result = AF.fillField(key, selector, values[key], { type: types[key] });
    if (result === 'empty-value') report.skipped.push(key);
    else if (result === 'already') report.already.push(key);
    else report[result].push(key);

    AF.log(`${result === 'missing' || result === 'failed' ? '✗' : '✓'} ${key}: ${result}`);
  }

  return report;
};

/** Placeholder selectors are marked so they can never silently half-work. */
AF.isPlaceholder = (selector) =>
  Array.isArray(selector)
    ? selector.every((s) => AF.isPlaceholder(s))
    : typeof selector === 'string' && selector.includes('REPLACE_ME');

/**
 * A human-readable identifier for a field, for diagnostics.
 *
 * The old version fell back through data-automation-id → aria-label → name →
 * type, and on Workday's multi-select inputs all three of the first options are
 * absent, so it reported the field as "text" — the input's *type*. Useless both
 * to the user and to anyone trying to patch a selector.
 *
 * This walks outward instead: the field's own id, then the enclosing
 * formField-* wrapper, then the visible label text.
 */
AF.describeField = function (el) {
  if (!el) return 'unknown field';

  const parts = [];

  const own = el.getAttribute('data-automation-id');
  if (own) parts.push(own);

  if (!own) {
    /* Prefer the outer formField-* wrapper over whatever ancestor happens to be
     * nearest. Workday nests these — formField-countryPhoneCode wraps
     * multiSelectContainer wraps multiselectInputContainer — and only the
     * outermost is the id you would actually put in a selector map. */
    const wrapper =
      el.closest('[data-automation-id^="formField-"]') ?? el.closest('[data-automation-id]');
    const id = wrapper?.getAttribute('data-automation-id');
    if (id) parts.push(id);
  }

  const label =
    el.getAttribute('aria-label') ||
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
    el.closest('label')?.textContent ||
    el.closest('[data-automation-id^="formField-"]')?.querySelector('label')?.textContent;

  const clean = label?.replace(/\s+/g, ' ').trim().slice(0, 48);
  if (clean) parts.push(`"${clean}"`);

  if (!parts.length && el.name) parts.push(el.name);
  if (!parts.length && el.placeholder) parts.push(`placeholder "${el.placeholder}"`);

  return parts.length ? parts.join(' ') : `unlabelled ${el.tagName.toLowerCase()}`;
};

/**
 * Is this input part of a multi-select that already holds a selection?
 *
 * Workday's multi-selects keep an empty, `required` text input for searching
 * and render the chosen value as a separate pill. Reading `.value` on that
 * input therefore reports empty no matter what the user picked — which made the
 * pre-submit guard refuse to submit a fully answered form, naming a field it
 * could not even identify.
 */
AF.isSatisfiedMultiselect = function (el) {
  const container = el.closest(
    '[data-automation-id^="formField-"], [data-automation-id="multiSelectContainer"]'
  );
  if (!container) return false;

  const pill = container.querySelector(
    '[data-automation-id^="selectedItem"], [data-automation-id="selectedItemList"]'
  );
  return !!pill && !!pill.textContent.trim();
};

/**
 * Find a form field by the text of its visible label.
 *
 * The escape hatch for cross-tenant drift. data-automation-ids are stable
 * within a tenant but not across them — one tenant's "How Did You Hear About
 * Us?" is formField-source, another names it something else entirely, and the
 * field then reports as simply not on the page. The question text, though, is
 * Workday boilerplate and barely varies.
 *
 * Returns the enclosing [data-automation-id] wrapper, so callers can drive it
 * exactly as they would a wrapper found by selector.
 */
AF.findFieldByLabel = function (labelText, { minScore = 0.6 } = {}) {
  const wanted = AF.normalizeText(labelText);
  if (!wanted) return null;

  let best = null;

  for (const wrap of document.querySelectorAll('[data-automation-id^="formField-"]')) {
    if (!wrap.getClientRects().length) continue;

    // The wrapper's own text is the label plus whatever is currently selected;
    // take the leading portion so a long selected value can't drown the label.
    const text = AF.normalizeText((wrap.textContent || '').slice(0, 120));
    if (!text) continue;

    const score = text.includes(wanted) ? 0.9 : AF.scoreMatch(text, wanted);
    if (score >= minScore && (!best || score > best.score)) best = { wrap, score };
  }

  return best?.wrap ?? null;
};

/** Human-readable one-liner for the widget status area. */
AF.summarize = function (report) {
  const ok = report.filled.length + report.already.length;
  const bad = report.missing.length + report.failed.length;
  const parts = [`${ok} filled`];
  if (bad) parts.push(`${bad} failed (${[...report.missing, ...report.failed].join(', ')})`);
  if (report.skipped.length) parts.push(`${report.skipped.length} not configured`);
  return parts.join(' · ');
};
