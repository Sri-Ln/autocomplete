/**
 * match.test.mjs — verifies the fuzzy option matcher.
 *
 *   node test/match.test.mjs
 *
 * This one earns its keep. The matcher picks an answer on a real job
 * application; a wrong pick is worse than no pick, so the negative cases below
 * matter as much as the positive ones.
 *
 * match.js is a content script (assigns onto a global `AF`), so it's evaluated
 * here against a stub global rather than imported.
 */

import { readFile } from 'node:fs/promises';

const AF = {};
const src = await readFile(new URL('../content/match.js', import.meta.url), 'utf8');
new Function('AF', 'location', src)(AF, { hostname: 'example.myworkdayjobs.com' });

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

/* ---------------- tenant extraction ---------------- */

check('tenant from finra host', AF.tenantFromHostname('finra.wd1.myworkdayjobs.com'), 'finra');
check('tenant from nvidia host', AF.tenantFromHostname('nvidia.wd5.myworkdayjobs.com'), 'nvidia');
check('tenant ignores wdN-first host', AF.tenantFromHostname('wd3.myworkdayjobs.com'), null);
check('tenant ignores www', AF.tenantFromHostname('www.myworkdayjobs.com'), null);
check('tenant handles short host', AF.tenantFromHostname('localhost'), null);

/* ---------------- scoring ladder ---------------- */

check('exact match scores 1', AF.scoreMatch('Career Site', 'career site'), 1);
check('case and punctuation ignored', AF.scoreMatch('FINRA Career-Site', 'finra career site'), 1);
check('unrelated scores 0', AF.scoreMatch('LinkedIn', 'finra career'), 0);
check('no shared tokens scores 0', AF.scoreMatch('Company Website', 'career site'), 0);

// A prefix match must outrank a substring match, which must outrank token overlap.
const prefix = AF.scoreMatch('FINRA Career Site', 'finra career');
const substring = AF.scoreMatch('The FINRA Career Site', 'career site');
const overlap = AF.scoreMatch('FINRA Employee Referral', 'finra career');
check('prefix > substring', prefix > substring, true);
check('substring > token overlap', substring > overlap, true);
check('token overlap is capped', overlap <= 0.84, true);

/* ---------------- the real FINRA case ---------------- */

// Top level of a typical Workday source prompt.
const TOP_LEVEL = [
  'Employee Referral',
  'Job Sites',
  'Social Media',
  'University / College',
  'Career Fair',
  'Other',
];

// After drilling into "Job Sites".
const JOB_SITES = [
  'Indeed',
  'LinkedIn',
  'Glassdoor',
  'FINRA Career Site',
  'ZipRecruiter',
];

const finra = AF.careerSiteCandidates('finra.wd1.myworkdayjobs.com');
check('finra candidates are tenant-first', finra[0], 'finra career site');

const inJobSites = AF.bestMatch(JOB_SITES, finra);
check('picks FINRA Career Site', inJobSites?.text, 'FINRA Career Site');
check('picks it via the tenant candidate', inJobSites?.candidate, 'finra career site');

// The answer is NOT at the top level — the matcher must decline, not guess,
// so the caller knows to drill into a category.
const atTopLevel = AF.bestMatch(TOP_LEVEL, finra);
check('declines when answer absent from top level', atTopLevel, null);

// And it should recognise which category to open.
const category = AF.bestMatch(TOP_LEVEL, ['job sites']);
check('finds the Job Sites category', category?.text, 'Job Sites');

/* ---------------- disambiguation ---------------- */

// Several entries contain "Career Site"; the tenant one must win.
const AMBIGUOUS = ['Other Career Site', 'FINRA Career Site', 'Partner Career Site'];
check('tenant disambiguates among similar options',
  AF.bestMatch(AMBIGUOUS, finra)?.text, 'FINRA Career Site');

// A different tenant on the same list picks its own.
const nvidia = AF.careerSiteCandidates('nvidia.wd5.myworkdayjobs.com');
check('nvidia picks NVIDIA Careers',
  AF.bestMatch(['Indeed', 'NVIDIA Careers', 'LinkedIn'], nvidia)?.text, 'NVIDIA Careers');

// With no tenant match available, the generic fallback still finds a career site.
check('generic fallback still works',
  AF.bestMatch(['Indeed', 'Company Career Site', 'LinkedIn'], finra)?.text,
  'Company Career Site');

/* ---------------- refusing to guess ---------------- */

check('returns null on an empty list', AF.bestMatch([], finra), null);
check('returns null when nothing is close',
  AF.bestMatch(['Indeed', 'LinkedIn', 'Glassdoor'], finra), null);
check('returns null for a blank wanted', AF.bestMatch(['Indeed'], ['']), null);

/* ---------------- object inputs ---------------- */

check('accepts {text} objects',
  AF.bestMatch([{ text: 'Indeed' }, { text: 'FINRA Career Site' }], finra)?.index, 1);

/* ---------------- US states ----------------
 * Regression: harvested from a real Workday state dropdown. The query "MA"
 * prefix-matched Maine, Maryland AND Massachusetts; Maine sorts first, so a
 * Massachusetts address silently became a Maine one. */

const REAL_STATES = [
  'Select One', 'Alabama', 'Alaska', 'American Samoa', 'Arizona', 'Arkansas',
  'Armed Forces Americas', 'Armed Forces Europe', 'Armed Forces Pacific',
  'California', 'Colorado', 'Connecticut', 'Delaware', 'District of Columbia',
  'Florida', 'Georgia', 'Guam', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts',
  'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska',
  'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
  'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania',
  'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];

check('MA expands to Massachusetts', AF.expandUsState('MA'), 'Massachusetts');
check('lowercase ma expands too', AF.expandUsState('ma'), 'Massachusetts');
check('full name passes through', AF.expandUsState('Massachusetts'), 'Massachusetts');
check('unknown value passes through', AF.expandUsState('Ontario'), 'Ontario');
check('empty stays empty', AF.expandUsState(''), '');

check('expanded MA selects Massachusetts',
  AF.bestMatch(REAL_STATES, [AF.expandUsState('MA')])?.text, 'Massachusetts');

// The three-letter guard, proven directly.
check('bare MA no longer matches Maine',
  AF.bestMatch(REAL_STATES, ['MA']), null);
check('short queries score zero unless exact',
  AF.scoreMatch('Maine', 'MA'), 0);
check('short query still matches itself exactly',
  AF.scoreMatch('MA', 'ma'), 1);

// Every abbreviation must round-trip against the real list.
const missing = [];
for (const [abbr, full] of Object.entries(AF.US_STATES)) {
  if (!REAL_STATES.includes(full)) continue; // territory not in this trimmed list
  const hit = AF.bestMatch(REAL_STATES, [AF.expandUsState(abbr)]);
  if (hit?.text !== full) missing.push(`${abbr}→${hit?.text ?? 'null'} (want ${full})`);
}
check('every US abbreviation resolves correctly', missing, []);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
