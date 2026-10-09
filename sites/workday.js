/* ============================================================================
 *  sites/workday.js — WORKDAY ADAPTER
 *
 *  ── SELECTOR STATUS ───────────────────────────────────────────────────────
 *  VERIFIED against live Workday pages:
 *    createAccount   nvidia.wd5     2026-09-10   all fields + submit
 *    signIn          nvidia.wd5     2026-09-10   all fields + submit
 *    myInformation   live tenant    2026-09-13   all fields + submit + dropdowns
 *    myInformation   acmeinsurance.wd5 2026-09-22  every selector above still
 *      matches, plus addressLine2 and phoneType, which that tenant renders and
 *      this file had no entry for.
 *
 *  UNVERIFIED (marked REPLACE_ME, safe to leave):
 *    errorSelectors — these forms validate on submit, not on blur, so the error
 *      container was never rendered during harvesting, on either tenant.
 *      guards.js already covers errors generically via [role="alert"] /
 *      [aria-invalid="true"].
 *
 *  Note the createAccount terms checkbox is absent entirely on some tenants.
 *  That is handled in guards.js (a field that is not on the page cannot be
 *  filled and no longer blocks submit), not with a placeholder here.
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
     * The step number is not fixed — step 1 of 7 on one tenant, step 2 of 8 on
     * another, and the rail carries no visible labels — so detection is DOM-
     * based. The URL ends /apply/... but a tenant may route through
     * useMyLastApplication, so that is no help either.
     * ================================================================== */
    myInformation: {
      label: 'My Information',
      detectSelector: '[data-automation-id="applyFlowMyInfoPage"]',

      /* Always two clicks here, whatever the autoSubmit setting says.
       *
       * This is the first page of a real application rather than a signup
       * form: it carries a name, an address, a phone number and a "how did you
       * hear about us" answer picked out of a tenant-specific tree, and a wrong
       * one submitted is not something you can take back — the next page has
       * already loaded and the application is live. Filling and submitting in
       * one click also means every one of those writes, several dropdown
       * round-trips and a page navigation happen back to back on Workday's own
       * re-rendering form. Stopping to let it settle, and to let the user look,
       * costs one click. */
      confirmBeforeSubmit: true,

      /* Plain text inputs — handled by the generic filler. Note each selector
       * matches a WRAPPER div; resolveField() finds the input inside it. */
      fields: {
        firstName: '[data-automation-id="formField-legalName--firstName"]',
        lastName: '[data-automation-id="formField-legalName--lastName"]',
        address1: '[data-automation-id="formField-addressLine1"]',
        address2: '[data-automation-id="formField-addressLine2"]', // VERIFIED acmeinsurance.wd5 2026-09-22
        city: '[data-automation-id="formField-city"]',
        zip: '[data-automation-id="formField-postalCode"]',
        phone: '[data-automation-id="formField-phoneNumber"]',
        phoneExtension: '[data-automation-id="formField-extension"]',
      },

      /* Never block submit on this being empty. Address Line 2 is genuinely
       * optional on every tenant seen so far.
       *
       * `phone` used to be here too, from when an absent field and an empty one
       * were reported the same way. It is aria-required on the tenants that
       * render it, so excusing it was wrong; guards.js now skips fields that
       * are not on the page, which is what that entry was really working
       * around. */
      optionalFields: ['address2', 'phoneExtension'],

      values: (ctx) => ({
        firstName: ctx.profile.firstName,
        lastName: ctx.profile.lastName,
        address1: ctx.profile.address1,
        address2: ctx.profile.address2,
        city: ctx.profile.city,
        zip: ctx.profile.zip,
        phone: ctx.profile.phone,
        phoneExtension: ctx.profile.phoneExtension,
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
          /* Every tenant words and nests this list its own way, so no single
           * profile value answers it everywhere. Whatever is selected at
           * submit — matched by us or picked by you — is remembered for this
           * host and tried first next time. See readRemembered(). */
          remember: true,
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
        county: {
          /* Only some tenants ask, and they render it either as a plain text
           * box or as a listbox scoped to the chosen state, so `auto` checks
           * which one is on the page. Runs after State for that reason.
           * "County" never matches the "Country" field: the label fallback
           * scores those two 0. */
          selector: [
            '[data-automation-id="formField-regionSubdivision1"]',
            '[data-automation-id="formField-county"]',
          ],
          labelFallback: 'County',
          kind: 'auto',
          label: 'County',
          value: (ctx) => ctx.profile.county,
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
        phoneType: {
          /* Required, and one of the fields that silently blocked submit: it
           * has no picker, so nothing answered it and unknownRequiredEmpty()
           * named it as an unmapped required field.
           *
           * Mobile is a constant rather than a profile setting on purpose. The
           * question is which handset this number rings, and the number people
           * put on an application is their mobile; a preference to get wrong
           * here would be a preference nobody wants to maintain. */
          selector: ['[data-automation-id="formField-phoneType"]'],
          labelFallback: 'Phone Device Type',
          kind: 'listbox',
          label: 'Phone Device Type',
          value: () => 'Mobile',
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

          /* This company's remembered answer first — it is an exact option
           * label from this very list — then the profile value. */
          const remembered = picker.remember ? ctx.remembered?.[key] : null;
          const attempts = [remembered, picker.value(ctx)].filter(
            (v, i, a) => v && a.indexOf(v) === i
          );
          if (!attempts.length) {
            report.skipped.push(key);
            continue;
          }

          const W = AF.sites.workday;
          const fn =
            picker.kind === 'multiselect' ? W.pickFromMultiselect
            : picker.kind === 'auto' ? W.pickOrType
            : W.pickFromListbox;

          let result;
          for (const wanted of attempts) {
            try {
              result = await fn(picker.selector, wanted, picker.labelFallback);
            } catch (err) {
              AF.log(`picker ${key} threw`, err);
              result = { ok: false, reason: String(err?.message ?? err) };
            }
            if (result.ok || result.notPresent) break;
            if (wanted === remembered) AF.log(`remembered ${key} "${wanted}" not on this list`);
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

        this.clearJunkExtension(values, report);
        return report;
      },

      /**
       * Empty a Phone Extension that holds something no extension could be.
       *
       * Nothing here writes your email into it, but other autofillers on the
       * page do (browser autofill, job-helper extensions), and it goes out on
       * the application as typed. With no extension in your profile, anything
       * that is not digits and the usual separators is cleared.
       */
      clearJunkExtension(values, report) {
        if (values.phoneExtension) return;
        const el = AF.resolveField(this.fields.phoneExtension);
        if (!el?.value || /^[\d\s#x.+-]*$/i.test(el.value)) return;
        AF.log(`clearing Phone Extension "${el.value}" (not an extension)`);
        if (AF.setNativeValue(el, '')) (report.cleared ??= []).push('phoneExtension');
      },

      /**
       * What the remembered pickers hold right now — { key: option label }.
       *
       * Read at submit, so it captures the final answer whoever chose it: our
       * match, or you picking by hand after we left the field for you.
       */
      readRemembered() {
        const W = AF.sites.workday;
        const out = {};
        for (const [key, picker] of Object.entries(this.pickers)) {
          if (!picker.remember) continue;
          const wrap = W.resolveWrapper(picker.selector, picker.labelFallback);
          if (!wrap) continue;
          const value = W.currentValue(wrap);
          if (value) out[key] = value;
        }
        return out;
      },

      /**
       * Leave the form settled before Continue is clicked.
       *
       * Five pickers run on this page and any of them can leave a prompt open —
       * a failed match, a category we drilled into and could not answer from, a
       * popup that ignored Escape. Navigating with one of those portals still
       * mounted unmounts it mid-navigation inside Workday's own React tree.
       * Blurring also gives the field its ordinary on-blur validation pass, so
       * anything the form objects to shows up before we submit rather than
       * after.
       */
      async beforeSubmit() {
        await AF.sites.workday.closePopup();
        document.activeElement?.blur?.();
        await new Promise((r) => setTimeout(r, 250));
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

  /**
   * A multi-select's chosen-items list — not a popup, whatever its role says.
   *
   * Workday renders the pills as <ul role="listbox"
   * data-automation-id="selectedItemList" aria-label="items selected">, and it
   * is on screen permanently (verified on a saved My Experience page). Counted
   * as a popup it did two kinds of damage: findOpenPopup's wrapper search,
   * reached on the first poll before the real dropdown had rendered, returned
   * the NEIGHBOURING field's pills as "the options" — a Degree dropdown read
   * Field of Study's chosen value as its only choice — and closePopup never saw
   * a clear screen on any page with a filled multi-select.
   */
  isPillList(el) {
    return !!el.closest('[data-automation-id="selectedItemList"]');
  },

  /** Every popup list currently on screen. Used to diff before/after a click. */
  visiblePopups() {
    return [...document.querySelectorAll('[role="listbox"], [data-automation-id="promptOptions"]')]
      .filter((el) => el.getClientRects().length && !AF.sites.workday.isPillList(el));
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
      if (byId && byId.getClientRects().length && !AF.sites.workday.isPillList(byId)) return byId;
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
          (el) => el.getClientRects().length && !AF.sites.workday.isPillList(el)
        );
        if (own.length) return own[0];
      }
    }

    // More than one appeared and none is attributable — refuse rather than guess.
    return appeared.length ? appeared[0] : null;
  },

  /**
   * Real, selectable options inside a popup.
   *
   * Workday nests the label inside the row — `li[data-automation-id="menuItem"]
   * [role="option"]` wrapping `p[data-automation-id="promptOption"]` — so a
   * naive query returns every option twice. Dedupe to the outermost row: that
   * is the node carrying the click handler, and it is what must be counted when
   * we ask "is there only one option in here?".
   */
  optionsIn(popup) {
    const els = [...popup.querySelectorAll('[role="option"], [data-automation-id="promptOption"]')];
    const rows = new Set();

    for (const el of els) {
      if (!el.getClientRects().length) continue;
      const row = el.closest('[role="option"], [data-automation-id="menuItem"]') ?? el;
      const text = AF.sites.workday.optionText(row);
      // "Select One" is Workday's placeholder row, not a value.
      if (text && text.toLowerCase() !== 'select one') rows.add(row);
    }
    return [...rows];
  },

  /**
   * An option's own text.
   *
   * Prefer `data-automation-label` on the promptOption node: textContent also
   * picks up the side charms Workday renders into the row (the delete charm on
   * a pill, the drill-in chevron on a category), and on some rows that arrives
   * as stray characters glued to the label.
   */
  optionText(el) {
    const node = el.matches('[data-automation-id="promptOption"]')
      ? el
      : el.querySelector('[data-automation-id="promptOption"]');
    const label = node?.getAttribute('data-automation-label');
    return (label ?? el.textContent ?? '').trim();
  },

  /**
   * Is this row a category to drill into, rather than an answer?
   *
   * This distinction is the whole reason "How Did You Hear About Us?" failed on
   * tenants that name a category exactly what the user saved. With
   * profile.source = "Career Site" and a tree of
   *
   *     Career Site  ›
   *       Acme Insurance Career Section
   *
   * the top-level row "Career Site" scores a perfect 1.0, so it was clicked and
   * reported as answered — while the click had only opened the category and
   * nothing was selected at all.
   *
   * Workday gives the leaf's clickable node `promptLeafNode` and puts a
   * chevron-right charm on a category. Neither is guaranteed on every tenant,
   * so this is a hint, not a verdict: pickFromMultiselect confirms what actually
   * happened by looking for a selection afterwards.
   */
  isCategoryRow(el) {
    if (el.querySelector('[data-automation-id="promptLeafNode"]')) return false;
    return !!el.querySelector(
      '[class*="chevron-right" i], [data-automation-id="chevronRight"], [class*="caret-right" i]'
    );
  },

  /** What this multi-select currently holds — '' when nothing is chosen. */
  selectionIn(wrap) {
    const pill = wrap.querySelector(
      '[data-automation-id="selectedItem"], [data-automation-id^="selectedItem"], [data-automation-id="selectedItemList"]'
    );
    return (pill?.textContent ?? '').trim();
  },

  /**
   * The chosen option's own label, from either widget: a multi-select's pill,
   * or a single select's button. '' when nothing is chosen. Reads the label
   * attribute where Workday provides one, so the delete charm and any
   * screen-reader text never end up in what we remember.
   */
  currentValue(wrap) {
    const W = AF.sites.workday;
    const pill = wrap.querySelector(
      '[data-automation-id="selectedItem"], [data-automation-id^="selectedItem"]'
    );
    if (pill) return W.optionText(pill);

    const button = wrap.querySelector('button[aria-haspopup="listbox"]');
    const shown = (button?.textContent ?? '').trim();
    return shown.toLowerCase() === 'select one' ? '' : shown;
  },

  /** Step back out of a category we drilled into by mistake. */
  async backOut(popup) {
    const back = popup?.querySelector('[data-automation-id="backButton"]');
    if (!back) return false;
    back.click();
    await new Promise((r) => setTimeout(r, 400));
    return true;
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
  /**
   * A field that is a listbox on some tenants and a text box on others:
   * pick from the list when there is one, otherwise type the value.
   */
  async pickOrType(selector, wanted, labelFallback) {
    const W = AF.sites.workday;
    const wrap = W.resolveWrapper(selector, labelFallback);
    if (!wrap) return { ok: false, notPresent: true, reason: 'field not on page' };
    if (wrap.querySelector('button[aria-haspopup="listbox"]')) {
      return W.pickFromListbox(selector, wanted, labelFallback);
    }
    const input = [...wrap.querySelectorAll('input[type="text"], input:not([type]), textarea')]
      .find((el) => el.getClientRects().length);
    if (!input) return { ok: false, notPresent: true, reason: 'no input found' };
    if (AF.normalizeText(input.value) === AF.normalizeText(wanted)) return { ok: true, already: true };
    return AF.setNativeValue(input, wanted)
      ? { ok: true }
      : { ok: false, reason: 'value did not stick' };
  },

  resolveWrapper(selector, labelFallback) {
    for (const sel of [].concat(selector)) {
      if (AF.isPlaceholder(sel)) continue;
      const hit = document.querySelector(sel);
      if (hit) return hit;
    }
    return labelFallback ? AF.findFieldByLabel(labelFallback) : null;
  },

  /**
   * Shut any open prompt, and confirm it actually shut.
   *
   * It used to fire Escape and assume. Escape is the right first try, but a
   * prompt that ignores it was left standing — and an open portal at the moment
   * Continue is clicked is unmounted mid-navigation inside Workday's own React
   * tree, which can take the application page down with it. So: Escape, check,
   * then dismiss the way a person does, by clicking outside. Returns whether
   * the screen is clear.
   */
  async closePopup() {
    const W = AF.sites.workday;
    const escape = () =>
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });

    document.activeElement?.dispatchEvent?.(escape());
    document.body.dispatchEvent(escape());
    await new Promise((r) => setTimeout(r, 200));

    if (!W.visiblePopups().length) return true;

    /* An outside click is the dismissal every one of these widgets handles,
     * because it is the one users perform. Aimed at <body> deliberately: it is
     * the one element on the page that owns nothing. */
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.click();
    await new Promise((r) => setTimeout(r, 250));

    const left = W.visiblePopups().length;
    if (left) AF.log(`${left} popup(s) would not close`);
    return left === 0;
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
    const hit = AF.bestMatch(options.map((o) => W.optionText(o)), [wanted]);

    if (!hit) {
      const sample = options.slice(0, 6).map((o) => W.optionText(o));
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

    /* Only a VISIBLE input is a search box.
     *
     * Some tenants (initrode.wd3) render this question as Workday's single select
     * instead: a listbox button plus a display:none <input> that holds the
     * field's value, with its onChange wired straight to the form. Typing the
     * query into that input wrote "Career Site" as the source id; Workday
     * re-read the form definition for it, the server answered with an error,
     * and the page died with "Something went wrong". A person never touches
     * that input, so neither do we — a select is answered from its list. */
    const input = [...(wrap.matches('input') ? [wrap] : wrap.querySelectorAll('input'))]
      .find((el) => el.getClientRects().length);
    if (!input) {
      if (wrap.querySelector('button[aria-haspopup="listbox"]')) {
        return W.pickFromListbox(selector, wanted, labelFallback);
      }
      return { ok: false, notPresent: true, reason: 'no input found' };
    }

    /* Query ladder: the full answer, then its most distinctive word, then an
     * empty query to just browse. "Career Site" → "career" widens the net when
     * the tenant words it as "Company Career Site". */
    const tokens = AF.tokenize(wanted);
    const queries = [wanted, tokens[0], ''].filter((q, i, a) => q !== undefined && a.indexOf(q) === i);

    // The tenant's own wording plus the generic fallbacks ("career site",
    // "company website", ...).
    const candidates = [wanted, ...AF.careerSiteCandidates()];
    let lastSeen = [];

    for (const query of queries) {
      const before = W.visiblePopups();
      input.focus();
      input.click();

      AF.setNativeValue(input, query ?? '', { blur: false });

      let popup = await AF.waitFor(() => W.findOpenPopup(input, before), 2500);
      if (!popup) continue;

      await new Promise((r) => setTimeout(r, 400)); // let the filter settle

      /* Browse from the top of the tree. The prompt remembers the category it
       * was last left in, so a previous attempt that drilled in and found
       * nothing — a remembered answer the tenant has since renamed — would
       * otherwise leave this one browsing a single folder. Only when browsing:
       * a typed query searches the whole tree already, and backing out of a
       * search view could clear the very results we just asked for. */
      for (let i = 0; !query && i < 3 && (await W.backOut(popup)); i++) {
        popup = W.findOpenPopup(input, before) ?? popup;
      }

      const options = W.optionsIn(popup);
      lastSeen = options.map((o) => W.optionText(o));
      if (!options.length) continue;

      /* Leaves first, categories second.
       *
       * A category named exactly what the user saved outscores every leaf
       * beneath it, so scoring the whole list at once picks the folder over its
       * contents. Answers are leaves; a category is only ever a route to one. */
      const leaves = options.filter((o) => !W.isCategoryRow(o));
      const leafHit = AF.bestMatch(leaves.map((o) => W.optionText(o)), candidates);

      let drilled = false;

      if (leafHit) {
        const chosen = await W.chooseOption(wrap, leaves[leafHit.index]);
        if (chosen.ok) return chosen;
        // It opened a subtree instead of selecting: the row was a category
        // after all, and we are now one level in.
        drilled = chosen.drilled === true;
        popup = chosen.popup ?? popup;
      }

      /* Nested. Two ways in, in order: a row matching what the user actually
       * asked for, then one matching a generic category name. The first is what
       * finds "Career Site › <Tenant> Career Section" — the user's answer names
       * the category, and the answer proper is one level down.
       *
       * Skipped entirely if the click above already drilled. `options` was read
       * before that click and every node in it has since been replaced; clicking
       * one would be clicking a node React has already unmounted, which is a way
       * to take the whole page down rather than a way to open a category. */
      if (!drilled) {
        const categories = options.filter((o) => W.isCategoryRow(o));
        const categoryTexts = categories.map((o) => W.optionText(o));
        const into =
          AF.bestMatch(categoryTexts, candidates) ??
          AF.bestMatch(categoryTexts, AF.SOURCE_CATEGORY_HINTS);

        if (!into) continue;
        if (!W.clickRow(categories[into.index])) continue;

        await new Promise((r) => setTimeout(r, 600));
      }

      /* Whichever way we got here, the list on screen is now the inside of a
       * category. Re-read it — never reuse the list from before the click. */
      const innerPopup = W.findOpenPopup(input, before) ?? popup;
      const inner = W.optionsIn(innerPopup);
      const innerTexts = inner.map((o) => W.optionText(o));
      if (innerTexts.length) lastSeen = innerTexts;

      /* Inside the right category, the best evidence is which row names this
       * company: "Career Site" › "Acme Insurance Career Section". See
       * AF.mentionsTenant — the hostname squashes the name and no amount of
       * scoring bridges that. */
      const named = innerTexts.findIndex((t) => AF.mentionsTenant(t));

      /* Then scoring, and loosely — but only here.
       *
       * The user said "Career Site" and this category IS "Career Site", so the
       * answer is one of these rows; the remaining job is to pick which. The
       * tenant words it in a way no generic phrase matches head-on, so a shared
       * token inside an already-correct category is enough signal. The same
       * threshold out at the top level would pick nonsense. */
      const innerHit =
        named >= 0
          ? { index: named, text: innerTexts[named] }
          : AF.bestMatch(innerTexts, candidates) ??
            AF.bestMatch(innerTexts, candidates, { threshold: 0.4, floor: 0.3 });

      if (innerHit) {
        const chosen = await W.chooseOption(wrap, inner[innerHit.index]);
        if (chosen.ok) return chosen;
      }

      // Wrong branch — climb back out so the next query starts from the top.
      await W.backOut(innerPopup);
    }

    await W.closePopup();
    return {
      ok: false,
      reason: `nothing matched "${wanted}"`,
      sample: lastSeen.slice(0, 6),
    };
  },

  /**
   * Click an option and confirm it actually answered the question.
   *
   * Clicking a row in these prompts does one of two things and looks identical
   * either way: it selects a value, or it opens a subtree. Assuming the first
   * is what produced the old silent failure — reported filled, nothing chosen,
   * and then a required-field guard blocking submit with no explanation that
   * pointed here. So read the field afterwards and believe only that.
   */
  /**
   * Click a row, but never one the page has already thrown away.
   *
   * Every click in these prompts re-renders the list, so any node read before
   * a click may be detached by the time we get to it. Clicking a detached node
   * does not just fail quietly: React's handler still runs, against a fiber for
   * an element that is no longer in the tree, and Workday's own code can throw
   * out of it — which takes down the application page and loses the step.
   */
  clickRow(row) {
    if (!row || !row.isConnected) {
      AF.log('refusing to click a detached option row');
      return false;
    }
    row.click();
    return true;
  },

  async chooseOption(wrap, row) {
    const W = AF.sites.workday;
    if (!W.clickRow(row)) return { ok: false, reason: 'the option list moved under us' };

    const selected = await AF.waitFor(() => W.selectionIn(wrap) || null, 1200);
    if (selected) return { ok: true, text: selected };

    return { ok: false, drilled: true, popup: W.visiblePopups()[0] ?? null };
  },
};
