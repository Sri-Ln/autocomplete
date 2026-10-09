/**
 * experience.js — the pure half of the My Experience page.
 *
 * Everything in here answers a question about TEXT, never about the DOM:
 * "which rung of the user's degree ladder is on this list?", "where does
 * '4 - Advanced' sit on this tenant's proficiency scale?", "is this the URL
 * that is already on the form?". The DOM half — opening listboxes, typing into
 * prompts, clicking Add — lives in sites/workday-experience.js and calls down
 * into here.
 *
 * Split this way for the same reason match.js is: a wrong answer here is a wrong
 * answer on somebody's job application, so these functions are unit-tested in
 * test/experience.test.mjs, and that is only practical while they touch nothing
 * but strings. Depends on match.js (AF.normalizeText, AF.scoreMatch) at call
 * time, so it must load after it — see the `js` array in manifest.json.
 *
 * ── THE ONE IDEA ───────────────────────────────────────────────────────
 * Every tenant writes its own option lists. One says "Master's Degree (±18
 * years)", the next "Master of Science"; one rates languages "Beginner /
 * Intermediate / Fluent", the next "1 - Beginner … 5 - Fluent", a third uses
 * LinkedIn's five working-proficiency phrases. So the profile never stores a
 * tenant's label. It stores what the user MEANS — an ordered ladder of
 * acceptable answers, or a semantic level — and this file maps that onto
 * whatever the form in front of us offers. When it cannot do so with
 * confidence it says so, and the field is left for the user. A blank field on
 * a review page costs one click; a wrong one goes out on the application.
 */

AF.experience = (() => {
  /* ------------------------------------------------------------------ */
  /* dates                                                               */
  /* ------------------------------------------------------------------ */

  const MONTH_NAMES = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];

  /**
   * "2019" / "08/2019" / "8-2019" / "2019-08" / "Aug 2019" / "August 2019"
   *   → { year: 2019, month: 8 | null }
   *
   * Anything else — "present", "", a typo — is null, and null means "leave the
   * date for the user". Workday's education dates are year-only on the tenant
   * this was built against, but the work-experience dates on the very same page
   * are month + year, and another tenant may ask for a month here too. So the
   * profile keeps whatever the user wrote and the filler uses what it needs.
   *
   * Years are bounded to something a person could plausibly have attended, so
   * a stray "12" never becomes the year 12.
   */
  function parseMonthYear(raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) return null;

    const year = (y) => {
      const n = Number(y);
      return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
    };
    const month = (m) => {
      const n = Number(m);
      return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
    };
    const both = (y, mo) => (y && mo ? { year: y, month: mo } : null);

    let m;
    if ((m = s.match(/^(\d{4})$/))) {
      const y = year(m[1]);
      return y ? { year: y, month: null } : null;
    }
    if ((m = s.match(/^(\d{1,2})\s*[/.-]\s*(\d{4})$/))) return both(year(m[2]), month(m[1]));
    if ((m = s.match(/^(\d{4})\s*[/.-]\s*(\d{1,2})$/))) return both(year(m[1]), month(m[2]));
    if ((m = s.match(/^([a-z]{3,9})\.?,?\s+(\d{4})$/))) {
      // A real month name or a prefix of one, at least three letters: "aug",
      // "sept", "august". Not "augx".
      const idx = MONTH_NAMES.findIndex((name) => name.startsWith(m[1]));
      return idx >= 0 ? both(year(m[2]), idx + 1) : null;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* option text                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * An option's text with Workday's bookkeeping taken off.
   *
   * Résumé-parsed skills arrive as "TypeScript (Suggested)", the skills
   * catalogue disambiguates with "Java (Programming Language)", and the degree
   * list appends "(±16 years)". None of those parentheticals is part of what
   * the user would call the thing, so comparisons are made without them.
   */
  function baseText(s) {
    return AF.normalizeText(String(s ?? '').replace(/\([^)]*\)/g, ' '));
  }

  /**
   * How well does one option name `wanted`? 0..1.
   *
   * Deliberately stricter than AF.scoreMatch, and the reason is one word:
   * "Java". scoreMatch scores "JavaScript" as a 0.92 prefix hit for it — the
   * same as "Java (Programming Language)" — and whichever sorts first wins. On a
   * skills list that is a different skill on someone's application. So here a
   * prefix only counts on a WORD boundary:
   *
   *   exact                               1.00  "Python" / "python"
   *   exact once parentheticals go        0.97  "Java (Programming Language)"
   *   option starts with the whole ask    0.90  "Java Spring" for "Java"
   *   the ask appears as whole words      0.80  "Applied Computer Science"
   *
   * and nothing below that.
   */
  function promptScore(option, wanted) {
    const o = AF.normalizeText(option);
    const w = AF.normalizeText(wanted);
    if (!o || !w) return 0;
    if (o === w) return 1;

    const ob = baseText(option);
    const wb = baseText(wanted) || w;
    if (ob && ob === wb) return 0.97;

    const words = ` ${ob || o} `;
    if (words.startsWith(` ${wb} `)) return 0.9;
    if (words.includes(` ${wb} `)) return 0.8;
    return 0;
  }

  /** Exact, or exact once the parentheticals go. */
  const EXACT = 0.97;
  /** Word-boundary prefix: "Marine" → "Marine Biology". */
  const PREFIX = 0.9;

  /**
   * Best option for `wanted` among `texts`, or null — skills and languages.
   *
   * Ties go to the SHORTER option: between two equal scores the one with fewer
   * extra words is the closer reading.
   */
  function bestPromptOption(texts, wanted, { min = 0.8 } = {}) {
    let best = null;
    texts.forEach((text, index) => {
      const score = promptScore(text, wanted);
      if (score < min) return;
      if (!best || score > best.score || (score === best.score && text.length < best.text.length)) {
        best = { index, text, score };
      }
    });
    return best;
  }

  /** Does a pill already on the field answer `wanted`? Exact only. */
  function alreadyHas(pillTexts, wanted) {
    return pillTexts.some((t) => promptScore(t, wanted) >= EXACT);
  }

  /* ------------------------------------------------------------------ */
  /* preference ladders — degree and field of study                      */
  /* ------------------------------------------------------------------ */

  /**
   * A ladder from whatever the profile holds: an array, one-per-line text, or
   * a lone string from before ladders existed. Blank rungs dropped, order kept.
   */
  function toLadder(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split('\n');
    const out = [];
    for (const v of list) {
      const s = String(v ?? '').trim();
      if (s && !out.some((x) => AF.normalizeText(x) === AF.normalizeText(s))) out.push(s);
    }
    return out;
  }

  /**
   * Which rung of the user's ladder does this list carry?
   *
   *   texts   the option labels on THIS form
   *   ladder  the user's acceptable answers, most preferred first
   *
   * → { index, text, rung, rungIndex, score } | null
   *
   * Two passes, and the order of them is the point. Pass one looks for an
   * EXACT hit on any rung, in ladder order. Only if no rung is on the list
   * verbatim does pass two accept a word-boundary prefix, again in ladder
   * order. Without the first pass a loose reading of rung 1 — "Computer
   * Science" landing on "Computer Science Education" — would beat rung 2
   * sitting right there word for word, which is the opposite of what a ladder
   * says. Below a prefix nothing counts: a rung that is not on the list is not
   * approximated, it is skipped, and a ladder with no rung on the list leaves
   * the field empty for the user.
   */
  function pickByLadder(texts, ladder) {
    const rungs = toLadder(ladder);
    for (const min of [EXACT, PREFIX]) {
      for (let r = 0; r < rungs.length; r++) {
        const hit = bestPromptOption(texts, rungs[r], { min });
        if (hit) return { ...hit, rung: rungs[r], rungIndex: r };
      }
    }
    return null;
  }

  /** Does a value already on the form sit on the ladder? Same rules. */
  function onLadder(text, ladder) {
    return pickByLadder([text], ladder);
  }

  /* ------------------------------------------------------------------ */
  /* language proficiency                                                */
  /* ------------------------------------------------------------------ */

  /** The levels the profile stores. Semantic, never a tenant's wording. */
  const LEVELS = ['beginner', 'intermediate', 'advanced', 'fluent', 'native'];

  /** Where each semantic level sits on the common ruler below. */
  const LEVEL_TARGET = { beginner: 1, intermediate: 2, advanced: 3, fluent: 4, native: 4.5 };

  /**
   * Phrases tenants use, placed on one ruler from 1 (barely) to 4.5 (native).
   *
   * Longest phrase wins, which is what keeps LinkedIn's scale in order: its
   * labels are built from overlapping words ("Limited WORKING proficiency",
   * "PROFESSIONAL working proficiency", "FULL PROFESSIONAL proficiency"), and
   * scoring by any single word would put three of the five on the same rung.
   */
  const SCALE_PHRASES = [
    ['native or bilingual', 4.5], ['mother tongue', 4.5], ['native', 4.5], ['bilingual', 4.5],
    ['first language', 4.5],
    ['full professional', 3.5], ['fluent', 4], ['fluency', 4], ['expert', 4],
    ['professional working', 3], ['advanced', 3], ['proficient', 3], ['professional', 3],
    ['upper intermediate', 2.5],
    ['limited working', 1.5], ['intermediate', 2], ['conversational', 2], ['working', 2],
    ['moderate', 2],
    ['classroom', 1.5], ['limited', 1.5], ['elementary', 1], ['beginner', 1], ['basic', 1],
    ['novice', 1], ['none', 0], ['no proficiency', 0],
  ];

  /** "Select One" and friends — rows on the list that are not a level. */
  const PLACEHOLDER = /^(select( one)?|choose( one)?|please select|none selected|-+|)$/;

  function phraseScore(norm) {
    let best = null;
    for (const [phrase, score] of SCALE_PHRASES) {
      if (` ${norm} `.includes(` ${phrase} `) && (!best || phrase.length > best.phrase.length)) {
        best = { phrase, score };
      }
    }
    return best?.score ?? null;
  }

  /**
   * Rank a tenant's proficiency scale.
   *
   * → { ok: true, ranked: [{ index, text, rank }] }  lowest first
   * → { ok: false, reason }                         when it cannot be trusted
   *
   * Two kinds of evidence. The words, through SCALE_PHRASES. And a leading
   * number — "4 - Advanced" — which is the tenant telling us the order outright.
   * When every option carries a number, the numbers ARE the order; the words
   * must still be recognisable, and must not contradict the numbers, or the
   * scale is refused. Without numbers, every option must be recognisable by
   * its words. One unrecognised label means we do not know where it sits, and
   * a level picked from a scale we half understand is a guess.
   */
  function rankScale(texts) {
    const rows = [];
    texts.forEach((text, index) => {
      const norm = AF.normalizeText(text);
      if (PLACEHOLDER.test(norm)) return;
      const num = norm.match(/^(\d+)\b/);
      rows.push({
        index,
        text,
        ordinal: num ? Number(num[1]) : null,
        words: phraseScore(norm.replace(/^\d+\s*/, '')),
      });
    });

    if (rows.length < 2) return { ok: false, reason: 'not a scale — fewer than two levels' };

    const unknown = rows.filter((r) => r.words === null);
    if (unknown.length) {
      return { ok: false, reason: `cannot place "${unknown[0].text}" on a proficiency scale` };
    }

    const numbered = rows.every((r) => r.ordinal !== null);
    if (numbered) {
      const byNum = [...rows].sort((a, b) => a.ordinal - b.ordinal);
      for (let i = 1; i < byNum.length; i++) {
        if (byNum[i].words < byNum[i - 1].words) {
          return {
            ok: false,
            reason: `numbers and words disagree: "${byNum[i - 1].text}" vs "${byNum[i].text}"`,
          };
        }
      }
      return { ok: true, ranked: byNum.map((r) => ({ index: r.index, text: r.text, rank: r.words })) };
    }

    const byWords = [...rows].sort((a, b) => a.words - b.words || a.index - b.index);
    return { ok: true, ranked: byWords.map((r) => ({ index: r.index, text: r.text, rank: r.words })) };
  }

  /**
   * The option on THIS scale that best says `level`.
   *
   * → { ok: true, index, text }  |  { ok: false, reason }
   *
   *   fluent / native   the top of the list, whatever it is called. A tenant
   *                     whose best rung is "Fluent" and one whose best rung is
   *                     "Native or bilingual proficiency" are both asking
   *                     "is this your strongest level?", and for this user the
   *                     answer is yes.
   *   anything else     the nearest rank, and on a tie the LOWER one — rounding
   *                     a claim about yourself up is the one mistake to avoid.
   *                     Nothing within a whole rung means the scale does not
   *                     have the level, and it is left.
   */
  function chooseLevel(texts, level) {
    const wanted = String(level ?? '').trim().toLowerCase();
    if (!LEVELS.includes(wanted)) return { ok: false, reason: `no level set` };

    const scale = rankScale(texts);
    if (!scale.ok) return scale;
    const { ranked } = scale;

    if (wanted === 'fluent' || wanted === 'native') {
      const top = ranked[ranked.length - 1];
      return { ok: true, index: top.index, text: top.text };
    }

    const target = LEVEL_TARGET[wanted];
    let best = null;
    for (const r of ranked) {
      const d = Math.abs(r.rank - target);
      if (!best || d < best.d || (d === best.d && r.rank < best.rank)) best = { ...r, d };
    }
    if (!best || best.d > 1) return { ok: false, reason: `this scale has nothing near "${wanted}"` };
    return { ok: true, index: best.index, text: best.text };
  }

  /**
   * Which of a language's levels answers this field?
   *
   * Workday's language abilities are tenant-defined, keyed by an opaque id per
   * ability type, so the label is the only thing that says what an ability is.
   * A single "Proficiency" dropdown, or an ability the profile has no specific
   * level for, takes the overall level.
   */
  function abilityKeyFor(label) {
    const t = AF.normalizeText(label);
    if (!t) return null;
    if (/\bread/.test(t)) return 'reading';
    if (/\bwrit/.test(t)) return 'writing';
    if (/\b(speak|spoken|oral|conversation)/.test(t)) return 'speaking';
    if (/\b(comprehen|listen|understand)/.test(t)) return 'comprehension';
    if (/\boverall\b/.test(t)) return 'overall';
    return null;
  }

  function levelFor(lang, label) {
    const key = abilityKeyFor(label);
    return String((key && lang?.[key]) || lang?.overall || '').trim().toLowerCase();
  }

  /** Tick "I am fluent in this language"? Only when the user says so. */
  const isFluent = (lang) => ['fluent', 'native'].includes(String(lang?.overall ?? '').toLowerCase());

  /* ------------------------------------------------------------------ */
  /* websites                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * A URL as the user meant it, with a scheme.
   *
   * People save "github.com/someone"; Workday's URL field rejects anything
   * without a scheme on submit. Adding https:// is the one change made.
   */
  function withScheme(url) {
    const s = String(url ?? '').trim();
    if (!s) return '';
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  }

  /**
   * Comparable form: no scheme, no "www.", no query, no trailing slash,
   * lowercase. Used only for "is this one already on the form?" — the résumé
   * parse pre-fills the same links with a different scheme or a trailing slash,
   * and adding them twice is exactly the duplicate this page must not get.
   */
  function urlKey(url) {
    return String(url ?? '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  }

  const sameUrl = (a, b) => !!urlKey(a) && urlKey(a) === urlKey(b);

  const WEBSITE_KINDS = ['linkedin', 'github', 'portfolio', 'other'];

  /** The profile's links, deduped, in the order they should be added. */
  function websiteList(profile) {
    const w = profile?.websites ?? {};
    const out = [];
    for (const kind of WEBSITE_KINDS) {
      const url = withScheme(w[kind]);
      if (url && !out.some((x) => sameUrl(x.url, url))) out.push({ kind, url });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the profile's entries                                               */
  /* ------------------------------------------------------------------ */

  /** An education slot the user actually filled in. */
  const hasEducation = (e) =>
    !!e &&
    (['school', 'gpa', 'from', 'to'].some((k) => String(e[k] ?? '').trim()) ||
      toLadder(e.degree).length > 0 ||
      toLadder(e.fieldOfStudy).length > 0);

  /** Same school? Names come back from the résumé parse lightly reworded. */
  function sameSchool(a, b) {
    const x = AF.normalizeText(a);
    const y = AF.normalizeText(b);
    if (!x || !y) return false;
    return x === y || AF.scoreMatch(a, b) >= 0.86 || AF.scoreMatch(b, a) >= 0.86;
  }

  /** Same language? "English" and "English (US)" are; "English" and "Bengali" never. */
  const sameLanguage = (a, b) => promptScore(a, b) >= EXACT || promptScore(b, a) >= EXACT;

  return {
    parseMonthYear,
    baseText,
    promptScore,
    bestPromptOption,
    alreadyHas,
    toLadder,
    pickByLadder,
    onLadder,
    LEVELS,
    rankScale,
    chooseLevel,
    abilityKeyFor,
    levelFor,
    isFluent,
    withScheme,
    urlKey,
    sameUrl,
    websiteList,
    WEBSITE_KINDS,
    hasEducation,
    sameSchool,
    sameLanguage,
  };
})();
