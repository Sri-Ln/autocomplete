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

    lastRun = { values, report };

    const autoSubmit = data.settings?.autoSubmit !== false;
    const summary = AF.summarize(report);
    const via = data.source === 'override' ? ' (host-specific login)' : '';

    if (!autoSubmit) {
      awaitingSubmitConfirm = true;
      return say('info', `${summary}${via}. Review, then click Submit.`);
    }

    say('info', `${summary}${via}. Checking before submit…`);
    await doSubmit();
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
      return;
    }

    const pageChanged = next.pageKey !== ctx.pageKey;
    const firstRun = !AF.widget.isMounted() && !widgetSuppressed;

    /* Workday mutates its DOM constantly. Without this early return we'd fire a
     * status message every 300ms forever, which is both wasteful and enough to
     * keep the service worker from ever idling. Nothing we render depends on
     * anything but the page key, so if that hasn't moved, there is nothing to do. */
    if (!pageChanged && !firstRun && !busy) return;

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

  function start() {
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
