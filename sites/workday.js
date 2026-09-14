/* ============================================================================
 *  sites/workday.js — WORKDAY ADAPTER
 *
 *  ── SELECTOR STATUS ───────────────────────────────────────────────────────
 *  VERIFIED against live Workday pages:
 *    createAccount   nvidia.wd5  2026-09-10   all fields + submit
 *    signIn          nvidia.wd5  2026-09-10   all fields + submit
 *    myInformation   ghr.wd1     2026-09-13   all fields + submit + dropdowns
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

  /* Every tenant: ghr.wd1..., nvidia.wd5..., stripe.wd1... One saved login
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
        address2: '[data-automation-id="REPLACE_ME_formField-addressLine2"]', // TODO: absent on ghr.wd1 — verify on a tenant that shows Line 2
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
          selector: '[data-automation-id="formField-source"]',
          kind: 'multiselect',
          label: 'How Did You Hear About Us',
          required: true,
          value: (ctx) => ctx.profile.source,
        },
        state: {
          selector: '[data-automation-id="formField-countryRegion"]',
          kind: 'listbox',
          label: 'State',
          // Expand "MA" first: the dropdown lists full names, and a two-letter
          // query prefix-matches Maine, Maryland and Massachusetts alike.
          value: (ctx) => AF.expandUsState(ctx.profile.state),
        },
        country: {
          selector: '[data-automation-id="formField-country"]',
          kind: 'listbox',
          label: 'Country',
          value: (ctx) => ctx.profile.country,
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
            result = await fn(picker.selector, wanted);
          } catch (err) {
            AF.log(`picker ${key} threw`, err);
            result = { ok: false, reason: String(err?.message ?? err) };
          }

          if (result.ok) {
            (result.already ? report.already : report.filled).push(key);
          } else if (result.notPresent && !picker.required) {
            /* The field simply isn't on this tenant's form. Not every Workday
             * instance shows Country, or a Suffix, or Address Line 2. Treating
             * an absent optional field as a failure would block submit forever
             * on those tenants — caught by the harness, which renders no
             * Country field. */
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

  /** The popup a trigger opened, or null. */
  findOpenPopup(trigger) {
    const controls = trigger.getAttribute('aria-controls');
    if (controls) {
      const byId = document.getElementById(controls);
      if (byId && byId.getClientRects().length) return byId;
    }
    // Fall back to any visible listbox — there is only ever one open at a time.
    for (const lb of document.querySelectorAll('[role="listbox"]')) {
      if (lb.getClientRects().length) return lb;
    }
    return null;
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
  async pickFromListbox(selector, wanted) {
    const W = AF.sites.workday;
    const wrap = document.querySelector(selector);
    // notPresent, not a failure: tenants render different subsets of this form.
    // customFill decides whether an absent field matters, based on `required`.
    if (!wrap) return { ok: false, notPresent: true, reason: 'field not on page' };

    const trigger = wrap.matches('button') ? wrap : wrap.querySelector('button');
    if (!trigger) return { ok: false, notPresent: true, reason: 'no dropdown button found' };

    if (W.triggerShows(trigger, wanted)) return { ok: true, already: true };

    trigger.click();
    const popup = await AF.waitFor(() => W.findOpenPopup(trigger), 2500);
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
  async pickFromMultiselect(selector, wanted) {
    const W = AF.sites.workday;
    const wrap = document.querySelector(selector);
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
      input.focus();
      input.click();

      if (query) AF.setNativeValue(input, query, { blur: false });
      else AF.setNativeValue(input, '', { blur: false });

      const popup = await AF.waitFor(() => W.findOpenPopup(input), 2500);
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

          const inner = W.optionsIn(W.findOpenPopup(input) ?? popup);
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
