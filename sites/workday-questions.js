/**
 * sites/workday-questions.js — the apply flow's question pages:
 * Application Questions, Voluntary Disclosures and Self Identify.
 *
 * Reads every form field into { question, widget, fieldId }, asks
 * AF.questions.resolve what to answer, and drives the widget with the My
 * Experience drivers. What a question MEANS is decided only in
 * content/questions.js; nothing here knows.
 *
 * Spec: docs/superpowers/specs/2026-10-12-application-questions-design.md
 */
(() => {
  const W = AF.sites.workday;
  const Q = AF.questions;
  const D = () => W.experience; // the drivers, exported by workday-experience.js

  const PAGES = {
    applicationQuestions: { label: 'Application Questions', id: 'applyFlowPrimaryQuestionsPage' },
    voluntaryDisclosures: { label: 'Voluntary Disclosures', id: 'applyFlowVoluntaryDisclosuresPage' },
    selfIdentify: { label: 'Self Identify', id: 'applyFlowSelfIdentifyPage' },
  };

  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const clip = (s) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const pageRoot = (key) => document.querySelector(`[data-automation-id="${PAGES[key].id}"]`);

  /** The question a field asks: its rich-text legend (Application Questions),
   *  its legend, or its label (the disclosure pages). Marker asterisk dropped. */
  function questionOf(wrap) {
    const legend = wrap.querySelector(':scope > fieldset > legend');
    const node = legend?.querySelector('[data-automation-id="richText"]') ?? legend ??
      wrap.querySelector(':scope > label');
    return Q.cleanQuestion(squash(node?.textContent));
  }

  /** Which driver a field needs. A listbox also carries a hidden text input,
   *  so it is recognised before plain text. */
  function widgetOf(wrap) {
    if (wrap.querySelector('[data-automation-id="dateInputWrapper"]')) return 'date';
    if (wrap.querySelector('button[aria-haspopup="listbox"]')) return 'listbox';
    if (wrap.querySelector('[data-automation-id="multiSelectContainer"]')) return 'prompt';
    const boxes = wrap.querySelectorAll('input[type="checkbox"], input[type="radio"]').length;
    if (boxes > 1) return 'choice';
    if (boxes === 1) return 'checkbox';
    if (wrap.querySelector('textarea, input[type="text"]')) return 'text';
    return null;
  }

  const isRequired = (wrap) => !!wrap.querySelector('[aria-required="true"], abbr');

  function choices(wrap) {
    return [...wrap.querySelectorAll('input[type="checkbox"], input[type="radio"]')].map((input) => ({
      input,
      label: squash(
        (input.id && wrap.querySelector(`label[for="${CSS.escape(input.id)}"]`))?.textContent ??
        input.closest('label')?.textContent
      ),
    }));
  }

  function dateValue(wrap) {
    const n = (name) => parseInt(
      wrap.querySelector(`[data-automation-id="dateSection${name}-input"]`)?.getAttribute('aria-valuenow') ?? '', 10);
    const [m, d, y] = ['Month', 'Day', 'Year'].map(n);
    return [m, d, y].every(Number.isFinite)
      ? `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
      : '';
  }

  /** What a field holds now, as text — '' when unanswered. */
  function currentValue(f) {
    switch (f.widget) {
      case 'listbox': return W.currentValue(f.wrap);
      case 'text': return squash(f.wrap.querySelector('textarea, input[type="text"]')?.value);
      case 'checkbox': return f.wrap.querySelector('input[type="checkbox"]')?.checked ? 'Yes' : '';
      case 'choice': return choices(f.wrap).find((c) => c.input.checked)?.label ?? '';
      case 'date': return dateValue(f.wrap);
      default: return '';
    }
  }

  function readFields(key) {
    const root = pageRoot(key);
    if (!root) return [];
    return [...root.querySelectorAll('[data-automation-id^="formField-"]')]
      .map((wrap) => ({
        wrap,
        fieldId: wrap.getAttribute('data-automation-id').slice('formField-'.length),
        question: questionOf(wrap),
        widget: widgetOf(wrap),
      }))
      .filter((f) => f.question && f.widget && f.widget !== 'prompt');
  }

  /** Put one decision on the page. → 'filled' | 'already' | null (reported). */
  async function fillField(f, decision, label, report) {
    switch (f.widget) {
      case 'listbox': {
        const res = await D().chooseFromListbox(f.wrap, (texts) => {
          const i = Q.pickOption(texts, decision);
          return i >= 0
            ? { ok: true, index: i, text: texts[i] }
            : { ok: false, reason: Q.optionReason(decision) };
        });
        if (res.already) { report.already.push(label); return 'already'; }
        if (!res.ok) { report.left.push(`${label} — ${res.reason}`); return null; }
        report.filled.push(label);
        if (res.was) report.replaced.push(`${label} ("${res.was}")`);
        return 'filled';
      }
      case 'text': {
        const before = report.filled.length;
        D().fillText(f.wrap, decision.answer, label, report);
        return report.filled.length > before ? 'filled' : null;
      }
      case 'checkbox': {
        const box = f.wrap.querySelector('input[type="checkbox"]');
        if (decision.answer !== 'Yes') { report.left.push(`${label} — "${decision.answer}" is not a tick`); return null; }
        box.click();
        if (!(await AF.waitFor(() => box.checked, 1000))) {
          report.failed.push(`${label} — the box did not tick`);
          return null;
        }
        report.filled.push(label);
        return 'filled';
      }
      case 'choice': {
        const list = choices(f.wrap);
        const i = Q.pickOption(list.map((c) => c.label), decision);
        if (i < 0) { report.left.push(`${label} — ${Q.optionReason(decision)}`); return null; }
        list[i].input.click();
        if (!(await AF.waitFor(() => list[i].input.checked, 1000))) {
          report.failed.push(`${label} — "${list[i].label}" did not take`);
          return null;
        }
        report.filled.push(label);
        return 'filled';
      }
      case 'date': {
        const before = report.filled.length;
        await D().setDate(f.wrap, decision.answer, label, report);
        return report.filled.length > before ? 'filled' : null;
      }
    }
    return null;
  }

  /* Answers read from a field the user set — the only ones allowed to replace
   * what is already on the page. A default No, a follow-up N/A, a sign-off or
   * a remembered answer never overrides a hand answer. */
  /* Each rule's profile field — the answer counts as the user's only when that
   * field is set (sponsorship and over-18 have defaults when it is not). */
  const PROFILE_RULES = {
    workAuthorization: 'workAuthorized',
    sponsorship: ['needsSponsorshipNow', 'needsSponsorshipFuture', 'needsSponsorship'],
    over18: 'over18', formerEmployee: 'employers',
  };
  const isSet = (v) => (Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== '');
  const fromProfile = (d, profile) =>
    d.source === 'preference' || d.source === 'self-id' ||
    (d.source === 'derived' && d.rule in PROFILE_RULES &&
      [].concat(PROFILE_RULES[d.rule]).some((k) => isSet(profile?.[k])));

  async function loadAnswers() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getAnswers' });
      return res?.ok ? res.answers ?? {} : {};
    } catch {
      return {};
    }
  }

  /**
   * Answer every field on the page.
   *
   * Left alone: a field already answered, unless the answer comes from a
   * profile field (fromProfile), and any checkbox or check-group already
   * ticked — a hand answer wins over defaults and memory, and a tick cannot
   * be safely untaken. An unanswerable field
   * goes under "Needs you" only if it is required.
   */
  async function fillPage(key, { profile }) {
    const report = { section: PAGES[key].label, filled: [], replaced: [], already: [], kept: [],
                     left: [], failed: [], signed: [], added: 0, note: '' };
    const fields = readFields(key);
    if (!fields.length) {
      report.note = 'no questions found on this page';
      return report;
    }
    const ctx = { profile, learned: await loadAnswers(), page: key,
                  company: AF.tenantFromHostname(), today: new Date() };

    let previous = null;
    for (const f of fields) {
      const label = clip(Q.questionCore(f.question)); // the question, not its preamble
      const current = currentValue(f);
      const decision = Q.resolve(f.question, { ...ctx, previous, widget: f.widget, fieldId: f.fieldId });

      let outcome = null;
      if (!decision.answer) {
        if (current) report.already.push(label);
        else if (isRequired(f.wrap)) report.left.push(`${label} — ${decision.reason}`);
      } else if (current && (!fromProfile(decision, profile) || f.widget === 'choice' || f.widget === 'checkbox')) {
        report.already.push(label);
      } else {
        outcome = await fillField(f, decision, label, report);
        if (outcome === 'filled' && decision.source === 'sign-off') {
          report.filled.pop();
          report.signed.push(label);
        }
      }
      previous = (outcome ? decision.answer : current) || null;
    }
    /* Let the last dropdown finish closing first, so closePopup finds nothing
     * open and sends no Escape — which would undo the last answer. Then check
     * every answer we reported filled is still there. */
    await new Promise((r) => setTimeout(r, 300));
    await W.closePopup();
    for (const f of fields) {
      const label = clip(Q.questionCore(f.question));
      if (f.widget === 'listbox' && report.filled.includes(label) && !currentValue(f)) {
        report.filled.splice(report.filled.indexOf(label), 1);
        report.failed.push(`${label} — the answer did not stay`);
      }
    }
    return report;
  }

  /** The page's answers as the user leaves it, for remember() at Submit. */
  function readAnswers(key) {
    return readFields(key)
      .map((f) => ({ question: f.question, answer: currentValue(f), widget: f.widget, fieldId: f.fieldId }))
      .filter((a) => a.answer && a.widget !== 'date');
  }

  for (const [key, { label, id }] of Object.entries(PAGES)) {
    W.pages[key] = {
      label,
      detectSelector: `[data-automation-id="${id}"]`,
      fields: {},
      manualSubmit: '[data-automation-id="pageFooterNextButton"]',
      sections: {
        questions: { label: 'Fill questions', fill: (c) => fillPage(key, c), present: () => true },
      },
      describe: (report) => W.pages.myExperience.describe(report),
      readAnswers: () => readAnswers(key),
    };
  }

  /* For the harness. */
  W.questionPages = { readFields, currentValue, fillPage, readAnswers };
})();
