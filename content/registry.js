/**
 * registry.js — "what site am I on, and which of its pages is this?"
 *
 * Kept deliberately dumb. All the knowledge lives in the adapters; this just
 * picks one. That's what makes site #2 a drop-in file.
 */

/** First adapter whose hostMatch accepts the current hostname. */
AF.currentSite = function (hostname = location.hostname) {
  return AF.SITES.find((site) => site.hostMatch.test(hostname)) ?? null;
};

/**
 * Which page of that site are we on?
 *
 * An adapter page declares either:
 *   detectSelector: '...'   — present in the DOM ⇒ this is the page  (usual case)
 *   detect: () => boolean   — for anything more involved
 *
 * Returns { key, page } or null.
 */
AF.currentPage = function (site) {
  if (!site) return null;

  // Escape hatch for testing before selectors are harvested:
  //   AF.forcePage = 'createAccount'  in the console.
  if (AF.forcePage && site.pages[AF.forcePage]) {
    return { key: AF.forcePage, page: site.pages[AF.forcePage], forced: true };
  }

  for (const [key, page] of Object.entries(site.pages)) {
    try {
      if (typeof page.detect === 'function') {
        if (page.detect()) return { key, page };
      } else if (page.detectSelector && !AF.isPlaceholder(page.detectSelector)) {
        if (document.querySelector(page.detectSelector)) return { key, page };
      }
    } catch (err) {
      AF.log(`detect for page "${key}" threw`, err);
    }
  }

  return null;
};

/**
 * Has this adapter been configured at all, or is it still all placeholders?
 * Drives the "you still need to harvest selectors" message in the widget,
 * which is the honest thing to show on a fresh install.
 */
AF.countPlaceholders = function (site) {
  let total = 0;
  let remaining = 0;

  for (const page of Object.values(site?.pages ?? {})) {
    const selectors = [
      ...Object.values(page.fields ?? {}),
      page.submit,
      page.detectSelector,
      ...(page.errorSelectors ?? []),
    ].filter(Boolean);

    for (const sel of selectors) {
      total++;
      if (AF.isPlaceholder(sel)) remaining++;
    }
  }

  return { total, remaining };
};

/** Everything main.js needs to decide what to render, in one call. */
AF.resolveContext = function () {
  const site = AF.currentSite();
  if (!site) return { site: null };

  const match = AF.currentPage(site);
  return {
    site,
    pageKey: match?.key ?? null,
    page: match?.page ?? null,
    forced: !!match?.forced,
    placeholders: AF.countPlaceholders(site),
  };
};
