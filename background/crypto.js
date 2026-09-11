/**
 * crypto.js — passphrase → key derivation, and AES-GCM encrypt/decrypt.
 *
 * Runs ONLY in the service worker (an ES module context). Content scripts never
 * import this and never see the key.
 *
 * Threat model, stated plainly:
 *   - Protects against: someone reading your Chrome profile directory off disk,
 *     a backup that syncs it, another process that can read files as you.
 *   - Does NOT protect against: malware already running as you that can wait for
 *     you to type the passphrase. Nothing client-side can.
 *
 * Shape on disk (chrome.storage.local):
 *   af_meta = { v: 1, salt: <b64>, check: { iv: <b64>, ct: <b64> } }
 *   The `check` blob is the string "AF_OK" encrypted with the real key. Decrypting
 *   it is how we tell a correct passphrase from a wrong one WITHOUT touching the
 *   real secrets — AES-GCM's auth tag makes a wrong key fail loudly rather than
 *   returning garbage.
 */

const PBKDF2_ITERATIONS = 250000; // ~200ms on a modern laptop. Raise, never lower.
const HASH = 'SHA-256';
const KEY_ALGO = { name: 'AES-GCM', length: 256 };
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96 bits — the size AES-GCM is specified for.
const CHECK_PLAINTEXT = 'AF_OK';

/* ------------------------------------------------------------------ */
/* base64 helpers (structured-clone can't move ArrayBuffers into storage) */
/* ------------------------------------------------------------------ */

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/* ------------------------------------------------------------------ */
/* key derivation                                                      */
/* ------------------------------------------------------------------ */

export function newSalt() {
  return bufToB64(randomBytes(SALT_BYTES));
}

/**
 * Derive the AES key from a passphrase. Deterministic: same passphrase + same
 * salt always yields the same key, which is what makes unlock work across
 * browser sessions without ever storing the passphrase.
 */
export async function deriveKey(passphrase, saltB64) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(b64ToBuf(saltB64)),
      iterations: PBKDF2_ITERATIONS,
      hash: HASH,
    },
    baseKey,
    KEY_ALGO,
    true, // extractable — we export it to chrome.storage.session (memory-only)
    ['encrypt', 'decrypt']
  );
}

/**
 * The key is cached in chrome.storage.session, which cannot hold a CryptoKey
 * object, so it round-trips through raw bytes.
 */
export async function exportKey(key) {
  return bufToB64(await crypto.subtle.exportKey('raw', key));
}

export async function importKey(rawB64) {
  return crypto.subtle.importKey('raw', b64ToBuf(rawB64), KEY_ALGO, true, [
    'encrypt',
    'decrypt',
  ]);
}

/* ------------------------------------------------------------------ */
/* encrypt / decrypt                                                   */
/* ------------------------------------------------------------------ */

/** Returns { iv, ct } — both base64. A fresh IV per call; never reuse one. */
export async function encrypt(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { iv: bufToB64(iv), ct: bufToB64(ct) };
}

/** Throws if the key is wrong or the data was tampered with (GCM auth tag). */
export async function decrypt(key, blob) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(blob.iv)) },
    key,
    b64ToBuf(blob.ct)
  );
  return new TextDecoder().decode(plain);
}

/* ------------------------------------------------------------------ */
/* passphrase verification                                             */
/* ------------------------------------------------------------------ */

export async function makeCheckBlob(key) {
  return encrypt(key, CHECK_PLAINTEXT);
}

/** True if `key` is the key that produced `checkBlob`. Never throws. */
export async function verifyKey(key, checkBlob) {
  try {
    return (await decrypt(key, checkBlob)) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}
