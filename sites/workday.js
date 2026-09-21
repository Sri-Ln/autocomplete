/* ============================================================================
 *  sites/workday.js — WORKDAY ADAPTER
 *
 *  ── SELECTOR STATUS ───────────────────────────────────────────────────────
 *  VERIFIED against live Workday pages:
 *    createAccount   nvidia.wd5  2026-09-10   all fields + submit
 *    signIn          nvidia.wd5  2026-09-10   all fields + submit
 *    myInformation   live tenant 2026-09-13   all fields + submit + dropdowns
 *
 *  UNVERIFIED (marked REPLACE_ME, safe to leave):
 *    myInformation.address2 — the harvested tenant's form had no Address Line 2
 *      at all. The id below is Workday's conventional one; if the field is
 *      absent it is skipped, and it is listed in optionalFields so a missing
 *      Line 2 never blocks submit.
 *    errorSelectors — these forms validate on submit, not on blur, so the error
 *      container was never rendered during harvesting. guards.js already covers
 *      errors generically via [role="alert"] / [aria-invalid="true"].
 *
 *  ── WHEN WORKDAY BREAKS IT LATER ──────────────────────────────────────────
 *  This file is the ONLY place selectors live. Re-run tools/harvest-myinfo.js,
 *  patch the one line.
 *
 *  ── ⚠ DO NOT FILL: data-automation-id="beecatcher" ────────────────────────
 *  A honeypot: name="website", 1×0px, absolutely positioned. Filling it flags
 *  the submission as a bot. Never add it to a field map, and never write a
 *  "fill every input" fallback.
 * ========================================================================= */

AF.sites.workday = {
  id: 'workday',
  label: 'Workday',

  /* Every tenant: acme.wd1..., example.wd5..., other.wd3... One saved login
   * covers all of them — see findCredential() in background/storage.js. */
  hostMatch: /(^|\.)myworkdayjobs\.com$/i,

  pages: {
    /* ====================================================================
     * PAGE: Create Account                                      [VERIFIED]
     * Same URL as Sign In; Workday swaps the view client-side.
     * ================================================================== */
    createAccount: {
      label: 'Create Account',
      detectSelector: '[data-automation-id="verifyPassword"]',

      fields: {
        email: '[data-automation-id="email"]',
        password: '[data-automation-id="password"]',
        verify: '[data-automation-id="verifyPassword"]',
        terms: '[data-automation-id="createAccountCheckbox"]',
      },
      fieldTypes: { terms: 'checkbox' },

      values: (ctx) => ({
        email: ctx.credential.email,
        password: ctx.credential.password,
        verify: ctx.credential.password,
        terms: true,
      }),

      /* ⚠ ENABLED even on an empty form, so a disabled-button check proves
       * nothing. allFieldsLanded() in guards.js is what protects here. */
      submit: '[data-automation-id="createAccountSubmitButton"]',
      errorSelectors: ['[data-automation-id="REPLACE_ME_errorMessage"]'],
    },

    /* ====================================================================
     * PAGE: Sign In                                             [VERIFIED]
     * ================================================================== */
    signIn: {
      label: 'Sign In',
      detect: () =>
        !!document.querySelector('[data-automation-id="signInFormo"]') &&
        !document.querySelector('[data-automation-id="verifyPassword"]'),

      fields: {
        email: '[data-automation-id="email"]',
        password: '[data-automation-id="password"]',
      },
      values: (ctx) => ({
        email: ctx.credential.email,
        password: ctx.credential.password,
      }),

      submit: '[data-automation-id="signInSubmitButton"]',
      errorSelectors: ['[data-automation-id="REPLACE_ME_errorMessage"]'],
    },

    /* ====================================================================
     * PAGE: My Information                                      [VERIFIED]
     * Step 1 of 7 in the apply flow. URL ends /apply/... but the tenant may
     * route through useMyLastApplication, so detection is DOM-based.
     * ================================================================== */
    myInformation: {
      label: 'My Information',
      detectSelector: '[data-automation-id="applyFlowMyInfoPage"]',

      /* Plain text inputs — handled by the generic filler. Note each selector
       * matches a WRAPPER div; resolveField() finds the input inside it. */
      fields: {
        firstName: '[data-automation-id="formField-legalName--firstName"]',
        lastName: '[data-automation-id="formField-legalName--lastName"]',
        address1: '[data-automation-id="formField-addressLine1"]',
        address2: '[data-automation-id="REPLACE_ME_formField-addressLine2"]', // TODO: absent on the tenant harvested so far — verify on one that shows Line 2
        city: '[data-automation-id="formField-city"]',
        zip: '[data-automation-id="formField-postalCode"]',
        phone: '[data-automation-id="formField-phoneNumber"]',
      },

      /* Never block submit on these being empty or missing. */
      optionalFields: ['address2', 'phone'],

      values: (ctx) => ({
        firstName: ctx.profile.firstName,
        lastName: ctx.profile.lastName,
        address1: ctx.profile.address1,
        address2: ctx.profile.address2,
        city: ctx.profile.city,
        zip: ctx.profile.zip,
        phone: ctx.profile.phone,
      }),

      /* Custom widgets. Not <select> and not text — these are button+listbox
       * and typeahead multi-selects, so the generic filler cannot touch them.
       * Run by customFill below, after the text pass. */
      pickers: {
        source: {
          /* Alternatives, tried in order, then a label-text fallback. One
           * tenant reported "field not on page" for formField-source while the
           * question was plainly on screen under a different id. */
          selector: [
            '[data-automation-id="formField-source"]',
            '[data-automation-id="formField-sourceProspect"]',
            '[data-automation-id="sourceSection"]',
          ],
          labelFallback: 'How Did You Hear About Us',
          kind: 'multiselect',
          label: 'How Did You Hear About Us',
          value: (ctx) => ctx.profile.source,
        },
        state: {
          selector: [
            '[data-automation-id="formField-countryRegion"]',
            '[data-automation-id="formField-region"]',
            '[data-automation-id="formField-state"]',
          ],
          labelFallback: 'State',
          kind: 'listbox',
          label: 'State',
          // Expand the abbreviation first: the dropdown lists full names, and a
          // two-letter query prefix-matches several states at once.
          value: (ctx) => AF.expandUsState(ctx.profile.state),
        },
        country: {
          selector: [
            '[data-automation-id="formField-country"]',
            '[data-automation-id="formField-addressCountry"]',
          ],
          labelFallback: 'Country',
          kind: 'listbox',
          label: 'Country',
          // "USA" / "US" / "U.S." all have to reach "United States of America".
          value: (ctx) => AF.expandCountry(ctx.profile.country),
        },
        phoneCountryCode: {
          /* Required, and a multi-select rather than a listbox. Usually arrives
           * prefilled, but on a blank application it is one of the fields that
           * silently blocks submit — and being unlabelled, it was the one
           * reporting itself as just "text". */
          selector: ['[data-automation-id="formField-countryPhoneCode"]'],
          labelFallback: 'Country Phone Code',
          kind: 'multiselect',
          label: 'Country Phone Code',
          /* The options read "United States of America (+1)", so the plain
           * country name is a substring match and the dialling code needs no
           * table of its own. */
          value: (ctx) => AF.expandCountry(ctx.profile.country),
        },
      },

      async customFill(values, report, ctx) {
        for (const [key, picker] of Object.entries(this.pickers)) {
          if (AF.isPlaceholder(picker.selector)) {
            report.skipped.push(key);
            continue;
          }

          const wanted = picker.value(ctx);
          if (!wanted) {
            report.skipped.push(key);
            continue;
          }

          const fn =
            picker.kind === 'multiselect'
              ? AF.sites.workday.pickFromMultiselect
              : AF.sites.workday.pickFromListbox;

          let result;
          try {
            result = await fn(picker.selector, wanted, picker.labelFallback);
          } catch (err) {
            AF.log(`picker ${key} threw`, err);
            result = { ok: false, reason: String(err?.message ?? err) };
          }

          if (result.ok) {
            (result.already ? report.already : report.filled).push(key);
          } else if (result.notPresent) {
            /* Genuinely absent from this tenant's form — skip, never block.
             *
             * This used to block when the picker was marked required, on the
             * reasoning that a required question must be answered. That was
             * wrong twice over: tenants render different subsets of this form,
             * and if the field really is present and really is required,
             * unknownRequiredEmpty() in guards.js catches it anyway by reading
             * the DOM. Blocking here only ever produced false refusals. */
            report.skipped.push(key);
          } else {
            report.failed.push(key);
            // Carry the reason up so the widget can say something useful
            // instead of just "failed".
            (report.reasons ??= {})[key] = `${picker.label}: ${result.reason}`;
            if (result.sample?.length) {
              report.reasons[key] += ` — saw: ${result.sample.join(', ')}`;
            }
          }
        }
        return report;
      },

      submit: '[data-automation-id="pageFooterNextButton"]',
      errorSelectors: ['[data-automation-id="REPLACE_ME_errorMessage"]'],
    },
  },

  /* ======================================================================
   * WIDGET DRIVERS
   *
   * Both must scope their option search to the OPEN POPUP, never to the whole
   * document. Harvesting document-wide returned the progress-bar steps
   * ("step 2 of 7My Experience", which are li[data-automation-id]) and the
   * phone-code field's already-selected pill ("United States of America (+1)",
   * a promptOption) mixed in with the real options. Matching against that soup
   * would pick nonsense.
   * ==================================================================== */

  /** Every listbox currently on screen. Used to diff before/after a click. */
  visiblePopups() {
    return [...document.querySelectorAll('[role="listbox"], [data-automation-id="promptOptions"]')]
      .filter((el) => el.getClientRects().length);
  },

  /**
   * The popup THIS trigger opened.
   *
   * @param before  popups that were already on screen before the click
   *
   * The old fallback — "any visible listbox, there's only one open at a time" —
   * was wrong. Workday's phone Country Code field is a multi-select whose
   * listbox is present and measurable even when closed, so State and Country
   * both resolved to it and reported
   *   no option matching "Massachusetts" — saw: United States of America (+1)
   * while the real state list sat untouched two elements away.
   *
   * Three strategies, strictest first:
   *   1. aria-controls — authoritative when Workday sets it
   *   2. a popup that appeared since the click — reliable and widget-agnostic
   *   3. a popup inside the same formField wrapper as the trigger
   * There is deliberately no "just grab any listbox" tier.
   */
  findOpenPopup(trigger, before = []) {
    const controls = trigger.getAttribute('aria-controls');
    if (controls) {
      const byId = document.getElementById(controls);
      if (byId && byId.getClientRects().length) return byId;
    }

    const beforeSet = new Set(before);
    const appeared = AF.sites.workday.visiblePopups().filter((el) => !beforeSet.has(el));
    if (appeared.length === 1) return appeared[0];

    /* Workday renders some popups as a sibling of the field rather than inside
     * it, so check the field wrapper and then its parent — but never wider. */
    const wrapper = trigger.closest('[data-automation-id^="formField-"]');
    if (wrapper) {
      for (const scope of [wrapper, wrapper.parentElement].filter(Boolean)) {
        const own = [...scope.querySelectorAll('[role="listbox"]')].filter(
          (el) => el.getClientRects().length
        );
        if (own.length) return own[0];
      }
    }

    // More than one appeared and none is attributable — refuse rather than guess.
    return appeared.length ? appeared[0] : null;
  },

  /** Real, selectable options inside a popup. */
  optionsIn(popup) {
    const els = [...popup.querySelectorAll('[role="option"], [data-automation-id="promptOption"]')];
    return els.filter((el) => {
      if (!el.getClientRects().length) return false;
      const text = el.textContent.trim();
      // "Select One" is Workday's placeholder row, not a value.
      return text && text.toLowerCase() !== 'select one';
    });
  },

  /** Does the trigger already display `wanted`? Keeps the run idempotent. */
  triggerShows(trigger, wanted) {
    const shown = `${trigger.textContent ?? ''} ${trigger.getAttribute('aria-label') ?? ''}`;
    return AF.normalizeText(shown).includes(AF.normalizeText(wanted));
  },

  /**
   * Locate a widget's wrapper: try each selector in turn, then fall back to
   * finding it by its visible label text.
   */
  resolveWrapper(selector, labelFallback) {
    for (const sel of [].concat(selector)) {
      if (AF.isPlaceholder(sel)) continue;
      const hit = document.querySelector(sel);
      if (hit) return hit;
    }
    return labelFallback ? AF.findFieldByLabel(labelFallback) : null;
  },

  async closePopup() {
    document.activeElement?.dispatchEvent?.(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  },

  /**
   * Button that opens a listbox — State, Country, Suffix, Phone Device Type.
   * Returns { ok, already?, reason?, sample? }.
   */
  async pickFromListbox(selector, wanted, labelFallback) {
    const W = AF.sites.workday;
    const wrap = W.resolveWrapper(selector, labelFallback);
    // notPresent, not a failure: tenants render different subsets of this form.
    if (!wrap) return { ok: false, notPresent: true, reason: 'field not on page' };

    const trigger = wrap.matches('button') ? wrap : wrap.querySelector('button');
    if (!trigger) return { ok: false, notPresent: true, reason: 'no dropdown button found' };

    if (W.triggerShows(trigger, wanted)) return { ok: true, already: true };

    // Snapshot first, so we can tell which popup this click actually opened.
    const before = W.visiblePopups();
    trigger.click();
    const popup = await AF.waitFor(() => W.findOpenPopup(trigger, before), 2500);
    if (!popup) return { ok: false, reason: 'dropdown did not open' };

    const options = W.optionsIn(popup);
    const hit = AF.bestMatch(options.map((o) => o.textContent.trim()), [wanted]);

    if (!hit) {
      const sample = options.slice(0, 6).map((o) => o.textContent.trim());
      await W.closePopup();
      return { ok: false, reason: `no option matching "${wanted}"`, sample };
    }

    options[hit.index].click();

    // Confirm it stuck rather than assuming the click registered.
    const settled = await AF.waitFor(() => W.triggerShows(trigger, hit.text), 1500);
    return settled
      ? { ok: true }
      : { ok: false, reason: `clicked "${hit.text}" but the field did not update` };
  },

  /**
   * Typeahead multi-select — "How Did You Hear About Us?".
   *
   * Typing is the primary strategy on purpose. Workday nests these sources
   * ("Job Sites" → "<Company> Career Site"), and its search filters across the
   * whole tree, so typing avoids having to navigate categories at all. If
   * typing finds nothing we fall back to browsing, then to drilling one level
   * into the most promising category.
   */
  async pickFromMultiselect(selector, wanted, labelFallback) {
    const W = AF.sites.workday;
    const wrap = W.resolveWrapper(selector, labelFallback);
    if (!wrap) return { ok: false, notPresent: true, reason: 'field not on page' };

    /* Check "already answered" BEFORE looking for the input.
     *
     * Once a choice is made, Workday swaps the text input for a pill showing
     * the selection, so the input is gone. Looking for the input first made a
     * second run report "no input found" — which, for a required picker, was
     * treated as a hard failure and blocked submit on any form the user had
     * already answered. Caught by running the harness fill twice. */
    const existing = wrap.querySelector(
      '[data-automation-id="selectedItem"], [data-automation-id^="selectedItem"], [data-automation-id="selectedItemList"]'
    );
    if (existing && existing.textContent.trim()) return { ok: true, already: true };

    const input = wrap.matches('input') ? wrap : wrap.querySelector('input[type="text"], input');
    if (!input) return { ok: false, notPresent: true, reason: 'no input found' };

    /* Query ladder: the full answer, then its most distinctive word, then an
     * empty query to just browse. "Career Site" → "career" widens the net when
     * the tenant words it as "Company Career Site". */
    const tokens = AF.tokenize(wanted);
    const queries = [wanted, tokens[0], ''].filter((q, i, a) => q !== undefined && a.indexOf(q) === i);

    let lastSeen = [];

    for (const query of queries) {
      const before = W.visiblePopups();
      input.focus();
      input.click();

      AF.setNativeValue(input, query ?? '', { blur: false });

      const popup = await AF.waitFor(() => W.findOpenPopup(input, before), 2500);
      if (!popup) continue;

      await new Promise((r) => setTimeout(r, 400)); // let the filter settle

      let options = W.optionsIn(popup);
      lastSeen = options.map((o) => o.textContent.trim());

      // Direct hit, scored against the tenant's own wording plus the generic
      // fallbacks ("career site", "company website", ...).
      const candidates = [wanted, ...AF.careerSiteCandidates()];
      let hit = AF.bestMatch(lastSeen, candidates);

      if (!hit) {
        // Nested: open the most likely category and look again.
        const category = AF.bestMatch(lastSeen, AF.SOURCE_CATEGORY_HINTS);
        if (category) {
          options[category.index].click();
          await new Promise((r) => setTimeout(r, 600));

          const inner = W.optionsIn(W.findOpenPopup(input, before) ?? popup);
          const innerTexts = inner.map((o) => o.textContent.trim());
          const innerHit = AF.bestMatch(innerTexts, candidates);
          if (innerHit) {
            inner[innerHit.index].click();
            await new Promise((r) => setTimeout(r, 400));
            return { ok: true };
          }
          lastSeen = innerTexts;
        }
      }

      if (hit) {
        options[hit.index].click();
        await new Promise((r) => setTimeout(r, 400));
        return { ok: true };
      }
    }

    await W.closePopup();
    return {
      ok: false,
      reason: `nothing matched "${wanted}"`,
      sample: lastSeen.slice(0, 6),
    };
  },
};
