/**
 * main.js — the orchestrator. Loads last; everything else is already on AF.
 *
 * Responsibilities, in order:
 *   1. Work out which site/page we're on (registry.js).
 *   2. Mount the floating widget and keep it in sync as the SPA navigates.
 *   3. On click: unlock if needed → fill → run guards → submit.
 *
 * Deliberately NOT here: any Workday-specific selector (those live in
 * sites/workday.js) and any crypto (that lives in the service worker).
 */

(() => {
  /* ---------------------------------------------------------------- */
  /* state                                                            */
  /* ---------------------------------------------------------------- */

  let ctx = { site: null, page: null, pageKey: null, placeholders: null };
  let status = { configured: false, unlocked: false };
  let busy = false;
  let awaitingSubmitConfirm = false; // two-step mode: filled, waiting for click #2
  let lastMessage = null;

  /** Unanswered free-text visa questions on screen. Drives the widget's action
   *  on pages the registry does not recognise — which is where they live. */
  let visaPending = 0;

  /**
   * Every message in one place, and never allowed to throw.
   *
   * `chrome.runtime.sendMessage` rejects outright once the extension is
   * reloaded from chrome://extensions while an old tab is still open — the
   * classic "Extension context invalidated". Without this the widget would
   * die silently on every reload during development.
   */
  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      AF.log('sendMessage failed', err);
      contextLost = true;
      return null;
    }
  }

  let contextLost = false;

  /* ---------------------------------------------------------------- */
  /* the visa explanation                                             */
  /* ---------------------------------------------------------------- */

  /**
   * The profile, cached.
   *
   * Note this goes through `getProfile`, not `getFillData` — the profile is
   * stored in plain text and needs no key, so the pill works while the
   * extension is still locked. There is no password anywhere near this path.
   *
   * The popup broadcasts `profileChanged` on save, which clears the cache; that
   * is the only way this can go stale, since nothing else writes the profile.
   */
  let profileCache = null;

  async function profile() {
    if (profileCache) return profileCache;
    const res = await send({ type: 'getProfile' });
    if (res?.ok) profileCache = res.profile;
    return profileCache;
  }

  /** The saved text, or null with a reason the user can act on. */
  async function visaText() {
    return AF.questions.visaExplanationFor((await profile()) ?? {});
  }

  /** Visa questions on screen that are still blank. */
  function pendingVisaFields() {
    try {
      return AF.freeText.findVisaQuestions().filter((q) => !q.filled);
    } catch (err) {
      AF.log('findVisaQuestions threw', err);
      return [];
    }
  }

  /**
   * Offer the pill on a field, if it is a visa question we can answer.
   *
   * Every exit is a hide, so the pill can never be left pointing at a field the
   * user has moved away from.
   */
  async function offerOn(el) {
    if (!AF.freeText.acceptsLongText(el)) return AF.pill.hide();

    const question = AF.freeText.questionFor(el);
    if (!AF.questions.wantsVisaExplanation(question)) return AF.pill.hide();

    const { text } = await visaText();

    /* The await above is a round trip to the service worker, which can take
     * long enough for focus to have moved on. Offering on a field the user has
     * left would plant a pill under an unrelated box. */
    if (document.activeElement !== el || !el.isConnected) return;

    if (!text) {
      return AF.pill.show(el, {
        label: 'No visa explanation saved — add one in the popup',
        state: 'warn',
      });
    }

    // Already answered: their text wins, and nagging over it would be noise.
    if (el.value.trim()) return AF.pill.hide();

    AF.pill.show(el, { label: 'Insert my visa status explanation' });
  }

  /** The click. This is the only thing that ever writes the explanation. */
  async function acceptPill(el) {
    const { text, reason } = await visaText();
    if (!text) return AF.pill.show(el, { label: reason, state: 'warn' });

    const res = AF.freeText.fill(el, text);

    if (!res.ok) return AF.pill.show(el, { label: res.reason, state: 'warn' });

    AF.pill.show(el, { label: 'Inserted — review it before you continue', state: 'done' });
    setTimeout(() => {
      if (AF.pill.currentTarget() === el) AF.pill.hide();
    }, 2600);

    visaPending = pendingVisaFields().length;
    paint();
  }

  /**
   * Fill every visa question on the page at once, from the widget.
   *
   * Fills and stops, deliberately. On a page the registry does not recognise
   * there is no `page.submit` and no `errorSelectors`, so AF.runGuards() cannot
   * run — no CAPTCHA check, no empty-required-field check, no validation-error
   * check. Clicking Continue here would be the one submit in the extension with
   * no safety scan behind it, on a page full of other questions we know nothing
   * about. So the user reviews and continues by hand.
   */
  async function fillVisaFields() {
    const { text, reason } = await visaText();
    if (!text) return say('warn', reason);

    const fields = pendingVisaFields();
    if (!fields.length) return say('info', 'No unanswered visa questions on this page.');

    const failed = [];
    let done = 0;
    for (const f of fields) {
      const res = AF.freeText.fill(f.el, text);
      if (res.ok) done++;
      else failed.push(`"${f.question.slice(0, 40)}" — ${res.reason}`);
    }

    visaPending = pendingVisaFields().length;

    if (!done) return say('err', `Could not fill: ${failed.join(' · ')}`);
    say(
      failed.length ? 'warn' : 'ok',
      `Filled ${done} visa question(s). Review, then click Continue yourself — ` +
        `this page has no safety checks configured, so nothing is submitted for you.` +
        (failed.length ? ` Skipped: ${failed.join(' · ')}` : '')
    );
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                        */
  /* ---------------------------------------------------------------- */

  function paint() {
    if (!AF.widget.isMounted()) return;

    const siteLabel = ctx.site?.label ?? 'Unknown site';
    const pageLabel = ctx.page?.label ?? null;

    const context = pageLabel
      ? `<b>${siteLabel}</b> · ${pageLabel}${ctx.forced ? ' (forced)' : ''}`
      : `<b>${siteLabel}</b> · no recognised form on this page`;

    /* Fresh install: nothing is set up yet. */
    if (!status.configured) {
      return AF.widget.render({
        context,
        tone: 'warn',
        actionLabel: null,
        message: {
          kind: 'warn',
          text: 'Not set up yet. Open the extension popup to create your passphrase and save your login.',
        },
      });
    }

    /* A visa question on a page we don't otherwise handle.
     *
     * Checked ahead of both the placeholder and locked branches, deliberately.
     * This path reads no selectors, so un-harvested ones cannot stop it; and
     * the explanation is plaintext profile data, so demanding a passphrase to
     * paste text the extension can already read would be theatre. */
    if (!ctx.page && visaPending > 0) {
      return AF.widget.render({
        context,
        tone: null,
        actionLabel: busy ? 'Working…' : `Fill visa answer${visaPending > 1 ? 's' : ''}`,
        disabled: busy,
        message: lastMessage ?? {
          kind: 'info',
          text:
            `${visaPending} visa question(s) here. This page isn't one the extension ` +
            `knows, so it fills only — you review and click Continue.`,
        },
      });
    }

    /* Selectors still un-harvested — the state this ships in. */
    const ph = ctx.placeholders;
    if (ph && ph.remaining === ph.total && ph.total > 0) {
      return AF.widget.render({
        context,
        tone: 'warn',
        actionLabel: null,
        message: {
          kind: 'warn',
          text: `All ${ph.total} selectors are still placeholders. Paste tools/harvest.js into the console, then fill in sites/workday.js.`,
        },
      });
    }

    /* Locked — one passphrase entry per Chrome session. */
    if (!status.unlocked) {
      return AF.widget.render({
        context,
        tone: 'warn',
        needsPass: true,
        focusPass: true,
        actionLabel: busy ? 'Unlocking…' : 'Unlock & Fill',
        disabled: busy,
        message: lastMessage,
      });
    }

    /* No form we recognise on screen. */
    if (!ctx.page) {
      return AF.widget.render({
        context,
        tone: null,
        actionLabel: null,
        message: lastMessage ?? {
          kind: 'info',
          text: 'Waiting for a Create Account or My Information form.',
        },
      });
    }

    AF.widget.render({
      context,
      tone: lastMessage?.kind === 'err' ? 'err' : lastMessage?.kind === 'ok' ? 'ok' : null,
      actionLabel: busy
        ? 'Working…'
        : awaitingSubmitConfirm
          ? 'Submit'
          : 'Fill & Submit',
      disabled: busy,
      message: lastMessage,
    });
  }

  function say(kind, text) {
    lastMessage = { kind, text };
    paint();
  }

  /* ---------------------------------------------------------------- */
  /* the click                                                        */
  /* ---------------------------------------------------------------- */

  async function onAction(passphrase) {
    if (busy) return;
    busy = true;
    paint();

    try {
      /* The visa path needs no key and no adapter, so it short-circuits ahead
       * of the unlock dance. See the branch of the same shape in paint(). */
      if (!ctx.page && visaPending > 0) {
        await fillVisaFields();
        return;
      }

      /* Our cached status can be stale — the popup may have unlocked since we
       * last looked. Re-check before demanding a passphrase we don't need.
       * This is also the path the popup's "Fill this page" takes, which sends
       * no passphrase at all. */
      if (!status.unlocked) {
        const fresh = await send({ type: 'status' });
        if (fresh) status = fresh;
      }

      if (!status.unlocked) {
        if (!passphrase) {
          busy = false;
          return say('err', 'Locked — enter your passphrase.');
        }

        const res = await send({ type: 'unlock', passphrase });
        if (!res?.ok) {
          busy = false;
          return say('err', res?.error ?? 'Unlock failed.');
        }
        status.unlocked = true;
        lastMessage = null;
      }

      if (awaitingSubmitConfirm) {
        await doSubmit();
      } else {
        await doFill();
      }
    } catch (err) {
      say('err', `Unexpected error: ${err?.message ?? err}`);
    } finally {
      busy = false;
      paint();
    }
  }

  /** Cached between the two clicks in two-step mode, so guards can re-check. */
  let lastRun = null;

  async function doFill() {
    if (!ctx.page) return say('info', 'No recognised form on this page.');

    const data = await send({ type: 'getFillData', hostname: location.hostname });

    if (!data?.ok) {
      const reasons = {
        NOT_CONFIGURED: 'Not set up. Open the popup first.',
        LOCKED: 'Locked — enter your passphrase.',
        NO_CREDENTIAL: 'No saved login. Add one in the popup (save it as the default so it works on every tenant).',
        DECRYPT_FAILED: 'Saved password could not be decrypted. Re-save it in the popup.',
      };
      if (data?.reason === 'LOCKED') status.unlocked = false;
      return say('err', reasons[data?.reason] ?? data?.error ?? 'Could not load your details.');
    }

    /* Build the value map. The adapter decides what goes where; we never
     * hardcode "email goes in the email field" outside the adapter. */
    const values = ctx.page.values({ profile: data.profile, credential: data.credential });

    // Never log a password, even with AF.debug on.
    AF.log('filling', ctx.pageKey, Object.keys(values));

    let report = AF.fillAll(ctx.page.fields, values, ctx.page.fieldTypes ?? {});

    /* Adapter-specific extras (Workday's popup listboxes, etc.). Wrapped so a
     * broken custom step still leaves the normal fields filled. */
    if (typeof ctx.page.customFill === 'function') {
      try {
        // Called on the page object so `this.pickers` resolves, and given the
        // full context because pickers read the profile directly.
        report =
          (await ctx.page.customFill.call(ctx.page, values, report, {
            profile: data.profile,
            credential: data.credential,
          })) ?? report;
      } catch (err) {
        AF.log('customFill threw', err);
      }
    }

    /* Yes/No questions. Structural discovery, not selectors — application
     * questions are written per company, so there is no stable id to map.
     * Answers are computed from the profile where possible and recalled only
     * for questions that carry no employer-specific variable. */
    let questions = { answered: [], left: [], failed: [] };
    try {
      questions = AF.answerQuestions({
        profile: data.profile,
        answers: data.answers ?? {},
      });
    } catch (err) {
      AF.log('answerQuestions threw', err);
    }

    lastRun = { values, report, questions };

    const autoSubmit = data.settings?.autoSubmit !== false;
    const summary = AF.summarize(report);
    const via = data.source === 'override' ? ' (host-specific login)' : '';

    const qNote = describeQuestions(questions);

    if (!autoSubmit) {
      awaitingSubmitConfirm = true;
      return say('info', `${summary}${via}${qNote}. Review, then click Submit.`);
    }

    say('info', `${summary}${via}${qNote}. Checking before submit…`);
    await doSubmit();
  }

  /**
   * Record the Yes/No answers currently on the page.
   *
   * This is the entire "learning" mechanism: an accumulating lookup table, no
   * model and no inference. A question answered once is answered for good —
   * but only if it carries no employer-specific variable, which
   * AF.questions.remember enforces.
   */
  async function captureAnswersNow() {
    try {
      const current = await send({ type: 'getAnswers' });
      if (!current?.ok) return;

      const { learned, stored } = AF.captureAnswers(current.answers ?? {});
      if (!stored.length) return;

      await send({ type: 'saveAnswers', answers: learned });
      AF.log('learned', stored.length, 'answer(s)');
    } catch (err) {
      AF.log('captureAnswers failed', err);
    }
  }

  /** One clause about the Yes/No questions, or nothing if there were none. */
  function describeQuestions(q) {
    const parts = [];
    if (q.answered.length) parts.push(`${q.answered.length} question(s) answered`);
    if (q.left.length) parts.push(`${q.left.length} left for you`);
    if (q.failed.length) parts.push(`${q.failed.length} question(s) failed`);
    return parts.length ? ` · ${parts.join(', ')}` : '';
  }

  async function doSubmit() {
    if (!lastRun) return say('err', 'Nothing filled yet.');

    /* Give React a beat to finish re-rendering after the last write, otherwise
     * we can read a stale disabled-state off the submit button. */
    await new Promise((r) => setTimeout(r, 250));

    /* A dropdown we could not set is a hard stop. allFieldsLanded() only reads
     * text inputs, so without this a failed "How Did You Hear About Us?" would
     * sail through and submit the form with a required question unanswered. */
    const pickerFailures = (lastRun.report?.failed ?? []).filter(
      (key) => ctx.page.pickers && key in ctx.page.pickers
    );
    if (pickerFailures.length) {
      awaitingSubmitConfirm = false;
      const detail = pickerFailures
        .map((k) => lastRun.report.reasons?.[k] ?? k)
        .join(' · ');
      return say('warn', `Not submitting — ${detail}`);
    }

    /* An unanswered question is a hard stop, always — even with autoSubmit on.
     *
     * These are declarations about you. Submitting with one blank is either a
     * validation error or, worse, an application that goes out saying nothing
     * where it should have said something. The widget lists each question and
     * why it was left, so the next click is informed. */
    const unanswered = lastRun.questions?.left ?? [];
    if (unanswered.length) {
      awaitingSubmitConfirm = false;
      const detail = unanswered
        .slice(0, 3)
        .map((q) => `"${q.question}" (${q.reason})`)
        .join(' · ');
      const more = unanswered.length > 3 ? ` …and ${unanswered.length - 3} more` : '';
      return say('warn', `Not submitting — answer these yourself: ${detail}${more}`);
    }

    const reason = AF.runGuards({
      fieldMap: ctx.page.fields,
      values: lastRun.values,
      submitSelector: ctx.page.submit,
      errorSelectors: ctx.page.errorSelectors ?? [],
      optionalFields: ctx.page.optionalFields ?? [],
      extraKnownSelectors: Object.values(ctx.page.pickers ?? {}).map((p) => p.selector),
    });

    if (reason) {
      awaitingSubmitConfirm = false;
      return say('warn', reason);
    }

    /* Learn from whatever you answered by hand before submitting. Done at
     * submit rather than on every click, because that is the moment the answers
     * are final. remember() refuses anything employer-specific, so a "No" for
     * one company can never be served to another. */
    await captureAnswersNow();

    const btn = document.querySelector(ctx.page.submit);
    btn.click();

    awaitingSubmitConfirm = false;
    lastRun = null;
    say('ok', 'Submitted — waiting for the next step…');

    /* Follow through, rather than declaring victory at the click.
     *
     * Two things can happen. Workday advances to a new view, in which case the
     * MutationObserver fires, refresh() sees a new page key and repaints — we
     * do nothing here. Or it stays put and renders a server-side error (email
     * already registered, password rejected), which nothing else would ever
     * surface, leaving the widget claiming success over a failed submit. */
    const submittedFrom = ctx.pageKey;
    setTimeout(() => {
      const now = AF.resolveContext();
      if (now.pageKey !== submittedFrom) return; // moved on; refresh() has it

      const err = AF.guards.validationErrors(ctx.page?.errorSelectors ?? []);
      if (err) {
        say('err', err.replace(/^Not submitting — /, 'Submit rejected: '));
      } else {
        say('ok', 'Submitted. Still on the same form — check the page.');
      }
    }, 2500);
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /** Set once the user has turned the widget off, so we stop re-evaluating. */
  let widgetSuppressed = false;

  async function refresh() {
    if (contextLost) return; // extension was reloaded; this tab needs a refresh

    const next = AF.resolveContext();

    /* Not a site we handle at all — don't put a widget on the page. */
    if (!next.site) {
      if (AF.widget.isMounted()) AF.widget.destroy();
      AF.pill.destroy();
      return;
    }

    const pageChanged = next.pageKey !== ctx.pageKey;
    const firstRun = !AF.widget.isMounted() && !widgetSuppressed;

    /* The visa questions are the one thing we render that the page key does NOT
     * capture: they appear on pages the registry returns null for, so pageKey
     * stays null from the first render to the last. Without counting them here,
     * a textarea that React mounts a second after the page does would never
     * reach the widget. */
    const nextVisa = next.page ? 0 : pendingVisaFields().length;
    const visaChanged = nextVisa !== visaPending;
    visaPending = nextVisa;

    /* Workday mutates its DOM constantly. Without this early return we'd fire a
     * status message every 300ms forever, which is both wasteful and enough to
     * keep the service worker from ever idling. Nothing we render depends on
     * anything but the page key and that count, so if neither has moved, there
     * is nothing to do. */
    if (!pageChanged && !firstRun && !busy && !visaChanged) return;

    if (pageChanged) {
      // A different form appeared → the previous fill's confirm no longer applies.
      awaitingSubmitConfirm = false;
      lastRun = null;
      lastMessage = null;
    }

    ctx = next;

    /* Status before mount, so "widget off" never flashes a widget on screen. */
    status = (await send({ type: 'status' })) ?? status;

    if (status.settings?.showWidget === false) {
      widgetSuppressed = true;
      if (AF.widget.isMounted()) AF.widget.destroy();
      return;
    }
    widgetSuppressed = false;

    if (!AF.widget.isMounted()) AF.widget.mount({ onAction });
    paint();
  }

  const refreshSoon = AF.debounce(refresh, 300);

  /* ---------------------------------------------------------------- */
  /* pill listeners                                                   */
  /* ---------------------------------------------------------------- */

  function watchFreeTextFields() {
    AF.pill.setAcceptHandler(acceptPill);

    /* focusin/focusout rather than focus/blur: those two don't bubble, and the
     * fields are mounted and replaced by React long after this runs, so a
     * delegated listener on the document is the only thing that keeps working. */
    document.addEventListener('focusin', (e) => offerOn(e.target));

    document.addEventListener('focusout', (e) => {
      /* Don't hide if focus is heading into the pill itself. It lives in a
       * shadow root, so relatedTarget reports as the host element. */
      if (e.relatedTarget?.id === 'af-pill-host') return;
      if (AF.pill.currentTarget() === e.target) AF.pill.hide();
    });

    /* The pill is absolutely positioned in document coordinates, so ordinary
     * scrolling carries it along for free. These cover the cases that actually
     * move the field relative to the document: a resize reflowing the form, and
     * scrolling inside a scrollable container (capture, because those events
     * don't bubble to window). */
    window.addEventListener('resize', () => AF.pill.reposition());
    window.addEventListener('scroll', () => AF.pill.reposition(), { capture: true, passive: true });
  }

  function start() {
    watchFreeTextFields();
    refresh();

    /* Workday is a single-page app: the Create Account form mounts without a
     * navigation event, so polling the DOM is the only reliable signal. The
     * observer is cheap because refresh() is debounced and does almost nothing
     * when the page key hasn't changed. */
    new MutationObserver(refreshSoon).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    /* SPA history navigations, for completeness. */
    window.addEventListener('popstate', refreshSoon);
    window.addEventListener('hashchange', refreshSoon);
  }

  /* "Fill this page" button in the popup routes through here. */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'fillNow') {
      onAction(null).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg?.type === 'profileChanged') {
      // The saved explanation just moved; the next pill must not offer the old one.
      profileCache = null;
      AF.pill.hide();
      return false;
    }
    if (msg?.type === 'settingsChanged') {
      // Clear the suppression flag so turning the widget back on takes effect
      // without a page reload, and force a repaint rather than a debounced one.
      widgetSuppressed = false;
      ctx = { site: null, page: null, pageKey: null, placeholders: null };
      refresh();
    }
    return false;
  });

  start();
})();
