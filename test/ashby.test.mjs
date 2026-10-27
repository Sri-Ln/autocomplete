/**
 * ashby.test.mjs — the Ashby adapter's company and host rules.
 *
 *   node test/ashby.test.mjs
 */

import { readFile } from 'node:fs/promises';

const AF = {};
const window = { AF };
const location = { hostname: 'jobs.ashbyhq.com', pathname: '/' };
for (const file of ['../content/00-namespace.js', '../content/match.js', '../content/questions.js', '../sites/ashby.js']) {
  const src = await readFile(new URL(file, import.meta.url), 'utf8');
  new Function('AF', 'location', 'window', src)(AF, location, window);
}
const A = AF.sites.ashby;

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

check('title wins', A.companyFrom('Software Engineer @ OpenAI', '/openai/123/application'), 'OpenAI');
check('last @ wins', A.companyFrom('Eng @ Infra @ Wrapbook', '/wrapbook/1'), 'Wrapbook');
check('path fallback', A.companyFrom('Jobs', '/game%20changer/9/application'), 'game changer');
check('nothing', A.companyFrom('', '/'), null);
check('host match', A.hostMatch.test('jobs.ashbyhq.com'), true);
check('no lookalike', A.hostMatch.test('jobs.ashbyhq.com.evil.example'), false);
check('page detects the submit button', A.pages.application.detectSelector, 'button.ashby-application-form-submit-button');
check('stub fill returns an empty report', A.pages.application.sections.application.present(), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
