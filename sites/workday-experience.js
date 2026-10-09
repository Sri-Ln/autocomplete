/* ============================================================================
 *  sites/workday-experience.js — WORKDAY ADAPTER, MY EXPERIENCE PAGE
 *
 *  Registers AF.sites.workday.pages.myExperience. Its own file, rather than
 *  another block in sites/workday.js, because nothing on this page fits the
 *  shape the other pages share. They are one flat form: a field map, a values()
 *  function, and a submit button the widget clicks. This page is a stack of
 *  REPEATING sections — Education 1, Education 2, Add Another — whose entries
 *  may already be there, pre-filled from the résumé parse, and which the user
 *  reviews section by section. So it has its own widget buttons, one per
 *  section, and each fills only its own section. See `sections` at the bottom.
 *
 *  ── ⚠ IT HAS NO `submit` ──────────────────────────────────────────────────
 *  Every other page lets main.js click the footer's Next after a fill and the
 *  guards. This one does not: nothing that fills a section, nor the popup's
 *  "Fill this page", can navigate off it. Next is clicked only by the widget's
 *  own Submit button, through `manualSubmit`, which nothing else reads.
 *
 *  ── SELECTOR STATUS ───────────────────────────────────────────────────────
 *  VERIFIED against a saved live My Experience page (2026-10-08):
 *    page            applyFlowMyExpPage
 *    sections        [role=group][aria-labelledby="<Name>-section"], entries
 *                    [role=group][aria-labelledby="<Name>-<n>-panel"], one
 *                    data-automation-id="add-button" per section ("Add" with
 *                    no entries, "Add Another" after)
 *    education       formField-schoolName (text), formField-degree (listbox
 *                    button + a display:none value input), formField-
 *                    fieldOfStudy (typeahead prompt), formField-gradeAverage
 *                    (GPA, text), formField-firstYearAttended / -lastYearAttended
 *                    (year-only date sections: dateSectionYear-input spinbutton)
 *    skills          formField-skills (typeahead prompt, multi)
 *    websites        formField-url per entry (text)
 *    social          formField-linkedInAccount (text)
 *
 *  ASSUMED (the saved page had no language entries, only the Add button):
 *    the fields INSIDE a language entry. Workday builds them from a server-side
 *    definition — a language picker, a "native"/fluent checkbox, and one
 *    proficiency dropdown per tenant-defined ability type, keyed by an opaque
 *    id. So they are found by LABEL, never by id: see fillLanguageEntry().
 *    formField-language is tried first because every other field on this page
 *    is formField-<property name>, and "language" is that property's name in
 *    Workday's own bundle.
 *
 *  ── THE RULES THIS FILE KEEPS (each one learned the hard way) ─────────────
 *    • Never type into an input that is not on screen. A Workday single select
 *      carries a display:none <input> whose onChange writes straight into the
 *      form value; typing into one took a live application page down. Selects
 *      are answered by opening the button's listbox and clicking an option.
 *    • Never click a detached node — W.clickRow — and re-read every option
 *      list after a click instead of reusing the one from before it.
 *    • Believe only the DOM afterwards: every selection is read back.
 *    • Close what we open. Every section ends with W.closePopup().
 *    • Never duplicate an entry. Existing entries are matched and filled first;
 *      Add is clicked only when the profile needs one more than the page has.
 *    • Pressing a section's button means "make it match my profile". A value
 *      already there that differs — usually the résumé parse's — is replaced;
 *      one that already matches is left untouched. Only fields the profile has
 *      a value for are touched, and skills are only ever added.
 * ========================================================================= */

(() => {
  const W = AF.sites.workday;
  const X = AF.experience;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ======================================================================
   * FINDING THINGS
   * ==================================================================== */

  /**
   * A section's group, by Workday's own aria wiring — then by heading text,
   * for a tenant whose heading ids differ. `name` is the heading id stem:
   * "Education", "Languages", "Skills", "Websites", "Social-Network-URLs".
   */
  function sectionRoot(name) {
    const byId = document.querySelector(`[role="group"][aria-labelledby="${name}-section"]`);
    if (byId) return byId;

    const want = AF.normalizeText(name.replace(/-/g, ' '));
    for (const h of document.querySelectorAll('h2, h3, h4')) {
      if (AF.normalizeText(h.textContent) !== want) continue;
      const group = h.closest('[role="group"]');
      if (group) return group;
    }
    return null;
  }

  /**
   * Entry panels in a section, as their heading ids ("Education-2-panel").
   *
   * Ids rather than elements, on purpose. Every Add, and many selections,
   * re-render the section; an element held across one of those may be a node
   * React has already thrown away. An id is re-resolved at each use.
   */
  function entryIds(section, name) {
    if (!section) return [];
    return [...section.querySelectorAll(`[role="group"][aria-labelledby^="${name}-"]`)]
      .map((el) => el.getAttribute('aria-labelledby'))
      .filter((id) => /-\d+-panel$/.test(id));
  }

  const entry = (id) => document.querySelector(`[role="group"][aria-labelledby="${id}"]`);

  /** "Education 2" — the entry's own heading, for messages. */
  const entryName = (id) =>
    document.getElementById(id)?.textContent.trim() || id.replace(/-panel$/, '').replace(/-/g, ' ');

  const field = (scope, name) => scope?.querySelector(`[data-automation-id="formField-${name}"]`) ?? null;

  /** First of several field names that exists — tenants rename date fields. */
  const fieldAny = (scope, names) => names.map((n) => field(scope, n)).find(Boolean) ?? null;

  /** A field's own label text. */
  const labelOf = (wrap) =>
    (wrap?.querySelector('label, legend')?.textContent ?? '').replace(/\*/g, '').trim();

  /**
   * Could a person type into this?
   *
   * The test that keeps us out of a single select's display:none value input:
   * that input has no layout box at all, so getClientRects() is empty. Checked
   * before EVERY text write on this page, not just where we expect trouble.
   */
  function isTypeable(el) {
    if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
    if (/^(hidden|checkbox|radio|file|button|submit)$/i.test(el.type ?? '')) return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  const textInput = (wrap) =>
    [...(wrap?.querySelectorAll('input, textarea') ?? [])].find(isTypeable) ?? null;

  const listboxButton = (wrap) => wrap?.querySelector('button[aria-haspopup="listbox"]') ?? null;

  /** The prompt's search box — visible, inside Workday's multiselect. */
  const promptInput = (wrap) =>
    [...(wrap?.querySelectorAll('[data-automation-id="multiSelectContainer"] input') ?? [])]
      .find(isTypeable) ?? null;

  /** Pill labels on a prompt. */
  const pills = (wrap) =>
    [...(wrap?.querySelectorAll('[data-automation-id="selectedItem"]') ?? [])].map((p) => W.optionText(p));

  /**
   * What a field shows, from either widget, minus Workday's wrapping parens.
   *
   * The saved page's degree button reads "(Master's Degree (±18 years))" — the
   * selection wrapped in a pair of parentheses — and comparing that verbatim
   * strips the whole value as a parenthetical.
   */
  function shown(wrap) {
    if (!wrap) return '';
    const v = W.currentValue(wrap);
    return v.replace(/^\((.*)\)$/s, '$1').trim();
  }

  /* ======================================================================
   * THE REPORT
   *
   * One per button press. `left` is the list that matters: everything the
   * user still has to do on this section, each with the reason we did not.
   * ==================================================================== */

  function newReport(section) {
    return { section, filled: [], replaced: [], already: [], kept: [], left: [], failed: [], added: 0, note: '' };
  }

  /** File a chooseFromListbox result under the right heading. */
  function record(report, label, res) {
    if (res.already) return report.already.push(label);
    if (!res.ok) {
      return report.left.push(`${label} — ${res.reason}${res.sample?.length ? ` (saw: ${res.sample.join(', ')})` : ''}`);
    }
    report.filled.push(label);
    if (res.was) report.replaced.push(`${label} ("${res.was}")`);
  }

  /* ======================================================================
   * WIDGET DRIVERS
   * ==================================================================== */

  /** Plain text field: set it to the profile's value, replacing what differs. */
  function fillText(wrap, value, label, report) {
    const want = String(value ?? '').trim();
    if (!want) return;
    if (!wrap) return report.left.push(`${label} — not on this form`);

    const input = textInput(wrap);
    if (!input) return report.failed.push(`${label} — no visible box to type into`);

    const current = input.value.trim();
    if (current === want) return report.already.push(label);

    AF.setNativeValue(input, want);
    if (input.value.trim() !== want) return report.failed.push(`${label} — the value did not stick`);
    report.filled.push(label);
    if (current) report.replaced.push(`${label} ("${current}")`);
  }

  /**
   * Button + listbox — Degree, a language, each proficiency dropdown.
   *
   * `choose(texts)` gets the option labels of THIS list and returns
   * { ok, index, text, note? } or { ok: false, reason }. Deciding by function
   * rather than by a wanted string is what lets one driver serve a degree
   * ladder, an exact language name and a proficiency scale.
   *
   * The popup is found the way W.pickFromListbox finds it (snapshot, click,
   * diff), and the row is re-read from the open popup after deciding: the
   * decision takes time, and a list that re-rendered meanwhile has new nodes.
   */
  /** A field's pill list: role="listbox", always on screen, never a popup. */
  const isPillList = (p) => !!p.closest('[data-automation-id="selectedItemList"]');

  /**
   * The popup this click opened — aria-controls, else the one new listbox.
   *
   * Not W.findOpenPopup, whose last resort searches the field wrapper's PARENT
   * for any visible listbox. On this page that parent is the whole entry, and
   * the entry also holds Field of Study's pill list, which is role="listbox"
   * too. Found by the harness: the degree dropdown "opened" onto the pill list
   * of the field beside it and read "Astro Gardening Technology" as its only
   * option. The saved live page nests them the same way. So: pill lists never
   * count, and nothing is guessed — if exactly one new listbox did not appear,
   * keep waiting.
   */
  function openedBy(trigger, before) {
    const controls = trigger.getAttribute('aria-controls');
    const byId = controls && document.getElementById(controls);
    if (byId && byId.getClientRects().length && !isPillList(byId)) return byId;
    const appeared = W.visiblePopups().filter((p) => !before.includes(p) && !isPillList(p));
    return appeared.length === 1 ? appeared[0] : null;
  }

  async function chooseFromListbox(wrap, choose) {
    const trigger = listboxButton(wrap) ?? wrap?.querySelector('button');
    if (!trigger) return { ok: false, reason: 'no dropdown button' };

    const before = W.visiblePopups();
    trigger.click();
    const popup = await AF.waitFor(() => openedBy(trigger, before), 2500);
    if (!popup) return { ok: false, reason: 'the dropdown did not open' };
    await sleep(80);

    const texts = W.optionsIn(popup).map((o) => W.optionText(o));
    const pick = choose(texts);
    if (!pick?.ok) {
      await W.closePopup();
      return { ok: false, reason: pick?.reason ?? 'nothing suitable', sample: texts.slice(0, 6) };
    }
    // Already the right one: close the list rather than click it again.
    const was = shown(wrap);
    if (was && AF.normalizeText(was) === AF.normalizeText(pick.text)) {
      await W.closePopup();
      return { ...pick, ok: true, already: true };
    }

    const live = W.optionsIn(openedBy(trigger, before) ?? popup);
    const row = live.find((o) => W.optionText(o) === pick.text);
    if (!W.clickRow(row)) {
      await W.closePopup();
      return { ok: false, reason: 'the option list moved under us' };
    }

    const settled = await AF.waitFor(() => W.triggerShows(trigger, pick.text), 1500);
    if (!settled) {
      await W.closePopup();
      return { ok: false, reason: `clicked "${pick.text}" but the field did not update` };
    }
    return { ...pick, ok: true, was };
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
  }

  /** The results list a search opened — never the field's own pill list,
   *  which is also role="listbox" and sits right next to the input. */
  function resultsPopup(input, before) {
    const controls = input.getAttribute('aria-controls');
    const byId = controls && document.getElementById(controls);
    if (byId && byId.getClientRects().length && W.optionsIn(byId).length) return byId;

    const appeared = W.visiblePopups().filter(
      (p) => !before.includes(p) && !isPillList(p) && W.optionsIn(p).length
    );
    return appeared.length === 1 ? appeared[0] : null;
  }

  /** Take back a stray search query, so it is not left sitting in the box. */
  function clearQuery(input) {
    if (input?.isConnected && isTypeable(input) && input.value) {
      AF.setNativeValue(input, '', { blur: false });
    }
  }

  /** Remove one pill by its delete charm — only ever one we just caused. */
  async function removePill(wrap, text) {
    const pill = [...wrap.querySelectorAll('[data-automation-id="selectedItem"]')]
      .find((p) => W.optionText(p) === text);
    const charm = pill?.querySelector('[data-automation-id="DELETE_charm"]');
    if (!W.clickRow(charm)) return false;
    return !!(await AF.waitFor(() => !pills(wrap).includes(text), 1200));
  }

  /**
   * Typeahead prompt — Field of Study, Skills, sometimes Language.
   *
   * `match(texts)` → { index, text } | null, as with chooseFromListbox.
   *
   * Searching is done the way a person does it, and the list is only believed
   * once it answers THIS query. Clicking into the box often opens a default
   * browse list (categories, or "the first 100 results" alphabetically) that
   * typing alone does not replace: Workday's catalogue prompts search only on
   * Enter. So: type, and if the list shows a match, take it; if it plainly
   * answers the query without one, stop; otherwise press Enter and read again.
   * Reading the default list as the answer is what made the first rung look
   * absent and sent the ladder through every other rung first.
   *
   * Enter can also COMMIT the highlighted row outright. That is checked for by
   * diffing the pills: a commit that answers the query is accepted, and one
   * that does not is removed at once and reported, because the only pill that
   * may ever appear is the one we chose.
   *
   * Returns { ok, text?, reason?, texts } — `texts` being every option seen,
   * which the ladder logic uses to decide whether a second pass is worth it.
   */
  /* Prompts already seen to search only on Enter, by field id. Learned on the
   * first search of a run, so every later one presses Enter straight away
   * instead of first waiting to see whether typing alone searches — on a
   * Skills list that wait was paid once per skill. */
  const searchesOnEnter = new Set();
  const fieldKey = (wrap) => wrap?.getAttribute('data-automation-id') ?? '';

  async function promptPick(wrap, query, match) {
    const input = promptInput(wrap);
    if (!input) {
      /* Some tenants render the same question as a single select: a listbox
       * button and a hidden value input. Answered from the list, never typed. */
      if (listboxButton(wrap)) {
        let seen = [];
        const res = await chooseFromListbox(wrap, (texts) => {
          seen = texts;
          const hit = match(texts);
          return hit ? { ok: true, ...hit } : { ok: false, reason: `nothing matching "${query}"` };
        });
        return { ...res, texts: seen };
      }
      return { ok: false, reason: 'no search box on this field', texts: [] };
    }

    const pillsBefore = pills(wrap);
    const before = W.visiblePopups();
    const results = () => resultsPopup(input, before);
    /* Is this list the results for THIS query, or the prompt's default list?
     * Seen live: Field of Study opens on an alphabetical default list and
     * searches only on Enter. The wanted option can sit in that default list
     * (an early-alphabet name does), so it was found and clicked there — and a click
     * on a default-list row selects nothing. Rows are believed once most of
     * the list carries a word of the query, or — after Enter — once the list
     * is no longer the one that was showing when Enter was pressed: Workday's
     * search returns loose relatives ("Codex" brings "Building Codes", "Code
     * Development"), so a word count alone rejected real results. Short
     * queries ("C#", "Go", "AI") keep their short words. */
    const allWords = AF.normalizeText(query).split(' ').filter(Boolean);
    const longWords = allWords.filter((w) => w.length >= 3 && !/^(and|the|for)$/.test(w));
    const words = longWords.length ? longWords : allWords;
    let baseline = null; // the list's text when Enter was pressed
    const isResults = (texts) => {
      if (!texts.length) return false;
      if (baseline !== null && texts.join('\n') !== baseline) return true;
      if (!words.length) return false;
      const relevant = texts.filter((t) => words.some((w) => AF.normalizeText(t).includes(w))).length;
      return relevant / texts.length >= 0.5;
    };
    const listNow = () => {
      const popup = results();
      return popup ? W.optionsIn(popup).map((o) => W.optionText(o)).join('\n') : '';
    };

    /* Poll the open list for up to `ms`. Done when the results show a match,
     * or have held still for a moment without one (`answered`). */
    const read = async (ms) => {
      const deadline = Date.now() + ms;
      let last = null;
      let steadySince = Date.now();
      for (;;) {
        const popup = results();
        const rows = popup ? W.optionsIn(popup) : [];
        const texts = rows.map((o) => W.optionText(o));
        const searched = isResults(texts);
        const hit = searched ? match(texts) : null;
        if (hit) return { rows, texts, hit, answered: true };
        const key = texts.join('\n');
        if (key !== last) { last = key; steadySince = Date.now(); }
        const answered = searched && Date.now() - steadySince >= 400;
        if (answered || Date.now() > deadline) return { rows, texts, hit: null, answered };
        await sleep(100);
      }
    };

    input.focus();
    input.click();
    AF.setNativeValue(input, query, { blur: false });

    const enterOnly = searchesOnEnter.has(fieldKey(wrap));
    let seen = enterOnly ? { hit: null, answered: false } : await read(1200);
    let how = 'typing';

    if (!seen.hit && !seen.answered) {
      /* Typing did not search. This prompt searches on Enter. */
      how = 'Enter';
      searchesOnEnter.add(fieldKey(wrap));
      baseline = listNow();
      pressEnter(input);
      await AF.waitFor(() => pills(wrap).length !== pillsBefore.length || null, 400);

      const committed = pills(wrap).filter((t) => !pillsBefore.includes(t));
      if (committed.length) {
        const ok = committed.length === 1 && match(committed);
        AF.log(`search "${query}": Enter committed "${committed.join(', ')}" — ${ok ? 'kept' : 'removed'}`);
        if (ok) {
          clearQuery(input);
          await W.closePopup();
          return { ok: true, text: committed[0], texts: committed };
        }
        for (const t of committed) await removePill(wrap, t);
        clearQuery(input);
        await W.closePopup();
        return { ok: false, reason: `Enter selected "${committed.join(', ')}" by itself — removed it`, texts: committed };
      }
      seen = await read(2500);
    }

    const { rows, texts, hit } = seen;
    AF.log(`search "${query}" (by ${how}): ${hit ? `found "${hit.text}"` : 'no match'}` +
      ` — list showed ${texts.length}: ${texts.slice(0, 6).join(' | ')}`);

    if (!hit) {
      clearQuery(input);
      await W.closePopup();
      return { ok: false, reason: texts.length ? `nothing matching "${query}"` : `no results for "${query}"`, texts };
    }

    /* Rows with a checkbox (Skills) select through the checkbox: a click on
     * the row itself was seen live to do nothing, while the same row's box
     * ticks it. Rows without one are clicked as before. */
    const row = rows[hit.index];
    const box = row?.querySelector('input[type="checkbox"]');
    if (!W.clickRow(box?.isConnected ? box : row)) {
      await W.closePopup();
      return { ok: false, reason: 'the option list moved under us', texts };
    }

    const newPill = () =>
      pills(wrap).find((t) => !pillsBefore.includes(t) && X.promptScore(t, hit.text) >= 0.97) ?? null;
    let landed = await AF.waitFor(() => newPill() || (box?.checked ? 'ticked' : null), 1500);
    if (landed === 'ticked') {
      // Ticked in the list; some prompts only add the pill once the list closes.
      landed = newPill() ?? (await (async () => {
        await W.closePopup();
        return AF.waitFor(newPill, 1200);
      })());
    }
    if (!landed) {
      // What the click hit and what the field holds now, to see why it did not take.
      AF.log(`clicked "${hit.text}" but no new pill — row <${row?.tagName?.toLowerCase()}` +
        ` role=${row?.getAttribute('role')} id=${row?.getAttribute('data-automation-id')}` +
        `${row?.querySelector('input[type="checkbox"]') ? ' has-checkbox' : ''}>` +
        ` · pills before: ${pillsBefore.join(' | ') || 'none'} · after: ${pills(wrap).join(' | ') || 'none'}`);
    }
    clearQuery(promptInput(wrap));
    await W.closePopup();
    return landed
      ? { ok: true, text: hit.text, texts }
      : { ok: false, reason: `clicked "${hit.text}" but nothing was selected`, texts };
  }

  /**
   * A ladder on a prompt: Field of Study.
   *
   * Same two passes as X.pickByLadder — any rung verbatim first, a word-prefix
   * only after — but a prompt only shows what was searched for, so each rung is
   * its own search. Pass one remembers which rungs had a prefix hit, so pass two
   * re-runs only those instead of the whole ladder again.
   *
   * `exactUpTo` / `prefixUpTo` limit each pass to the rungs before that index,
   * so a value already on the form is only replaced by a strictly better one.
   */
  /** For the log: options that share a word with the rung, as exact JSON with their score. */
  function nearMisses(texts, rung) {
    const w = AF.normalizeText(rung).split(' ')[0];
    return (texts ?? []).filter((t) => AF.normalizeText(t).includes(w)).slice(0, 5)
      // Invisible characters spelled out, so a label that only LOOKS identical shows why.
      .map((t) => {
        const spelled = t.replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
        return `"${spelled}" = ${X.promptScore(t, rung)}`;
      });
  }

  async function promptLadder(wrap, ladder, { exactUpTo = Infinity, prefixUpTo = Infinity } = {}) {
    const rungs = X.toLadder(ladder);
    const hasPrefix = [];
    let lastReason = 'no rung is on this list';

    for (let r = 0; r < Math.min(rungs.length, exactUpTo); r++) {
      const res = await promptPick(wrap, rungs[r], (t) => X.bestPromptOption(t, rungs[r], { min: 0.97 }));
      AF.log(`ladder exact pass, rung ${r + 1} "${rungs[r]}": ${res.ok ? `took "${res.text}"` : res.reason}`, nearMisses(res.texts, rungs[r]));
      if (res.ok) return { ...res, rung: rungs[r], rungIndex: r };
      hasPrefix[r] = !!X.bestPromptOption(res.texts ?? [], rungs[r], { min: 0.9 });
      if (/moved|nothing was selected|by itself/.test(res.reason)) lastReason = res.reason;
    }
    for (let r = 0; r < Math.min(rungs.length, prefixUpTo); r++) {
      if (!hasPrefix[r]) continue;
      const res = await promptPick(wrap, rungs[r], (t) => X.bestPromptOption(t, rungs[r], { min: 0.9 }));
      AF.log(`ladder prefix pass, rung ${r + 1} "${rungs[r]}": ${res.ok ? `took "${res.text}"` : res.reason}`);
      if (res.ok) return { ...res, rung: rungs[r], rungIndex: r };
      lastReason = res.reason;
    }
    return { ok: false, reason: lastReason };
  }

  /**
   * Workday's date sections — From / To.
   *
   * A date field is one spinbutton <input> per part (month, year), each laid
   * under a display <div> that shows the value. The input is positioned
   * absolutely, 1px wide and scaled to 0.01, so it LOOKS hidden — but it is not
   * the display:none kind of hidden the rules above forbid. It has a layout
   * box, it is role="spinbutton", and it is the element every keystroke a
   * person makes on a date goes to: clicking the display focuses it, and its
   * onChange (Workday's handleDirectNumericInput) is the typing path itself.
   * So we do what a person does — click the display, then type the number —
   * and accept it only when the spinbutton reports that number back.
   */
  async function setDate(wrap, raw, label, report) {
    if (!String(raw ?? '').trim()) return;
    if (!wrap) return report.left.push(`${label} — not on this form`);

    const date = X.parseMonthYear(raw);
    if (!date) return report.left.push(`${label} — "${raw}" is not a date I can read (use 2019 or 08/2019)`);

    const part = (name) => ({
      input: wrap.querySelector(`[data-automation-id="dateSection${name}-input"]`),
      display: wrap.querySelector(`[data-automation-id="dateSection${name}-display"]`),
    });
    const parts = [
      { name: 'month', ...part('Month'), want: date.month },
      { name: 'year', ...part('Year'), want: date.year },
    ].filter((p) => p.input);

    if (!parts.length) return report.failed.push(`${label} — no date inputs found`);

    const valueOf = (input) => {
      const n = parseInt(input.getAttribute('aria-valuenow') ?? input.value, 10);
      return Number.isFinite(n) ? n : null;
    };

    const current = parts.map((p) => valueOf(p.input));
    const hadValue = current.some((v) => v !== null);
    if (hadValue && parts.every((p, i) => p.want === null || current[i] === p.want)) {
      return report.already.push(label);
    }

    let wrote = 0;
    for (const p of parts) {
      if (p.want !== null && valueOf(p.input) === p.want) continue;
      if (p.want === null) {
        if (valueOf(p.input) !== null) continue; // nothing to set it to; leave it
        report.left.push(`${label} — this form wants a ${p.name}; add one in the popup`);
        continue;
      }
      if (p.input.getAttribute('role') !== 'spinbutton' || !p.input.getClientRects().length) {
        report.failed.push(`${label} — the ${p.name} box is not a date spinner`);
        continue;
      }
      p.display?.click();
      AF.setNativeValue(p.input, String(p.want), { blur: false });
      const ok = await AF.waitFor(() => valueOf(p.input) === p.want, 1200);
      if (ok) wrote++;
      else report.failed.push(`${label} — the ${p.name} did not take ${p.want}`);
    }
    // Blur last, so Workday validates the whole date once both parts are in.
    document.activeElement?.blur?.();
    if (wrote) {
      report.filled.push(label);
      if (hadValue) report.replaced.push(label);
    }
  }

  /**
   * Add one entry to a section and return its id — or null.
   *
   * Confirmed by the entry count, never by the click: a new panel id must
   * appear that was not there before.
   */
  async function addEntry(name) {
    const section = sectionRoot(name);
    const before = new Set(entryIds(section, name));
    const btn = section?.querySelector('[data-automation-id="add-button"]');
    if (!W.clickRow(btn)) return null;
    const id = await AF.waitFor(
      () => entryIds(sectionRoot(name), name).find((x) => !before.has(x)) ?? null,
      3000
    );
    if (id) await sleep(150); // let the new entry's fields mount
    return id;
  }

  /**
   * Delete an entry WE added, and confirm it went.
   *
   * Only ever called on an entry this run created and could not answer — a
   * language the tenant's list does not carry. Left in place it is a blank,
   * required entry the user would have to find and delete before Next would
   * go through. An entry that was already on the page is never removed.
   * The Delete button carries no automation id; it is the panel's own button
   * reading "Delete", outside every form field.
   */
  async function removeEntry(name, id) {
    const btn = [...(entry(id)?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent.trim() === 'Delete' && !b.closest('[data-automation-id^="formField-"]')
    );
    if (!W.clickRow(btn)) return false;
    return !!(await AF.waitFor(() => !entryIds(sectionRoot(name), name).includes(id) || !entry(id), 2000));
  }

  /** Leave the page as a person would: nothing open, nothing focused. */
  async function settle() {
    await W.closePopup();
    document.activeElement?.blur?.();
    await sleep(100);
  }

  /* ======================================================================
   * EDUCATION
   * ==================================================================== */

  const schoolOf = (id) => textInput(field(entry(id), 'schoolName'))?.value.trim() ?? '';

  /** A panel nobody has started: no school, no degree, no field of study. */
  function isBlankEducation(id) {
    const e = entry(id);
    return !schoolOf(id) && !shown(field(e, 'degree')) && !pills(field(e, 'fieldOfStudy')).length;
  }

  async function fillEducationEntry(id, edu, report) {
    const name = entryName(id);
    const e = () => entry(id);

    fillText(field(e(), 'schoolName'), edu.school, `${name} school`, report);

    /* Degree — a ladder against a listbox. */
    const degreeLadder = X.toLadder(edu.degree);
    const degreeWrap = field(e(), 'degree');
    if (degreeLadder.length && !degreeWrap) report.left.push(`${name} degree — not on this form`);
    if (degreeLadder.length && degreeWrap) {
      /* Always opened: the best rung THIS list offers is the answer, and a
       * value already there is kept only when it is that same option. */
      const res = await chooseFromListbox(degreeWrap, (texts) => {
        const hit = X.pickByLadder(texts, degreeLadder);
        return hit
          ? { ok: true, index: hit.index, text: hit.text, rungIndex: hit.rungIndex }
          : { ok: false, reason: 'no rung of your degree ladder is on this list' };
      });
      record(report, `${name} degree`, res);
    }

    /* Field of study — a ladder against a prompt. */
    const fieldLadder = X.toLadder(edu.fieldOfStudy);
    const fosWrap = field(e(), 'fieldOfStudy');
    if (fieldLadder.length && !fosWrap) report.left.push(`${name} field of study — not on this form`);
    if (fieldLadder.length && fosWrap) {
      /* A value already there is kept unless this list has a strictly better
       * one, by the ladder's own order: any exact rung beats any prefix one,
       * then the earlier rung wins. Off the ladder entirely, it is replaced.
       * The new pill goes on first and only then is the old one taken off, so
       * a search that finds nothing never leaves the field emptier. */
      const label = `${name} field of study`;
      const old = [...new Set([...pills(fosWrap), shown(fosWrap)].filter(Boolean))];
      const rank = (c) => {
        const hit = X.onLadder(c, fieldLadder);
        if (!hit) return null;
        const exact = !!X.bestPromptOption([c], hit.rung, { min: 0.97 });
        return { exact, rungIndex: hit.rungIndex };
      };
      const best = old.map(rank).filter(Boolean)
        .sort((a, b) => (b.exact - a.exact) || (a.rungIndex - b.rungIndex))[0] ?? null;
      const limits = !best ? {}
        : best.exact ? { exactUpTo: best.rungIndex, prefixUpTo: 0 }
        : { prefixUpTo: best.rungIndex };
      const worthTrying = !best || limits.exactUpTo !== 0 || limits.prefixUpTo !== 0;

      const res = worthTrying ? await promptLadder(fosWrap, fieldLadder, limits) : null;
      if (res?.ok) {
        for (const t of old) {
          if (t !== res.text && pills(field(e(), 'fieldOfStudy')).includes(t)) {
            await removePill(field(e(), 'fieldOfStudy'), t);
          }
        }
        report.filled.push(label);
        if (old.length) report.replaced.push(`${label} ("${old[0]}")`);
      } else if (best) {
        report.already.push(label);
      } else {
        report.left.push(`${label} — ${res?.reason ?? 'no rung is on this list'}`);
      }
    }

    fillText(fieldAny(e(), ['gradeAverage', 'gpa']), edu.gpa, `${name} GPA`, report);
    await setDate(fieldAny(e(), ['firstYearAttended', 'startDate']), edu.from, `${name} from`, report);
    await setDate(fieldAny(e(), ['lastYearAttended', 'endDate']), edu.to, `${name} to`, report);
  }

  async function fillEducation({ profile }) {
    const report = newReport('Education');
    const wanted = (profile?.education ?? []).filter(X.hasEducation).slice(0, 2);
    if (!wanted.length) {
      report.note = 'No education saved — add it on the popup\'s Experience tab.';
      return report;
    }
    if (!sectionRoot('Education')) {
      report.note = 'This page has no Education section.';
      return report;
    }

    /* Match before adding. First pass: an entry already naming the school —
     * the résumé parse's — is THAT education, whatever slot it sits in. Second
     * pass: an entry nobody has started. Only then is Add clicked. */
    const ids = entryIds(sectionRoot('Education'), 'Education');
    const used = new Set();
    const target = wanted.map((edu) => {
      if (!edu.school) return null;
      const id = ids.find((x) => !used.has(x) && X.sameSchool(schoolOf(x), edu.school));
      if (id) used.add(id);
      return id ?? null;
    });

    /* Second pass: a blank entry; failing that, any entry not yet claimed, in
     * order. The résumé parse's Education 1 with the school misspelt is still
     * Education 1, and is corrected rather than duplicated. */
    for (let i = 0; i < wanted.length; i++) {
      if (target[i]) continue;
      const free = entryIds(sectionRoot('Education'), 'Education').filter((x) => !used.has(x));
      const blank = free.find((x) => isBlankEducation(x)) ?? free[0];
      if (blank) {
        target[i] = blank;
      } else {
        target[i] = await addEntry('Education');
        if (!target[i]) {
          report.failed.push(`Education ${i + 1} — Add did not produce a new entry`);
          continue;
        }
        report.added++;
      }
      used.add(target[i]);
    }

    for (let i = 0; i < wanted.length; i++) {
      if (target[i]) await fillEducationEntry(target[i], wanted[i], report);
    }
    return report;
  }

  /* ======================================================================
   * LANGUAGES
   * ==================================================================== */

  /** The language picker in an entry: by id, else the field labelled "Language". */
  function languageField(e) {
    const byId = field(e, 'language');
    if (byId) return byId;
    return [...(e?.querySelectorAll('[data-automation-id^="formField-"]') ?? [])].find((w) => {
      const l = AF.normalizeText(labelOf(w));
      return /^language\b/.test(l) && !/proficien|fluen|level/.test(l);
    }) ?? null;
  }

  /** "I am fluent in this language" — formField-native, or any checkbox saying fluent/native. */
  function fluentBox(e) {
    const byId = field(e, 'native')?.querySelector('input[type="checkbox"]');
    if (byId) return byId;
    return [...(e?.querySelectorAll('input[type="checkbox"]') ?? [])].find((box) => {
      const wrap = box.closest('[data-automation-id^="formField-"]') ?? box.parentElement;
      return /fluent|native/i.test(wrap?.textContent ?? '');
    }) ?? null;
  }

  const languageOf = (id) => shown(languageField(entry(id)));

  /** Every proficiency dropdown in an entry, by automation id (re-resolved at use). */
  function abilityFields(e) {
    const lang = languageField(e);
    const box = fluentBox(e)?.closest('[data-automation-id^="formField-"]');
    return [...(e?.querySelectorAll('[data-automation-id^="formField-"]') ?? [])]
      .filter((w) => w !== lang && w !== box && listboxButton(w))
      .map((w) => w.getAttribute('data-automation-id'));
  }

  async function chooseLanguage(wrap, name) {
    const match = (texts) => X.bestPromptOption(texts, name, { min: 0.97 });
    if (promptInput(wrap)) return promptPick(wrap, name, match);
    return chooseFromListbox(wrap, (texts) => {
      const hit = match(texts);
      return hit ? { ok: true, ...hit } : { ok: false, reason: `"${name}" is not on this list` };
    });
  }

  async function fillLanguageEntry(id, lang, report) {
    const e = () => entry(id);
    const name = lang.language;

    const langWrap = languageField(e());
    if (!langWrap) {
      report.failed.push(`${name} — no language picker in ${entryName(id)}`);
      return;
    }
    const current = shown(langWrap);
    if (current) {
      if (X.sameLanguage(current, name)) report.already.push(`${name}`);
      else return report.kept.push(`${entryName(id)} ("${current}")`);
    } else {
      const res = await chooseLanguage(langWrap, name);
      if (!res.ok) {
        report.left.push(`${name} — ${res.reason}`);
        return 'unanswered';
      }
      report.filled.push(`${name}`);
      await sleep(250); // the ability fields can depend on the language chosen
    }

    /* The fluent box: ticked only when the user's overall level says fluent or
     * native, and never unticked — if it is already on, someone put it there. */
    const box = fluentBox(e());
    if (box) {
      if (X.isFluent(lang) && !box.checked) {
        if (AF.setNativeChecked(box, true)) report.filled.push(`${name} fluent`);
        else report.failed.push(`${name} fluent — the box would not tick`);
      } else if (X.isFluent(lang)) {
        report.already.push(`${name} fluent`);
      }
    }

    /* One dropdown per ability — or a single "Proficiency" one. Each is matched
     * to the user's level for that skill by its label, and the level is mapped
     * onto THIS dropdown's scale by X.chooseLevel. */
    for (const autoId of abilityFields(e())) {
      const wrap = () => e()?.querySelector(`[data-automation-id="${autoId}"]`);
      const label = labelOf(wrap()) || 'proficiency';
      const what = `${name} ${label.toLowerCase()}`;
      const level = X.levelFor(lang, label);
      if (!level) {
        report.left.push(`${what} — no level saved`);
        continue;
      }
      const res = await chooseFromListbox(wrap(), (texts) => X.chooseLevel(texts, level));
      record(report, what, res);
    }
  }

  async function fillLanguages({ profile }) {
    const report = newReport('Languages');
    const langs = (profile?.languages ?? []).filter((l) => String(l?.language ?? '').trim());
    if (!langs.length) {
      report.note = 'No languages saved — add them on the popup\'s Experience tab.';
      return report;
    }
    if (!sectionRoot('Languages')) {
      report.note = 'This page has no Languages section.';
      return report;
    }

    // Same order as Education: what is already listed, then blank entries, then Add.
    const ids = entryIds(sectionRoot('Languages'), 'Languages');
    const used = new Set();
    const target = langs.map((l) => {
      const id = ids.find((x) => !used.has(x) && X.sameLanguage(languageOf(x), l.language));
      if (id) used.add(id);
      return id ?? null;
    });

    for (let i = 0; i < langs.length; i++) {
      let addedHere = false;
      if (!target[i]) {
        const blank = entryIds(sectionRoot('Languages'), 'Languages')
          .find((x) => !used.has(x) && !languageOf(x));
        if (blank) {
          target[i] = blank;
        } else {
          target[i] = await addEntry('Languages');
          if (!target[i]) {
            report.failed.push(`${langs[i].language} — Add did not produce a new entry`);
            continue;
          }
          addedHere = true;
          report.added++;
        }
        used.add(target[i]);
      }
      // Filled as we go: a new entry's picker is answered before the next Add.
      const outcome = await fillLanguageEntry(target[i], langs[i], report);
      if (outcome === 'unanswered' && addedHere) {
        await W.closePopup();
        if (await removeEntry('Languages', target[i])) {
          report.added--;
          used.delete(target[i]);
        } else {
          report.failed.push(`${langs[i].language} — could not remove the empty entry it added`);
        }
      }
    }
    return report;
  }

  /* ======================================================================
   * SKILLS
   * ==================================================================== */

  const skillsField = () =>
    document.querySelector('[data-automation-id="formField-skills"]') ??
    sectionRoot('Skills')?.querySelector('[data-automation-id^="formField-"]') ??
    null;

  /**
   * Add each saved skill that is not already a pill.
   *
   * Never removes one. The résumé parse's "(Suggested)" pills are the user's to
   * keep or delete; the only pill this ever takes away is one Enter committed
   * on its own that was not what we searched for (see promptPick).
   */
  /**
   * A skill's option: its exact name, or the name plus a parenthetical
   * ("Java (Programming Language)"). Never a longer name — "React" is not
   * "React VR", "AWS" is not "AWS Tools". A skill with symbols in it (C#, C++,
   * .NET) must match its text as written, because normalising strips them and
   * "C#" would otherwise equal "C".
   */
  function skillMatch(texts, skill) {
    const raw = (t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ');
    const want = raw(skill);
    const i = texts.findIndex((t) => raw(t) === want);
    if (i >= 0) return { index: i, text: texts[i], score: 1 };
    if (/[^a-z0-9\s]/i.test(skill)) return null;
    return X.bestPromptOption(texts, skill, { min: 0.97 });
  }

  async function fillSkills({ profile }) {
    const report = newReport('Skills');
    const skills = (profile?.skills ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (!skills.length) {
      report.note = 'No skills saved — add them on the popup\'s Experience tab.';
      return report;
    }
    if (!skillsField()) {
      report.note = 'This page has no Skills field.';
      return report;
    }

    for (const skill of skills) {
      const wrap = skillsField();
      if (X.alreadyHas(pills(wrap), skill)) {
        report.already.push(skill);
        continue;
      }
      const res = await promptPick(wrap, skill, (texts) => skillMatch(texts, skill));
      if (res.ok) {
        report.filled.push(X.promptScore(res.text, skill) >= 1 ? skill : `${skill} → "${res.text}"`);
      } else {
        report.left.push(`${skill} — ${res.reason}`);
      }
    }
    return report;
  }

  /* ======================================================================
   * WEBSITES
   * ==================================================================== */

  const urlOf = (id) => textInput(field(entry(id), 'url'))?.value.trim() ?? '';

  async function fillWebsites({ profile }) {
    const report = newReport('Websites');
    const links = X.websiteList(profile);
    if (!links.length) {
      report.note = 'No links saved — add them on the popup\'s Experience tab.';
      return report;
    }

    if (sectionRoot('Websites')) {
      const used = new Set();
      for (const { kind, url } of links) {
        const ids = entryIds(sectionRoot('Websites'), 'Websites');
        const there = ids.find((x) => X.sameUrl(urlOf(x), url));
        if (there) {
          used.add(there);
          report.already.push(kind);
          continue;
        }
        let id = ids.find((x) => !used.has(x) && !urlOf(x));
        if (!id) {
          id = await addEntry('Websites');
          if (!id) {
            report.failed.push(`${kind} — Add did not produce a new entry`);
            continue;
          }
          report.added++;
        }
        used.add(id);
        fillText(field(entry(id), 'url'), url, kind, report);
      }
    }

    /* "Social Network URLs" — a fixed LinkedIn box on some tenants, separate
     * from the Websites list. Only LinkedIn: the profile has nothing for the
     * Twitter/Facebook boxes some tenants put beside it. */
    const linkedin = X.withScheme(profile?.websites?.linkedin);
    const social = document.querySelector('[data-automation-id="formField-linkedInAccount"]');
    if (linkedin && social) fillText(social, linkedin, 'LinkedIn profile box', report);

    if (!sectionRoot('Websites') && !social) report.note = 'This page has no Websites section.';
    return report;
  }

  /* ======================================================================
   * THE PAGE
   * ==================================================================== */

  /** Wrap a section's fill so it always settles the page, even if it throws. */
  const run = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } finally {
      await settle();
    }
  };

  AF.sites.workday.pages.myExperience = {
    label: 'My Experience',
    detectSelector: '[data-automation-id="applyFlowMyExpPage"]',

    /* Nothing for the generic filler, and no `submit` — see the header. */
    fields: {},

    /* Read only by the widget's Submit button — see the header. */
    manualSubmit: '[data-automation-id="pageFooterNextButton"]',

    /**
     * One widget button each. `present()` decides whether the button shows;
     * Websites is the one a tenant may leave out entirely (the Social Network
     * box counts — it is the same button). The other three always show and
     * say so if the section is missing, rather than vanishing.
     */
    sections: {
      education: { label: 'Education', fill: run(fillEducation), present: () => true },
      languages: { label: 'Languages', fill: run(fillLanguages), present: () => true },
      skills: { label: 'Skills', fill: run(fillSkills), present: () => true },
      websites: {
        label: 'Websites',
        fill: run(fillWebsites),
        present: () =>
          !!(sectionRoot('Websites') ||
             document.querySelector('[data-automation-id="formField-linkedInAccount"]')),
      },
    },

    /**
     * One line for the widget.
     *   "Education: 4 filled, 2 already there, 1 entry added. Left for you: …"
     * `kept` — values already on the form that differ from the profile — are
     * named, because "we left your school alone" is something to check.
     */
    describe(report) {
      if (report.note && !report.filled.length && !report.already.length) {
        return { kind: 'info', text: `${report.section}: ${report.note}` };
      }
      // The itemised report goes to the console, never the widget.
      AF.log(`${report.section} report`, report);

      const parts = [
        report.filled.length && `${report.filled.length} filled`,
        report.replaced.length && `${report.replaced.length} replaced`,
        report.already.length && `${report.already.length} already set`,
        report.added && `${report.added} ${report.added === 1 ? 'entry' : 'entries'} added`,
      ].filter(Boolean);
      let text = `${report.section}: ${parts.join(', ') || 'nothing to do'}.`;

      // What still needs the user: at most two, kept short, and a count of the rest.
      const todo = [...report.failed, ...report.left, ...report.kept];
      if (todo.length) {
        const clip = (t) => (t.length > 70 ? `${t.slice(0, 67)}…` : t);
        const more = todo.length > 2 ? ` (+${todo.length - 2} more)` : '';
        text += ` Needs you: ${todo.slice(0, 2).map(clip).join('; ')}${more}.`;
      }

      const kind = report.failed.length ? 'err' : todo.length ? 'warn' : 'ok';
      return { kind, text };
    },
  };

  /* For the harness: the drivers, so each can be checked on its own. */
  AF.sites.workday.experience = {
    sectionRoot, entryIds, fillText, chooseFromListbox, promptPick, promptLadder, setDate, addEntry,
  };
})();
