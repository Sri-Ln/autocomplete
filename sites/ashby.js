/**
 * sites/ashby.js — Ashby (jobs.ashbyhq.com), a single-page application form.
 *
 * One page, one Fill button: the adapter reads every question on the form and
 * answers it from the profile and learned answers, the way the Workday question
 * pages do. The final submit is only ever pressed by the user, from the widget.
 *
 * Reading the form and filling it are added in later steps; until then the
 * page reports nothing filled and learns nothing.
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
  const TEXT_INPUT = 'textarea, input[type="text"], input[type="email"], input[type="tel"], input[type="url"]';
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
        fields.push({ wrap: consent[0].closest('label').parentElement, fieldId: 'communicationConsent',
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

  async function fillPage() {
    return { section: 'Application', filled: [], replaced: [], already: [], kept: [], left: [],
             failed: [], signed: [], added: 0, note: '' };
  }

  function readAnswers() {
    return [];
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
