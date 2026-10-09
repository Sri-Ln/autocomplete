/**
 * 00-namespace.js — must load first. See the `js` array in manifest.json.
 *
 * Why a global instead of ES modules: MV3 content scripts declared in the
 * manifest cannot use `import`. Files listed in `js` run in order and share one
 * scope, so a single namespace object is the no-build-step way to split code
 * across files. (The service worker is a real ES module and does use imports.)
 *
 * Everything hangs off window.AF. Nothing on the page can see it — content
 * scripts run in an isolated world.
 */

window.AF = window.AF || {};
AF.sites = AF.sites || {}; // individual adapters register themselves here
AF.SITES = AF.SITES || []; // ordered list, built by sites/index.js

AF.VERSION = '0.1.0';

/** Set true in the console to get a play-by-play of every field write. */
AF.debug = false;
AF.log = (...args) => {
  if (AF.debug) console.log('%c[AF]', 'color:#7c5cff;font-weight:bold', ...args);
};

/**
 * Poll `fn` until it returns something truthy, or give up after `timeoutMs`.
 * Used wherever Workday mounts something asynchronously — popup listboxes,
 * lazily-rendered form sections. Returns the truthy value, or null on timeout.
 */
AF.waitFor = function (fn, timeoutMs = 2000, intervalMs = 50) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const tick = () => {
      let value = null;
      try {
        value = fn();
      } catch {
        /* a not-yet-mounted DOM is an expected reason to throw here */
      }
      if (value) return resolve(value);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, intervalMs);
    };

    tick();
  });
};

/**
 * Debounce, for the MutationObserver in main.js.
 *
 * With a maxWait, and that part is not optional here. A plain debounce clears
 * its timer on every call, so a page that mutates faster than the delay
 * starves it completely: measured against a DOM changing every 50ms, the
 * observer fired 101 times in five seconds and the callback ran zero times.
 * Workday pages have spinners, live regions and animations, so this is the
 * normal case, not a pathological one — and the callback being starved means
 * the widget stops noticing that the page moved on, which looks exactly like
 * the extension having died.
 *
 * So: quiet pages still get the debounce, and a page that never goes quiet
 * still gets a run every `maxWaitMs`.
 */
AF.debounce = function (fn, ms, maxWaitMs = ms * 6) {
  let timer;
  let firstCallAt = 0;

  return (...args) => {
    const now = Date.now();
    if (!firstCallAt) firstCallAt = now;

    const run = () => {
      clearTimeout(timer);
      timer = undefined;
      firstCallAt = 0;
      fn(...args);
    };

    if (now - firstCallAt >= maxWaitMs) return run();

    clearTimeout(timer);
    timer = setTimeout(run, Math.min(ms, firstCallAt + maxWaitMs - now));
  };
};
