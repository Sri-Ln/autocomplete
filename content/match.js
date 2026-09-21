/**
 * match.js — fuzzy option matching for dropdowns whose exact wording differs
 * per tenant.
 *
 * The motivating case: Workday's "How did you hear about us?" prompt. On FINRA
 * the right answer is "FINRA Career Site"; on NVIDIA it's some variation on
 * "NVIDIA Careers". Hardcoding either is useless across tenants, so we derive
 * what to look for from the hostname and score the options we actually find.
 *
 * Pure functions, no DOM. Unit-tested in test/match.test.mjs — which matters,
 * because getting this wrong means silently picking the wrong answer on a real
 * job application rather than failing loudly.
 */

/** Lowercase, strip punctuation, collapse whitespace. */
AF.normalizeText = function (s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’“”]/g, '') // smart quotes
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
};

AF.tokenize = function (s) {
  const n = AF.normalizeText(s);
  return n ? n.split(' ') : [];
};

/** Words too small to carry meaning in an acronym. */
const ACRONYM_STOPWORDS = new Set(['of', 'the', 'and', 'for', 'de', 'a', 'an']);

/**
 * Initials of the significant words.
 *   "United States of America" → "usa"
 *   "United Kingdom"           → "uk"
 * Used to let a country typed as "USA" find its full-name option.
 */
AF.acronymOf = function (s) {
  return AF.tokenize(s)
    .filter((t) => !ACRONYM_STOPWORDS.has(t))
    .map((t) => t[0])
    .join('');
};

/**
 * How well does `option` answer `wanted`? Returns 0..1.
 *
 * The ladder is deliberate: exact beats prefix beats substring beats token
 * overlap. Token overlap is capped below the substring tier so a loose bag-of-
 * words hit can never outrank a real substring match.
 */
AF.scoreMatch = function (option, wanted) {
  const o = AF.normalizeText(option);
  const w = AF.normalizeText(wanted);
  if (!o || !w) return 0;

  if (o === w) return 1;

  /* Acronyms, checked BEFORE the short-query guard below.
   *
   * "USA" must find "United States of America". The guard that stops "MA" from
   * matching "Maine" would otherwise reject it too, because both are short and
   * neither is an exact hit. An acronym is different from a prefix: it has to
   * account for EVERY significant word, so it cannot collide the way a prefix
   * does — "MA" is not the acronym of "Maine", but "USA" is the acronym of
   * "United States of America". */
  if (w.length >= 2 && w.length <= 5 && !w.includes(' ')) {
    if (AF.acronymOf(o) === w) return 0.95;
  }

  /* Short queries must NOT prefix-match.
   *
   * Measured against a real Workday state list: the query "MA" prefix-matched
   * "Maine", "Maryland" and "Massachusetts" equally, and "Maine" sorts first —
   * so a Massachusetts address silently became a Maine one. Anything three
   * characters or shorter is almost always an abbreviation, and an abbreviation
   * that is not an exact hit is not evidence of anything.
   *
   * Expand abbreviations before calling this (see AF.expandUsState). */
  if (w.length <= 3) return 0;

  if (o.startsWith(w) || w.startsWith(o)) return 0.92;
  if (o.includes(w)) return 0.86;

  const optionTokens = new Set(AF.tokenize(o));
  const wantedTokens = AF.tokenize(w);
  if (!wantedTokens.length) return 0;

  let hits = 0;
  for (const t of wantedTokens) if (optionTokens.has(t)) hits++;
  if (hits === 0) return 0;

  const coverage = hits / wantedTokens.length;      // how much of the ask is present
  const precision = hits / optionTokens.size;        // how much of the option is signal
  // Coverage dominates: "FINRA Career Site" should still win for "finra career"
  // despite the extra token.
  return Math.min(0.84, coverage * 0.75 + precision * 0.25);
};

/**
 * Try each candidate phrase in priority order; return the first that clears
 * `threshold`. If none do, fall back to the best scorer overall, but only if it
 * clears `floor` — below that we would rather select nothing than the wrong
 * thing on someone's job application.
 *
 * @param options    array of strings, or of objects with a `.text`
 * @param candidates ordered phrases, most specific first
 * @returns { index, text, score, candidate } | null
 */
AF.bestMatch = function (options, candidates, { threshold = 0.6, floor = 0.55 } = {}) {
  const texts = options.map((o) => (typeof o === 'string' ? o : (o?.text ?? '')));
  let overall = null;

  for (const candidate of candidates) {
    let round = null;

    for (let i = 0; i < texts.length; i++) {
      const score = AF.scoreMatch(texts[i], candidate);
      if (!round || score > round.score) round = { index: i, text: texts[i], score, candidate };
    }

    if (!round) continue;
    if (!overall || round.score > overall.score) overall = round;
    if (round.score >= threshold) return round; // specific candidate won — stop here
  }

  return overall && overall.score >= floor ? overall : null;
};

/**
 * Tenant slug from a Workday hostname.
 *   finra.wd1.myworkdayjobs.com        → "finra"
 *   nvidia.wd5.myworkdayjobs.com       → "nvidia"
 *   wd3.myworkdayjobs.com              → null   (no tenant label)
 *
 * Workday hostnames are <tenant>.<wdN>.myworkdayjobs.com, so the tenant is the
 * first label — unless the first label is itself the wdN part.
 */
AF.tenantFromHostname = function (hostname = location.hostname) {
  const parts = String(hostname).toLowerCase().split('.');
  if (parts.length < 3) return null;
  const first = parts[0];
  if (/^wd\d+$/.test(first) || first === 'www') return null;
  return first;
};

/**
 * Ordered phrases to look for in a "how did you hear about us" prompt,
 * most specific first.
 *
 * The tenant-prefixed forms run first so that when a list contains several
 * entries with "Career Site" in them, we land on this company's.
 */
AF.careerSiteCandidates = function (hostname = location.hostname) {
  const tenant = AF.tenantFromHostname(hostname);
  const generic = [
    'career site',
    'company career site',
    'company website',
    'corporate website',
    'careers page',
  ];
  if (!tenant) return generic;

  return [
    `${tenant} career site`,
    `${tenant} careers`,
    `${tenant} career`,
    `${tenant} website`,
    tenant,
    ...generic,
  ];
};

/**
 * Category names worth drilling into when the answer isn't at the top level.
 * Workday nests sources: "Job Sites" → "<Company> Career Site".
 */
AF.SOURCE_CATEGORY_HINTS = [
  'job sites',
  'job site',
  'career site',
  'company',
  'website',
  'online',
  'other',
];

/* ------------------------------------------------------------------ */
/* US states                                                          */
/* ------------------------------------------------------------------ */

/**
 * Workday's state dropdown lists full names ("Massachusetts"), but people type
 * abbreviations ("MA"). Expanding before matching is the fix; see the
 * short-query guard in scoreMatch for why fuzzy matching cannot be trusted to
 * do this on its own.
 *
 * Territories and the Armed Forces entries are included because they appear in
 * the real Workday list.
 */
AF.US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AS: 'American Samoa', AZ: 'Arizona', AR: 'Arkansas',
  AA: 'Armed Forces Americas', AE: 'Armed Forces Europe', AP: 'Armed Forces Pacific',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', GU: 'Guam',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', MP: 'Northern Mariana Islands',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', VI: 'Virgin Islands, U.S.',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** "MA" → "Massachusetts". Anything else passes through untouched. */
AF.expandUsState = function (value) {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  return AF.US_STATES[raw.toUpperCase()] ?? raw;
};

/* ------------------------------------------------------------------ */
/* countries                                                          */
/* ------------------------------------------------------------------ */

/**
 * Short forms people actually type, mapped to Workday's wording.
 *
 * acronymOf() handles "USA" on its own, but not "US" (two letters against a
 * three-word name) or "U.S." (the dot normalises to a space, so it is no
 * longer a single token). Those need to be spelled out.
 *
 * Keys are normalized — lowercase, punctuation stripped.
 */
AF.COUNTRY_ALIASES = {
  'us': 'United States of America',
  'u s': 'United States of America',
  'usa': 'United States of America',
  'u s a': 'United States of America',
  'united states': 'United States of America',
  'america': 'United States of America',
  'uk': 'United Kingdom',
  'u k': 'United Kingdom',
  'great britain': 'United Kingdom',
  'uae': 'United Arab Emirates',
  'korea': 'Korea, Republic of',
  'south korea': 'Korea, Republic of',
};

/** "USA" → "United States of America". Unknown values pass through. */
AF.expandCountry = function (value) {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  return AF.COUNTRY_ALIASES[AF.normalizeText(raw)] ?? raw;
};
