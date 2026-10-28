/**
 * questions.js — deciding how to answer an application question.
 *
 * ── THE RULE THAT SHAPES THIS FILE ──────────────────────────────────
 *
 * An earlier design stored one answer per question, keyed by the question text
 * with company names stripped out. That is wrong, and wrong in a way that
 * produces confidently false answers:
 *
 *     "Have you ever worked for Vertex Dynamics?"    -> No
 *     "Have you ever worked for Google?"  -> Yes
 *
 * Both reduce to the same signature. Storing either answer makes the other
 * wrong. The lesson generalises:
 *
 *     If you had to redact something to make two questions look alike, the
 *     answer depends on the thing you redacted. Such a question must be
 *     COMPUTED from data, never recalled from a table.
 *
 * So questions fall into four buckets, checked in order:
 *
 *   1. SENSITIVE  never answered automatically. Legal declarations and
 *                 protected characteristics. Always left for the user.
 *   2. DERIVED    computed from structured profile data. Correct per company
 *                 because the company is an input, not something redacted away.
 *   3. PREFERENCE a stable fact about you that genuinely does not vary by
 *                 employer ("willing to relocate"). Read from the profile.
 *   4. RECALLED   fuzzy match against questions you have answered before.
 *                 ONLY permitted when the signature contains no variable —
 *                 enforced, not merely documented. See resolve().
 *
 * Anything unmatched is left blank and reported. Refusing is always allowed.
 */

AF.questions = {};

/* ------------------------------------------------------------------ */
/* 1. sensitive — never automated                                     */
/* ------------------------------------------------------------------ */

/**
 * Questions the extension must never answer, even if the profile could.
 *
 * Work authorisation and sponsorship are on this list for automation purposes
 * but ARE derivable — see DERIVED below. The distinction: they are answered
 * only from a field the user set deliberately and explicitly, never inferred,
 * and never recalled from a previous application.
 */
AF.questions.SENSITIVE = [
  /convict|criminal|felony|misdemeanou?r|arrest|offen[cs]e|background check/i,
  /disab(led|ility)|impairment|accommodation/i,
  /veteran|military service|armed forces|protected veteran/i,
  /\b(race|ethnicity|ethnic origin|gender|sex|sexual orientation)\b/i,
  /\bhispanic|latino\b/i,
  /eeo|equal employment|affirmative action|self.?identif/i,
  /salary history|current (salary|compensation)/i, // illegal to ask in many states
  /\bage (range|group|bracket)\b|how old\b|\byour (current )?age\b|^age\s*\??$/i,
  /transgender|\bpronouns?\b/i,
  /communit(y|ies) .*identify|lgbt|queer/i,
];

AF.questions.isSensitive = (text) =>
  AF.questions.SENSITIVE.some((re) => re.test(String(text ?? '')));

/* A saved 'YYYY-MM-DD' strictly before today's calendar date. Today itself is
 * still a valid start. */
function startDatePassed(startDate, today) {
  const t = today ?? new Date();
  const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(startDate ?? '')) && startDate < iso;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Strip the trailing required-marker and whitespace Workday adds to labels. */
AF.questions.cleanQuestion = function (text) {
  return String(text ?? '')
    .replace(/\*+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * The question itself, out of whatever surrounds it.
 *
 * Some tenants put a policy statement in the label and the question at its
 * end — Initrode's runs to 2,000 characters before "Are you a relative of
 * a current Public Official?". Matched whole, the preamble's "employee of a
 * government" would steer the rules and swamp a recall match. So past 300
 * characters the question is the last sentence that ends in "?", or the last
 * 300 characters when none does.
 */
AF.questions.questionCore = function (text) {
  const clean = AF.questions.cleanQuestion(text);
  if (clean.length <= 300) return clean;
  const end = clean.lastIndexOf('?');
  if (end < 0) return clean.slice(-300).trim();
  const head = clean.slice(0, end);
  const start = Math.max(...['. ', '? ', '! ', ': '].map((p) => head.lastIndexOf(p)));
  return clean.slice(start < 0 ? 0 : start + 2, end + 1).trim();
};

/**
 * Does the profile's employer list include `org`?
 *
 * Fuzzy, because "Vertex Dynamics" on the application and "Vertex Dynamics, Inc." in your history are
 * the same company. Uses the same scorer as everything else, so the refusal
 * behaviour is consistent.
 */
AF.questions.hasWorkedFor = function (employers, org) {
  if (!org || !Array.isArray(employers) || employers.length === 0) return false;
  const hit = AF.bestMatch(employers, [org], { threshold: 0.75, floor: 0.75 });
  return !!hit;
};

/** Tri-state profile flags: 'yes' | 'no' | '' (unset → do not answer). */
function flag(value) {
  const v = AF.normalizeText(value);
  if (v === 'yes' || v === 'true') return 'Yes';
  if (v === 'no' || v === 'false') return 'No';
  return null;
}

/* ------------------------------------------------------------------ */
/* 2. derived — computed, company-aware                               */
/* ------------------------------------------------------------------ */

/**
 * Each entry captures the varying part of the question rather than redacting
 * it. `extract` pulls the company (or other variable) straight out of the
 * question text, which is more reliable than sniffing it from the page.
 */
AF.questions.DERIVED = [
  {
    /* Any consent question — Yes, for every employer, whatever it is about
     * (the user's rule, 2026-10-13): "Do you consent to receive follow up
     * communication via SMS WhatsApp from Talent Acquisition…?", "Opt in to
     * text updates", "I agree to receive emails about new roles". Read by the
     * flavour word, consent, not the sentence. First, so "consent to being
     * referred to other roles" is not read as a referral. Sensitive questions
     * are matched before any rule, so "consent to a background check" is
     * still left for the user. */
    id: 'consentDefault',
    yesNo: true,
    test: /\bconsent(s|ed|ing)?\b|\bopt(ing)?[\s-]?in\b|\b(agree|happy|wish|like|willing)\b.{0,20}\b(receive|be contacted|be texted|hear from)\b|\b(may|can) (we )?(contact|text|call|e-?mail|message) you\b/i,
    resolve: () => 'Yes',
    explain: () => 'consent: defaults to Yes',
  },

  {
    /* Conflict-of-interest and anti-bribery questions — always No, by the
     * user's decision (2026-10-13). Vandelay Capital asks six in a row:
     *   "Were you referred or recommended for this position by a Government Official?"
     *   "Are you an Immediate Family Member or Close Associate of any Government Official…?"
     *   "…are you subject to any post-employment restrictions (… cooling off period …)?"
     *   "…have you had the ability to directly or indirectly influence the award of business…?"
     *   "Are you currently, or have you been in the past three years, a Government Official…?"
     * Read by their flavour words, not their sentences, so the next tenant's
     * wording lands here too. First in the list: "employed by a financial
     * regulator" must not reach formerEmployee. Never "official" alone —
     * "official transcripts" is not a conflict of interest. */
    id: 'conflictOfInterest',
    yesNo: true,
    test: /\b(government|public|foreign|elected|political|state|municipal|local)\s+(officials?|officers?|employees?|entity|agency|body)\b|politically exposed|\bPEP\b|financial regulator|regulatory (body|agency|authority)|close (personal )?associates?|immediate family|family members?|\brelatives?\b|\bspouse\b|domestic partner|\b(referred|recommended)\b|\binfluence\b|decision.?making authority|award of business|post.?employment restrictions?|cooling.?off|recusal|conflicts? of interest/i,
    resolve: () => 'No',
    explain: () => 'defaults to No',
  },

  {
    id: 'formerEmployee',
    /* Phrasings seen in the wild, all of which must reach this rule:
     *   "Have you ever worked for X as a full-time or temporary employee?"
     *   "Have you previously been employed at X?"
     *   "Are you a former employee of X?"
     *   "Did you work for X?"
     * The {0,25} gap absorbs "ever", "previously been", "at any time" etc.
     * Deliberately does NOT start with a bare "are you", which would drag in
     * "are you willing to work weekends". */
    test: /(?:have you|did you|were you|do you).{0,25}(?:worked?|working|employed|employee)\b|(?:former|previous|current)\s+employee\b/i,
    orgFrom: [
      /* Not "with": "worked with Salesforce / children" is about experience. */
      /\b(?:worked?|employed)\s+(?:for|at|by)\s+(.+?)(?:\s+(?:as|in|during)\b|[?.,]|$)/i,
      /\b(?:former|previous)\s+employee\s+(?:of|at|with)\s+(.+?)(?:[?.,]|$)/i,
    ],
    requires: 'employers',
    unclear: 'could not tell which company this asks about',
    /* No unless the company — or a brand the question names with it, as in
     * "Acme Bakery or affiliated brands (Bagel Barn, Bean Co)" — is one you
     * worked for. An empty employer list is a No, not a refusal: the user's
     * call, 2026-10-12, since the odds a "No" is wrong are slim. */
    resolve: ({ profile, org, affiliates = [] }) => {
      if (!org) return null; // cannot tell which company; leave it
      const employers = Array.isArray(profile.employers) ? profile.employers : [];
      return [org, ...affiliates].some((n) => AF.questions.hasWorkedFor(employers, n)) ? 'Yes' : 'No';
    },
    explain: ({ org, answer }) =>
      answer === 'Yes'
        ? `"${org}" (or a brand named with it) is in your employment history`
        : `"${org}" is not in your employment history`,
  },

  {
    /* "Current employer", "Most recent company", "Current or most recent
     * employer name" — the top line of "Companies you've worked for". Short
     * label shapes only, anchored: "Why do you want to leave your current
     * employer?" and "Have you worked at X?" are other questions. Owned here,
     * so never recalled; an empty list leaves the field. */
    id: 'currentEmployer',
    test: /^(?:current|most recent|latest)(?:\s*\(?\s*(?:or|\/)\s*(?:most recent|current|latest)\s*\)?)?\s+(?:employer|company)(?:\s+name)?\s*[?:*]*$/i,
    requires: 'employers',
    resolve: ({ profile }) =>
      (Array.isArray(profile.employers) ? profile.employers : []).map((e) => String(e ?? '').trim()).find(Boolean) ?? null,
    explain: () => 'the first company in your employment history',
  },

  {
    id: 'relativeEmployed',
    yesNo: true,
    test: /(relative|family member|friend|acquaintance).{0,40}(employ|work)/i,
    resolve: () => 'No',
    explain: () => 'defaults to No',
  },

  {
    /* "Any agreements with your current or former employer(s) that could
     * prohibit or limit your employment with X? (non-compete, non-solicit…)",
     * "Are you under a non-compete…?" — No unless the user answers otherwise. */
    id: 'restrictiveAgreement',
    yesNo: true,
    test: /non.?compete|non.?solicit|restrictive covenant|agreements?\b.{0,80}\b(prohibit|limit|restrict|preclude|prevent)/i,
    resolve: () => 'No',
    explain: () => 'defaults to No',
  },

  {
    /* "Are you a relative of a current Public Official?", "…of a senior level
     * person for a company other than X?" — always No. */
    id: 'relativeOfOfficial',
    yesNo: true,
    test: /\brelative of\b.{0,80}\b(official|officer|executive|senior|director|board)|\brelated to\b.{0,60}\b(official|officer|executive|employee)/i,
    resolve: () => 'No',
    explain: () => 'defaults to No',
  },

  {
    /* Export-control screening: "Is your most recent country of citizenship or
     * permanent residency one of: North Korea; Syria; Iran; or Cuba?" — No
     * (the user's rule, 2026-10-27). Needs both a sanctioned country and a
     * citizenship / residency word, so a question that only names one of
     * these countries elsewhere is left alone. */
    id: 'embargoedCountry',
    yesNo: true,
    test: /^(?=.*\b(north korea|syria|iran|cuba)\b)(?=.*\b(citizen|nationality|national|residen)).*/i,
    resolve: () => 'No',
    explain: () => 'defaults to No',
  },

  {
    id: 'over18',
    test: /\b(18 years|eighteen|at least 18|over 18|age of 18|legal working age)\b/i,
    requires: 'over18',
    /* Unset → Yes: the user's default, 2026-10-13. The popup switch wins. */
    resolve: ({ profile }) => flag(profile.over18) ?? 'Yes',
    explain: () => 'from your profile (Yes unless you set it)',
  },

  {
    id: 'workAuthorization',
    // Deliberately derived-only. Never recalled, never inferred.
    test: /(legally (authoriz|entitl)|authoriz(ed|ation) to work|right to work|eligible to work)/i,
    requires: 'workAuthorized',
    /* Unset → Yes: the user's default, 2026-10-13. The popup switch wins. */
    resolve: ({ profile }) => flag(profile.workAuthorized) ?? 'Yes',
    explain: () => 'from your profile (Yes unless you set it)',
  },

  {
    id: 'sponsorship',
    // Note the polarity trap: "will you REQUIRE sponsorship" is the opposite of
    // "are you authorised". Kept as its own entry with its own profile field so
    // the two can never be conflated.
    test: /(require|need|request).{0,30}(sponsor|visa|h-?1b|work permit)|sponsorship (now|in the future)/i,
    requires: 'needsSponsorshipNow',
    /* Two answers since 2026-10-13: sponsorship to commence employment, and
     * in the future. A question that names only one gets that one; "now or in
     * the future", or one that names neither, is Yes if either is. Each is No
     * when unset (the user's default); the popup switches win. */
    resolve: ({ profile, question = '' }) => {
      const { now, future } = AF.questions.sponsorshipFlags(profile);
      const asksFuture = /\bfuture\b|\blater\b|\bat any (point|time)\b|\bany time\b/i.test(question);
      const asksNow = /\b(commence|begin|start)\w*\b|\bnow\b|\bcurrent(ly)?\b|\bat this time\b|\bat the time of\b|\bupon hire\b|\bimmediately\b/i.test(question);
      if (asksFuture && !asksNow) return future;
      if (asksNow && !asksFuture) return now;
      return now === 'Yes' || future === 'Yes' ? 'Yes' : 'No';
    },
    explain: () => 'from your sponsorship answers (No unless you set them)',
  },
];

/** How the user is authorized to work — picks among several "Yes" rows.
 *  'citizen' | 'permanentResident' | 'visa' | '' (unknown). The popup's
 *  "Work authorization basis" wins; otherwise needing sponsorship (now or
 *  later) means a visa. */
AF.questions.workAuthBasis = (profile = {}) => {
  const set = String(profile.workAuthBasis ?? '').trim();
  if (['citizen', 'permanentResident', 'visa'].includes(set)) return set;
  const { now, future } = AF.questions.sponsorshipFlags(profile);
  return now === 'Yes' || future === 'Yes' ? 'visa' : '';
};

/** The two sponsorship answers, Yes/No each. A profile from before the split
 *  has only `needsSponsorship`, which then stands for both. */
AF.questions.sponsorshipFlags = (profile = {}) => {
  const old = flag(profile.needsSponsorship);
  return {
    now: flag(profile.needsSponsorshipNow) ?? old ?? 'No',
    future: flag(profile.needsSponsorshipFuture) ?? old ?? 'No',
  };
};

/* ------------------------------------------------------------------ */
/* 3. preferences — stable, employer-independent                      */
/* ------------------------------------------------------------------ */

AF.questions.PREFERENCES = [
  {
    id: 'willingToRelocate',
    test: /willing to relocat|open to relocat|able to relocat|consider relocat/i,
    requires: 'willingToRelocate',
    resolve: ({ profile }) => flag(profile.willingToRelocate),
  },
  {
    id: 'willingToTravel',
    test: /willing to travel|able to travel|comfortable.{0,20}travel/i,
    requires: 'willingToTravel',
    resolve: ({ profile }) => flag(profile.willingToTravel),
  },
  {
    /* A date picker wants a date, not "2 weeks": answered from the saved start
     * date. A text box still falls through to noticePeriod below. */
    id: 'startDate',
    widget: 'date',
    test: /notice period|when (can|could) you start|earliest start|availability to start|start date/i,
    requires: 'startDate',
    resolve: ({ profile, today }) => {
      const m = String(profile.startDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m || startDatePassed(profile.startDate, today)) return null;
      return mmddyyyy(new Date(+m[1], +m[2] - 1, +m[3]));
    },
    /* Why a null: a date that has gone by, as opposed to one never saved. */
    whyNot: ({ profile, today }) => startDatePassed(profile.startDate, today)
      ? 'your saved start date has passed — update it in the popup' : null,
  },
  {
    id: 'noticePeriod',
    test: /notice period|when (can|could) you start|earliest start|availability to start/i,
    requires: 'noticePeriod',
    resolve: ({ profile }) => profile.noticePeriod || null,
  },
  {
    id: 'expectedSalary',
    test: /salary|compensation (expectation|requirement|range)|expected (pay|compensation)|desired (pay|compensation)|pay (expectation|range|requirement)/i,
    requires: 'expectedSalary',
    resolve: ({ profile }) => String(profile.expectedSalary ?? '').trim() || null,
  },
];

/* ------------------------------------------------------------------ */
/* 3c. self-identification — saved answers, disclosure pages only      */
/* ------------------------------------------------------------------ */

/**
 * The demographic questions, answered from what the user saved on purpose in
 * the popup — never learned, never guessed. Only on SELF_ID_PAGES or when
 * ctx.selfId is true; anywhere else the same wording is SENSITIVE and left alone.
 *
 * `field` is the Workday formField id (stable across tenants) and is checked
 * first: the veteran question's label is a page of VEVRAA text that also says
 * "disability". `options` map a saved value onto a tenant's wording; "decline"
 * is shared (DECLINE).
 */
/* An adapter page can instead set `selfId: true` (ctx.selfId). The list stays for Workday.
   Application Questions too: tenants ask veteran status there (Dexcom, 2026-10-13). */
AF.questions.SELF_ID_PAGES = ['voluntaryDisclosures', 'selfIdentify', 'applicationQuestions'];

const DECLINE = /not wish|n[’']?t wish|decline|prefer not|rather not|do not want|don[’']?t want|choose not|not to (answer|disclose|self)|not declared|not specified/i;

AF.questions.SELF_ID = [
  { id: 'eeoGender', field: /^gender$/i, test: /\bgender\b|\bsex\b/i,
    options: { male: /^(male|man)\b/i, female: /^(female|woman)\b/i, nonbinary: /non.?binary/i } },
  { id: 'eeoHispanic', field: /^hispanicOrLatino$/i, test: /hispanic|latin[oax]/i,
    options: { yes: /^yes\b/i, no: /^no\b/i } },
  { id: 'eeoEthnicity', field: /^ethnicity/i, test: /\brace\b|ethnic/i,
    options: { asian: /\basian\b/i, black: /black|african/i, white: /\bwhite\b/i,
      nativeAmerican: /american indian|alaska/i, pacificIslander: /hawaiian|pacific islander/i,
      twoOrMore: /two or more/i,
      /* Every other race on Workday's list says "(Not Hispanic or Latino)". */
      hispanic: { match: /hispanic|latin/i, not: /\bnot hispanic|non.?hispanic/i } } },
  { id: 'eeoVeteran', field: /^veteranStatus$/i, test: /veteran/i,
    /* Never "I am a veteran, but not a protected veteran" — that declares
     * service. A list with "I am not a veteran" gets that row. */
    options: { notVeteran: [
      /* Never served: "I am not a veteran" first, then "not a protected veteran". */
      /\bnot a veteran\b/i,
      { match: /\bnot a (protected )?veteran\b|\bi am not\b/i, not: /\bam a veteran\b|veteran,? but\b/i },
    ],
      protectedVeteran: { match: /identify as (one or more|a protected)|\bprotected veteran\b/i, not: /\bnot\b/i } } },
  { id: 'eeoDisability', field: /^disabilityStatus$/i, test: /disabilit/i,
    options: { yes: /^yes\b/i, no: /^no\b/i } },
];

/* ------------------------------------------------------------------ */
/* 3d. sign-offs and follow-ups                                        */
/* ------------------------------------------------------------------ */

const fullName = (p = {}) =>
  [p.firstName, p.lastName].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ') || null;
const mmddyyyy = (d) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

/**
 * Filled, by the user's decision (2026-10-12): they submit the application
 * themselves, so a consent box, a typed-name signature and the date signed
 * are theirs to have filled. Each is reported as "signed". Matched per widget,
 * so a "Name" text box is a signature only on Self Identify.
 */
AF.questions.SIGN_OFFS = [
  /* A tick, or — on tenants that ask it as a dropdown — the Yes / I Agree row. */
  { id: 'consent', widget: ['checkbox', 'listbox', 'choice'],
    /* An opt-in is not a sign-off — it is still a Yes, from the consent rule
     * in DERIVED, but it is not reported as "signed". */
    test: (q) => /terms and conditions|\bi (have read|agree|acknowledge|certify|consent|attest|understand|verify|confirm|affirm)\b|electronic(ally)? sign|\bcertif|truthful|true and (accurate|correct|complete)|accurate and complete/i.test(q) &&
      !/marketing|promotional|newsletter|text messages|\bsms\b|opt.?in|subscribe/i.test(q),
    resolve: () => 'Yes', explain: () => 'ticked for you as a sign-off' },
  { id: 'signatureName', widget: 'text',
    test: (q, ctx) => /signature|\b(enter|type) your (full |legal )?name\b/i.test(q) ||
      (ctx.page === 'selfIdentify' && /^(your )?(full |legal )?name$/i.test(q)),
    resolve: ({ profile }) => fullName(profile), explain: () => 'your name, as a signature' },
  { id: 'signatureDate', widget: 'date',
    test: (q, ctx) => /\bsign/i.test(q) || (ctx.page === 'selfIdentify' && /^(today'?s )?date$/i.test(q)),
    resolve: ({ today }) => mmddyyyy(today ?? new Date()), explain: () => "today's date, as the date signed" },
];

/* "If yes, …" — answered N/A only when the question above was answered No. */
const FOLLOW_UP = /^(?:if (?:yes|so)|if you answered yes|if applicable)\b/i;

/**
 * Which rule owns a question, if any. Shared by resolve() (to answer) and
 * signature() (to refuse learning anything a rule already answers).
 */
/* Legal declarations with a profile field of their own. Checked before
 * sign-offs, so "I certify that I am legally authorized to work" follows the
 * field the user set rather than being ticked as a formality. */
const DECLARATIONS = ['workAuthorization', 'sponsorship', 'over18'];

AF.questions.matchRule = function (question, ctx = {}) {
  const { page, widget, fieldId = '', selfId = false } = ctx;
  /* A saved self-id value is a choice, never text to type into a box. */
  if ((selfId === true || AF.questions.SELF_ID_PAGES.includes(page)) && widget !== 'text') {
    const rule = AF.questions.SELF_ID.find((r) => r.field.test(fieldId)) ??
      AF.questions.SELF_ID.find((r) => r.test.test(question));
    if (rule) return { kind: 'self-id', rule };
  }
  /* Sensitive before sign-offs: "I certify that I have never been convicted"
   * is a legal declaration, not a box to tick for the user. */
  if (AF.questions.isSensitive(question)) return { kind: 'sensitive', rule: null };
  const declaration = AF.questions.DERIVED.find((r) => DECLARATIONS.includes(r.id) && r.test.test(question));
  if (declaration) return { kind: 'derived', rule: declaration };
  const signOff = AF.questions.SIGN_OFFS.find((r) => [].concat(r.widget).includes(widget) && r.test(question, ctx));
  if (signOff) return { kind: 'sign-off', rule: signOff };
  if (FOLLOW_UP.test(question)) return { kind: 'follow-up', rule: null };
  /* A Yes/No default never goes into a text box: "Referred by (name)" is not a "No". */
  const derived = AF.questions.DERIVED.find((r) => !(r.yesNo && widget === 'text') &&
    (!r.widget || [].concat(r.widget).includes(widget)) &&
    r.test.test(question) && ownsQuestion(r, question));
  if (derived) return { kind: 'derived', rule: derived };
  const preference = AF.questions.PREFERENCES.find((r) =>
    (!r.widget || [].concat(r.widget).includes(widget)) && r.test.test(question));
  if (preference) return { kind: 'preference', rule: preference };
  return null;
};

/**
 * Which of a widget's options carries a decision → its index, or -1.
 *
 * Self-id values are semantic ("decline", "notVeteran") and are found by the
 * patterns above, never by a decline row standing in for a real answer. Other
 * answers: exact text, then a row that starts with it ("Yes, I have…"), then
 * an N/A row for N/A, then — never for a bare Yes/No — the closest wording.
 */
/* Rows that say Yes or No in other words. */
const AFFIRM = /^(yes|y|sure|ok(ay)?|absolutely|i do|i am|i will|i would|i('| a)?m (happy|willing)|i (hereby )?(consent|agree|accept|acknowledge|confirm|certify|authori[sz]e|allow|give (my )?(consent|permission)|wish|want|would like)|(consent|agree|accept|allow|opt[\s-]?in|subscribe)\b)/i;
const NEGATE = /^(no|n)\b|\b(not|don[’']?t|do not|decline|disagree|opt[\s-]?out|refuse|unsubscribe|withdraw|never)\b/i;

AF.questions.pickOption = function (options, decision) {
  const texts = (options ?? []).map((t) => String(t ?? '').trim());
  if (!decision?.answer || !texts.length) return -1;

  if (decision.source === 'self-id') {
    if (decision.answer === 'decline') return texts.findIndex((t) => DECLINE.test(t));
    const spec = AF.questions.SELF_ID.find((r) => r.id === decision.rule)?.options?.[decision.answer];
    if (!spec) return -1;
    /* An array is a preference order: the first pattern any option meets wins. */
    for (const one of [].concat(spec)) {
      const { match, not } = one instanceof RegExp ? { match: one } : one;
      const i = texts.findIndex((t) => match.test(t) && !DECLINE.test(t) && !(not && not.test(t)));
      if (i >= 0) return i;
    }
    return -1;
  }

  /* A sign-off as a dropdown: "Yes", or "I Agree" / "I Accept" — never the
   * "I Do Not Agree" row. */
  if (decision.source === 'sign-off' && decision.answer === 'Yes') {
    return texts.findIndex((t) => /^(yes|(i )?(agree|accept|certify|verify|confirm|acknowledge))\b/i.test(t) &&
      !/\b(not|don[’']?t|disagree|decline)\b/i.test(t));
  }

  /* "Yes - I have US work authorization as a Citizen…" / "Yes - … via a
   * non-immigrant visa…": with more than one Yes row, the right one depends on
   * HOW the user is authorized (decision.basis). Unknown, or no row for it,
   * picks nothing rather than a guess. */
  if (decision.source === 'derived' && decision.rule === 'workAuthorization' && decision.answer === 'Yes') {
    const yesRows = texts.map((t, i) => (/^yes\b/i.test(t) || (AFFIRM.test(t) && !NEGATE.test(t)) ? i : -1)).filter((i) => i >= 0);
    if (yesRows.length > 1) {
      const rowFor = (re) => yesRows.find((i) => re.test(texts[i])) ?? -1;
      switch (decision.basis) {
        case 'visa': return rowFor(/visa|non-?immigrant|\bf-?1\b|\bh-?1b\b|\bopt\b|\bead\b|\bl-?1\b|\btn\b|sponsor/i);
        case 'citizen': return rowFor(/citizen/i);
        case 'permanentResident': {
          const i = rowFor(/permanent resident|green card/i);
          return i >= 0 ? i : rowFor(/citizen/i);
        }
        default: return -1;
      }
    }
  }

  const norm = texts.map((t) => AF.normalizeText(t));
  const want = AF.normalizeText(decision.answer);
  let i = norm.indexOf(want);
  if (i < 0) i = norm.findIndex((t) => t.startsWith(`${want} `));
  if (i < 0 && want === 'n a') i = texts.findIndex((t) => /^(n\/?a|not applicable)\b/i.test(t));
  /* No "Yes" or "No" row: take the row that says it — "I consent", "I agree",
   * "Opt in", "I would like to" for a Yes; "I do not consent", "Opt out" for
   * a No (the user's rule, 2026-10-13). A Yes never takes a row that negates. */
  if (i < 0 && want === 'yes') i = texts.findIndex((t) => AFFIRM.test(t) && !NEGATE.test(t));
  if (i < 0 && want === 'no') i = texts.findIndex((t) => NEGATE.test(t));
  if (i < 0 && !/^(yes|no)$/.test(want)) {
    i = AF.bestMatch(texts, [decision.answer], { threshold: 0.75, floor: 0.75 })?.index ?? -1;
  }
  return i;
};

/** Why a decision found no row, for the drivers' "left" report. */
AF.questions.optionReason = (decision) =>
  decision?.rule === 'workAuthorization' && decision.answer === 'Yes' && 'basis' in decision
    ? 'no "Yes" row fits — set "Work authorization basis" in the popup'
    : `"${decision?.answer}" is not one of the options`;

/* ------------------------------------------------------------------ */
/* 3b. visa explanation — prose, not a tier                           */
/* ------------------------------------------------------------------ */

/**
 * Some applications ask for the visa story in prose rather than Yes/No:
 * "Please explain your visa status". That is a different shape of answer from
 * everything above — a saved paragraph, dropped into a textarea — so it is
 * deliberately NOT a DERIVED rule. Keeping it out of resolve() means the radio
 * group tiers are untouched and can never be handed 60 words of prose.
 *
 * ── WHY BOTH HALVES ARE REQUIRED ────────────────────────────────────
 * A match needs a visa/work-authorisation TOPIC *and* a request for an
 * EXPLANATION. Topic alone is not enough, and the reason is the sponsorship
 * question:
 *
 *     "Will you now or in the future require visa sponsorship?"   → Yes/No
 *     "If you require sponsorship, please provide details"        → prose
 *
 * Both say "sponsorship". Only the second wants a paragraph. Matching on topic
 * alone would paste a personal legal statement over a Yes/No question that the
 * `sponsorship` rule already answers correctly.
 */
const VISA_TOPIC =
  /visa|immigration|work\s+(?:authoriz|authoris|permit)|sponsor|h-?1b|\bopt\b|\bstem\b|\bead\b|green\s*card|citizenship status/i;

const WANTS_PROSE =
  /explain|describe|detail|elaborate|specify|comment|provide (?:more )?information|tell us (?:more|about)/i;

AF.questions.wantsVisaExplanation = function (text) {
  const question = AF.questions.cleanQuestion(text);
  if (!question) return false;
  return VISA_TOPIC.test(question) && WANTS_PROSE.test(question);
};

/**
 * The saved explanation, or a refusal saying how to fix it.
 *
 * Declines on an empty field rather than writing '' — same contract as every
 * other declaration here. A blank answer looks filled and is not.
 *
 * @returns { text: string|null, reason: string }
 */
AF.questions.visaExplanationFor = function (profile = {}) {
  const text = String(profile.visaExplanation ?? '').trim();
  if (!text) {
    return {
      text: null,
      reason: 'add your visa status explanation in the extension popup, on the Profile tab',
    };
  }
  return { text, reason: 'your saved visa status explanation' };
};

/* ------------------------------------------------------------------ */
/* signatures — for the recall tier                                   */
/* ------------------------------------------------------------------ */

/* "our company", "this organization" — the company asking, whoever it is. */
const COMPANY_PHRASES = /\b(?:our|this) (?:company|organi[sz]ation|firm)\b/g;

/**
 * Replace the company asking with "[company]", so one answer serves every
 * employer: "Are you comfortable with Acme Bakery's dress code?" and the same
 * question from Globex share a signature.
 *
 * The company is the Workday tenant slug ("acmebakery"), matched only when a
 * run of up to four words squashes to it EXACTLY — a prefix match turned
 * "United States" into the company on a "statestreet" tenant.
 *
 * Questions whose answer depends on the company ("Have you worked for X?")
 * never reach this: matchRule owns them, and owned questions are not learned.
 */
AF.questions.swapCompany = function (normalized, company) {
  const out = String(normalized ?? '').replace(COMPANY_PHRASES, '[company]');
  const slug = AF.normalizeText(company).replace(/\s+/g, '');
  if (slug.length < 4) return out;
  const tokens = out.split(' ');
  const res = [];
  for (let i = 0; i < tokens.length; ) {
    let took = 0;
    for (let len = Math.min(4, tokens.length - i); len >= 1; len--) {
      if (tokens.slice(i, i + len).join('') === slug) { took = len; break; }
    }
    if (!took) { res.push(tokens[i++]); continue; }
    res.push('[company]');
    i += took;
    if (tokens[i] === 's') i++; // "Acme Bakery's" → normalized "acme bakery s"
  }
  return res.join(' ');
};

/**
 * A question's identity for recall: its core, normalised, company swapped.
 *
 * Not recallable when a rule owns it (sensitive, self-identification, sign-off,
 * follow-up, derived, preference) — those are answered fresh every time.
 */
/* Your history WITH this company — applied, interviewed, referred. True at
 * one employer, false at the next, so never learned, whatever the company is
 * called in the question. (Not "non-compete": "are you under a non-compete
 * that would preclude this role?" is about your existing agreements and has
 * the same answer everywhere.) */
const COMPANY_HISTORY = /\b(appl(y|ied)|interview\w*|referr?\w*)\b/i;

/* A written answer to "why / explain / describe" is about one company. */
const WRITTEN = /\b(why|explain|describe|elaborate|tell us)\b/i;

AF.questions.signature = function (text, ctx = {}) {
  const question = AF.questions.questionCore(text);
  const company = ctx.company ??
    // A site that names no company means none — never fall through to the hostname.
    (typeof AF.currentCompany === 'function' ? AF.currentCompany() : AF.tenantFromHostname?.()) ?? '';
  const signature = AF.questions.swapCompany(AF.normalizeText(question), company);
  const m = question ? AF.questions.matchRule(question, ctx) : null;
  const refusal = m
    ? (m.kind === 'sensitive' ? 'sensitive' : `worked out by a rule (${m.rule?.id ?? m.kind})`)
    : COMPANY_HISTORY.test(question)
      ? 'your history with one company does not carry to another'
      : ctx.widget === 'text' && WRITTEN.test(question)
        ? 'a written answer is about one company'
        : null;
  return { signature, recallable: !!signature && !refusal, reason: refusal };
};

/* ------------------------------------------------------------------ */
/* resolution                                                         */
/* ------------------------------------------------------------------ */

function extractOrg(rule, text) {
  for (const re of rule.orgFrom ?? []) {
    const m = text.match(re);
    if (m?.[1]) {
      return m[1]
        /* A parenthetical defines the company, it is not part of its name:
         *   "Acme Insurance (including any company affiliated with or acquired
         *    by Acme Insurance)"
         * Left in, it both mangles the name shown back to the user and lets an
         * affiliate named in the brackets score a match the user never earned. */
        .replace(/\s*\(.*$/, '')
        /* "Acme Bakery or affiliated brands" → "Acme Bakery": the brands are
         * read separately, from the parentheses (extractAffiliates). */
        .replace(/\s+(?:or|and)\s+(?:its\s+|any\s+)?(?:affiliat|subsidiar|related|sister|parent)\w*\b.*$/i, '')
        /* Trailing qualifier: "Initech as of 2019", "Globex the parent company".
         * The leading \s+ is load-bearing — without it "Acme Insurance" matched
         * "the" at position 0 and the whole name was deleted, which is how this
         * question came back unanswered on a live application. */
        .replace(/\s+\b(as|an?|the)\b.*$/i, '')
        .replace(/[,.]$/, '')
        .trim();
    }
  }
  return null;
}

/**
 * Does a derived rule really own this question? "Have you worked for X?" only
 * when X reads as a company — a capitalised name, not "the federal
 * government" or "children". Otherwise the question is an ordinary one, left
 * for the user the first time and learnable after.
 */
const looksLikeCompany = (org) =>
  !!org && /^[A-Z0-9]/.test(org) && !/\b(government|military|armed forces|army|navy|air force)\b/i.test(org);

function ownsQuestion(rule, question) {
  if (rule.id !== 'formerEmployee') return true;
  /* "Do you have any relatives employed at X?" is the relatives rule's. */
  if (/\b(relatives?|family members?|friends?|acquaintances?)\b/i.test(question)) return false;
  return looksLikeCompany(extractOrg(rule, question));
}

/**
 * Brands a question names in parentheses: "(Bagel Barn, Bean Co, Crumb House)".
 * Only name-like items — capitalised, at most four words — so a definition
 * such as "(including any company affiliated with or acquired by Acme)" adds
 * nothing.
 */
function extractAffiliates(text) {
  const inside = String(text).match(/\(([^)]*)\)/)?.[1];
  if (!inside) return [];
  return inside
    .split(/,|;|\s+or\s+|\s+and\s+/i)
    .map((s) => s.replace(/^\s*(?:including|e\.?g\.?|such as|i\.e\.?)\s+/i, '').trim())
    .filter((s) => /^[A-Z0-9]/.test(s) && s.split(/\s+/).length <= 4);
}

/**
 * Decide how to answer one question.
 *
 * ctx = { profile, learned, page, widget, fieldId, previous, today, company }
 * — all optional. `page` is the Workday page key, `widget` the field's kind
 * ('listbox' | 'text' | 'checkbox' | 'choice' | 'date'), `previous` the answer
 * to the question just above (for "If yes, …").
 *
 * @returns {
 *   answer:  string|null,
 *   source:  'self-id' | 'sign-off' | 'sensitive' | 'follow-up' | 'derived'
 *            | 'preference' | 'recalled' | 'none',
 *   rule:    string|null,
 *   reason:  string      — shown to the user, always populated
 * }
 *
 * A null answer is a legitimate, expected outcome. Everything about this file
 * is built to make refusing cheap and guessing hard.
 */
AF.questions.resolve = function (text, ctx = {}) {
  const { profile = {}, learned = {} } = ctx;
  const question = AF.questions.questionCore(text);
  if (!question) return { answer: null, source: 'none', rule: null, reason: 'no question text' };

  const m = AF.questions.matchRule(question, ctx);
  switch (m?.kind) {
    case 'self-id': {
      const value = String(profile[m.rule.id] ?? '').trim();
      return value
        ? { answer: value, source: 'self-id', rule: m.rule.id, reason: 'your saved self-identification answer' }
        : { answer: null, source: 'none', rule: m.rule.id,
            reason: "set this in the popup's Self-identification section to fill it" };
    }
    case 'sign-off': {
      const answer = m.rule.resolve({ ...ctx, profile });
      return answer
        ? { answer, source: 'sign-off', rule: m.rule.id, reason: m.rule.explain() }
        : { answer: null, source: 'none', rule: m.rule.id, reason: 'add your first and last name in the popup' };
    }
    case 'sensitive':
      return { answer: null, source: 'sensitive', rule: null,
               reason: 'left for you — this is a legal or protected-characteristic question' };
    case 'follow-up':
      return ctx.previous === 'No'
        ? { answer: 'N/A', source: 'follow-up', rule: 'followUp', reason: 'the question above was answered No' }
        : { answer: null, source: 'none', rule: 'followUp', reason: 'depends on your answer to the question above' };
    case 'derived': {
      const rule = m.rule;
      const org = extractOrg(rule, question);
      const answer = rule.resolve({ profile, org, question, affiliates: extractAffiliates(question) });
      if (answer === null) {
        return {
          answer: null, source: 'none', rule: rule.id,
          reason: !org && rule.unclear
            ? rule.unclear
            : org
              ? `needs your "${rule.requires}" list to answer this for "${org}"`
              : `set "${rule.requires}" in your profile to answer this automatically`
        };
      }
      return { answer, source: 'derived', rule: rule.id,
               reason: rule.explain ? rule.explain({ org, answer }) : 'computed from your profile',
               /* pickOption needs this to choose among several "Yes" rows. */
               ...(rule.id === 'workAuthorization' ? { basis: AF.questions.workAuthBasis(profile) } : {}) };
    }
    case 'preference': {
      const answer = m.rule.resolve({ profile, today: ctx.today });
      return answer === null
        ? { answer: null, source: 'none', rule: m.rule.id,
            reason: m.rule.whyNot?.({ profile, today: ctx.today })
              ?? `set "${m.rule.requires}" in your profile to answer this automatically` }
        : { answer, source: 'preference', rule: m.rule.id, reason: 'from your saved preference' };
    }
  }

  /* recall — only for questions no rule owns. */
  const { signature, recallable, reason } = AF.questions.signature(question, ctx);
  if (!recallable) return { answer: null, source: 'none', rule: null, reason: reason ?? 'not recallable' };

  const keys = Object.keys(learned);
  if (keys.length) {
    const hit = AF.bestMatch(keys, [signature], { threshold: 0.82, floor: 0.82 });
    if (hit) {
      return { answer: learned[hit.text].answer, source: 'recalled', rule: null,
               reason: `you answered this before (${learned[hit.text].seen ?? 1}×)` };
    }
  }
  return { answer: null, source: 'none', rule: null, reason: 'not seen before' };
};

/**
 * Record an answer the user gave by hand.
 * Refuses anything that must not be recalled, so a bad entry cannot be created
 * even by a caller that forgot to check.
 */
AF.questions.remember = function (learned, text, answer, ctx = {}) {
  /* signature() refuses anything a rule owns — "Are you legally authorized to
   * work?" is driven by a field you set, and a learned copy would only be a
   * confusing duplicate in the Answers list that could disagree with it. */
  const { signature, recallable, reason } = AF.questions.signature(text, ctx);
  if (!recallable || !answer) return { stored: false, learned, reason: reason ?? 'no answer' };

  const next = { ...learned };
  const prior = next[signature];
  next[signature] = {
    answer,
    seen: (prior?.seen ?? 0) + 1,
    updated: new Date().toISOString().slice(0, 10),
  };
  return { stored: true, learned: next, signature };
};
