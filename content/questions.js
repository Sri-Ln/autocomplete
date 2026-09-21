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
  /\b(race|ethnicity|ethnic origin|gender identity|sexual orientation)\b/i,
  /\bhispanic|latino\b/i,
  /eeo|equal employment|affirmative action|self.?identif/i,
  /salary history|current (salary|compensation)/i, // illegal to ask in many states
];

AF.questions.isSensitive = (text) =>
  AF.questions.SENSITIVE.some((re) => re.test(String(text ?? '')));

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
      /\b(?:worked?|employed)\s+(?:for|at|with|by)\s+(.+?)(?:\s+(?:as|in|during)\b|[?.,]|$)/i,
      /\b(?:former|previous)\s+employee\s+(?:of|at|with)\s+(.+?)(?:[?.,]|$)/i,
    ],
    requires: 'employers',
    resolve: ({ profile, org }) => {
      if (!org) return null; // cannot answer without knowing which company
      if (!Array.isArray(profile.employers) || profile.employers.length === 0) return null;
      return AF.questions.hasWorkedFor(profile.employers, org) ? 'Yes' : 'No';
    },
    explain: ({ org, answer }) =>
      answer === 'Yes'
        ? `"${org}" is in your employment history`
        : `"${org}" is not in your employment history`,
  },

  {
    id: 'relativeEmployed',
    test: /(relative|family member|friend|acquaintance).{0,40}(employ|work)/i,
    orgFrom: [/\b(?:employed|work(?:s|ing)?)\s+(?:for|at|with)\s+(.+?)(?:[?.,]|$)/i],
    requires: 'relativesAt',
    resolve: ({ profile, org }) => {
      const list = profile.relativesAt;
      if (!Array.isArray(list)) return null;
      if (list.length === 0) return 'No'; // explicitly empty means none
      if (!org) return null;
      return AF.questions.hasWorkedFor(list, org) ? 'Yes' : 'No';
    },
    explain: ({ org, answer }) =>
      answer === 'Yes' ? `you listed a relative at "${org}"` : 'no relatives listed at this company',
  },

  {
    id: 'over18',
    test: /\b(18 years|eighteen|at least 18|over 18|age of 18|legal working age)\b/i,
    requires: 'over18',
    resolve: ({ profile }) => flag(profile.over18),
    explain: () => 'from your profile',
  },

  {
    id: 'workAuthorization',
    // Deliberately derived-only. Never recalled, never inferred.
    test: /(legally (authoriz|entitl)|authoriz(ed|ation) to work|right to work|eligible to work)/i,
    requires: 'workAuthorized',
    resolve: ({ profile }) => flag(profile.workAuthorized),
    explain: () => 'from the work-authorisation field you set',
  },

  {
    id: 'sponsorship',
    // Note the polarity trap: "will you REQUIRE sponsorship" is the opposite of
    // "are you authorised". Kept as its own entry with its own profile field so
    // the two can never be conflated.
    test: /(require|need|request).{0,30}(sponsor|visa|h-?1b|work permit)|sponsorship (now|in the future)/i,
    requires: 'needsSponsorship',
    resolve: ({ profile }) => flag(profile.needsSponsorship),
    explain: () => 'from the sponsorship field you set',
  },
];

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
    id: 'noticePeriod',
    test: /notice period|when (can|could) you start|earliest start|availability to start/i,
    requires: 'noticePeriod',
    resolve: ({ profile }) => profile.noticePeriod || null,
  },
];

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

/* Things whose presence means the answer varies by that thing. A question
 * containing any of these can never be recalled. */
const VARIABLE_MARKERS = [
  /\b(?:for|at|with|of|to)\s+[A-Z][A-Za-z0-9&.\-]*(?:\s+(?:Inc|LLC|Ltd|Corp|Co|Group|Technologies|Labs)\b\.?)?/,
  /\bour\b|\bthis (company|role|position|organi[sz]ation)\b|\bus\b/i,
];

/**
 * A question's identity for recall purposes.
 *
 * Returns { signature, recallable }. `recallable` is false when the question
 * mentions a specific company, refers to "our"/"this company", or is sensitive
 * — because the stored answer would not transfer to the next application.
 */
AF.questions.signature = function (text) {
  const clean = AF.questions.cleanQuestion(text);
  const signature = AF.normalizeText(clean);

  const mentionsSomethingVariable = VARIABLE_MARKERS.some((re) => re.test(clean));
  const sensitive = AF.questions.isSensitive(clean);

  return {
    signature,
    recallable: !!signature && !mentionsSomethingVariable && !sensitive,
    reason: sensitive
      ? 'sensitive'
      : mentionsSomethingVariable
        ? 'refers to a specific employer, so the answer does not transfer'
        : null,
  };
};

/* ------------------------------------------------------------------ */
/* resolution                                                         */
/* ------------------------------------------------------------------ */

function extractOrg(rule, text) {
  for (const re of rule.orgFrom ?? []) {
    const m = text.match(re);
    if (m?.[1]) {
      return m[1]
        .replace(/\b(as|an?|the)\b.*$/i, '')
        .replace(/[,.]$/, '')
        .trim();
    }
  }
  return null;
}

/**
 * Decide how to answer one question.
 *
 * @returns {
 *   answer:  string|null,
 *   source:  'sensitive' | 'derived' | 'preference' | 'recalled' | 'none',
 *   rule:    string|null,
 *   reason:  string      — shown to the user, always populated
 * }
 *
 * A null answer is a legitimate, expected outcome. Everything about this file
 * is built to make refusing cheap and guessing hard.
 */
AF.questions.resolve = function (text, { profile = {}, learned = {} } = {}) {
  const question = AF.questions.cleanQuestion(text);
  if (!question) return { answer: null, source: 'none', rule: null, reason: 'no question text' };

  /* 1. sensitive — before anything else, and without exception. */
  if (AF.questions.isSensitive(question)) {
    return {
      answer: null,
      source: 'sensitive',
      rule: null,
      reason: 'left for you — this is a legal or protected-characteristic question',
    };
  }

  /* 2. derived. */
  for (const rule of AF.questions.DERIVED) {
    if (!rule.test.test(question)) continue;

    const org = extractOrg(rule, question);
    const answer = rule.resolve({ profile, org });

    if (answer === null) {
      return {
        answer: null,
        source: 'none',
        rule: rule.id,
        reason: org
          ? `needs your "${rule.requires}" list to answer this for "${org}"`
          : `set "${rule.requires}" in your profile to answer this automatically`,
      };
    }
    return {
      answer,
      source: 'derived',
      rule: rule.id,
      reason: rule.explain ? rule.explain({ org, answer }) : 'computed from your profile',
    };
  }

  /* 3. preferences. */
  for (const rule of AF.questions.PREFERENCES) {
    if (!rule.test.test(question)) continue;
    const answer = rule.resolve({ profile });
    if (answer === null) {
      return {
        answer: null,
        source: 'none',
        rule: rule.id,
        reason: `set "${rule.requires}" in your profile to answer this automatically`,
      };
    }
    return { answer, source: 'preference', rule: rule.id, reason: 'from your saved preference' };
  }

  /* 4. recall — only for questions that carry no variable. */
  const { signature, recallable, reason } = AF.questions.signature(question);
  if (!recallable) {
    return { answer: null, source: 'none', rule: null, reason: reason ?? 'not recallable' };
  }

  const keys = Object.keys(learned);
  if (keys.length) {
    const hit = AF.bestMatch(keys, [signature], { threshold: 0.82, floor: 0.82 });
    if (hit) {
      return {
        answer: learned[hit.text].answer,
        source: 'recalled',
        rule: null,
        reason: `you answered this before (${learned[hit.text].seen ?? 1}×)`,
      };
    }
  }

  return { answer: null, source: 'none', rule: null, reason: 'not seen before' };
};

/**
 * Record an answer the user gave by hand.
 * Refuses anything that must not be recalled, so a bad entry cannot be created
 * even by a caller that forgot to check.
 */
AF.questions.remember = function (learned, text, answer) {
  const { signature, recallable } = AF.questions.signature(text);
  if (!recallable || !answer) return { stored: false, learned };

  /* Don't remember what the profile already answers.
   *
   * "Are you legally authorized to work?" is driven by a field you set; storing
   * a copy adds a confusing duplicate to the Answers list and invites the two
   * to disagree after you edit the profile. resolve() checks the derived tier
   * first so the copy would never actually be read — which makes it pure noise
   * with a side of doubt. */
  const question = AF.questions.cleanQuestion(text);
  const handledByProfile = [...AF.questions.DERIVED, ...AF.questions.PREFERENCES].some(
    (rule) => rule.test.test(question)
  );
  if (handledByProfile) return { stored: false, learned, reason: 'answered from your profile' };

  const next = { ...learned };
  const prior = next[signature];
  next[signature] = {
    answer,
    seen: (prior?.seen ?? 0) + 1,
    updated: new Date().toISOString().slice(0, 10),
  };
  return { stored: true, learned: next, signature };
};
