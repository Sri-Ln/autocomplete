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
  city: '',
  state: '',
  zip: '',
  country: '',
};

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
  for (const k of Object.keys(EMPTY_PROFILE)) clean[k] = String(profile[k] ?? '').trim();
  return setLocal(K_PROFILE, clean);
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
