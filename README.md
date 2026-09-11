# Autocomplete

One-click autofill + submit for Workday account creation and application forms.
Manifest V3, vanilla JS, no build step, no dependencies.

## Status

| Page | Selectors | Verified |
|---|---|---|
| **Create Account** | real | live page, 2026-09-10 |
| **Sign In** | real | live page, 2026-09-10 |
| My Information | placeholder | needs an account to reach |

Create Account and Sign In work now. My Information does not — reaching it
requires a signed-in account and an open job application, so those 8 fields are
still `REPLACE_ME_*`.

```
grep -rn REPLACE_ME sites/     # 13 remaining, all on My Information
```

### Two Workday facts worth knowing

**`beecatcher` is a honeypot.** `name="website"`, 1×0px, absolutely positioned.
Invisible to you, present in the DOM, and filling it flags your submission as a
bot. It is excluded in both `sites/workday.js` and `content/guards.js`. Never add
a "fill every input" fallback.

**The Create Account button is enabled on a completely empty form.** So a
disabled-button check proves nothing. What actually protects you is
`allFieldsLanded()` in `content/guards.js`, which re-reads the DOM after filling.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the extension icon → create a passphrase → save your login

## First-time setup

**Passphrase.** Encrypts your saved passwords. Never stored anywhere — you type it
once per Chrome session, and the derived key lives in memory-only session storage
until you close the browser.

**Login.** Save one as the **default** and it is used on every Workday tenant, so a
company you have never applied to fills on the first click. Add a *host override*
only if one company's password rules force a different password there.

**Profile.** Name, phone, address. Used on the application form (My Information),
not on the signup page.

## Harvesting the real selectors

1. Open a live Workday **Create Account** page.
2. DevTools → Console → paste all of `tools/harvest.js` → Enter.
3. Read the printed table, or run `__afCopy()` to get a paste-ready `fields: {}`
   block on your clipboard.
4. Paste the ids into `sites/workday.js`, replacing the `REPLACE_ME_*` ones.
5. Reload the extension, reload the Workday tab.

Console helpers, once harvest.js has run:

| Command | Does |
|---|---|
| `__afHarvest()` | Re-scan after the form changes |
| `__afHarvest(true)` | Include hidden / off-screen elements |
| `__afCopy()` | Copy a ready-made `fields: {}` block |
| `__afWhat($0)` | The automation-id of the element selected in Elements |

Before the selectors exist you can still force a page type for testing:

```js
AF.forcePage = 'createAccount'   // in the page console
AF.debug = true                  // log every field write
```

## Tests

No framework, no npm. Node's built-in WebCrypto is the same implementation
Chrome's service worker uses, so these exercise the real thing.

```
node test/crypto.test.mjs    # 11 checks — key derivation, round-trip, tampering
node test/vault.test.mjs     # 17 checks — default vs. per-host credential lookup
```

`vault.test.mjs` is the one that proves the behaviour you actually want: one
saved login resolving on a Workday tenant you have never visited.

### Testing the React setter

Open `test/harness.html` in Chrome. It renders a genuinely React-controlled form
and loads the real `content/react-set.js` — not a copy.

- **Fill naively** → inputs look full, React state stays empty. This is the bug the
  whole extension exists to avoid.
- **Fill with AF.setNativeValue** → React state matches. PASS.

Verify this passes before pointing the extension at a real signup page, so you
aren't debugging the setter and your selectors at the same time.

## How it works

```
[click widget]
  ├─ unlock if needed (passphrase → PBKDF2 → key in storage.session)
  ├─ registry: which site, which page type?
  ├─ fill each mapped field    (each write isolated; one failure never aborts)
  ├─ safety scan:  CAPTCHA visible?  field still empty?  validation error?
  │                unmapped required field?  submit button disabled?
  │        any hit → ABORT, widget says exactly which
  └─ clear → click submit
```

Re-clicking is safe. Fields already holding the right value are skipped, so a
partial fill finishes cleanly on a second click.

## Files

| File | Job |
|---|---|
| `manifest.json` | MV3 config. Host patterns and content-script load order. |
| `background/crypto.js` | PBKDF2 + AES-GCM. |
| `background/storage.js` | `chrome.storage` wrapper. Profile, vault, session key. |
| `background/service-worker.js` | Message router. The only place plaintext passwords exist. |
| `content/react-set.js` | **The React-safe setter.** Start here if filling breaks. |
| `content/filler.js` | Selector → element resolution, isolated writes, run report. |
| `content/guards.js` | The pre-submit safety scan. |
| `content/registry.js` | Which site / which page. |
| `content/widget.js` | The floating button. Shadow DOM. |
| `content/main.js` | Orchestration. |
| `sites/workday.js` | **All Workday selectors.** The only file Workday changes affect. |
| `tools/harvest.js` | Console snippet for finding real automation-ids. |
| `test/harness.html` | Proves the setter drives React state. |
| `test/crypto.test.mjs` | Key derivation, encryption, tamper detection. |
| `test/vault.test.mjs` | Default vs. per-host credential lookup. |

## Adding another site

Three edits, plus a host pattern:

1. Create `sites/greenhouse.js` following the shape of `sites/workday.js`.
2. Add it to `AF.SITES` in `sites/index.js`.
3. Add it to the `js` array in `manifest.json` (before `content/registry.js`).
4. Add its host to `content_scripts.matches` in `manifest.json`.

Nothing in `content/` or `background/` is Workday-specific, so nothing else changes.

## Deliberately not automated

- **CAPTCHA.** If one is on screen, the extension fills and stops.
- **Email verification.** Out of scope entirely.

## Security notes

- Passwords: AES-GCM, key derived with PBKDF2-SHA256 at 250k iterations.
- The key lives in `chrome.storage.session` (memory only, wiped when Chrome
  closes) and is readable only from trusted contexts — content scripts cannot
  reach it. They receive a decrypted password for one immediate use.
- Profile details (name, address, phone) are stored in **plain text**.
- This protects against someone reading your Chrome profile directory. It does
  not protect against malware already running as you.
