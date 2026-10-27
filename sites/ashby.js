/**
 * sites/ashby.js — Ashby (jobs.ashbyhq.com), a single-page application form.
 *
 * One page, one Fill button: the adapter reads every question on the form and
 * answers it from the profile and learned answers, the way the Workday question
 * pages do. The final submit is only ever pressed by the user, from the widget.
 *
 * Fill never presses Ashby's submit button and never touches a file input or
 * the autofill uploader: the résumé is attached by the user.
 */
(() => {
  const SUBMIT = 'button.ashby-application-form-submit-button';

  /** The company is the text after the last " @ " in the tab title
   *  ("Software Engineer @ OpenAI"), else the board slug — the first path
   *  segment of jobs.ashbyhq.com/<slug>/<job>. null when neither says. */
  function companyFrom(title, pathname) {
    const t = String(title ?? '');
    const at = t.lastIndexOf(' @ ');
    const fromTitle = at >= 0 ? t.slice(at + 3).trim() : '';
    if (fromTitle) return fromTitle;
    const slug = String(pathname ?? '').split('/').filter(Boolean)[0];
    if (!slug) return null;
    try {
      return decodeURIComponent(slug).trim() || null;
    } catch {
      return slug;
    }
  }

  /* ------------------------------------------------------------------ */
  /* reading the form                                                   */
  /* ------------------------------------------------------------------ */

  const UPLOADER = '.ashby-application-form-autofill-uploader';
  // The reCAPTCHA response textarea is never a question, even inside a field wrap.
  const TEXT_INPUT = 'textarea:not([name="g-recaptcha-response"]):not(.g-recaptcha-response), input[type="text"], input[type="email"], input[type="tel"], input[type="url"]';
  const clean = (s) => AF.questions.cleanQuestion(s);

  /** The visible label of one radio or checkbox: its label[for], else the
   *  label that wraps it (Patreon's consent radios). */
  function optionLabel(input) {
    const byFor = input.id
      ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
    return clean((byFor ?? input.closest('label'))?.textContent);
  }

  /** The widget a [data-field-path] element holds, first match wins; null for
   *  anything this adapter does not fill. */
  function widgetOf(wrap) {
    if (wrap.querySelector('input[type="file"]')) return 'file';
    if (wrap.querySelector('.ashby-application-form-input-yesno')) return 'yesno';
    if (wrap.querySelector('input[role="combobox"]')) return 'location';
    if (wrap.querySelector('.ashby-application-form-input-date')) return 'date';
    if (wrap.querySelector('.ashby-application-form-input-radio-group')) return 'choice';
    if (wrap.querySelector('.ashby-application-form-input-checkbox-group')) {
      return wrap.querySelectorAll('input[type="checkbox"]').length > 1 ? 'choice' : 'checkbox';
    }
    if (wrap.querySelector(TEXT_INPUT)) return 'text';
    return null;
  }

  /** Every question on the page, in page order, across the application and
   *  the survey (EEO) containers. */
  function readFields() {
    const fields = [];
    for (const wrap of document.querySelectorAll('[data-field-path]')) {
      if (wrap.closest(UPLOADER)) continue;
      const widget = widgetOf(wrap);
      if (!widget) continue;
      const titleEl = wrap.querySelector('.ashby-application-form-question-title');
      let question = clean(titleEl?.textContent);
      if (widget === 'checkbox') {
        // A lone checkbox's statement is its option label ("I acknowledge...").
        question = clean(`${question} ${optionLabel(wrap.querySelector('input[type="checkbox"]'))}`);
      }
      const required = !!titleEl?.matches('[class*="_required_"]') || !!wrap.querySelector(`${TEXT_INPUT}, input[type="file"]`)?.required;
      fields.push({ wrap, fieldId: wrap.getAttribute('data-field-path'), question, widget, required });

      // Patreon's text-message consent radios sit inside the phone entry.
      const consent = [...wrap.querySelectorAll('input[type="radio"][name="communicationConsent"]')];
      if (consent.length) {
        const first = optionLabel(consent[0]).replace(/^(yes|no)\s*[-:]\s*/i, '');
        fields.push({ wrap: (consent[0].closest('label') ?? consent[0]).parentElement, fieldId: 'communicationConsent',
                      question: first, widget: 'choice', required: false });
      }
    }
    return fields;
  }

  /** What the field shows now; '' when unanswered. */
  function currentValue(field) {
    const { wrap, widget } = field;
    switch (widget) {
      case 'file':
        return clean(wrap.querySelector('.ashby-application-form-input-file-item-name')?.textContent);
      case 'yesno': {
        const on = wrap.querySelector('.ashby-application-form-input-yesno-option[aria-pressed="true"]');
        return on ? clean(on.textContent) : '';
      }
      case 'choice':
      case 'checkbox':
        return [...wrap.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')]
          .map(optionLabel).join(', ');
      default:
        return wrap.querySelector(`input[role="combobox"], .ashby-application-form-input-date, ${TEXT_INPUT}`)?.value ?? '';
    }
  }

  /* ------------------------------------------------------------------ */
  /* filling                                                            */
  /* ------------------------------------------------------------------ */

  const Q = AF.questions;
  const clip = (s) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const norm = (s) => AF.normalizeText(s);

  /* Standard fields come from the profile and replace a differing value. Each
   * row matches only text inputs (the location row only the location widget),
   * so a yes/no "May we email you?" is never handed an address. */
  const STANDARD = [
    { widget: 'text', test: (f) => f.fieldId === '_systemfield_name' || /^(full |legal )?name$/i.test(f.question),
      value: (p) => [p.firstName, p.lastName].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ') },
    { widget: 'text', test: (f) => /first name|^preferred name$/i.test(f.question), value: (p) => p.firstName },
    { widget: 'text', test: (f) => /last name|surname/i.test(f.question), value: (p) => p.lastName },
    { widget: 'text', test: (f) => f.fieldId === '_systemfield_email' || /^e-?mail( address)?$/i.test(f.question), value: (p) => p.email },
    { widget: 'text', test: (f) => !!f.wrap.querySelector('input[type="tel"]') || /^((mobile|cell) )?phone( number)?$/i.test(f.question), value: (p) => p.phone },
    { widget: 'text', test: (f) => /^linkedin( (profile|url))?( url)?$/i.test(f.question), value: (p) => p.websites?.linkedin },
    { widget: 'text', test: (f) => /^github( (profile|url))?$/i.test(f.question), value: (p) => p.websites?.github },
    { widget: 'text', test: (f) => /^(personal )?(website|portfolio|site)( ?\/ ?(website|portfolio))?( url)?$/i.test(f.question), value: (p) => p.websites?.portfolio },
    { widget: 'location', test: (f) => f.fieldId === '_systemfield_location' || /^(current )?location$|where are you (currently )?(located|based)|city/i.test(f.question),
      value: (p) => [p.city, p.state].map((x) => String(x ?? '').trim()).filter(Boolean).join(', ') },
  ];

  /* Answers from a field the user set — the only ones allowed to replace what
   * is on the page (the same rule as sites/workday-questions.js). A default No,
   * a follow-up N/A, a sign-off or a remembered answer never overrides a hand
   * answer. */
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

  /** The radios or checkboxes of a choice/checkbox field, with their labels. */
  function choices(wrap) {
    return [...wrap.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
      .map((input) => ({ input, label: optionLabel(input) }));
  }

  /** Click one option the way a person does: its label, else the input. */
  function clickOption(input) {
    const label = (input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null) ?? input.closest('label');
    (label ?? input).click();
  }

  async function fillYesNo(f, decision, label, report) {
    const i = Q.pickOption(['Yes', 'No'], decision);
    if (i < 0) {
      if (f.required) report.left.push(`${label} — "${decision.answer}" is not Yes or No`);
      return false;
    }
    const button = f.wrap.querySelector(`button[data-option="${i === 0 ? 'yes' : 'no'}"]`);
    button?.click();
    if (!(await AF.waitFor(() => button?.getAttribute('aria-pressed') === 'true', 1000))) {
      report.failed.push(`${label} — the button did not take`);
      return false;
    }
    return true;
  }

  async function fillChoice(f, decision, label, report) {
    const list = choices(f.wrap);
    const i = Q.pickOption(list.map((c) => c.label), decision);
    if (i < 0) {
      if (f.required) report.left.push(`${label} — "${decision.answer}" is not one of the options`);
      return false;
    }
    clickOption(list[i].input);
    if (!(await AF.waitFor(() => list[i].input.checked, 1000))) {
      report.failed.push(`${label} — "${list[i].label}" did not take`);
      return false;
    }
    return true;
  }

  /** A date input is a React date picker: type the date, Enter commits it. */
  async function fillDate(f, decision, label, report) {
    const input = f.wrap.querySelector('.ashby-application-form-input-date');
    AF.setNativeValue(input, decision.answer, { blur: false });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.blur();
    await new Promise((r) => setTimeout(r, 50));
    if (input.value !== decision.answer) {
      report.failed.push(`${label} — the date did not stay`);
      return false;
    }
    return true;
  }

  /** The listbox a combobox controls, else the nearest one around it. */
  function listboxFor(input, wrap) {
    const id = input.getAttribute('aria-controls');
    const byId = id ? document.getElementById(id) : null;
    if (byId) return byId;
    for (let el = input.parentElement; el; el = el.parentElement) {
      const box = el.querySelector('[role="listbox"]');
      if (box) return box;
      if (el === wrap) break;
    }
    return null;
  }

  /** Type the city, wait for the typeahead, take the first option that names it. */
  async function fillLocation(f, text, report) {
    const input = f.wrap.querySelector('input[role="combobox"]');
    const city = norm(text.split(',')[0]);
    AF.setNativeValue(input, text, { blur: false });
    const option = await AF.waitFor(() => {
      const box = listboxFor(input, f.wrap);
      return [...(box?.querySelectorAll('[role="option"]') ?? [])].find((o) => norm(o.textContent).includes(city));
    }, 3000);
    if (option) {
      option.click();
      if (await AF.waitFor(() => input.value && input.getAttribute('aria-expanded') !== 'true', 1000)) return true;
    }
    AF.setNativeValue(input, '', { blur: false });
    report.left.push('Location — pick it yourself');
    return false;
  }

  /** Put one answer on the page → true when it took (reported otherwise). */
  function drive(f, text, decision, label, report) {
    switch (f.widget) {
      case 'text': {
        const input = f.wrap.querySelector(TEXT_INPUT);
        if (AF.setNativeValue(input, text)) return true;
        report.failed.push(`${label} — the page rejected the write`);
        return false;
      }
      case 'location': return fillLocation(f, text, report);
      case 'yesno': return fillYesNo(f, decision, label, report);
      case 'choice':
      case 'checkbox': return fillChoice(f, decision, label, report);
      case 'date': return fillDate(f, decision, label, report);
    }
    return false;
  }

  /**
   * Answer every question on the page.
   *
   * Left alone: a field already answered, unless the answer comes from the
   * profile (standard fields, or a rule fromProfile accepts); a ticked box or
   * chosen option is never changed. A question that cannot be answered is listed
   * only if required.
   */
  async function fillPage({ profile }) {
    const report = { section: 'Application', filled: [], replaced: [], already: [], kept: [],
                     left: [], failed: [], signed: [], added: 0, note: '' };
    const fields = readFields();
    if (!fields.length) {
      report.note = 'no questions found on this page';
      return report;
    }
    const ctx = { profile, learned: await loadAnswers(), company: AF.currentCompany(), selfId: true, today: new Date() };

    let previous = null;
    for (const f of fields) {
      const label = clip(Q.questionCore(f.question));
      const current = currentValue(f);

      if (f.widget === 'file') {
        if (!current) report.left.push(`${label} — attach it yourself`);
        continue;
      }

      const row = STANDARD.find((r) => r.widget === f.widget && r.test(f));
      let done = false;
      if (row) {
        const value = String(row.value(profile) ?? '').trim();
        if (!value) {
          if (current) report.already.push(label);
          else if (f.required) report.left.push(`${label} — not in your profile`);
        /* A set location is never replaced: the typeahead rewrites the text
         * ("Testville, ZZ, USA"), so a differing value would be replaced forever. */
        } else if (current === value || (f.widget === 'location' && current)) {
          report.already.push(label);
        } else if (await drive(f, value, null, label, report)) {
          report.filled.push(label);
          if (current) report.replaced.push(`${label} ("${current}")`);
          done = true;
        }
        previous = (done ? value : current) || null;
        continue;
      }

      const decision = Q.resolve(f.question, { ...ctx, previous, widget: f.widget === 'yesno' ? 'choice' : f.widget, fieldId: f.fieldId });
      if (!decision.answer) {
        if (current) report.already.push(label);
        else if (f.required) report.left.push(`${label} — ${decision.reason}`);
      } else if (current && (current === decision.answer || !fromProfile(decision, profile) ||
                 ['yesno', 'choice', 'checkbox'].includes(f.widget))) {
        report.already.push(label);
      } else if (await drive(f, decision.answer, decision, label, report)) {
        done = true;
        if (decision.source === 'sign-off') report.signed.push(label);
        else report.filled.push(label);
        if (current) report.replaced.push(`${label} ("${current}")`);
      }
      previous = (done ? decision.answer : current) || null;
    }
    return report;
  }

  /** The page's answers as the user leaves it, for remember() at Submit. Not
   *  standard fields, files, dates or locations: those are the profile's. */
  function readAnswers() {
    return readFields()
      .filter((f) => !['file', 'date', 'location'].includes(f.widget) &&
        !(f.widget === 'text' && STANDARD.some((r) => r.widget === 'text' && r.test(f))))
      .map((f) => ({ question: f.question, answer: currentValue(f), widget: f.widget === 'yesno' ? 'choice' : f.widget, fieldId: f.fieldId }))
      .filter((a) => a.answer);
  }

  AF.sites.ashby = {
    id: 'ashby',
    label: 'Ashby',
    hostMatch: /^jobs\.ashbyhq\.com$/i,
    company: () => companyFrom(document.title, location.pathname),
    companyFrom,
    form: { readFields, currentValue, fillPage, readAnswers },

    pages: {
      application: {
        label: 'Application',
        detectSelector: SUBMIT,
        fields: {},
        selfId: true,
        manualSubmit: SUBMIT,
        submitLabel: 'Submit application',
        hint: 'Press Fill, attach your résumé, check the page, then Submit application.',
        sections: {
          application: { label: 'Fill', fill: (c) => fillPage(c), present: () => true },
        },
        describe: (report) => AF.describeReport(report),
        readAnswers,
      },
    },
  };
})();
