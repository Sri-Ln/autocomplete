/**
 * questions.test.mjs — verifies question classification and answering.
 *
 *   node test/questions.test.mjs
 *
 * The centrepiece is the employer case: the same question about two different
 * companies must produce two different answers. An earlier design stored one
 * answer per redacted question and would have got one of them wrong every time.
 */

import { readFile } from 'node:fs/promises';

const AF = {};
for (const file of ['../content/match.js', '../content/questions.js']) {
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

const PROFILE = {
  employers: ['Google', 'Acme Corp', 'Initech'],
  relativesAt: [],
  over18: 'yes',
  workAuthorized: 'yes',
  needsSponsorship: 'no',
  willingToRelocate: 'yes',
  noticePeriod: '2 weeks',
};

const ask = (q, profile = PROFILE, learned = {}) =>
  AF.questions.resolve(q, { profile, learned });

/* ================= THE CASE THAT DROVE THE REDESIGN ================= */

const notWorked = ask('Have you ever worked for Vertex Dynamics as a full-time or temporary employee?*');
const haveWorked = ask('Have you ever worked for Google as a full-time or temporary employee?*');

check('never worked at Vertex Dynamics -> No', notWorked.answer, 'No');
check('did work at Google -> Yes', haveWorked.answer, 'Yes');
check('both are derived, not recalled', [notWorked.source, haveWorked.source],
  ['derived', 'derived']);
check('explains itself for the user', notWorked.reason,
  '"Vertex Dynamics" is not in your employment history');

// Fuzzy on company naming: the application says "Vertex Dynamics", your history may not
// spell a company identically.
check('fuzzy company match across suffixes',
  ask('Have you ever worked for Acme Corporation as an employee?').answer, 'Yes');

// Phrasing variants must reach the same rule.
check('"former employee of" phrasing',
  ask('Are you a former employee of Initech?').answer, 'Yes');
check('"previously employed at" phrasing',
  ask('Have you previously been employed at Google?').answer, 'Yes');

/* This is the guard that makes the above safe: such a question can never be
 * stored, so a Yes from one company cannot leak to another. */
check('employer question is NOT recallable',
  AF.questions.signature('Have you ever worked for Vertex Dynamics as a full-time employee?').recallable,
  false);
check('and says why', AF.questions.signature('Have you ever worked for Vertex Dynamics?').reason,
  'refers to a specific employer, so the answer does not transfer');
check('remember() refuses to store it',
  AF.questions.remember({}, 'Have you ever worked for Vertex Dynamics?', 'No').stored, false);

/* Without an employment history it must decline, not assume "No". */
const noHistory = ask('Have you ever worked for Vertex Dynamics?', { ...PROFILE, employers: [] });
check('no employment history -> declines', noHistory.answer, null);
check('and asks for what it needs', noHistory.reason,
  'needs your "employers" list to answer this for "Vertex Dynamics"');

/* ================= sensitive: never answered ================= */

const sensitive = [
  'Have you ever been convicted of a felony?',
  'Do you have a disability?',
  'Are you a protected veteran?',
  'What is your race or ethnicity?',
  'Please self-identify your gender',
  'Are you Hispanic or Latino?',
  'What is your current salary?',
];
for (const q of sensitive) {
  const r = ask(q);
  check(`refuses: "${q.slice(0, 42)}"`, [r.answer, r.source], [null, 'sensitive']);
}

// Even with a learned entry present, sensitive wins — order is load-bearing.
const poisoned = { 'do you have a disability': { answer: 'No', seen: 9 } };
check('sensitive beats a learned entry',
  ask('Do you have a disability?', PROFILE, poisoned).source, 'sensitive');

/* ================= derived, non-company ================= */

check('over 18', ask('Are you at least 18 years of age?').answer, 'Yes');
check('work authorization', ask('Are you legally authorized to work in the United States?').answer, 'Yes');
check('sponsorship polarity', ask('Will you now or in the future require sponsorship?').answer, 'No');

// The polarity trap: these two must not resolve to the same rule.
check('authorization and sponsorship are distinct rules',
  [ask('Are you legally authorized to work in the US?').rule,
   ask('Will you require visa sponsorship?').rule],
  ['workAuthorization', 'sponsorship']);

// Unset means decline, never a default.
const unset = ask('Will you require sponsorship?', { ...PROFILE, needsSponsorship: '' });
check('unset flag declines', unset.answer, null);
check('unset flag explains', unset.reason, 'set "needsSponsorship" in your profile to answer this automatically');

check('relatives: empty list means No',
  ask('Do you have any relatives employed at Vertex Dynamics?').answer, 'No');

/* ================= preferences ================= */

check('relocate', ask('Are you willing to relocate?').answer, 'Yes');
check('relocate is a preference', ask('Are you willing to relocate?').source, 'preference');
check('notice period', ask('What is your notice period?').answer, '2 weeks');
check('unset preference declines',
  ask('Are you willing to travel?', { ...PROFILE, willingToTravel: '' }).answer, null);

/* ================= recall ================= */

let learned = {};
const generic = 'Do you have a valid driver licence?';

check('unseen question declines', ask(generic, PROFILE, learned).answer, null);
check('and says so', ask(generic, PROFILE, learned).reason, 'not seen before');

const remembered = AF.questions.remember(learned, generic, 'Yes');
check('generic question IS stored', remembered.stored, true);
learned = remembered.learned;

check('recalled next time', ask(generic, PROFILE, learned).answer, 'Yes');
check('marked as recalled', ask(generic, PROFILE, learned).source, 'recalled');

/* Recall is deliberately STRICT (threshold 0.82), so a respelling misses.
 *
 * "driver licence" vs "drivers license" shares 5 of 7 tokens and scores ~0.71.
 * Loosening to catch it would also make these two match at 0.80:
 *     "Are you willing to relocate?"
 *     "Are you willing to travel?"
 * — four of five tokens in common, opposite meanings. A missed recall costs one
 * click and stores a second entry; a false recall submits a wrong answer on a
 * real application. The asymmetry decides it. */
check('respelling is NOT recalled (deliberate)',
  ask('Do you have a valid drivers license?', PROFILE, learned).answer, null);

// The pair that forces the strict threshold, proven directly.
const relocateLearned = AF.questions.remember({}, 'Are you willing to relocate?', 'Yes').learned;
check('relocate/travel do not cross-match',
  AF.bestMatch(Object.keys(relocateLearned),
    [AF.questions.signature('Are you willing to travel?').signature],
    { threshold: 0.82, floor: 0.82 }),
  null);

// An unrelated question must not be dragged in by a loose match.
check('unrelated question is not recalled',
  ask('Do you own a car?', PROFILE, learned).answer, null);

check('seen count increments',
  AF.questions.remember(learned, generic, 'Yes').learned[
    AF.questions.signature(generic).signature
  ].seen, 2);

/* ================= "our company" is not recallable either ================= */

for (const q of [
  'Why do you want to work at our company?',
  'Have you applied to this company before?',
  'Have you interviewed with us previously?',
]) {
  check(`not recallable: "${q.slice(0, 40)}"`, AF.questions.signature(q).recallable, false);
}

/* ================= visa explanation (free text) ================= */

/* A prose answer is wanted only when the question asks for BOTH a visa/work-auth
 * topic AND an explanation. Requiring both is the whole design: "Will you require
 * visa sponsorship?" is on-topic but is a Yes/No radio the sponsorship rule
 * already owns, and pasting 60 words of prose at it would be wrong. */

const wantsVisa = (q) => AF.questions.wantsVisaExplanation(q);

for (const q of [
  'Please explain your visa status',
  'Describe your current work authorization status',
  'If you require sponsorship, please provide details',
  'Please explain your immigration status and work authorization',
  'What is your visa status? Please elaborate.',
  'Please specify the type of work permit you hold',
]) {
  check(`wants prose: "${q.slice(0, 44)}"`, wantsVisa(q), true);
}

/* The negatives matter more than the positives here — a false positive pastes a
 * personal legal statement into a field the user never looked at. */
for (const q of [
  'Are you legally authorized to work in the United States?', // Yes/No, workAuthorization owns it
  'Will you now or in the future require visa sponsorship?',   // Yes/No, sponsorship owns it
  'Please provide a cover letter',                             // prose, wrong topic
  'Is there anything else you would like us to know?',         // prose, no topic at all
  'Please explain why you left your last position',            // explanation cue, wrong topic
  '',
]) {
  check(`no prose: "${q.slice(0, 44)}"`, wantsVisa(q), false);
}

/* The two Yes/No rules must keep owning their questions — adding the prose rule
 * must not have pulled them into a different tier. */
check('sponsorship Yes/No still routes to its own rule',
  ask('Will you now or in the future require visa sponsorship?').rule, 'sponsorship');
check('work authorization Yes/No still routes to its own rule',
  ask('Are you legally authorized to work in the United States?').rule, 'workAuthorization');

/* An unset profile field must decline rather than fill an empty string —
 * the same refusal contract every other declaration follows. */
const visaUnset = AF.questions.visaExplanationFor({ visaExplanation: '' });
check('no saved explanation -> declines', visaUnset.text, null);
check('and says what to do', visaUnset.reason,
  'add your visa status explanation in the extension popup, on the Profile tab');

const visaSet = AF.questions.visaExplanationFor({ visaExplanation: '  As an F-1 visa holder…  ' });
check('saved explanation is offered, trimmed', visaSet.text, 'As an F-1 visa holder…');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
