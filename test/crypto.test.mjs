/**
 * crypto.test.mjs — verifies background/crypto.js end to end.
 *
 *   node test/crypto.test.mjs
 *
 * No npm, no test framework, no package.json. Node's built-in WebCrypto is the
 * same implementation Chrome's service worker uses, so passing here means the
 * real thing works.
 *
 * crypto.js is loaded through a data: URL because the repo has no
 * package.json — without one Node would treat a bare .js as CommonJS and the
 * `export` statements would fail to parse.
 */

import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../background/crypto.js', import.meta.url), 'utf8');
const C = await import(
  'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64')
);

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
  ok ? passed++ : failed++;
}

/* ------------------------------------------------------------------ */

const salt = C.newSalt();
const key = await C.deriveKey('correct-horse', salt);
const checkBlob = await C.makeCheckBlob(key);

// Same passphrase + same salt must reproduce the same key across sessions.
// This is the entire basis of unlock working after a browser restart.
const rederived = await C.deriveKey('correct-horse', salt);
check('correct passphrase verifies', await C.verifyKey(rederived, checkBlob), true);

const wrongKey = await C.deriveKey('wrong-horse', salt);
check('wrong passphrase rejected', await C.verifyKey(wrongKey, checkBlob), false);

// A different salt with the same passphrase must NOT collide.
const otherSalt = await C.deriveKey('correct-horse', C.newSalt());
check('different salt → different key', await C.verifyKey(otherSalt, checkBlob), false);

/* password round-trip */

const blob = await C.encrypt(key, 'hunter2hunter2');
check('decrypt returns the original', await C.decrypt(rederived, blob), 'hunter2hunter2');

// The key round-trips through chrome.storage.session as raw bytes.
const reimported = await C.importKey(await C.exportKey(key));
check('export → import preserves key', await C.decrypt(reimported, blob), 'hunter2hunter2');

// Wrong key must throw, never return garbage. If GCM's auth tag didn't hold,
// we could type nonsense into a real password field.
let threw = false;
try {
  await C.decrypt(wrongKey, blob);
} catch {
  threw = true;
}
check('wrong key throws (auth tag holds)', threw, true);

// Tampered ciphertext must be rejected too.
const tampered = { ...blob, ct: blob.ct.slice(0, -4) + 'AAAA' };
let tamperThrew = false;
try {
  await C.decrypt(key, tampered);
} catch {
  tamperThrew = true;
}
check('tampered ciphertext rejected', tamperThrew, true);

/* IV hygiene — reusing an IV under one key breaks AES-GCM badly */

const blob2 = await C.encrypt(key, 'hunter2hunter2');
check('fresh IV per encrypt', blob.iv !== blob2.iv, true);
check('same plaintext → different ciphertext', blob.ct !== blob2.ct, true);

/* unicode, because passwords contain anything */

const weird = 'pässwörd–🔐—ok';
check('unicode survives', await C.decrypt(key, await C.encrypt(key, weird)), weird);

/* cost — high enough to matter, low enough not to annoy */

const t0 = Date.now();
await C.deriveKey('timing', salt);
const ms = Date.now() - t0;
console.log(`  ..    derive cost ~${ms}ms (want 100–1000ms)`);
check('derive cost is in a sane range', ms > 30 && ms < 3000, true);

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
