/* ============================================================================
 *  sites/workday.js — WORKDAY ADAPTER
 *
 *  ── SELECTOR STATUS ───────────────────────────────────────────────────────
 *  VERIFIED against a live Workday page on 2026-09-10
 *  (nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/login):
 *      createAccount — all fields + submit
 *      signIn        — all fields + submit
 *
 *  STILL PLACEHOLDER (reaching these needs a real account, so they were not
 *  harvested):
 *      myInformation — every field
 *      errorSelectors on both auth pages — this form does NOT validate on blur,
 *        it only renders errors after a submit attempt, so the container id was
 *        never observed. guards.js already covers errors generically via
 *        [role="alert"] / [aria-invalid="true"], so this is a bonus, not a gap.
 *
 *  Find everything outstanding with:   grep -rn REPLACE_ME sites/
 *
 *  ── HOW TO HARVEST THE REST ───────────────────────────────────────────────
 *  1. Get to the page (e.g. apply to a job → My Information).
 *  2. DevTools console → paste all of tools/harvest.js → Enter.
 *  3. __afCopy() puts a ready-made fields:{} block on your clipboard.
 *  4. Paste below, reload the extension, reload the tab.
 *
 *  ── WHEN WORKDAY BREAKS IT LATER ──────────────────────────────────────────
 *  This file is the ONLY place selectors live. Nothing else in the extension
 *  hardcodes a Workday detail. Re-harvest, patch the one line.
 *
 *  ── ⚠ DO NOT FILL: data-automation-id="beecatcher" ────────────────────────
 *  It is a honeypot — name="website", 1×0px, absolutely positioned, invisible
 *  to humans but present in the DOM. Workday uses it to catch bots that fill
 *  every input they find. Anything written there flags the submission.
 *  Never add it to a fields map, and never write a "fill all inputs" fallback.
 * ========================================================================= */

AF.sites.workday = {
  id: 'workday',
  label: 'Workday',

  /* Matches every tenant: nvidia.wd5..., stripe.wd1..., salesforce.wd12...
   * One saved login covers all of them — see findCredential() in
   * background/storage.js for the default/override rule. */
  hostMatch: /(^|\.)myworkdayjobs\.com$/i,

  pages: {
    /* ====================================================================
     * PAGE: Create Account                                      [VERIFIED]
     *
     * Note this is the SAME URL as Sign In (…/login). Workday swaps the view
     * client-side with no navigation, which is why detection is DOM-based and
     * why main.js watches for mutations rather than URL changes.
     *
     * Confirmed: email, password and verify are the only inputs. Name, phone
     * and address are NOT here — they are on My Information, later.
     * ================================================================== */
    createAccount: {
      label: 'Create Account',

      /* verifyPassword exists ONLY on this view. The <form> itself is
       * data-automation-id="signInFormo" on BOTH views, so it cannot be used
       * to tell them apart. */
      detectSelector: '[data-automation-id="verifyPassword"]',

      fields: {
        email:    '[data-automation-id="email"]',
        password: '[data-automation-id="password"]',
        verify:   '[data-automation-id="verifyPassword"]',
        terms:    '[data-automation-id="createAccountCheckbox"]',
      },

      fieldTypes: {
        /* Rendered at opacity:0 behind a styled label — 24×24 and still
         * hit-testable, so it resolves normally and the native `checked`
         * setter is enough. Verified: no click fallback needed. */
        terms: 'checkbox',
      },

      values: (ctx) => ({
        email: ctx.credential.email,
        password: ctx.credential.password,
        verify: ctx.credential.password,
        terms: true,
      }),

      submit: '[data-automation-id="createAccountSubmitButton"]',

      /* ⚠ This button is ENABLED even on a completely empty form, so the
       * "is submit disabled" guard proves nothing here. The guard that
       * actually protects you is allFieldsLanded() in content/guards.js. */

      errorSelectors: [
        '[data-automation-id="REPLACE_ME_errorMessage"]', // TODO: harvest after a failed submit
      ],
    },

    /* ====================================================================
     * PAGE: Sign In                                             [VERIFIED]
     *
     * Once an account exists on a tenant, this is the page you actually hit
     * on repeat visits — so it is worth automating too.
     * ================================================================== */
    signIn: {
      label: 'Sign In',

      /* Must explicitly exclude the Create Account view, since both render
       * the same form id. Order in this object is not relied upon. */
      detect: () =>
        !!document.querySelector('[data-automation-id="signInFormo"]') &&
        !document.querySelector('[data-automation-id="verifyPassword"]'),

      fields: {
        email:    '[data-automation-id="email"]',
        password: '[data-automation-id="password"]',
      },

      values: (ctx) => ({
        email: ctx.credential.email,
        password: ctx.credential.password,
      }),

      submit: '[data-automation-id="signInSubmitButton"]',

      errorSelectors: [
        '[data-automation-id="REPLACE_ME_errorMessage"]', // TODO: harvest after a failed submit
      ],
    },

    /* ====================================================================
     * PAGE: My Information                                   [PLACEHOLDER]
     *
     * The first real step of an application, and where name / phone / address
     * actually live. Not harvested — reaching it requires a signed-in account
     * and an open job application.
     *
     * To harvest: sign in, open any job, click Apply, then run tools/harvest.js.
     * ================================================================== */
    myInformation: {
      label: 'My Information',

      detectSelector: '[data-automation-id="REPLACE_ME_myInformationPage"]', // TODO: verify against live Workday page

      fields: {
        firstName: '[data-automation-id="REPLACE_ME_legalNameSection_firstName"]',  // TODO: verify against live Workday page
        lastName:  '[data-automation-id="REPLACE_ME_legalNameSection_lastName"]',   // TODO: verify against live Workday page
        address1:  '[data-automation-id="REPLACE_ME_addressSection_addressLine1"]', // TODO: verify against live Workday page
        city:      '[data-automation-id="REPLACE_ME_addressSection_city"]',         // TODO: verify against live Workday page
        state:     '[data-automation-id="REPLACE_ME_addressSection_region"]',       // TODO: verify — likely a LISTBOX, see pickFromListbox
        zip:       '[data-automation-id="REPLACE_ME_addressSection_postalCode"]',   // TODO: verify against live Workday page
        country:   '[data-automation-id="REPLACE_ME_addressSection_country"]',      // TODO: verify — likely a LISTBOX, see pickFromListbox
        phone:     '[data-automation-id="REPLACE_ME_phone_phoneNumber"]',           // TODO: verify against live Workday page
      },

      values: (ctx) => ({
        firstName: ctx.profile.firstName,
        lastName: ctx.profile.lastName,
        address1: ctx.profile.address1,
        city: ctx.profile.city,
        state: ctx.profile.state,
        zip: ctx.profile.zip,
        country: ctx.profile.country,
        phone: ctx.profile.phone,
      }),

      /* Country/region on Workday are usually button + popup listbox, not
       * <select>. Runs after the normal fill pass and only for fields the
       * generic filler could not resolve. Delete this if harvesting shows
       * they are plain <select> elements. */
      customFill: async (values, report) => {
        for (const key of ['country', 'state']) {
          const selector = AF.sites.workday.pages.myInformation.fields[key];
          if (AF.isPlaceholder(selector)) continue;
          if (AF.resolveField(selector)) continue; // already handled

          const ok = await AF.sites.workday.pickFromListbox(selector, values[key]);
          (ok ? report.filled : report.missing).push(key);
        }
        return report;
      },

      submit: '[data-automation-id="REPLACE_ME_bottom-navigation-next-button"]', // TODO: verify against live Workday page

      errorSelectors: [
        '[data-automation-id="REPLACE_ME_errorMessage"]', // TODO: verify against live Workday page
      ],
    },
  },

  /* ======================================================================
   * Workday's custom dropdown: a button that opens a popup listbox of
   * [role="option"] elements. Click, wait for the popup, click the match.
   *
   * Exactly the kind of thing a pure-JSON selector config could never
   * express — which is why adapters are code, not data.
   * ==================================================================== */
  pickFromListbox: async (triggerSelector, wantedText) => {
    if (!wantedText) return false;

    const trigger = document.querySelector(triggerSelector);
    if (!trigger) return false;

    trigger.click();

    const wanted = String(wantedText).trim().toLowerCase();
    const option = await AF.waitFor(() => {
      const options = [...document.querySelectorAll('[role="option"]')];
      return (
        options.find((o) => o.textContent.trim().toLowerCase() === wanted) ||
        // "United States" should still match "United States of America"
        options.find((o) => o.textContent.trim().toLowerCase().startsWith(wanted)) ||
        null
      );
    }, 2000);

    if (!option) {
      trigger.click(); // close what we opened; leave the page as we found it
      return false;
    }

    option.click();
    return true;
  },
};
