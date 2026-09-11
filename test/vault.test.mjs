/**
 * vault.test.mjs — verifies the credential lookup rule.
 *
 *   node test/vault.test.mjs
 *
 * This is the behaviour you asked for specifically: one saved login that works
 * on every Workday tenant, including ones you have never visited, with a
 * per-host override available when a single company forces a different password.
 *
 * chrome.storage is stubbed with a plain in-memory object before storage.js is
 * imported, since that module reads the global at call time.
 */

import { readFile } from 'node:fs/promises';

/* ---- chrome.storage stub ------------------------------------------ */

const disk = {};
const mem = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return key in disk ? { [key]: disk[key] } : {};
      },
      async set(obj) {
        Object.assign(disk, obj);
      },
      async clear() {
        for (const k of Object.keys(disk)) delete disk[k];
      },
    },
    session: {
      async get(key) {
        return key in mem ? { [key]: mem[key] } : {};
      },
      async set(obj) {
        Object.assign(mem, obj);
      },
      async remove(key) {
        delete mem[key];
      },
      async clear() {
        for (const k of Object.keys(mem)) delete mem[k];
      },
    },
  },
};

const src = await readFile(new URL('../background/storage.js', import.meta.url), 'utf8');
const S = await import(
  'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64')
);

/* ---- tiny assert -------------------------------------------------- */

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`}`);
  ok ? passed++ : failed++;
}

/* ---- tests -------------------------------------------------------- */

// Nothing saved yet.
check('no credential before setup', await S.findCredential('nvidia.wd5.myworkdayjobs.com'), null);

// Save ONE default credential.
await S.putCredential(null, { email: 'me@example.com', iv: 'IV', ct: 'CT' });

// The point of the whole design: a tenant never seen before still resolves.
const fresh = await S.findCredential('stripe.wd1.myworkdayjobs.com');
check('unvisited tenant uses default', fresh?.source, 'default');
check('unvisited tenant gets the email', fresh?.entry.email, 'me@example.com');

const other = await S.findCredential('nvidia.wd5.myworkdayjobs.com');
check('a second unvisited tenant too', other?.source, 'default');

// Pin an override for one company whose password rules differ.
await S.putCredential('nvidia.wd5.myworkdayjobs.com', {
  email: 'me+nvidia@example.com',
  iv: 'IV2',
  ct: 'CT2',
});

const pinned = await S.findCredential('nvidia.wd5.myworkdayjobs.com');
check('override wins on its host', pinned?.source, 'override');
check('override carries its own email', pinned?.entry.email, 'me+nvidia@example.com');

// The override must not leak onto other hosts.
const unaffected = await S.findCredential('stripe.wd1.myworkdayjobs.com');
check('other hosts still get default', unaffected?.entry.email, 'me@example.com');

// Deleting the override falls back, it does not leave a hole.
await S.deleteCredential('nvidia.wd5.myworkdayjobs.com');
check('deleting override falls back to default',
  (await S.findCredential('nvidia.wd5.myworkdayjobs.com'))?.source, 'default');

// The popup list must never expose ciphertext or IVs.
await S.putCredential('acme.wd3.myworkdayjobs.com', { email: 'x@y.z', iv: 'I', ct: 'C' });
const listed = await S.listCredentials();
check('list exposes default email only', listed.default, { email: 'me@example.com' });
check('list exposes override host+email only', listed.overrides,
  [{ host: 'acme.wd3.myworkdayjobs.com', email: 'x@y.z' }]);
check('list leaks no ciphertext', JSON.stringify(listed).includes('"ct"'), false);

/* profile whitelisting */

await S.setProfile({ firstName: '  Ada  ', lastName: 'Lovelace', evil: 'DROP TABLE' });
const profile = await S.getProfile();
check('profile trims whitespace', profile.firstName, 'Ada');
check('profile drops unknown keys', 'evil' in profile, false);
check('profile fills missing keys', profile.city, '');

/* session key is memory-only */

await S.setSessionKeyRaw('RAWKEY');
check('session key reads back', await S.getSessionKeyRaw(), 'RAWKEY');
check('session key is not on disk', JSON.stringify(disk).includes('RAWKEY'), false);
await S.clearSessionKey();
check('session key clears', await S.getSessionKeyRaw(), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
