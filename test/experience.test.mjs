/**
 * experience.test.mjs — the pure half of the My Experience filler.
 *
 *   node test/experience.test.mjs
 *
 * Preference ladders, proficiency-scale ranking, date parsing and URL
 * de-duplication. Every one of these decides what goes onto a real application,
 * so the negative cases — "leave it, do not guess" — matter as much as the
 * positive ones.
 *
 * match.js and experience.js are content scripts (they assign onto a global
 * `AF`), so both are evaluated here against a stub global rather than imported.
 * All values are synthetic.
 */

import { readFile } from 'node:fs/promises';

const AF = {};
for (const file of ['../content/match.js', '../content/experience.js']) {
  const src = await readFile(new URL(file, import.meta.url), 'utf8');
  new Function('AF', 'location', src)(AF, { hostname: 'example.wd1.myworkdayjobs.com' });
}
const X = AF.experience;

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

/* ---------------- dates ---------------- */

check('year only', X.parseMonthYear('2015'), { year: 2015, month: null });
check('MM/YYYY', X.parseMonthYear('08/2015'), { year: 2015, month: 8 });
check('M-YYYY', X.parseMonthYear('8-2015'), { year: 2015, month: 8 });
check('YYYY-MM', X.parseMonthYear('2015-09'), { year: 2015, month: 9 });
check('month name', X.parseMonthYear('August 2015'), { year: 2015, month: 8 });
check('short month name', X.parseMonthYear('Sep 2015'), { year: 2015, month: 9 });
check('"Sept" is September', X.parseMonthYear('Sept 2015'), { year: 2015, month: 9 });
check('not a month name', X.parseMonthYear('Augx 2015'), null);
check('month 13 refused', X.parseMonthYear('13/2015'), null);
check('"present" is left for the user', X.parseMonthYear('present'), null);
check('a stray two-digit number is not a year', X.parseMonthYear('12'), null);
check('blank', X.parseMonthYear(''), null);

/* ---------------- prompt scoring (skills) ---------------- */

const SKILLS = ['JavaScript', 'Java (Programming Language)', 'Java Spring', 'Python (Programming Language)'];
check('"Java" is not JavaScript', X.bestPromptOption(SKILLS, 'Java')?.text, 'Java (Programming Language)');
check('"Python" finds its parenthetical form', X.bestPromptOption(SKILLS, 'python')?.text,
  'Python (Programming Language)');
check('"JavaScript" exact', X.bestPromptOption(SKILLS, 'JavaScript')?.text, 'JavaScript');
check('a skill not on the list is left', X.bestPromptOption(SKILLS, 'Kubernetes'), null);
check('an existing "(Suggested)" pill counts as already there',
  X.alreadyHas(['Teamwork (Suggested)', 'Python (Programming Language)'], 'Teamwork'), true);
check('but a near-miss pill does not', X.alreadyHas(['JavaScript (Suggested)'], 'Java'), false);

/* ---------------- preference ladders ---------------- */

check('ladder from one-per-line text', X.toLadder('Alpha\n  Beta \n\nalpha'), ['Alpha', 'Beta']);
check('ladder from a legacy single string', X.toLadder('Gamma Studies'), ['Gamma Studies']);

// Synthetic field-of-study list.
const FIELDS = [
  'Underwater Basketry', 'Underwater Basketry Education', 'Applied Widgetry',
  'Widgetry', 'Astro Gardening', 'General Studies',
];
check('rung 1 wins when it is on the list',
  X.pickByLadder(FIELDS, ['Applied Widgetry', 'Widgetry'])?.rungIndex, 0);
check('rung 2 used when rung 1 is absent',
  X.pickByLadder(FIELDS, ['Quantum Origami', 'Astro Gardening'])?.text, 'Astro Gardening');
check('and it reports which rung', X.pickByLadder(FIELDS, ['Quantum Origami', 'Astro Gardening'])?.rung,
  'Astro Gardening');
check('an exact rung 2 beats a loose (prefix) reading of rung 1',
  X.pickByLadder(FIELDS, ['Astro', 'Widgetry'])?.text, 'Widgetry');
check('a word-boundary prefix is used when no rung is exact',
  X.pickByLadder(FIELDS, ['Quantum Origami', 'Astro'])?.text, 'Astro Gardening');
check('a ladder with nothing on the list leaves the field',
  X.pickByLadder(FIELDS, ['Quantum Origami', 'Time Travel']), null);
check('a mere substring is not a match', X.pickByLadder(FIELDS, ['Basketry Education']), null);
check('an empty ladder picks nothing', X.pickByLadder(FIELDS, []), null);

const DEGREES = ['Select One', "Associate's Degree (±14 years)", "Bachelor's Degree (±16 years)",
  "Master's Degree (±18 years)", 'Doctorate (±21 years)'];
check("degree rung matches with Workday's (±N years) suffix",
  X.pickByLadder(DEGREES, ["Master's Degree", 'Master of Science'])?.text, "Master's Degree (±18 years)");
check('degree falls to rung 2 on a tenant that words it differently',
  X.pickByLadder(['Bachelor of Science', 'Master of Science'], ["Master's Degree", 'Master of Science'])?.text,
  'Master of Science');
check('a bachelor ladder never lands on a master option',
  X.pickByLadder(['Master of Science'], ["Bachelor's Degree", 'Bachelor of Science']), null);
check('onLadder accepts an existing value that is a rung',
  !!X.onLadder("Bachelor's Degree (±16 years)", ["Bachelor's Degree"]), true);

/* ---------------- proficiency scales ---------------- */

const SIMPLE = ['Select One', 'Beginner', 'Intermediate', 'Fluent'];
const LINKEDIN = ['Elementary proficiency', 'Limited working proficiency',
  'Professional working proficiency', 'Full professional proficiency',
  'Native or bilingual proficiency'];
const NUMBERED = ['Select One', '1 - Beginner', '2 - Classroom Study', '3 - Intermediate',
  '4 - Advanced', '5 - Fluent'];
// Shuffled on purpose: the numbers, not list order, are the ranking.
const NUMBERED_SHUFFLED = ['5 - Fluent', '2 - Classroom Study', 'Select One', '1 - Beginner',
  '4 - Advanced', '3 - Intermediate'];

const pick = (texts, level) => {
  const r = X.chooseLevel(texts, level);
  return r.ok ? r.text : `LEFT: ${r.reason}`;
};

check('simple: fluent → Fluent', pick(SIMPLE, 'fluent'), 'Fluent');
check('simple: native → the top, Fluent', pick(SIMPLE, 'native'), 'Fluent');
check('simple: beginner', pick(SIMPLE, 'beginner'), 'Beginner');
check('simple: intermediate', pick(SIMPLE, 'intermediate'), 'Intermediate');
check('simple: advanced rounds DOWN on a tie, never up', pick(SIMPLE, 'advanced'), 'Intermediate');

check('linkedin ranks in its own order',
  X.rankScale(LINKEDIN).ranked.map((r) => r.index), [0, 1, 2, 3, 4]);
check('linkedin: fluent → the top rung', pick(LINKEDIN, 'fluent'), 'Native or bilingual proficiency');
check('linkedin: beginner', pick(LINKEDIN, 'beginner'), 'Elementary proficiency');
check('linkedin: intermediate', pick(LINKEDIN, 'intermediate'), 'Limited working proficiency');
check('linkedin: advanced', pick(LINKEDIN, 'advanced'), 'Professional working proficiency');

check('numbered: fluent → 5 - Fluent', pick(NUMBERED, 'fluent'), '5 - Fluent');
check('numbered: beginner → 1, not Classroom Study', pick(NUMBERED, 'beginner'), '1 - Beginner');
check('numbered: intermediate', pick(NUMBERED, 'intermediate'), '3 - Intermediate');
check('numbered: advanced', pick(NUMBERED, 'advanced'), '4 - Advanced');
check('numbered, shuffled: fluent still the highest number', pick(NUMBERED_SHUFFLED, 'fluent'), '5 - Fluent');
check('numbered, shuffled: ranked by number',
  X.rankScale(NUMBERED_SHUFFLED).ranked.map((r) => r.text),
  ['1 - Beginner', '2 - Classroom Study', '3 - Intermediate', '4 - Advanced', '5 - Fluent']);
check('the placeholder is never a level', X.rankScale(NUMBERED).ranked.some((r) => /select/i.test(r.text)), false);

check('unrankable: labels we cannot place are left',
  X.chooseLevel(['Select One', 'Level A', 'Level B', 'Level C'], 'fluent').ok, false);
check('and it says why', /cannot place "Level A"/.test(X.chooseLevel(['Level A', 'Level B'], 'fluent').reason), true);
check('unrankable: one stray label spoils the scale',
  X.chooseLevel(['Beginner', 'Intermediate', 'Grade 7'], 'beginner').ok, false);
check('unrankable: numbers that contradict the words',
  X.chooseLevel(['1 - Fluent', '2 - Beginner'], 'fluent').ok, false);
check('a single option is not a scale', X.chooseLevel(['Fluent'], 'fluent').ok, false);
check('no level set → nothing chosen', X.chooseLevel(SIMPLE, '').ok, false);
check('beginner on a scale that starts at Advanced is left',
  X.chooseLevel(['Advanced', 'Fluent'], 'beginner').ok, false);

/* ---------------- abilities ---------------- */

check('Reading', X.abilityKeyFor('Reading*'), 'reading');
check('Writing', X.abilityKeyFor('Writing Proficiency'), 'writing');
check('Speaking', X.abilityKeyFor('Speaking'), 'speaking');
check('Comprehension', X.abilityKeyFor('Listening / Comprehension'), 'comprehension');
check('a lone Proficiency dropdown has no specific key', X.abilityKeyFor('Language Proficiency'), null);

const LANG = { language: 'Esperanto', overall: 'advanced', reading: 'fluent', writing: '', speaking: '' };
check('per-skill level used where set', X.levelFor(LANG, 'Reading'), 'fluent');
check('overall used where the skill is blank', X.levelFor(LANG, 'Writing'), 'advanced');
check('overall used for a single dropdown', X.levelFor(LANG, 'Proficiency'), 'advanced');
check('fluent checkbox: advanced is not fluent', X.isFluent(LANG), false);
check('fluent checkbox: native is', X.isFluent({ overall: 'native' }), true);

check('same language with a region', X.sameLanguage('Esperanto', 'Esperanto (Standard)'), true);
check('different languages', X.sameLanguage('Esperanto', 'Volapük'), false);

/* ---------------- websites ---------------- */

check('scheme added when missing', X.withScheme('example.org/someone'), 'https://example.org/someone');
check('scheme kept when present', X.withScheme('http://example.org'), 'http://example.org');
check('same url despite scheme, www and trailing slash',
  X.sameUrl('https://www.example.org/someone/', 'example.org/someone'), true);
check('different paths differ', X.sameUrl('https://example.org/a', 'https://example.org/b'), false);
check('blank never equals blank', X.sameUrl('', ''), false);
check('website list: ordered, deduped, blanks dropped',
  X.websiteList({ websites: { linkedin: 'example.org/in/x', github: '', portfolio: 'https://example.org/in/x/', other: 'example.net' } }),
  [{ kind: 'linkedin', url: 'https://example.org/in/x' }, { kind: 'other', url: 'https://example.net' }]);

/* ---------------- entries ---------------- */

check('an empty education slot is not an entry', X.hasEducation({ school: '', degree: [], fieldOfStudy: [] }), false);
check('a ladder alone makes it one', X.hasEducation({ school: '', degree: ['Some Degree'] }), true);
check('school names compare loosely', X.sameSchool('Example State University', 'example state university'), true);
check('different schools do not', X.sameSchool('Example State University', 'Sample Tech Institute'), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
