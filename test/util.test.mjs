/**
 * util.test.mjs — the two timing helpers every content script leans on.
 *
 *   node test/util.test.mjs
 *
 * Small file, real bugs. AF.debounce drives the MutationObserver that tells the
 * widget the page moved on, and AF.waitFor drives every "did the dropdown open
 * yet" poll. When either one misbehaves the symptom is the same: the widget
 * stops responding and there is nothing in the console to say why.
 *
 * 00-namespace.js is a content script (assigns onto a global `AF`), so it is
 * evaluated here against a stub global rather than imported.
 */

import { readFile } from 'node:fs/promises';

const AF = {};
const src = await readFile(new URL('../content/00-namespace.js', import.meta.url), 'utf8');
new Function('window', 'AF', src)({ AF }, AF);

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${label}` +
      (ok ? '' : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`)
  );
  ok ? passed++ : failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- debounce ---------------- */

{
  let runs = 0;
  const d = AF.debounce(() => runs++, 60);
  d();
  await sleep(150);
  check('a single call runs once', runs, 1);
}

{
  let runs = 0;
  const d = AF.debounce(() => runs++, 60);
  d(); d(); d(); d();
  await sleep(150);
  check('a burst collapses to one run', runs, 1);
}

{
  let seen = null;
  const d = AF.debounce((...args) => (seen = args), 40);
  d('a');
  d('b'); // the last call wins, as a debounce should
  await sleep(120);
  check('the last arguments win', seen, ['b']);
}

/* The regression this maxWait exists for.
 *
 * Measured against the old implementation on a DOM mutating every 50ms: the
 * observer fired 101 times in five seconds and the callback ran ZERO times.
 * A Workday page with a spinner or a live region mutates continuously, so a
 * debounce that can be starved indefinitely means the widget never notices the
 * page changed — which reads, from the outside, as the extension having died. */
{
  let runs = 0;
  const d = AF.debounce(() => runs++, 100, 300);

  const until = Date.now() + 900;
  while (Date.now() < until) {
    d();
    await sleep(20); // faster than the debounce delay: never a quiet moment
  }

  check('continuous churn cannot starve it', runs >= 2, true);
  check('and it did not run on every call either', runs <= 6, true);
}

{
  /* maxWait must not turn into a repeating timer once the page goes quiet. */
  let runs = 0;
  const d = AF.debounce(() => runs++, 40, 120);
  d();
  await sleep(300);
  const after = runs;
  await sleep(200);
  check('it stops when the calls stop', [after, runs], [1, 1]);
}

{
  /* A later burst is a new window, not a continuation of the old one. */
  let runs = 0;
  const d = AF.debounce(() => runs++, 40, 120);
  d();
  await sleep(150);
  d();
  await sleep(150);
  check('a second burst runs again', runs, 2);
}

/* ---------------- waitFor ---------------- */

{
  const got = await AF.waitFor(() => 'ready', 200);
  check('resolves with the truthy value', got, 'ready');
}

{
  let calls = 0;
  const got = await AF.waitFor(() => (++calls >= 3 ? 'late' : null), 500, 20);
  check('polls until the value appears', got, 'late');
  check('and stopped polling once it had it', calls, 3);
}

{
  const started = Date.now();
  const got = await AF.waitFor(() => null, 150, 20);
  const elapsed = Date.now() - started;
  check('gives up and returns null', got, null);
  check('and does so near the deadline, not later', elapsed < 600, true);
}

{
  /* A not-yet-mounted DOM throwing is an expected reason to keep waiting, not
   * a reason to reject — callers await this without a try/catch. */
  let calls = 0;
  const got = await AF.waitFor(() => {
    if (++calls < 3) throw new Error('not mounted yet');
    return 'mounted';
  }, 500, 20);
  check('a throwing probe is just a miss', got, 'mounted');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
