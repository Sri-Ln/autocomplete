/**
 * guards.js — the safety scan that runs between "filled" and "submit".
 *
 * The whole point: the day Workday renames a data-automation-id, the fill goes
 * partial. Without this, one click would cheerfully submit a half-empty form
 * and burn an email address on a broken account. Every guard below returns a
 * reason string (shown verbatim in the widget) or null if it's satisfied.
 *
 * Guards are generic. Anything Workday-specific — which selector marks an error
 * container, say — comes from the adapter, so this file survives site changes.
 */

/**
 * CAPTCHA. We do not touch these, by design. If one is on screen, we fill and
 * stop, and you finish by hand.
 */
const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  'iframe[title*="captcha" i]',
  '.g-recaptcha',
  '#h-captcha',
  /* Workday wraps its submit button in [data-automation-id="noCaptchaWrapper"],
   * which is present and empty when no challenge is required. Any iframe that
   * shows up inside it is a challenge widget. Verified present on the live
   * Create Account page (empty, no challenge at the time). */
  '[data-automation-id="noCaptchaWrapper"] iframe',
];

/**
 * Inputs we must never touch or reason about.
 *
 * Workday ships a honeypot: data-automation-id="beecatcher", name="website",
 * 1×0px and absolutely positioned. A human never fills it; a naive bot fills
 * every input it finds and flags itself. We never write to it (it is not in any
 * fields map), and we also exclude it here so that if Workday ever marks it
 * `required` — a very effective trap — our own guard doesn't report it as a
 * missing field and send you hunting for a selector that must stay empty.
 */
const HONEYPOTS = [
  '[data-automation-id="beecatcher"]',
  'input[name="website"]',
];

function isHoneypot(el) {
  return HONEYPOTS.some((sel) => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });
}

function anyVisible(selectors, root = document) {
  for (const sel of selectors) {
    for (const el of root.querySelectorAll(sel)) {
      if (el.getClientRects().length > 0) return el;
    }
  }
  return null;
}

AF.guards = {
  /** A visible CAPTCHA means stop. Never attempt to solve or bypass one. */
  captcha() {
    return anyVisible(CAPTCHA_SELECTORS)
      ? 'CAPTCHA on page — filled, but not submitting. Finish by hand.'
      : null;
  },

  /**
   * Did everything we tried to write actually land? Re-reads the DOM rather
   * than trusting the fill report, because React can revert a value after the
   * fact if it disagreed with it.
   */
  allFieldsLanded(fieldMap, values) {
    const empty = [];

    for (const [key, selector] of Object.entries(fieldMap)) {
      if (AF.isPlaceholder(selector)) continue;
      const want = values[key];
      if (want === undefined || want === null || want === '') continue;

      const el = AF.resolveField(selector);
      if (!el) {
        empty.push(key);
        continue;
      }
      if (el.type === 'checkbox') {
        if (!el.checked && (want === true || want === 'true')) empty.push(key);
      } else if (!String(el.value ?? '').trim()) {
        empty.push(key);
      }
    }

    return empty.length
      ? `Not submitting — these fields are still empty: ${empty.join(', ')}.`
      : null;
  },

  /**
   * Any required field on the form we did not even know about? Catches the case
   * where Workday adds a new mandatory field and our selector map is stale.
   */
  unknownRequiredEmpty(knownSelectors) {
    const known = new Set();
    for (const sel of knownSelectors) {
      if (AF.isPlaceholder(sel)) continue;
      const el = AF.resolveField(sel);
      if (el) known.add(el);
    }

    const orphans = [];
    const required = document.querySelectorAll(
      'input[required], select[required], textarea[required], [aria-required="true"]'
    );

    for (const el of required) {
      const field = el.matches('input, select, textarea')
        ? el
        : el.querySelector('input, select, textarea');
      if (!field || known.has(field)) continue;
      if (field.type === 'hidden' || !field.getClientRects().length) continue;
      if (isHoneypot(field)) continue; // must stay empty — see HONEYPOTS above
      // Password fields we deliberately skip are handled by the caller, not here.
      if (!String(field.value ?? '').trim()) {
        orphans.push(
          field.getAttribute('data-automation-id') ||
            field.getAttribute('aria-label') ||
            field.name ||
            field.type
        );
      }
    }

    return orphans.length
      ? `Not submitting — unmapped required field(s) still empty: ${orphans.join(', ')}. Harvest their data-automation-id and add them to sites/workday.js.`
      : null;
  },

  /**
   * Visible validation errors. Workday's own error containers come from the
   * adapter; the generic ARIA patterns catch the rest.
   */
  validationErrors(adapterErrorSelectors = []) {
    const selectors = [
      ...adapterErrorSelectors.filter((s) => !AF.isPlaceholder(s)),
      '[aria-invalid="true"]',
      '[role="alert"]',
    ];

    const el = anyVisible(selectors);
    if (!el) return null;

    const text = (el.textContent || '').trim().slice(0, 120);
    return text
      ? `Not submitting — the form is showing an error: "${text}"`
      : 'Not submitting — the form is showing a validation error.';
  },

  /** A disabled submit button means Workday isn't satisfied yet. */
  submitReady(submitSelector) {
    if (AF.isPlaceholder(submitSelector)) {
      return 'Submit selector is still a placeholder — nothing to click. See sites/workday.js.';
    }

    const btn = document.querySelector(submitSelector);
    if (!btn) return 'Submit button not found — check the selector in sites/workday.js.';
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      return 'Not submitting — the submit button is still disabled.';
    }
    if (!btn.getClientRects().length) return 'Not submitting — submit button is not visible.';
    return null;
  },
};

/**
 * Run every guard in order and return the FIRST reason to stop, or null to
 * proceed. Order matters: cheapest and most explanatory first.
 */
AF.runGuards = function ({ fieldMap, values, submitSelector, errorSelectors }) {
  const checks = [
    () => AF.guards.captcha(),
    () => AF.guards.allFieldsLanded(fieldMap, values),
    () => AF.guards.validationErrors(errorSelectors),
    () => AF.guards.unknownRequiredEmpty(Object.values(fieldMap)),
    () => AF.guards.submitReady(submitSelector),
  ];

  for (const check of checks) {
    try {
      const reason = check();
      if (reason) return reason;
    } catch (err) {
      // A broken guard must never be the thing that lets a bad submit through.
      AF.log('guard threw', err);
      return 'Not submitting — a safety check failed to run. See console with AF.debug = true.';
    }
  }
  return null;
};
