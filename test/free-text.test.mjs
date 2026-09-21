/**
 * free-text.test.mjs — which fields can hold a paragraph.
 *
 *   node test/free-text.test.mjs
 *
 * Only the pure predicate is tested here. The DOM walking in
 * AF.findFreeTextQuestions needs a real layout engine to be worth anything
 * (getClientRects, computed styles), so it is exercised in
 * test/free-text-harness.html instead — the same split widget.js uses.
 */

import { readFile } from 'node:fs/promises';

const AF = {};
for (const file of ['../content/match.js', '../content/questions.js', '../content/free-text.js']) {
  const src = await readFile(new URL(file, import.meta.url), 'utf8');
  new Function('AF', 'location', src)(AF, { hostname: 'x.wd1.myworkdayjobs.com' });
}

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

/* A stand-in for a DOM element. Only the properties the predicate reads are
 * defined, which is also a statement of what it is allowed to read: no layout,
 * no parents, nothing that would make it untestable outside a browser. */
const field = (props) => ({
  tagName: 'INPUT',
  type: 'text',
  maxLength: -1, // the DOM's "no maxlength attribute" value for an input
  disabled: false,
  readOnly: false,
  ...props,
});

/* ================= shapes that take a paragraph ================= */

check('a textarea does',
  AF.freeText.acceptsLongText(field({ tagName: 'TEXTAREA', maxLength: -1 })), true);

check('so does an unbounded text input',
  AF.freeText.acceptsLongText(field({})), true);

check('and one with a generous maxlength',
  AF.freeText.acceptsLongText(field({ maxLength: 2000 })), true);

/* ================= shapes that do not ================= */

/* The load-bearing negative. Workday renders plenty of short single-line answer
 * boxes; pasting 60 words into one silently truncates at the maxlength and the
 * application goes out with half a sentence. */
check('a short-answer input does not',
  AF.freeText.acceptsLongText(field({ maxLength: 40 })), false);

check('nor does a typed input that is not free text',
  AF.freeText.acceptsLongText(field({ type: 'email' })), false);

check('nor a date input',
  AF.freeText.acceptsLongText(field({ type: 'date' })), false);

check('nor a checkbox',
  AF.freeText.acceptsLongText(field({ type: 'checkbox' })), false);

check('nor a select',
  AF.freeText.acceptsLongText(field({ tagName: 'SELECT', type: undefined })), false);

/* Writing to either of these throws or silently no-ops, so they must never be
 * offered a pill. */
check('nor a disabled textarea',
  AF.freeText.acceptsLongText(field({ tagName: 'TEXTAREA', disabled: true })), false);

check('nor a read-only textarea',
  AF.freeText.acceptsLongText(field({ tagName: 'TEXTAREA', readOnly: true })), false);

check('nor nothing at all', AF.freeText.acceptsLongText(null), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
