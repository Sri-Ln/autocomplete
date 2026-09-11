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
  typeof selector === 'string' && selector.includes('REPLACE_ME');

/** Human-readable one-liner for the widget status area. */
AF.summarize = function (report) {
  const ok = report.filled.length + report.already.length;
  const bad = report.missing.length + report.failed.length;
  const parts = [`${ok} filled`];
  if (bad) parts.push(`${bad} failed (${[...report.missing, ...report.failed].join(', ')})`);
  if (report.skipped.length) parts.push(`${report.skipped.length} not configured`);
  return parts.join(' · ');
};
