// AF.describeReport — the one-line report every site's widget shows.
import { readFileSync } from 'node:fs';

const AF = { log() {} };
new Function('AF', readFileSync(new URL('../content/filler.js', import.meta.url), 'utf8'))(AF);

let failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return;
  failed++;
  console.error(`FAIL ${label}\n  got      ${a}\n  expected ${e}`);
}

check('summary line', AF.describeReport({ section: 'Questions', filled: ['a', 'b'], replaced: [], already: ['c'],
  kept: [], left: ['Salary — not set', 'Start — not set', 'Pronouns'], failed: [], signed: ['Terms'], added: 0, note: '' }),
  { kind: 'warn', text: 'Questions: 2 filled, 1 already set, 1 signed. Needs you: Salary — not set; Start — not set (+1 more).' });
check('note only', AF.describeReport({ section: 'X', filled: [], already: [], failed: [], left: [], kept: [], note: 'no questions found on this page' }),
  { kind: 'info', text: 'X: no questions found on this page' });

console.log(failed ? `${failed} failed` : 'all passed');
if (failed) process.exit(1);
