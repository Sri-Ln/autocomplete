/**
 * storage.js — thin, typed-ish wrapper over chrome.storage.
 *
 * Two tiers, deliberately:
 *   chrome.storage.local    persists to disk. Profile (plaintext) + vault (ciphertext).
 *   chrome.storage.session  memory only, wiped when Chrome closes, and by default
 *                           readable ONLY from trusted contexts (service worker,
 *                           popup) — never from content scripts. The derived key
 *                           lives here. We deliberately do NOT call
 *                           setAccessLevel(); the restrictive default is the point.
 *
 * Service-worker only (ES module). Content scripts talk to this via messages.
 */

const K_META = 'af_meta';       // { v, salt, check:{iv,ct} }
const K_PROFILE = 'af_profile'; // plaintext personal details
const K_VAULT = 'af_vault';     // { default: entry|null, overrides: { host: entry } }
const K_SETTINGS = 'af_settings';
const K_ANSWERS = 'af_answers'; // { <question signature>: { answer, seen, updated } }
const SK_KEY = 'af_session_key'; // raw AES key, base64, memory only

/**
 * Profile = the non-secret stuff that is identical on every site.
 * NOTE: `email` is NOT here. Email is half of a login credential, so it lives in
 * the vault next to its password. One source of truth. The myInformation page
 * pulls the email from whichever credential matched.
 */
export const EMPTY_PROFILE = {
  firstName: '',
  lastName: '',
  phone: '',
  address1: '',
  address2: '', // apt / unit — not present on every tenant's form
  city: '',
  state: '',   // "MA" or "Massachusetts"; expanded before matching
  zip: '',
  country: '',

  /* Answer to "How Did You Hear About Us?".
   *
   * Deliberately a free-text preference rather than something derived from the
   * hostname. A Workday tenant slug is often an internal abbreviation that
   * looks nothing like the company's name, so it cannot be used to guess the
   * dropdown's wording. The matcher scores this against whatever the dropdown
   * actually offers, so "Career Site" finds "<Company> Career Site". */
  source: 'Career Site',

  /* ---- inputs to the question engine (content/questions.js) ----
   *
   * These exist so company-specific questions can be COMPUTED rather than
   * recalled. "Have you ever worked for X?" is answered by checking X against
   * `employers`, which is correct per company — storing one remembered answer
   * would be right for one employer and wrong for every other. */

  employers: [],    // companies you have worked for
  relativesAt: [],  // companies where you have a relative; empty list means "none"

  /* Tri-state: 'yes' | 'no' | '' . Empty means DO NOT ANSWER — never a default.
   * Work authorisation and sponsorship in particular are legal declarations, so
   * they are answered only from a value set here deliberately. */
  over18: '',
  workAuthorized: '',
  needsSponsorship: '',
  willingToRelocate: '',
  willingToTravel: '',
  noticePeriod: '',

  /* Free-text answer to "Please explain your visa status".
   *
   * A paragraph rather than a flag, because some applications ask for the visa
   * story in prose. Stored as one block: the wording is personal and legal, and
   * splitting it into fields the extension assembles would be inventing
   * sentences on the user's behalf.
   *
   * Never written during an ordinary fill — it is offered, and a click accepts
   * it. See content/free-text.js. */
  visaExplanation: '',
};

/** Profile keys holding arrays rather than strings. */
export const PROFILE_LIST_FIELDS = ['employers', 'relativesAt'];

export const DEFAULT_SETTINGS = {
  autoSubmit: true,   // false → widget fills, then waits for a second click
  showWidget: true,
};

/* ------------------------------------------------------------------ */
/* local (disk)                                                        */
/* ------------------------------------------------------------------ */

async function getLocal(key, fallback) {
  const out = await chrome.storage.local.get(key);
  return out[key] === undefined ? fallback : out[key];
}

const setLocal = (key, value) => chrome.storage.local.set({ [key]: value });

export const getMeta = () => getLocal(K_META, null);
export const setMeta = (meta) => setLocal(K_META, meta);

export async function getProfile() {
  return { ...EMPTY_PROFILE, ...(await getLocal(K_PROFILE, {})) };
}
export function setProfile(profile) {
  // Whitelist: never let an unexpected key ride along into storage.
  const clean = {};
  for (const k of Object.keys(EMPTY_PROFILE)) {
    if (PROFILE_LIST_FIELDS.includes(k)) {
      const list = Array.isArray(profile[k])
        ? profile[k]
        : String(profile[k] ?? '').split(/[\n,]/);
      clean[k] = list.map((s) => String(s).trim()).filter(Boolean);
    } else {
      clean[k] = String(profile[k] ?? '').trim();
    }
  }
  return setLocal(K_PROFILE, clean);
}

/* ------------------------------------------------------------------ */
/* learned answers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Answers the user gave by hand, keyed by question signature.
 *
 * Only questions that carry no employer-specific variable ever land here —
 * content/questions.js enforces that in remember(), so a "No" for one company
 * can never be served up for another. Stores the question shape and the answer,
 * nothing about which company asked it or when you applied.
 */
export const getAnswers = () => getLocal(K_ANSWERS, {});
export const setAnswers = (answers) => setLocal(K_ANSWERS, answers ?? {});

export async function forgetAnswer(signature) {
  const answers = await getAnswers();
  delete answers[signature];
  return setAnswers(answers);
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await getLocal(K_SETTINGS, {})) };
}
export async function setSettings(patch) {
  return setLocal(K_SETTINGS, { ...(await getSettings()), ...patch });
}

/* ------------------------------------------------------------------ */
/* vault                                                               */
/* ------------------------------------------------------------------ */

export async function getVault() {
  return await getLocal(K_VAULT, { default: null, overrides: {} });
}

/**
 * Credential lookup — the rule that makes "same login everywhere" work.
 *
 *   1. exact hostname override, if one was deliberately pinned
 *   2. otherwise the default credential
 *
 * So a tenant you have never visited still fills on the first click.
 */
export async function findCredential(hostname) {
  const vault = await getVault();
  const override = vault.overrides?.[hostname];
  if (override) return { entry: override, source: 'override', host: hostname };
  if (vault.default) return { entry: vault.default, source: 'default', host: null };
  return null;
}

/** host === null writes the default credential. */
export async function putCredential(host, entry) {
  const vault = await getVault();
  if (host === null) vault.default = entry;
  else (vault.overrides ??= {})[host] = entry;
  return setLocal(K_VAULT, vault);
}

export async function deleteCredential(host) {
  const vault = await getVault();
  if (host === null) vault.default = null;
  else delete vault.overrides?.[host];
  return setLocal(K_VAULT, vault);
}

/** Emails only — passwords stay encrypted. Safe to hand to the popup UI. */
export async function listCredentials() {
  const vault = await getVault();
  return {
    default: vault.default ? { email: vault.default.email } : null,
    overrides: Object.entries(vault.overrides ?? {}).map(([host, e]) => ({
      host,
      email: e.email,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* session (memory)                                                    */
/* ------------------------------------------------------------------ */

export async function getSessionKeyRaw() {
  const out = await chrome.storage.session.get(SK_KEY);
  return out[SK_KEY] ?? null;
}

export const setSessionKeyRaw = (raw) => chrome.storage.session.set({ [SK_KEY]: raw });
export const clearSessionKey = () => chrome.storage.session.remove(SK_KEY);

/* ------------------------------------------------------------------ */

/** Wipes everything. Used by the popup's "Reset extension" button. */
export async function wipeAll() {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
}
