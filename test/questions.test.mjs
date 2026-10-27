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
  'worked out by a rule (formerEmployee)');
check('remember() refuses to store it',
  AF.questions.remember({}, 'Have you ever worked for Vertex Dynamics?', 'No').stored, false);

/* Without an employment history it is a No: the user's call, 2026-10-12. */
const noHistory = ask('Have you ever worked for Vertex Dynamics?', { ...PROFILE, employers: [] });
check('no employment history -> No', noHistory.answer, 'No');
check('and says why', noHistory.reason, '"Vertex Dynamics" is not in your employment history');

/* ================= the live Acme Insurance question ================= */

/* Reported from a real application. Three things about this one string broke
 * the employer rule at once: the company name starts with "The", the question
 * carries a parenthetical listing affiliates, and the <legend> drags in the
 * required-marker asterisk from an aria-hidden <abbr>. */
const ACME_INS =
  'Have you previously been employed by Acme Insurance (including any company affiliated with or acquired by Acme Insurance)?*';

const acmeNo = ask(ACME_INS);
check('Acme Insurance, not an employer -> No', acmeNo.answer, 'No');
check('and it is derived', acmeNo.source, 'derived');
/* The parenthetical is a definition of the company, not part of its name. If it
 * leaked in, the reason line below would read back as one absurd company. */
check('parenthetical does not leak into the company name', acmeNo.reason,
  '"Acme Insurance" is not in your employment history');

check('Acme Insurance in the history -> Yes',
  ask(ACME_INS, { ...PROFILE, employers: ['Acme Insurance', 'Initech'] }).answer, 'Yes');
check('fuzzy across the legal suffix too',
  ask(ACME_INS, { ...PROFILE, employers: ['Acme Insurance Holdings, Inc.'] }).answer,
  'Yes');

/* A brand named in the parenthetical is part of what is asked about: "Globex
 * (Acme Corp)" asks about Acme Corp too, and you worked there. */
check('a brand named in the parenthetical counts',
  ask('Have you previously been employed by Globex (Acme Corp)?').answer, 'Yes');
check('and an unknown one does not',
  ask('Have you previously been employed by Globex (Hooli)?').answer, 'No');

/* The asterisk must not reach any rule, not just this one. */
check('asterisked sponsorship still resolves',
  ask('Will you now or in the future require sponsorship?*').answer, 'No');
check('asterisked over-18 still resolves',
  ask('Are you at least 18 years of age?*').answer, 'Yes');

/* Company-specific, so the derived-not-remembered guarantee has to hold here. */
check('Acme Insurance question is NOT recallable',
  AF.questions.signature(ACME_INS).recallable, false);
check('remember() refuses the Acme Insurance question',
  AF.questions.remember({}, ACME_INS, 'No').stored, false);

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

// Unset takes the user's default (2026-10-13); a saved value always wins.
const unset = ask('Will you require sponsorship?', { ...PROFILE, needsSponsorship: '' });
check('unset sponsorship -> No', unset.answer, 'No');
check('saved sponsorship Yes wins',
  ask('Will you require sponsorship?', { ...PROFILE, needsSponsorship: 'yes' }).answer, 'Yes');

/* Split in two (2026-10-13): to commence employment, and in the future. */
const SP = { ...PROFILE, needsSponsorship: undefined, needsSponsorshipNow: 'no', needsSponsorshipFuture: 'yes' };
for (const [q, want] of [
  ['Will you require sponsorship to commence employment?', 'No'],
  ['Do you currently require visa sponsorship?', 'No'],
  ['Will you require sponsorship in the future?', 'Yes'],
  ['Will you now or in the future require sponsorship for employment visa status?', 'Yes'],
  ['Do you require visa sponsorship?', 'Yes'],
]) {
  check(`sponsorship now No, future Yes: "${q.slice(0, 50)}"`, ask(q, SP).answer, want);
}
check('both No: "now or in the future" is No',
  ask('Will you now or in the future require sponsorship?', { ...SP, needsSponsorshipFuture: 'no' }).answer, 'No');
check('both unset: No',
  ask('Will you require sponsorship in the future?', { ...SP, needsSponsorshipNow: '', needsSponsorshipFuture: '' }).answer, 'No');
check('a profile from before the split: its one answer stands for both',
  ask('Will you require sponsorship to commence employment?', { ...PROFILE, needsSponsorship: 'yes' }).answer, 'Yes');

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

/* ================= "our company" is learnable, as [COMPANY] ================= */

/* The company asking, whoever it is: the answer carries over (2026-10-12). */
check('recallable: "Why do you want to work at our company?"',
  AF.questions.signature('Why do you want to work at our company?').recallable, true);

const sig = (q, company) => AF.questions.signature(q, { company }).signature;
check('our company -> [company]', sig('Why do you want to work at our company?', ''),
  'why do you want to work at [company]');
check('the tenant\'s name -> [company], possessive dropped',
  sig("Are you comfortable with Acme Bakery's dress code?", 'acmebakery'),
  'are you comfortable with [company] dress code');
check('same question at another company, same signature',
  sig("Are you comfortable with Globex's dress code?", 'globex'),
  'are you comfortable with [company] dress code');
check('a slug inside ordinary words is not swapped',
  sig('Are you authorized to work in the United States and at State Farmhouse?', 'statefarmhouse'),
  'are you authorized to work in the united states and at [company]');

const learnedAtBakery = AF.questions.remember({}, "Are you comfortable with Acme Bakery's dress code?", 'Yes',
  { company: 'acmebakery' });
check('stored under [company]', learnedAtBakery.stored, true);
const atGlobex = AF.questions.resolve("Are you comfortable with Globex's dress code?",
  { learned: learnedAtBakery.learned, company: 'globex' });
check('recalled at another company', [atGlobex.answer, atGlobex.source], ['Yes', 'recalled']);

check('a rule-owned question is never stored',
  AF.questions.remember({}, 'Will you now or in the future require sponsorship?', 'No', { company: 'globex' }).stored, false);
check('a self-id answer is never stored',
  AF.questions.remember({}, 'What is your legal gender?', 'Female', { page: 'voluntaryDisclosures', fieldId: 'gender' }).stored, false);
check('a sign-off is never stored',
  AF.questions.remember({}, 'Yes, I have read and consent to the terms and conditions', 'Yes', { widget: 'checkbox' }).stored, false);

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

/* ================= Vandelay Capital, 2026-10-13 ================= */

/* Conflict-of-interest questions default to No, job texts to Yes, and work
 * authorisation, unset, to Yes. Exactly as asked live, required marker and all. */
const MS = [
  ['Do you consent to receive follow up communication via SMS WhatsApp from Talent Acquisition regarding job opportunities at Vandelay Capital?*', 'Yes', 'consentDefault'],
  ['Were you referred or recommended for this position by a Government Official?*', 'No', 'conflictOfInterest'],
  ['Are you an Immediate Family Member or Close Associate of any Government Official who has the ability to directly or indirectly influence the award of business to Vandelay Capital and/or exercise decision making authority that impacts Vandelay Capital?*', 'No', 'conflictOfInterest'],
  ['On the basis of employment as a Government Official or employee of a financial regulator, are you subject to any post-employment restrictions (including, but not limited to, cooling off period, non-disclosure of confidential information, recusal requirements, etc.)?*', 'No', 'conflictOfInterest'],
  ['In a capacity as a Government Official or employee of a financial regulator, have you had the ability to directly or indirectly influence the award of business to Vandelay Capital and/or exercise decision making authority that impacts Vandelay Capital?*', 'No', 'conflictOfInterest'],
  ['Are you currently, or have you been in the past three years, a Government Official [1], including military and/or law enforcement, or employed by a financial regulator?*', 'No', 'conflictOfInterest'],
  ['Are you legally authorized to work for Vandelay Capital in the country in which the job is located?*', 'Yes', 'workAuthorization'],
];
const BLANK = { firstName: 'A', lastName: 'B' }; // nothing set: the defaults decide
const askAs = (q, widget, profile = BLANK) => AF.questions.resolve(q, { profile, learned: {}, widget });
for (const [q, answer, rule] of MS) {
  const r = askAs(q, 'listbox');
  check(`MS ${answer}: "${q.slice(0, 50)}"`, [r.answer, r.rule], [answer, rule]);
}

/* The same flavour in other tenants' words. */
for (const q of [
  'Were you referred by a current employee?',
  'Do you have a spouse or domestic partner who works for a government agency?',
  'Are you a politically exposed person (PEP)?',
  'Do you have any family members who are public officials?',
  'Do you have any conflicts of interest we should know about?',
]) {
  check(`default No: "${q.slice(0, 50)}"`, askAs(q, 'choice').answer, 'No');
}

/* And the guards around them. */
check('a saved work-authorisation No still wins',
  askAs(MS[6][0], 'listbox', { workAuthorized: 'no' }).answer, 'No');
check('"official transcripts" is not a conflict of interest',
  askAs('Can you provide official transcripts?', 'listbox').rule === 'conflictOfInterest', false);
/* Any consent question is a Yes, whatever it is about (2026-10-13). */
for (const [q, widget] of [
  ['Do you agree to receive marketing text messages about new roles?', 'listbox'],
  ['I consent to being contacted by phone or email about other opportunities', 'checkbox'],
  ['Would you like to opt in to text message updates?', 'choice'],
  ['Opt-in to receive WhatsApp notifications', 'checkbox'],
  ['Do you consent to us retaining your data for future vacancies?', 'listbox'],
  ['May we contact you about future positions?', 'choice'],
  ['Do you consent to being referred to other roles at the company?', 'listbox'],
]) {
  const r = askAs(q, widget);
  // Yes either way; one that starts "I consent" is a sign-off and reported as signed.
  check(`consent Yes: "${q.slice(0, 50)}"`, r.answer, 'Yes');
}
/* No "Yes" row: the row that says Yes in other words, never one that negates. */
const yes = { answer: 'Yes', source: 'derived', rule: 'consentDefault' };
const no = { answer: 'No', source: 'derived', rule: 'conflictOfInterest' };
for (const [opts, want] of [
  [['I do not consent', 'I consent'], 'I consent'],
  [['I consent to receive SMS', 'I do not consent to receive SMS'], 'I consent to receive SMS'],
  [['Opt out', 'Opt in'], 'Opt in'],
  [["I don't agree", 'I agree'], 'I agree'],
  [['No, thank you', 'Yes, please contact me'], 'Yes, please contact me'],
  [['I would like to receive updates', 'I would not like to receive updates'], 'I would like to receive updates'],
]) {
  const i = AF.questions.pickOption(opts, yes);
  check(`Yes picks "${want}" from ${JSON.stringify(opts)}`, opts[i], want);
}
check('No picks "I do not consent"', ['I consent', 'I do not consent'][AF.questions.pickOption(['I consent', 'I do not consent'], no)], 'I do not consent');
check('a Yes with only negating rows picks nothing', AF.questions.pickOption(['I do not consent', 'Decline'], yes), -1);

check('a consent sign-off is still reported as signed',
  askAs('I have read and consent to the terms and conditions', 'checkbox').source, 'sign-off');
check('consent to a background check is still left for you',
  askAs('Do you consent to a background check?', 'listbox').answer, null);
check('a "Referred by" text box is never answered No',
  askAs('Referred by (name of employee)', 'text').answer === 'No', false);

/* ================= company questions default to No ================= */

const BAKERY = 'Do you currently, or have you previously worked for Acme Bakery or affiliated brands (Bagel Barn, Bean Co, Crumb House)';
check('affiliated-brands question: none of them -> No', ask(BAKERY).answer, 'No');
check('names the company, not "or affiliated brands"', ask(BAKERY).reason,
  '"Acme Bakery" is not in your employment history');
check('worked at an affiliate -> Yes',
  ask(BAKERY, { ...PROFILE, employers: ['Bean Co'] }).answer, 'Yes');

check('relatives -> No even with no list at all',
  ask('Do you have any relatives employed at Vertex Dynamics?', { ...PROFILE, relativesAt: undefined }).answer, 'No');

const PREAMBLE = 'Globex is committed to the highest standards of ethical conduct. '.repeat(6) +
  'A Public Official includes any officer or employee of a government. ' +
  'Are you a relative of a current Public Official?';
check('long preamble: the question is the last sentence',
  AF.questions.questionCore(PREAMBLE), 'Are you a relative of a current Public Official?');
check('relative of a public official -> No', [ask(PREAMBLE).answer, ask(PREAMBLE).rule],
  ['No', 'conflictOfInterest']);
check('relative of a senior person elsewhere -> No',
  ask('Are you a relative of a current senior level person or senior commercial person for a company other than Globex? (e.g. CEO, CFO)').answer,
  'No');
check('short questions are left whole',
  AF.questions.questionCore('Are you over 18?*'), 'Are you over 18?');

/* ================= gender is sensitive outside the disclosure pages ================= */
check('legal gender is sensitive', ask('What is your legal gender?').source, 'sensitive');

/* ================= self-identification: saved answers, disclosure pages only ================= */

const EEO = { ...PROFILE, firstName: 'Testy', lastName: 'McTestface',
  eeoGender: 'decline', eeoEthnicity: 'decline', eeoHispanic: 'no', eeoVeteran: 'notVeteran', eeoDisability: 'no' };
const onVD = (q, extra = {}) => AF.questions.resolve(q, { profile: EEO, page: 'voluntaryDisclosures', ...extra });

check('gender on Voluntary Disclosures -> the saved answer',
  [onVD('What is your legal gender?').answer, onVD('What is your legal gender?').source], ['decline', 'self-id']);
check('unset leaves it alone',
  AF.questions.resolve('What is your legal gender?', { profile: { ...EEO, eeoGender: '' }, page: 'voluntaryDisclosures' }).answer, null);
check('field id wins over a label that mentions disability',
  onVD('We are a Government contractor … a service-connected disability … protected veterans', { fieldId: 'veteranStatus' }).rule,
  'eeoVeteran');
check('disability by field id on Self Identify',
  AF.questions.resolve('Please check one of the boxes below:', { profile: EEO, page: 'selfIdentify', fieldId: 'disabilityStatus' }).answer,
  'no');
check('a Language dropdown on Self Identify is not a self-id question',
  AF.questions.matchRule('Language', { page: 'selfIdentify', fieldId: 'disabilityForm' }), null);

const pick = (opts, decision) => AF.questions.pickOption(opts, decision);
const GENDER = ['Male', 'Female', 'I do not wish to self-identify'];
check('decline finds the decline option', pick(GENDER, onVD('What is your legal gender?')), 2);
check('decline wording variant', pick(['Asian', 'White', 'I choose not to disclose'],
  { answer: 'decline', source: 'self-id', rule: 'eeoEthnicity' }), 2);
const VET = ['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran', 'I do not wish to self-identify'];
check('not a veteran', pick(VET, { answer: 'notVeteran', source: 'self-id', rule: 'eeoVeteran' }), 0);
check('protected veteran never picks the "not" row', pick(VET, { answer: 'protectedVeteran', source: 'self-id', rule: 'eeoVeteran' }), 1);
check('disability No picks the long No row', pick(
  ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'],
  { answer: 'no', source: 'self-id', rule: 'eeoDisability' }), 1);
check('female is not male', pick(GENDER, { answer: 'female', source: 'self-id', rule: 'eeoGender' }), 1);

/* ================= sign-offs ================= */

check('terms checkbox -> ticked', [
  AF.questions.resolve('Yes, I have read and consent to the terms and conditions', { profile: EEO, widget: 'checkbox' }).answer,
  AF.questions.resolve('Yes, I have read and consent to the terms and conditions', { profile: EEO, widget: 'checkbox' }).source,
], ['Yes', 'sign-off']);
check('signature name', AF.questions.resolve('Enter your name (required) and the name of your agency (if applicable) or N/A.',
  { profile: EEO, widget: 'text' }).answer, 'Testy McTestface');
check('Self Identify "Name" box', AF.questions.resolve('Name', { profile: EEO, widget: 'text', page: 'selfIdentify' }).answer,
  'Testy McTestface');
check('no name in the profile -> left, with a reason', [
  AF.questions.resolve('Name', { profile: {}, widget: 'text', page: 'selfIdentify' }).answer,
  AF.questions.resolve('Name', { profile: {}, widget: 'text', page: 'selfIdentify' }).reason,
], [null, 'add your first and last name in the popup']);
check('signature date is today', AF.questions.resolve('Date', {
  profile: EEO, widget: 'date', page: 'selfIdentify', today: new Date(2026, 9, 12) }).answer, '10/12/2026');
check('"Name" elsewhere is not a signature', AF.questions.matchRule('Name', { widget: 'text', page: 'applicationQuestions' }), null);

/* ================= follow-ups ================= */

const FOLLOW = 'If yes, what is your relationship with this individual? Enter N/A if not applicable.';
check('follow-up after a No -> N/A', AF.questions.resolve(FOLLOW, { previous: 'No' }).answer, 'N/A');
check('follow-up after a Yes -> left', AF.questions.resolve(FOLLOW, { previous: 'Yes' }).answer, null);
check('N/A finds an N/A option', pick(['Yes', 'No', 'N/A'], { answer: 'N/A', source: 'follow-up' }), 2);

/* ================= expected salary ================= */

check('expected salary -> the saved text',
  ask('What is your expected salary for the position you are applying for?', { ...PROFILE, expectedSalary: '$100k, negotiable' }).answer,
  '$100k, negotiable');
check('salary history is still sensitive', ask('What is your salary history?').source, 'sensitive');

/* ================= picking Yes / No ================= */
check('Yes picks Yes, not "Yes, but…"', pick(['No', 'Yes', 'Yes, but…'], { answer: 'Yes', source: 'derived' }), 1);
check('Yes falls back to a "Yes, …" row', pick(['No, never', 'Yes, I have'], { answer: 'Yes', source: 'derived' }), 1);
check('no option for the answer -> -1', pick(['Maybe'], { answer: 'Yes', source: 'derived' }), -1);

/* ================= review findings, 2026-10-12 ================= */

/* C1: a certification about a legal or protected matter is not a sign-off. */
const CB = (q, profile = EEO) => AF.questions.resolve(q, { profile, widget: 'checkbox' });
check('C1: "never convicted" certification is not ticked',
  CB('I certify that I have never been convicted of a felony.').source, 'sensitive');
check('C1: disability acknowledgement is not ticked',
  CB('I acknowledge that I have a disability').source, 'sensitive');
check('C1: a work-authorisation certification follows the profile field',
  [CB('I certify that I am legally authorized to work in the US', { ...EEO, workAuthorized: 'no' }).answer,
   CB('I certify that I am legally authorized to work in the US', { ...EEO, workAuthorized: 'no' }).source],
  ['No', 'derived']);
check('C1: a sponsorship certification follows the profile field',
  CB('I certify that I will not require sponsorship', { ...EEO, needsSponsorship: 'no' }).rule, 'sponsorship');

/* C2: "hispanic" never picks a "(Not Hispanic or Latino)" race. */
const RACES = ['American Indian or Alaska Native (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)',
  'Black or African American (Not Hispanic or Latino)', 'Hispanic or Latino', 'White (Not Hispanic or Latino)',
  'I do not wish to self-identify'];
check('C2: hispanic picks "Hispanic or Latino"', pick(RACES, { answer: 'hispanic', source: 'self-id', rule: 'eeoEthnicity' }), 3);
check('C2: asian still picks Asian', pick(RACES, { answer: 'asian', source: 'self-id', rule: 'eeoEthnicity' }), 1);

/* I1: other decline wordings. */
for (const opt of ["I don't wish to answer", 'I don’t wish to answer', 'Not Declared', 'Not Specified', 'Rather not say']) {
  check(`I1: decline finds "${opt}"`, pick(['Male', 'Female', opt], { answer: 'decline', source: 'self-id', rule: 'eeoGender' }), 2);
}

/* I2: "not a protected veteran" never claims service the user did not have. */
check('I2: notVeteran prefers "I am not a veteran" over "a veteran, but not protected"',
  pick(['I am a veteran, but not a protected veteran', 'I am not a veteran', 'I identify as one or more of the classifications of protected veteran'],
    { answer: 'notVeteran', source: 'self-id', rule: 'eeoVeteran' }), 1);

/* I3: "worked with X" / "employed by the government" are not employer questions. */
for (const q of ['Have you worked with Salesforce?', 'Have you worked with children before?',
  'Have you ever been employed by the federal government?', 'Do you have experience working with Python?',
  'Have you worked in a fast-paced environment?', 'Do you currently work night shifts?']) {
  check(`I3: not an employer question: "${q.slice(0, 40)}"`, AF.questions.matchRule(q, {}), null);
}
check('I3: and so it can be learned', AF.questions.signature('Have you worked with children before?').recallable, true);

/* I4: whether you applied / interviewed / were referred is per company — never carried over. */
for (const q of ['Have you applied to Acme Bakery before?', 'Have you interviewed with Globex previously?',
  'Were you referred by a current Acme Bakery employee?']) {
  check(`I4: not learned: "${q.slice(0, 40)}"`, AF.questions.remember({}, q, 'Yes', { company: 'acmebakery' }).stored, false);
}

/* I5: a written "why / explain" answer is never learned. */
check('I5: "why do you want to work here" text is not learned',
  AF.questions.remember({}, 'Why do you want to work at Acme Bakery?', 'I love bread.', { company: 'acmebakery', widget: 'text' }).stored, false);
check('I5: a short factual text answer still is',
  AF.questions.remember({}, 'How many years of retail experience do you have?', '3', { widget: 'text' }).stored, true);

/* I6: self-id answers never go into a text box. */
check('I6: no self-id value typed into a text box',
  AF.questions.resolve('What gender pronouns do you use?', { profile: EEO, page: 'voluntaryDisclosures', widget: 'text' }).answer, null);

/* Found while fixing I7: a relatives question is not about your own employment. */
const RELATIVES = ask('Do you have any relatives employed at Acme Bakery?');
check('relatives employed at X -> No, and not by the formerEmployee rule',
  [RELATIVES.answer, RELATIVES.rule === 'formerEmployee'], ['No', false]);

/* ================= live feedback, 2026-10-13 ================= */

const LIVE = { firstName: 'Testy', lastName: 'McTestface', employers: ['Initech'], eeoVeteran: 'notVeteran' };
const live = (q, widget = 'listbox') =>
  AF.questions.resolve(q, { profile: LIVE, page: 'applicationQuestions', widget, company: 'globex' });

check('F1: sponsorship with the switch unset -> No',
  live('Do you now, or will you in the future, require immigration sponsorship for work authorization?*').answer, 'No');
check('F1: the switch still wins when set',
  AF.questions.resolve('Will you require sponsorship?', { profile: { needsSponsorship: 'yes' } }).answer, 'Yes');
const AGREEMENTS = 'Do you have any agreements with your current or former employer(s) that could potentially prohibit or limit your employment with Globex? This could include agreements such as, but not limited to, the following: non-compete agreement, confidentiality agreement, non-solicitation agreement, invention assignment agreement, employment agreement, or separation agreement. If yes, you may be asked to provide to Globex upon request.*';
check('F2: restrictive agreements -> No', [live(AGREEMENTS).answer, live(AGREEMENTS).rule], ['No', 'restrictiveAgreement']);
check('F2: the non-compete wording too',
  live('Are you currently under a non-compete agreement that would preclude you from accepting the position?').answer, 'No');
check('F3: 18 or older with the switch unset -> Yes', live('Are you currently 18 years or older?*').answer, 'Yes');
check('F4: "I verify … truthful and accurate" checkbox -> ticked',
  [live('I verify that my application submission is truthful and accurate.*', 'checkbox').answer,
   live('I verify that my application submission is truthful and accurate.*', 'checkbox').source], ['Yes', 'sign-off']);
const verifyDecision = live('I verify that my application submission is truthful and accurate.*', 'listbox');
check('F4: as a dropdown, it picks the agree option',
  pick(['Select One', 'I Agree', 'I Do Not Agree'], verifyDecision), 1);
check('F4: …or Yes', pick(['No', 'Yes'], verifyDecision), 1);
const VETQ = 'Please select the veteran status which most accurately describes your status.*';
check('F5: veteran status on Application Questions uses the saved answer', live(VETQ).source, 'self-id');
check('F5: "I am not a veteran" is preferred over "not a protected veteran"',
  pick(['I am not a protected veteran', 'I am not a veteran', 'I identify as one or more of the classifications of protected veteran'], live(VETQ)), 1);
check('F5: with only "not a protected veteran" on offer, that one',
  pick(['I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran'], live(VETQ)), 0);

check('selfId flag answers gender off Workday',
  AF.questions.resolve('Gender', { profile: EEO, selfId: true, widget: 'choice' }).source, 'self-id');
check('no flag, no page: gender stays sensitive',
  AF.questions.resolve('Gender', { profile: EEO, widget: 'choice' }).answer, null);
check('selfId never learns a demographic',
  AF.questions.remember({}, 'Gender', 'Female', { selfId: true, widget: 'choice' }).stored, false);
check('Workday page list still works without the flag',
  AF.questions.resolve('What is your legal gender?', { profile: EEO, page: 'voluntaryDisclosures', widget: 'listbox' }).source, 'self-id');

const TODAY = new Date(2026, 9, 27);
const sd = (startDate, widget) => AF.questions.resolve('When can you start?',
  { profile: { noticePeriod: '2 weeks', startDate }, widget, today: TODAY });
check('date widget gets the saved start date', sd('2026-11-16', 'date').answer, '11/16/2026');
check('start date equal to today is answered', sd('2026-10-27', 'date').answer, '10/27/2026');
check('text widget still gets the notice period', sd('2026-11-16', 'text').answer, '2 weeks');
check('unset start date → blank', sd('', 'date').answer, null);
check('past start date → blank', sd('2026-10-01', 'date').answer, null);
check('past start date says why', sd('2026-10-01', 'date').reason, 'your saved start date has passed — update it in the popup');
for (const q of ['What is your age range?', 'Do you identify as transgender?',
                 'What are your pronouns?', 'Which communities do you identify with?'])
  check(`sensitive: ${q}`, AF.questions.isSensitive(q), true);
check('age wording is not over-broad', AF.questions.isSensitive('Are you willing to manage a team?'), false);

check('pronounce is not the pronoun question', AF.questions.isSensitive('How do you pronounce your name?'), false);

/* A site that names no company (hook returns null) must not fall back to the
   hostname: on Ashby that rule would say "jobs". */
{
  const keep = [AF.currentCompany, AF.tenantFromHostname];
  AF.currentCompany = () => null;
  AF.tenantFromHostname = () => 'jobs';
  check('null company hook: hostname is not swapped in',
    AF.questions.signature('Do you enjoy open jobs at Acme?').signature, 'do you enjoy open jobs at acme');
  [AF.currentCompany, AF.tenantFromHostname] = keep;
}

/* Age as a number is as protected as an age range. */
for (const q of ['What is your current age?', 'What is your age?']) {
  check(`sensitive: ${q}`, AF.questions.isSensitive(q), true);
  check(`left blank: ${q}`, AF.questions.resolve(q, { profile: PROFILE, learned: {}, widget: 'text' }).answer, null);
  check(`not recallable: ${q}`, AF.questions.remember({}, q, '30', { widget: 'text' }).stored, false);
}
for (const q of ['What stage are you at?', 'Expected wage?', 'Which agency referred you?',
                 'What is your average response time?', 'Please share your page URL.'])
  check(`not age: ${q}`, AF.questions.isSensitive(q), false);

/* ---- Work authorization with several "Yes" rows: pick by basis ---- */
const WA_Q = 'Are you currently authorized to work for any employer in the United States?';
const WA_ROWS = [
  'Yes - I have US work authorization as a Citizen or US Permanent Resident / Green Card Holder',
  'Yes - I have US work authorization via a non-immigrant visa (e.g. F-1, H-1B, L-1, TN)',
  'No - I am not currently authorized to work in the US',
];
const waPick = (profile, rows = WA_ROWS) =>
  AF.questions.pickOption(rows, AF.questions.resolve(WA_Q, { profile, learned: {}, widget: 'choice' }));
const WAP = { workAuthorized: 'yes', needsSponsorshipNow: 'no', needsSponsorshipFuture: 'yes' };
check('sponsorship flag Yes -> visa row', waPick(WAP), 1);
check('workAuthBasis visa -> visa row', waPick({ workAuthorized: 'yes', workAuthBasis: 'visa' }), 1);
check('workAuthBasis citizen -> citizen row', waPick({ workAuthorized: 'yes', workAuthBasis: 'citizen' }), 0);
check('workAuthBasis permanentResident -> green card row', waPick({ workAuthorized: 'yes', workAuthBasis: 'permanentResident' }), 0);
check('explicit basis beats the sponsorship flags', waPick({ ...WAP, workAuthBasis: 'citizen' }), 0);
check('unknown basis picks nothing', waPick({ workAuthorized: 'yes', needsSponsorshipNow: 'no', needsSponsorshipFuture: 'no' }), -1);
check('no row for the basis picks nothing', waPick({ workAuthorized: 'yes', workAuthBasis: 'citizen' },
  [WA_ROWS[1], 'Yes - I have another status', WA_ROWS[2]]), -1);
check('permanent resident falls back to a citizen-or-permanent row',
  waPick({ workAuthorized: 'yes', workAuthBasis: 'permanentResident' }, ['Yes - citizen', WA_ROWS[1], WA_ROWS[2]]), 0);
check('a No answer is unchanged', waPick({ workAuthorized: 'no', workAuthBasis: 'visa' }), 2);
check('plain Yes/No is unchanged', waPick({ workAuthorized: 'yes' }, ['Yes', 'No']), 0);
check('a single Yes row is unchanged', waPick({ workAuthorized: 'yes' }, [WA_ROWS[1], WA_ROWS[2]]), 0);
check('the decision carries the basis',
  AF.questions.resolve(WA_Q, { profile: WAP, learned: {} }).basis, 'visa');
check('the left reason names the popup field',
  /work authorization basis/i.test(AF.questions.optionReason(AF.questions.resolve(WA_Q, { profile: WAP, learned: {} }))), true);

/* ---- "Other website" -> handled in sites/ashby.js (harness) ---- */

/* ---- Current employer: first of employers ---- */
const CE = { employers: ['Initech', 'Globex'] };
for (const q of ['Current employer', 'Current company?', 'Most recent employer', 'Current or most recent employer',
                 'Current or most recent company name', 'Current (or most recent) employer', 'Most recent company name?']) {
  const r = AF.questions.resolve(q, { profile: CE, learned: {}, widget: 'text' });
  check(`current employer: ${q}`, [r.answer, r.rule, r.source], ['Initech', 'currentEmployer', 'derived']);
}
check('blank first lines are skipped',
  AF.questions.resolve('Current employer', { profile: { employers: ['', '  ', 'Globex'] }, learned: {}, widget: 'text' }).answer, 'Globex');
check('empty list -> no answer',
  AF.questions.resolve('Current employer', { profile: { employers: [] }, learned: {}, widget: 'text' }).answer, null);
for (const q of ['Have you worked at Initech before?', 'Why do you want to leave your current employer?',
                 'Are you a current employee of Initech?', 'Is your current employer aware you are applying?'])
  check(`not currentEmployer: ${q}`, AF.questions.resolve(q, { profile: CE, learned: {}, widget: 'text' }).rule === 'currentEmployer', false);
check('never recalled', AF.questions.remember({}, 'Current employer', 'Initech', { widget: 'text' }).stored, false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
