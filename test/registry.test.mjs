/**
 * registry.test.mjs — verifies where the company name comes from.
 *
 *   node test/registry.test.mjs
 *
 * The company name feeds the answer policy ("does this question mention the
 * employer?"). It used to be read off the Workday hostname everywhere; now the
 * site adapter supplies it and the hostname rule is only the fallback.
 */

import { readFile } from 'node:fs/promises';

const AF = {};
const location = { hostname: 'nvidia.wd5.myworkdayjobs.com' };
const window = {};
for (const file of ['00-namespace.js', 'match.js', 'registry.js']) {
  const src = await readFile(new URL(`../content/${file}`, import.meta.url), 'utf8');
  new Function('AF', 'location', 'window', src)(AF, location, window);
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

AF.SITES = [];
check('no site: hostname rule', AF.currentCompany(null), 'nvidia');
check('site without hook: hostname rule', AF.currentCompany({ hostMatch: /x/ }), 'nvidia');
check('site hook wins', AF.currentCompany({ company: () => 'OpenAI' }), 'OpenAI');
check('blank hook → null', AF.currentCompany({ company: () => '  ' }), null);
check('throwing hook → null', AF.currentCompany({ company: () => { throw new Error('x'); } }), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
