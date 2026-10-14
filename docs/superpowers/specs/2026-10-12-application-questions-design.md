# Application Questions, Voluntary Disclosures and Self Identify — design

Date: 2026-10-12 · Branch: `feat/application-questions`

## Goal

Fill the three Workday apply-flow steps the extension does not touch today, the
way My Experience is filled: one press of **Fill** answers every question it
can, leaves the rest blank, and the widget lists what still needs the user.

| Page | `data-automation-id` | Seen on |
|---|---|---|
| Application Questions | `applyFlowPrimaryQuestionsPage` | Panera, Initrode ("1 of 2") |
| Voluntary Disclosures | `applyFlowVoluntaryDisclosuresPage` | Panera |
| Self Identify | `applyFlowSelfIdentifyPage` | Panera |

Each company words its questions differently, but the question *types* repeat.
No LLM: types are recognised by rules, answers come from the profile or from the
user's own earlier answers.

## Decisions (from the user)

1. **Demographic answers are saved answers.** Gender, race/ethnicity,
   Hispanic/Latino, veteran status and disability are set once, deliberately, in
   the popup. Unset leaves the field alone. Never learned from a page, never
   guessed. Used only on Voluntary Disclosures and Self Identify; everywhere
   else these questions stay on the never-answer (SENSITIVE) list.
2. **Company-dependent questions default to No.**
   - "Have you worked for <company>?" → **Yes** only if the company, or an
     affiliate named in the question, matches an employer in the profile;
     otherwise **No** (also when the employer list is empty).
   - "Do you have relatives at <company>?" / "Are you a relative of a public
     official / senior person at <company>?" → always **No**.
   - The `relativesAt` profile list is removed from the popup.
3. **Unrecognised questions are learned.** The user's hand answer is remembered
   with the company name replaced by `[COMPANY]` and reused at any company,
   filled automatically and listed in the summary.
4. **Expected salary is one saved text.** Used as-is in a text box; in a
   dropdown, the option that best matches it.
5. **Sign-offs are filled.** Terms/certification checkboxes are ticked,
   signature-name fields get the full name, signature-date fields get today's
   date. Each is listed in the summary as signed.

## How each question is answered

`AF.questions.resolve(text, ctx)` checks in this order; the first that applies wins.

1. **Self-identification** — only when `ctx.page` is Voluntary Disclosures or
   Self Identify. Rules for gender (including "legal gender"), race/ethnicity,
   Hispanic/Latino, veteran, disability → the saved answer, or `null` if unset.
2. **SENSITIVE** — everywhere else, unchanged in spirit, plus `/\bgender\b/`
   (today only "gender identity" matches, so "What is your legal gender?" is
   recallable — a hole).
3. **Sign-offs** — certification / terms / "electronically signing" checkboxes
   → tick; "signature" / "enter your name" text → full name; "date signed" →
   today.
4. **Derived, company-aware** — `formerEmployee` (rule 2 above, with affiliates
   from the parenthetical checked too, not stripped away), `relativeEmployed`
   and new `relativeOfOfficial` → `No`; `workAuthorization`, `sponsorship`,
   `over18` unchanged.
5. **Preferences** — relocate, travel, notice period unchanged; new
   `expectedSalary`.
6. **Follow-ups** — "If yes, …" questions directly after a question answered
   **No** → `N/A` (text) or the N/A-like option. Otherwise left alone.
7. **Learned** — signature match (below), threshold as today (0.82).
8. Otherwise `null`, reason shown under "Needs you".

### Learning with `[COMPANY]`

Today `signature()` refuses to learn any question that names a company. New rule:

- The company is known from the Workday host's tenant (`panerabread.wd5…` →
  "Panera Bread", via the existing `AF.mentionsTenant` logic) and from the
  question itself.
- Mentions of it (and of "our company" / "this company" / "us") become
  `[COMPANY]` in the signature, so "Do you consent to Panera's background
  check?" and "Do you consent to Acme's background check?" share one entry.
- The derived company-dependent rules (step 4) run before recall, so their
  answers are never learned (`remember()` already refuses anything a rule
  handles).
- Long preambles: the signature is built from the last sentence ending in `?`
  (or the last 300 characters if none), so Initrode's 2,000-character policy
  text does not swamp the match.
- Never learned: sensitive, self-identification, sign-off and follow-up
  questions.

## Components

### `content/questions.js` — the rules (no DOM)

Updated rule tables and `resolve` / `signature` / `remember` as above. Takes
`ctx = { profile, learned, page, company, previous }` where `previous` is the
answer to the question before (for follow-ups). Pure functions; covered by
`test/questions.test.mjs` using the real wording from the four saved pages.

### `sites/workday-questions.js` — new: readers and page entries

- **Reader:** each `[data-automation-id^="formField-"]` on the page →
  `{ wrap, question, widget, options? }`.
  - `question`: the wrapper's label or `richText` text, in full (not cut to 300
    characters as `free-text.js` does today).
  - `widget`: `listbox` (button `aria-haspopup="listbox"`), `radio`,
    `checkbox`, `text` / `textarea`, `date` (spinbutton sections), `prompt`.
  - `options`: read by opening the dropdown — the saved pages show Workday adds
    the list only on open.
- **Drivers:** reuse the existing exports of `AF.sites.workday.experience`
  (`chooseFromListbox`, `fillText`, `setDate`, `promptPick`) rather than
  copying them. `setDate` gains a Day section for MM/DD/YYYY.
  Option choice: exact text, then `AF.bestMatch` against the answer (Yes/No and
  "decline"-style wording).
- **Page entries** for the three pages, wired the way
  `applyFlowMyExpPage` is (`detectSelector`, sections, `describe`).
- **Capture at Next:** each question's current value goes through
  `remember()` as radio groups do today (`AF.captureAnswers`).

### Popup

- Profile tab: add **Expected salary** (text). Remove **Relatives at**.
- New **Self-identification** section: five dropdowns (gender, race/ethnicity,
  Hispanic/Latino, veteran, disability), each defaulting to *Not set*. Values
  are the user's wording, matched against each page's options.
- Learned answers keep appearing in the existing Answers list (forget one / all).

### Widget

Same Fill button and one-line summary as My Experience, e.g.
"Application Questions: 4 filled, 1 signed. Needs you: …".

## Errors and refusals

- An answer that matches no option leaves the field alone and is listed:
  "Gender: saved 'Decline' matches no option here".
- A dropdown that will not open or settle → left, listed, no retry loop.
- Nothing already answered on the page is changed unless the rule's answer
  differs **and** came from the profile (not from learning).

## Testing

- `test/questions.test.mjs`: every question from the four saved pages → expected
  type and answer; company swap; preamble trimming; follow-up N/A; gender is now
  sensitive outside the disclosure pages.
- `test/questions-harness.html` (new): synthetic copies of the three pages'
  structure (listbox + hidden input, textarea, checkbox, date spinbuttons),
  synthetic profile and synthetic company names (e.g. "Acme Bakery") only, as
  in the other harnesses.
- Live check on the Panera flow by the user.

## Out of scope

- Self Identify's Employee ID (left blank) and its form Language dropdown
  (already set by Workday).

- LLM classification (a single hook in `resolve` step 7 is where it would go).
- Page 2 of Initrode's questions (no saved copy yet).
- Free-text answers beyond salary, sign-off name and N/A.
