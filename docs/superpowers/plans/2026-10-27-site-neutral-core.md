# Site-Neutral Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Workday assumptions from the shared code so a second site (Ashby, next plan) is one adapter file, with Workday behaving exactly as on v1.0.0.

**Architecture:** Shared code asks the current site adapter (`ctx.site` / `AF.currentSite()`) for anything site-specific through optional hooks, falling back to today's Workday behaviour when a hook is absent. Two profile fields are added (`email`, `startDate`). The widget's report line moves into a shared helper.

**Tech Stack:** Chrome MV3 extension, plain JS on the `AF` namespace, no npm, no build. Node tests run with `node test/<file>.test.mjs` (Node built-ins only).

**Spec:** `docs/superpowers/specs/2026-10-26-ashby-adapter-design.md` (Step 1)

## Global Constraints

- Workday behaviour is unchanged: every `test/*.test.mjs` passes after every task, and the existing expectations are never edited to make them pass.
- No new dependencies, no build step. Match the surrounding style: `AF.*` functions with a JSDoc-style block comment saying why, 2-space indent, single quotes.
- Branch `feat/ashby` from `main`, shared with the Ashby plan (this plan's commits come first); one PR into `main` at the end. Commit each task locally; never push — the user reviews the branch before push. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run all tests: `for f in test/*.test.mjs; do node "$f" || echo "FAIL $f"; done` (bash). Passing means no `FAIL` line.

## Review Focus

1. A question that mentions the company on Workday must still be saved as `[company]` — the new `AF.currentCompany()` must return the same slug `tenantFromHostname` did on every Workday host (pinned in Task 1).
2. A Workday self-identification page must still answer EEO questions, and a Workday Application Questions page must still answer veteran status (`SELF_ID_PAGES` still applies with no flag; pinned in Task 2).
3. A profile saved before this change (no `email` / `startDate` keys) must load with both as `''`, and an unknown key must still be dropped (pinned in Task 3).
4. Popup edits must still reach open Workday tabs after `broadcast` stops hard-coding the host (checked by hand in Task 4).
5. The widget line for My Experience must read exactly as before once `describe` moves (pinned in Task 5).

---

### Task 0: Branch, issue, docs

- [ ] **Step 1:** On `feat/ashby` (already created from `main`).
- [ ] **Step 2:** Open a GitHub issue "Ashby application forms (and a site-neutral core)" summarising the spec's Goals and linking the spec path; note its number for the PR body.
- [ ] **Step 3:** Stage `docs/superpowers/specs/2026-10-26-ashby-adapter-design.md` and both plan files in `docs/superpowers/plans/`; commit: `docs: Ashby adapter design and plans`.

### Task 1: Company name from the site

**Files:**
- Modify: `content/registry.js` (add `AF.currentCompany`)
- Modify: `sites/workday.js` (add `company` to `AF.sites.workday`)
- Modify: `content/main.js:406`, `content/radio-groups.js:145,179`, `content/questions.js:579`
- Test: `test/registry.test.mjs` (create)

`sites/workday-questions.js:191` and `AF.careerSiteCandidates` / `AF.mentionsTenant` in `content/match.js` stay on `tenantFromHostname`: they run only on Workday.

**Interfaces:**
- Produces: `AF.currentCompany(site = AF.currentSite()) → string | null` — `site.company()` when the site defines it, else `AF.tenantFromHostname()`. A hook that throws or returns blank → `null`.
- Produces: site hook `company(): string | null` (optional on any adapter).

- [ ] **Step 1: Write the failing test** `test/registry.test.mjs`, loading `content/00-namespace.js`, `content/match.js`, `content/registry.js` into a stub `AF` the way `test/match.test.mjs` does, with `location = { hostname: 'nvidia.wd5.myworkdayjobs.com' }`:

```js
AF.SITES = [];
check('no site: hostname rule', AF.currentCompany(null), 'nvidia');
check('site without hook: hostname rule', AF.currentCompany({ hostMatch: /x/ }), 'nvidia');
check('site hook wins', AF.currentCompany({ company: () => 'OpenAI' }), 'OpenAI');
check('blank hook → null', AF.currentCompany({ company: () => '  ' }), null);
check('throwing hook → null', AF.currentCompany({ company: () => { throw new Error('x'); } }), null);
```

- [ ] **Step 2:** `node test/registry.test.mjs` → FAIL (`AF.currentCompany is not a function`).
- [ ] **Step 3:** Implement `AF.currentCompany` in `content/registry.js`; add `company: () => AF.tenantFromHostname()` to `AF.sites.workday`; replace the four shared callers with `AF.currentCompany()` (`questions.js:579` becomes `ctx.company ?? AF.currentCompany?.() ?? AF.tenantFromHostname?.() ?? ''`, since Node tests load questions.js without registry.js).
- [ ] **Step 4:** Run all tests → no FAIL.
- [ ] **Step 5:** Commit: `refactor: the site names the company, not the hostname`.

### Task 2: Self-identification by page flag

**Files:**
- Modify: `content/questions.js:395` (`matchRule`)
- Modify: `content/main.js:406` (`rememberQuestions` base ctx)
- Test: `test/questions.test.mjs` (append)

**Interfaces:**
- Produces: `ctx.selfId: boolean` accepted by `AF.questions.resolve / matchRule / remember`. Self-ID rules apply when `ctx.selfId === true` **or** `SELF_ID_PAGES.includes(ctx.page)` (the list stays, so Workday needs no change).
- Produces: page flag `selfId: true` on an adapter page; `rememberQuestions` passes `selfId: !!ctx.page.selfId`.

- [ ] **Step 1: Write the failing tests** (reuse the file's `EEO` profile):

```js
check('selfId flag answers gender off Workday',
  AF.questions.resolve('Gender', { profile: EEO, selfId: true, widget: 'choice' }).source, 'self-id');
check('no flag, no page: gender stays sensitive',
  AF.questions.resolve('Gender', { profile: EEO, widget: 'choice' }).answer, null);
check('selfId never learns a demographic',
  AF.questions.remember({}, 'Gender', 'Female', { selfId: true, widget: 'choice' }).stored, false);
check('Workday page list still works without the flag',
  AF.questions.resolve('What is your legal gender?', { profile: EEO, page: 'voluntaryDisclosures', widget: 'listbox' }).source, 'self-id');
```

- [ ] **Step 2:** `node test/questions.test.mjs` → the first test FAILs.
- [ ] **Step 3:** Change the condition in `matchRule`; add `selfId` to `rememberQuestions`' base ctx.
- [ ] **Step 4:** Run all tests → no FAIL.
- [ ] **Step 5:** Commit: `refactor: self-identification follows a page flag`.

### Task 3: `email` and `startDate` in the profile

**Files:**
- Modify: `background/storage.js` (`EMPTY_PROFILE`)
- Modify: `popup/popup.js:15-17` (`PROFILE_FIELDS`), `popup/popup.html` (Profile tab)
- Test: `test/vault.test.mjs` (append)

**Interfaces:**
- Produces: `profile.email: string`, `profile.startDate: string` (`'YYYY-MM-DD'` or `''`), both plain strings through the existing whitelist branch.

- [ ] **Step 1: Write the failing tests:**

```js
await S.setProfile({ firstName: 'Ada', email: ' ada@example.com ', startDate: '2026-11-16' });
const p2 = await S.getProfile();
check('email is kept, trimmed', p2.email, 'ada@example.com');
check('startDate is kept', p2.startDate, '2026-11-16');
// Seed the file's chrome.storage stub with af_profile = { firstName: 'Old' } (no new keys), then:
const old = await S.getProfile();
check('an old profile reads both as empty', [old.email, old.startDate], ['', '']);
```

- [ ] **Step 2:** `node test/vault.test.mjs` → FAIL.
- [ ] **Step 3:** Add `email: ''` (next to `phone`, comment: used where a site asks for email without a login — the vault login stays Workday's) and `startDate: ''` (next to `noticePeriod`, comment: `YYYY-MM-DD`, for date-picker start questions) to `EMPTY_PROFILE`; add both to `PROFILE_FIELDS`; in `popup.html` add `<label>Email<input type="email" id="email" /></label>` beside Phone and `<label>Earliest start date<input type="date" id="startDate" /></label>` beside Notice period.
- [ ] **Step 4:** Run all tests → no FAIL. Open `test/popup-harness.html` by hand: both fields render, save and reload.
- [ ] **Step 5:** Commit: `feat(profile): email and earliest start date`.

### Task 4: Section submit, popup broadcast and wording

**Files:**
- Modify: `content/main.js:435-451` (`onSectionSubmit`), `content/main.js:738, 807, 857`
- Modify: `content/guards.js:171-172, 199, 203`
- Modify: `popup/popup.js:713, 1041`

**Interfaces:**
- Consumes: `ctx.site.label`.
- Produces: optional site hook `closePopup(): Promise<void>`; `onSectionSubmit` calls `await ctx.site?.closePopup?.()` (Workday already has this method on `AF.sites.workday`).

- [ ] **Step 1:** Replace `AF.sites.workday.closePopup()` with the hook call. In the three `onSectionSubmit` messages replace "Workday" with `${ctx.site.label}`.
- [ ] **Step 2:** `broadcast(msg)` queries `chrome.runtime.getManifest().content_scripts.flatMap((c) => c.matches)` instead of the literal pattern.
- [ ] **Step 3:** The other listed strings: where a message is Workday-only by nature (it only appears on a Workday page), leave it; where it can appear on any site, use `ctx.site?.label` or neutral wording. `popup.js:713` "All Workday sites" stays (it labels the Workday login's default).
- [ ] **Step 4:** Run all tests → no FAIL. By hand: `test/questions-harness.html?page=aq` still ends with Submit clicking Next once; with the extension loaded, change a profile field in the popup and confirm an open Workday tab's widget repaints.
- [ ] **Step 5:** Commit: `refactor: section submit and popup broadcast ask the site`.

### Task 5: Shared report line

**Files:**
- Modify: `content/filler.js` (add `AF.describeReport`)
- Modify: `sites/workday-experience.js:1220` (`describe` delegates)
- Test: `test/widget.test.mjs` or a new `test/report.test.mjs` loading `content/filler.js` (whichever loads cleanly in Node)

**Interfaces:**
- Produces: `AF.describeReport(report) → { kind: 'info'|'ok'|'warn'|'err', text }` — today's `myExperience.describe` body, unchanged.

- [ ] **Step 1: Write the failing test** pinning today's output:

```js
check('summary line', AF.describeReport({ section: 'Questions', filled: ['a','b'], replaced: [], already: ['c'],
  kept: [], left: ['Salary — not set', 'Start — not set', 'Pronouns'], failed: [], signed: ['Terms'], added: 0, note: '' }),
  { kind: 'warn', text: 'Questions: 2 filled, 1 already set, 1 signed. Needs you: Salary — not set; Start — not set (+1 more).' });
check('note only', AF.describeReport({ section: 'X', filled: [], already: [], failed: [], left: [], kept: [], note: 'no questions found on this page' }),
  { kind: 'info', text: 'X: no questions found on this page' });
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Move the body to `AF.describeReport` in `content/filler.js`; `describe(report) { return AF.describeReport(report); }`.
- [ ] **Step 4:** Run all tests → no FAIL.
- [ ] **Step 5:** Commit: `refactor: one report line for every site`.

### Task 6: Verify and open the PR

- [ ] **Step 1:** All Node tests pass; the harnesses `test/harness.html`, `myinfo-harness.html`, `myexp-harness.html`, `questions-harness.html` (all three `?page=`), `flow-harness.html` pass by hand (open each, verdict green).
- [ ] **Step 2:** Live Workday check (sync this branch, fill My Information and Application Questions) is left for the user's end review — list it in the hand-off.
- [ ] **Step 3:** No push: continue with the Ashby plan on the same branch.
