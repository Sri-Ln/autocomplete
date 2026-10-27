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
