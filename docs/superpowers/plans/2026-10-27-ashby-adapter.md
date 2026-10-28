# Ashby Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One press of **Fill** on a `jobs.ashbyhq.com` application form fills everything the extension recognises; the widget's **Submit application** then saves the user's typed answers and clicks Ashby's submit.

**Architecture:** One adapter file, `sites/ashby.js`, registered like Workday. Its one page is a *section page* (the path `content/main.js` already runs for Workday's question pages): `sections.application.fill` reads every field entry into `{question, widget, fieldId}`, fills standard fields from the profile, sends the rest through `AF.questions.resolve`, and drives Ashby's widgets. Two shared rule changes in `content/questions.js` (start date, more demographic wording).

**Tech Stack:** Chrome MV3, plain JS on `AF`, no npm. Node tests via `node test/<file>.test.mjs`; DOM behaviour via a browser harness `test/ashby-harness.html` (synthetic markup, run by hand or with Playwright on `file://`).

**Spec:** `docs/superpowers/specs/2026-10-26-ashby-adapter-design.md` (Step 2)

**Depends on:** `docs/superpowers/plans/2026-10-27-site-neutral-core.md`, done first on the same branch — uses `AF.currentCompany`, `ctx.selfId`, `profile.email`, `profile.startDate`, the `closePopup` hook and `AF.describeReport`.

## Global Constraints

- Same branch `feat/ashby`, after the core plan's commits; one PR into `main` closing the issue opened in the core plan. Commit each task locally; never push — the user reviews the branch before push. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Select only on `ashby-application-form-*` classes, `data-field-path`, `id`/`name`, roles and ARIA — never hashed classes like `_fieldEntry_1e3gg_28`. Sole exception: required marker `label[class*="_required_"]`.
- Never touch: any `input[type=file]`; anything under `.ashby-application-form-autofill-uploader`; `textarea[name="g-recaptcha-response"]`; anything in a reCAPTCHA iframe.
- Fill never clicks `button.ashby-application-form-submit-button`; only the widget's Submit press (existing `onSectionSubmit`) does.
- Text-like inputs: `AF.setNativeValue(el, value)`. Radios, checkboxes, Yes/No, location option: real `.click()`, then confirm with `AF.waitFor`.
- Harness and test data are synthetic (names like "Testy McTestface"); never copy the user's profile or the saved company pages wholesale into the repo.
- All `test/*.test.mjs` pass after every task; Workday harnesses unaffected.

## Review Focus

1. **Ashby's own "Autofill from resume" already filled the form** with parsed values: profile-owned standard fields (name, email, phone, links) are replaced and reported as replaced; question answers already present are left (Task 4 harness case "prefilled").
2. **Location typeahead returns no matching option** (or none within 3 s): the typed text is cleared and Location is listed under Needs you — never left as unselected free text (Task 4 harness case "location miss").
3. **A demographic question with no saved counterpart** (age range, transgender, sexual orientation, pronouns) is left blank and never learned at Submit (Task 1 tests).
4. **User switches between the Overview and Application tabs** of the job: the widget appears on Application and goes away on Overview, with no stale "Submit" state (Task 2 live check).
5. **A required field the extension cannot answer** (company-specific text, file) is listed under Needs you, and the résumé is always listed while its input is empty (Task 4 harness).

---

### Task 1: Start-date rule and demographic wording

**Files:**
- Modify: `content/questions.js` — `DERIVED` (new `startDate` rule before `noticePeriod`), `matchRule` (rule-level widget filter), `SENSITIVE`
- Test: `test/questions.test.mjs` (append)

**Interfaces:**
- Produces: DERIVED rule `{ id: 'startDate', widget: 'date', test: <noticePeriod's pattern plus /start date/>, requires: 'startDate', resolve }` → `MM/DD/YYYY` from `profile.startDate` (`'YYYY-MM-DD'`), using the file's `mmddyyyy`.
- Produces: a DERIVED/PREFERENCES rule may carry `widget` (string or array); `matchRule` skips it when `ctx.widget` is not listed.

- [ ] **Step 1: Write the failing tests:**

```js
const TODAY = new Date(2026, 9, 27);
const sd = (startDate, widget) => AF.questions.resolve('When can you start?',
  { profile: { noticePeriod: '2 weeks', startDate }, widget, today: TODAY });
check('date widget gets the saved start date', sd('2026-11-16', 'date').answer, '11/16/2026');
check('text widget still gets the notice period', sd('2026-11-16', 'text').answer, '2 weeks');
check('unset start date → blank', sd('', 'date').answer, null);
check('past start date → blank', sd('2026-10-01', 'date').answer, null);
check('past start date says why', sd('2026-10-01', 'date').reason, 'your saved start date has passed — update it in the popup');
for (const q of ['What is your age range?', 'Do you identify as transgender?',
                 'What are your pronouns?', 'Which communities do you identify with?'])
  check(`sensitive: ${q}`, AF.questions.isSensitive(q), true);
check('age wording is not over-broad', AF.questions.isSensitive('Are you willing to manage a team?'), false);
```

- [ ] **Step 2:** `node test/questions.test.mjs` → FAIL.
- [ ] **Step 3:** Add the rule and the widget filter. A past date resolves to `null` with exactly the reason above (follow how the file reports a reason for an unset `requires`; compare dates on `today` from ctx, default `new Date()`). Add `SENSITIVE` patterns for `\bage (range|group|bracket)\b|how old`, `transgender`, `pronoun`, `communit(y|ies) .*identify|lgbt|queer`.
- [ ] **Step 4:** Run all tests → no FAIL (the existing `'What gender pronouns do you use?'` test keeps passing).
- [ ] **Step 5:** Commit: `feat(questions): saved start date for date pickers; more demographic wording stays sensitive`.

### Task 2: Adapter skeleton, company, wiring

**Files:**
- Create: `sites/ashby.js`
- Modify: `sites/index.js` (add `AF.sites.ashby`), `manifest.json` (`content_scripts[0].matches` and `host_permissions` gain `https://jobs.ashbyhq.com/*`; `sites/ashby.js` in `js` after `sites/workday-questions.js`; description drops "Workday" for "Workday and Ashby")
- Test: `test/ashby.test.mjs` (create)

**Interfaces:**
- Produces: `AF.sites.ashby = { id: 'ashby', label: 'Ashby', hostMatch: /^jobs\.ashbyhq\.com$/i, company(), pages: { application } }`.
- Produces: `AF.sites.ashby.companyFrom(title: string, pathname: string) → string | null` — text after the last ` @ ` in the title, trimmed; else the first path segment, URL-decoded; else `null`. `company()` calls it with `document.title`, `location.pathname`.
- Produces: page `application` — `{ label: 'Application', detectSelector: 'button.ashby-application-form-submit-button', fields: {}, selfId: true, manualSubmit: 'button.ashby-application-form-submit-button', submitLabel: 'Submit application', hint: 'Press Fill, attach your résumé, check the page, then Submit application.', sections: { application: { label: 'Fill', fill: (c) => fillPage(c), present: () => true } }, describe: AF.describeReport, readAnswers }` (`fillPage`/`readAnswers` from Tasks 3–4; stub them to return an empty report / `[]` here).

- [ ] **Step 1: Write the failing test** — load `content/00-namespace.js`, `content/match.js`, `content/questions.js`, `sites/ashby.js` into a stub `AF` (pattern of `test/questions.test.mjs`):

```js
const A = AF.sites.ashby;
check('title wins', A.companyFrom('Software Engineer @ OpenAI', '/openai/123/application'), 'OpenAI');
check('last @ wins', A.companyFrom('Eng @ Infra @ Wrapbook', '/wrapbook/1'), 'Wrapbook');
check('path fallback', A.companyFrom('Jobs', '/game%20changer/9/application'), 'game changer');
check('nothing', A.companyFrom('', '/'), null);
check('host match', A.hostMatch.test('jobs.ashbyhq.com'), true);
check('no lookalike', A.hostMatch.test('jobs.ashbyhq.com.evil.example'), false);
```

- [ ] **Step 2:** `node test/ashby.test.mjs` → FAIL.
- [ ] **Step 3:** Implement the skeleton, wiring and manifest changes.
- [ ] **Step 4:** Run all tests → no FAIL. Live: sync this branch (`node tools/sync-extension.mjs feat/ashby`), reload, open any `jobs.ashbyhq.com` job: the widget shows on the Application tab with a **Fill** button, not on Overview, and switching tabs back and forth updates it (Review Focus 4).
- [ ] **Step 5:** Commit: `feat(ashby): register the site and its application page`.

### Task 3: Reading the form

**Files:**
- Modify: `sites/ashby.js`
- Create: `test/ashby-harness.html` (synthetic Ashby markup + verdict, styled and structured like `test/questions-harness.html`, no React needed)

**Interfaces:**
- Produces: `readFields() → Array<{ wrap: Element, fieldId: string, question: string, widget: 'text'|'choice'|'checkbox'|'yesno'|'date'|'location'|'file', required: boolean }>`, in page order, over both the application container and the survey container (`.ashby-survey-form-container`).
- Produces: `currentValue(field) → string` ('' when unanswered; for `file`, the `.ashby-application-form-input-file-item-name` text).
- Exposed for the harness: `AF.sites.ashby.form = { readFields, currentValue, fillPage, readAnswers }`.

Field discovery: every `[data-field-path]` element, outside `.ashby-application-form-autofill-uploader`. `fieldId` = `data-field-path`. `question` = `AF.questions.cleanQuestion` of its `.ashby-application-form-question-title` text. `required` = that title has `[class*="_required_"]` or the input has `required`.

Widget, first match wins: `input[type=file]` → `file`; `.ashby-application-form-input-yesno` → `yesno`; `input[role=combobox]` → `location`; `.ashby-application-form-input-date` → `date`; radio group fieldset → `choice`; checkbox group with >1 option → `choice`; with exactly 1 → `checkbox`, and its `question` becomes `title + ' ' + option label` (so "I acknowledge… Arbitration Agreement" reaches the sign-off rule); `textarea` or `input[type=text|email|tel|url]` → `text`. Anything else is skipped.

Patreon's SMS-consent radios (`input[name="communicationConsent"]`) sit inside the phone entry: read them as a separate `choice` field whose question is their own label text (check the exact markup in `Page_files/Software Engineer, Backend @ Patreon_Ashbyhq.html`).

- [ ] **Step 1: Write the failing harness.** `test/ashby-harness.html` loads `content/00-namespace.js`, `react-set.js`, `match.js`, `questions.js`, `filler.js`, `sites/ashby.js` and renders synthetic entries reproducing the saved pages' markup for: name, email, phone (+ consent radios), location combobox with a fake listbox, LinkedIn, GitHub, résumé file, a yes/no sponsorship, a yes/no "work in office 3 days", a radio "How did you hear about us?", a single arbitration checkbox, a react-datepicker-classed start date, a required company text question, an autofill uploader (must be ignored), and a survey container with EEOC gender/race/veteran radios plus a multi-checkbox ethnicity group and an age-range radio. Assert `readFields()` returns each with the expected `widget`, `question`, `required`, and that the autofill uploader and recaptcha textarea are absent.
- [ ] **Step 2:** Open it → verdict FAIL.
- [ ] **Step 3:** Implement `readFields` / `currentValue`.
- [ ] **Step 4:** Harness → PASS.
- [ ] **Step 5:** Commit: `feat(ashby): read the application form`.

### Task 4: Filling, and learning at Submit

**Files:**
- Modify: `sites/ashby.js`, `test/ashby-harness.html`

**Interfaces:**
- Consumes: `readFields`, `currentValue` (Task 3); `AF.questions.resolve / pickOption / questionCore`; `AF.currentCompany()`; `AF.describeReport`.
- Produces: `fillPage({ profile }) → report` (`{ section: 'Application', filled, replaced, already, kept, left, failed, signed, added: 0, note }`, the shape `AF.describeReport` reads).
- Produces: `readAnswers() → Array<{ question, answer, widget, fieldId }>` — fields with a current value, excluding `file`, `date`, `location` and standard fields.

Standard fields (from the profile; replace a differing value and report it in `replaced`):

| Match | Value |
|---|---|
| `fieldId === '_systemfield_name'`, or question `/^(full |legal )?name$/i` | `firstName + ' ' + lastName` |
| question `/first name\|^preferred name$/i` ("Legal First Name", OpenAI's "Preferred Name") | `firstName` |
| question `/last name\|surname/i` | `lastName` |
| `_systemfield_email` or question `/e-?mail/i` | `email` |
| `input[type=tel]` or question `/phone/i` | `phone` |
| question `/linkedin/i` | `websites.linkedin` |
| question `/github/i` | `websites.github` |
| question `/website\|portfolio\|personal site/i` | `websites.portfolio` |
| `_systemfield_location` / `location` widget | `${city}, ${state}` |

Rows match only `text` widgets (the location row only the `location` widget), so a yes/no "May we email you?" never gets an address. Unset profile value → skipped, and listed only if required. Everything else → `AF.questions.resolve(question, { profile, learned, company: AF.currentCompany(), selfId: true, today: new Date(), widget, fieldId, previous })`, passing `widget: 'choice'` for `yesno`; `file` is never resolved and, when required and empty, listed as "Résumé — attach it yourself" (by its question). Overwrite policy for resolved answers: the `fromProfile` rule of `sites/workday-questions.js` (copy it; a ticked box or chosen option is never changed). Sign-offs move from `filled` to `signed`.

Drivers:
- `text`: `AF.setNativeValue(input, value)`.
- `yesno`: `i = pickOption(['Yes','No'], decision)`; click `button[data-option="yes"|"no"]`; confirm `aria-pressed="true"`.
- `choice` / `checkbox`: `pickOption` over option label texts; click the option's `label`; confirm `input.checked`.
- `date`: `AF.setNativeValue` with the `MM/DD/YYYY` answer, then Enter keydown and blur; confirm `input.value` still equals it.
- `location`: `AF.setNativeValue(input, text, { blur: false })`; wait ≤3000 ms for `[role=option]` in the listbox the input controls (`aria-controls`, else the nearest `[role=listbox]`); click the first whose normalised text contains the normalised city; confirm `input.value` non-empty and `aria-expanded !== 'true'`. No match → clear the input and list "Location — pick it yourself".

- [ ] **Step 1: Write the failing harness cases** (synthetic profile with `eeoGender: 'female'`, `eeoEthnicity: 'asian'`, `eeoVeteran: 'notVeteran'`, `startDate` 30 days ahead, `workAuthorized: 'yes'`, `needsSponsorshipNow: 'no'`):
  - fill → name, email, phone, LinkedIn, GitHub filled; location option clicked; sponsorship `No` pressed; arbitration box ticked and in `signed`; consent radio `Yes`; start date set; EEOC gender `Female`, race option matching Asian, veteran "I am not a protected veteran"; ethnicity checkbox group Asian ticked; age range untouched; office question and company text question in `left`; résumé listed; autofill uploader and file inputs untouched; Ashby's submit button **not** clicked.
  - "prefilled": name pre-set to "Parsed Name" → `replaced` contains Name; a pre-chosen "How did you hear" option is kept.
  - "location miss": the fake listbox offers no matching city → input empty, Location in `left`.
  - `readAnswers()` after the user picks "How did you hear" → includes it; excludes name, résumé, date, location.
- [ ] **Step 2:** Harness → FAIL.
- [ ] **Step 3:** Implement `fillPage`, the drivers, and `readAnswers`.
- [ ] **Step 4:** Harness → PASS; all Node tests → no FAIL.
- [ ] **Step 5:** Commit: `feat(ashby): fill the application and learn answers at Submit`.

### Task 5: Live check, docs, PR

**Files:**
- Modify: `README.md` (supported sites; Ashby flow in one short paragraph)

- [ ] **Step 1:** (User, at end review) With `feat/ashby` synced and the popup's Email and Earliest start date set, open one live Ashby application. Press **Fill**: check each Review Focus item that can be seen live (location pick, prefilled replacement, résumé listed). Do **not** press Submit unless the user is applying for real.
- [ ] **Step 2:** README section; all Node tests → no FAIL.
- [ ] **Step 3:** Commit `docs: Ashby in the README`. No push — hand off to the user for review.
