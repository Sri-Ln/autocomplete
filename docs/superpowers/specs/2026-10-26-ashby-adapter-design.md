# Ashby adapter and a site-neutral core — design

Date: 2026-10-26 · Branches: `refactor/site-neutral-core`, then `feat/ashby`

## Why

The extension fills Workday only. Many jobs are on Ashby (`jobs.ashbyhq.com`),
and Greenhouse and Lever will follow. The user wants each new site to be an
addition, one adapter file, not a rewrite, and wants the saved profile and
learned answers shared across sites so nothing is entered twice.

Ashby application forms are a single page. One press of **Fill** should fill
everything the extension recognises; the user attaches the résumé, reviews,
and submits.

## Goals

- `sites/ashby.js` fills the standard fields on any Ashby application form in
  one click.
- The shared code (`content/`, `background/`, `popup/`) carries no Workday
  assumption that a second site would trip over. After this work, adding a
  site means: one `sites/<name>.js`, its entry in `sites/index.js`, and its
  host in `manifest.json`.
- One profile, one set of learned answers, used by every site.

## Non-goals

- **Résumé and cover letter.** The user attaches these from elsewhere. The
  extension never touches a file input, and never touches Ashby's "Autofill
  from resume" uploader (`.ashby-application-form-autofill-uploader`), which
  overwrites fields when given a file.
- **Per-company code.** No selectors or branches for one company. Company
  questions are still filled wherever the generic rules, the saved
  demographic answers or learned answers cover them (see "Questions") — the
  user wants as many filled as possible.
- **Ashby forms embedded in a company's own careers page** (iframe on another
  domain). `all_frames` stays false; only `jobs.ashbyhq.com` itself.
- Greenhouse, Lever. The core work makes them easy; building them is later.
- Any LLM (issue #2 stays separate).

## Anti-goals

- **Workday changes behaviour.** Step 1 is a refactor: every Workday page
  fills, guards and submits exactly as on v1.0.0. All `test/*.test.mjs` stay
  green, and the browser harnesses in `test/*.html` still pass by hand.
- **Ashby submits on Fill.** Fill never clicks Submit Application; only the
  widget's separate Submit press does (see "Submit behaviour").
- **Touching anti-bot machinery.** Never write to
  `textarea[name="g-recaptcha-response"]` or anything inside a reCAPTCHA frame.
- **Corrupting learned answers.** A wrong company name (e.g. "jobs") swapped
  into question signatures would poison `af_answers` for every site.

## Constraints

- Plain JS content scripts on the `AF` namespace, no npm, no build step; tests
  use Node built-ins only (see README → Tests). Match the existing style.
- Ashby is React. Text-like inputs: native value setter + `input`/`change`
  (+ `blur`) via `content/react-set.js`. Radios, checkboxes, Yes/No buttons,
  the location picker: real clicks.
- Select on the stable `ashby-application-form-*` classes and `data-field-path`
  / `id`; never on hashed CSS-module classes (`_fieldEntry_1e3gg_28`). The one
  exception is the required marker, `[class*="_required_"]` on the label.

## Step 1 — site-neutral core (`refactor/site-neutral-core`)

Each item lists the leak (from an audit of v1.0.0) and the fix.

1. **Company name.** `AF.tenantFromHostname` (`content/match.js:139`) returns
   the first hostname label: right on `nvidia.wd5.myworkdayjobs.com`, `"jobs"`
   on Ashby. Add an optional site hook `company()`; a shared
   `AF.currentCompany()` calls it, falling back to the hostname rule. Replace
   the callers (`main.js:406`, `radio-groups.js:145,179`,
   `questions.js:579`, `workday-questions.js:191`, and inside `match.js`:
   `careerSiteCandidates` ~155, `mentionsTenant` ~190). Workday's hook is the
   current hostname rule.
2. **Picks bucket — not changed (builder's call, made by Claude).** Picks are
   keyed by hostname (`main.js:1080`, `service-worker.js:144`), which would
   lump all Ashby companies together, but no Ashby field uses picks in this
   build. Re-key only when a site needs it.
3. **Email in the profile.** Email exists only in the vault, so any page that
   needs it must demand the passphrase. Add `email` to `EMPTY_PROFILE` and the
   write whitelist (`background/storage.js`), and to the popup's Profile tab.
   `startDate` is added the same way (see Step 2 → Start date).
   Pages without `needsCredential` read `profile.email`. Workday's
   Create Account / Sign In keep using the vault login. No migration: the
   field starts empty and the popup shows it; the user fills it once.
4. **Self-identification by page flag.** `SELF_ID_PAGES`
   (`questions.js:320`) lists Workday page keys, and the self-ID `field:`
   rules match Workday `formField-…` ids. Replace the list with a page flag
   (e.g. `selfId: true`) that the adapter sets, carried in `ctx`. The Workday
   pages set it where they are listed today. How a non-Workday reader
   identifies gender / race / veteran (passing a recognised field id, or the
   rules gaining text patterns) is the builder's call, provided Workday
   decisions are unchanged.
5. **Section submit hook.** `onSectionSubmit` calls
   `AF.sites.workday.closePopup()` directly (`main.js:435`). Make it an
   optional adapter hook.
6. **Popup broadcast.** `broadcast` (`popup.js:1041`) messages only
   `*.myworkdayjobs.com` tabs. Message every host the manifest's content
   scripts match (`chrome.runtime.getManifest()`), so popup edits reach Ashby
   tabs too.
7. **Wording.** Messages naming Workday in shared code (`main.js:738, 807,
   857`, `guards.js:171-172, 199, 203`, `popup.js:713`) become site-neutral or
   use `site.label`.

Not changed: the Workday verification/Gmail flow (fenced by its host
already), `filler.js`'s `formField-` label fallback (harmless elsewhere).

Each item gets a unit test where the code is testable in Node (e.g.
`currentCompany` with and without a hook, pick keying, self-ID by flag).

## Step 2 — Ashby adapter (`feat/ashby`)

### Wiring

- `manifest.json`: `https://jobs.ashbyhq.com/*` in `content_scripts.matches`
  and `host_permissions`; `sites/ashby.js` (and any `sites/ashby-*.js`) in the
  `js` list before `sites/index.js`; description no longer says Workday-only.
- `sites/index.js`: add `AF.sites.ashby`.
- `hostMatch: /^jobs\.ashbyhq\.com$/i`.
- `company()`: the company as displayed. Saved pages are titled
  `"<Job> @ <Company>"`, and the URL is `/<org-slug>/<job-id>/application`;
  prefer the title, fall back to the slug.

### Page

One page, `application`, detected when
`.ashby-application-form-container` and
`button.ashby-application-form-submit-button` are present. The job page has
Overview / Application tabs on one SPA route; the existing MutationObserver
refresh in `main.js` should pick the form up when the tab switches (verify).

No `needsCredential`: Ashby never asks for the passphrase.

### Submit behaviour

**Decided by the user: the Workday Review pattern.** Fill fills and the
widget lists what was filled and what still needs them (always including the
résumé while its input is empty). The widget's main button then reads
**Submit**; the user attaches the résumé, reviews, and presses it. That press
saves the answers they typed into unrecognised questions (`readAnswers`) and
clicks `button.ashby-application-form-submit-button`. This is the existing
sections / `manualSubmit` / `onSectionSubmit` path in `main.js`; the Ashby
page is shaped as a section page, with its own `readAnswers`. If the user
clicks Ashby's own button instead, the application goes in but nothing is
learned — accepted.

### Fields

Standard (fixed ids, present on every form seen):

| Field | Selector | Value |
|---|---|---|
| Name | `#_systemfield_name` | `firstName + ' ' + lastName` |
| Email | `#_systemfield_email` | `profile.email` |
| Location | `[data-field-path="_systemfield_location"] input[role=combobox]` | type `city, state`; click the first listbox option that matches the city; if none, leave it and list it |
| Gender, race, veteran | `[data-field-path="_systemfield_eeoc_gender"]`, `…_race`, `…_veteran_status` radios | the saved `eeo*` answers via `pickOption`; unset → left alone |

Matched by label (company-defined UUID fields, but generic questions):

| Field | Recognised by | Value |
|---|---|---|
| Phone | `input[type=tel]` in a field entry | `profile.phone` |
| First / last name ("Legal First Name") | label | `firstName` / `lastName` |
| LinkedIn, GitHub, Website / Portfolio | label | `websites.linkedin / github / portfolio` |
| Work authorization, sponsorship, over 18, relocate… | label → `AF.questions.resolve` | as on Workday (popup value wins; defaults per the 2026-10-12 decisions) |

Phone's SMS consent radio (`name="communicationConsent"`) is a consent
question, so per the 2026-10-12 decisions it is answered Yes.

### Questions

Everything that is not a standard field goes through the same resolver as
Workday: `{question, widget, fieldId}` read from each
`.ashby-application-form-field-entry` / `[data-field-path]`, then
`AF.questions.resolve` and `pickOption`. So a company-specific question is
answered only when an existing rule already covers it (a consent or
certification sign-off, salary from `expectedSalary`) or the user answered it
before; anything else is left blank and listed. No question is special-cased
per company, and no new shared rule is added (Workday must not change).
**Demographics — decided by the user: fill company surveys too.** The Ashby
page sets `selfId: true`, so the saved `eeo*` answers fill any gender, race /
ethnicity, Hispanic/Latino, veteran or disability question on the page,
including company-written surveys (Wrapbook's "What is your gender
identity?", "Which ethnicity(ies) do you identify with?" — a checkbox group:
tick the option(s) matching the saved answer). Demographic questions with no
saved counterpart (age, transgender, sexual orientation) stay blank and are
listed; they are never learned from a page (2026-10-12 decision 1).

**Agreements — decided by the user: tick them.** Single checkboxes whose own
statement is an acknowledgement, certification, consent or agreement are
ticked, arbitration agreements included (OpenAI's "I acknowledge… the
Arbitration Agreement"). So for a single checkbox the reader passes the
checkbox's statement, not only the field title, to the resolver. Each is
listed in the summary as signed.

"How did you hear about us?" has no rule today (`profile.source` feeds only
Workday's own picker), so on Ashby it is learned like any other question:
answered by hand once, then reused (Claude's call).

Widget drivers needed (in the adapter, like `workday-questions.js`):

- **Yes/No:** click `button[data-option="yes"|"no"]`; confirm via
  `aria-pressed="true"`. Ignore the hidden checkbox next to it.
- **Radio group:** click the option's `label`; confirm via `data-checked` on
  `.ashby-application-form-input-radio-group-option`.
- **Checkbox group:** same, per option.
- **Text / textarea / tel / email:** native setter.
- **Date (react-datepicker):** an `input[type=text]`
  (`.ashby-application-form-input-date`, MM/DD/YYYY), so the reader must
  classify it as a date widget. Set the value with the native setter and
  confirm react-datepicker took it (Enter or blur; builder verifies on the
  saved OpenAI page). The only date question answered is the start date
  (below); any other date field is left blank and listed.

### Start date — decided by the user: a saved date

A new profile field **`startDate`** ("Earliest start date"), a date input in
the popup next to Notice period, stored as `YYYY-MM-DD`. Added to
`EMPTY_PROFILE`, the write whitelist and the popup field list (this goes in
Step 1 with `email`).

A new rule, checked before `noticePeriod` with the same question pattern
(`when can you start`, `earliest start`, `start date`, `availability to
start`): when the widget is a **date**, answer `startDate` in the widget's
format. Text and textarea widgets keep getting `noticePeriod` as today, so
Workday is unchanged. Claude's calls: unset → blank and listed; a saved date
already in the past → blank and listed as "start date has passed — update it
in the popup", never silently moved.
- **File:** never touched.

### Guards

Ashby uses an invisible reCAPTCHA Enterprise (`.grecaptcha-badge`). Since the
extension never submits on Ashby, the CAPTCHA guard does not need to change,
but the badge must not make Fill refuse or the widget show a blocking error.

## Left to the builder

- Module split (one `sites/ashby.js` or `ashby.js` + `ashby-questions.js`).
- The exact hook names and how `ctx` carries `selfId` and the company.
- How the location option is chosen when several match.
- Test fixtures: trimmed copies of the three saved pages in
  `Page_files/*_Ashbyhq.html` (Wrapbook, OpenAI, Patreon), for a harness like
  `test/questions-harness.html` and for Node tests of the reader.

## Verification

- Step 1: all Node tests pass; Workday harnesses pass by hand; a live Workday
  application fills as before.
- Step 2: the three saved pages fill as the tables above say; then one live
  Ashby application, filled and reviewed by the user before they submit.
