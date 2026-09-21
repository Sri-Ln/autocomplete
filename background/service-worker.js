/**
 * service-worker.js — the only place plaintext passwords are ever handled.
 *
 * Acts as a crypto oracle. Content scripts cannot read the key; they ask for a
 * fill payload and get back plaintext for one immediate use.
 *
 * MV3 kills this worker after ~30s idle. That is fine and expected: the derived
 * key lives in chrome.storage.session, not in a module variable, so a worker
 * restart does NOT force you to re-enter the passphrase. Only closing Chrome does.
 *
 * ── Message protocol ────────────────────────────────────────────────
 *   status            → { configured, unlocked }
 *   setup             { passphrase }                → { ok }
 *   unlock            { passphrase }                → { ok, error? }
 *   lock                                            → { ok }
 *   getProfile        → { ok, profile }
 *   saveProfile       { profile }                   → { ok }
 *   listCredentials   → { ok, default, overrides }        (emails only)
 *   saveCredential    { host|null, email, password }→ { ok }
 *   deleteCredential  { host|null }                 → { ok }
 *   getSettings / saveSettings
 *   getFillData       { hostname }                  → { ok, profile, credential }
 *   wipe              → { ok }
 *
 * Failure reasons returned to callers: NOT_CONFIGURED | LOCKED | NO_CREDENTIAL
 */

import * as C from './crypto.js';
import * as S from './storage.js';

/* ------------------------------------------------------------------ */
/* key handling                                                        */
/* ------------------------------------------------------------------ */

/** The live AES key, or null if locked. Reads from memory-only session storage. */
async function currentKey() {
  const raw = await S.getSessionKeyRaw();
  if (!raw) return null;
  try {
    return await C.importKey(raw);
  } catch {
    await S.clearSessionKey(); // corrupt — force a clean re-unlock
    return null;
  }
}

/** First-run: choose a passphrase. Creates the salt and the verification blob. */
async function setup(passphrase) {
  if (!passphrase || passphrase.length < 4) {
    return { ok: false, error: 'Passphrase must be at least 4 characters.' };
  }

  /* Re-running setup mints a new salt, which means a new key, which means every
   * existing vault entry becomes permanently unopenable. Refuse rather than
   * quietly destroy them — "Erase everything" in Settings is the deliberate way. */
  if (await S.getMeta()) {
    return {
      ok: false,
      error: 'Already set up. Use "Erase everything" in Settings to start over.',
    };
  }

  const salt = C.newSalt();
  const key = await C.deriveKey(passphrase, salt);
  const check = await C.makeCheckBlob(key);

  await S.setMeta({ v: 1, salt, check });
  await S.setSessionKeyRaw(await C.exportKey(key)); // setup leaves you unlocked
  return { ok: true };
}

async function unlock(passphrase) {
  const meta = await S.getMeta();
  if (!meta) return { ok: false, error: 'NOT_CONFIGURED' };

  const key = await C.deriveKey(passphrase, meta.salt);

  // Verify against the check blob rather than a real secret, so a wrong
  // passphrase can never half-decrypt something into a Workday field.
  if (!(await C.verifyKey(key, meta.check))) {
    return { ok: false, error: 'Wrong passphrase.' };
  }

  await S.setSessionKeyRaw(await C.exportKey(key));
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* fill payload                                                        */
/* ------------------------------------------------------------------ */

/**
 * Hand a content script everything it needs for one fill, and nothing more.
 * The key never leaves this worker — only the decrypted password does, and only
 * at the moment of use.
 */
async function getFillData(hostname) {
  const meta = await S.getMeta();
  if (!meta) return { ok: false, reason: 'NOT_CONFIGURED' };

  const key = await currentKey();
  if (!key) return { ok: false, reason: 'LOCKED' };

  const match = await S.findCredential(hostname);
  if (!match) return { ok: false, reason: 'NO_CREDENTIAL' };

  let password;
  try {
    password = await C.decrypt(key, match.entry);
  } catch {
    // Key is valid but this entry will not open — written under an older
    // passphrase, or storage was edited by hand.
    return { ok: false, reason: 'DECRYPT_FAILED' };
  }

  return {
    ok: true,
    profile: await S.getProfile(),
    credential: { email: match.entry.email, password },
    source: match.source, // 'default' | 'override' — the widget reports which
    settings: await S.getSettings(),
    answers: await S.getAnswers(),
  };
}

async function saveCredential({ host, email, password }) {
  const key = await currentKey();
  if (!key) return { ok: false, error: 'LOCKED' };
  if (!email) return { ok: false, error: 'Email is required.' };
  if (!password) return { ok: false, error: 'Password is required.' };

  const blob = await C.encrypt(key, password);
  await S.putCredential(host ?? null, { email: email.trim(), ...blob });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

const handlers = {
  async status() {
    // Settings ride along so the content script can decide whether to show the
    // widget at all without a second round trip on every page change.
    return {
      configured: !!(await S.getMeta()),
      unlocked: !!(await S.getSessionKeyRaw()),
      settings: await S.getSettings(),
    };
  },
  setup: (m) => setup(m.passphrase),
  unlock: (m) => unlock(m.passphrase),
  async lock() {
    await S.clearSessionKey();
    return { ok: true };
  },

  async getProfile() {
    return { ok: true, profile: await S.getProfile() };
  },
  async saveProfile(m) {
    await S.setProfile(m.profile ?? {});
    return { ok: true };
  },

  async listCredentials() {
    return { ok: true, ...(await S.listCredentials()) };
  },
  saveCredential: (m) => saveCredential(m),
  async deleteCredential(m) {
    await S.deleteCredential(m.host ?? null);
    return { ok: true };
  },

  async getAnswers() {
    return { ok: true, answers: await S.getAnswers() };
  },
  async saveAnswers(m) {
    await S.setAnswers(m.answers);
    return { ok: true };
  },
  async forgetAnswer(m) {
    await S.forgetAnswer(m.signature);
    return { ok: true };
  },

  async getSettings() {
    return { ok: true, settings: await S.getSettings() };
  },
  async saveSettings(m) {
    await S.setSettings(m.patch ?? {});
    return { ok: true };
  },

  getFillData: (m) => getFillData(m.hostname),

  async wipe() {
    await S.wipeAll();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
    return false;
  }

  // One try/catch for every handler — a thrown error becomes a clean response
  // instead of a dropped message port and a caller that hangs forever.
  Promise.resolve(handler(msg))
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

  return true; // keep the port open for the async response
});
