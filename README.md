# Autocomplete

One-click autofill + submit for Workday account creation and application forms.
Manifest V3, vanilla JS, no build step, no dependencies.

## Status

| Page | Selectors | Verified |
|---|---|---|
| **Create Account** | real | live page, 2026-09-10 |
| **Sign In** | real | live page, 2026-09-10 |
| **My Information** | real | two live tenants, 2026-09-13 and 2026-09-22 |
| **My Experience** | real, except inside a language entry | a saved live page, 2026-10-08; `test/myexp-harness.html` |

My Experience has no Fill button. The widget shows one button per section —
**Education**, **Languages**, **Skills**, **Websites** — and each makes its own
section match the popup's **Experience** tab: entries already on the page are
reused before Add is clicked, and a pre-filled value that differs is replaced
(skills are only ever added). Under them, **Submit** clicks the page's Next;
it does not require any section to have been filled first. Degree and Field of study are *ladders* (acceptable answers, best
first); language levels are semantic and mapped onto each tenant's own scale.
See `sites/workday-experience.js` and `content/experience.js`.

All three fill. My Information covers the text fields plus the four widgets the
generic filler cannot touch — State, Country, Country Phone Code and Phone
Device Type — and answers the Yes/No questions on the page from your profile.
It always takes two clicks: fill, look, submit. See **Two-step pages** below.

```
grep -rn REPLACE_ME sites/     # 3 remaining, all errorSelectors
```

The three left are error-message containers. These forms validate on submit
rather than on blur, so the container had not rendered on any page harvested so
far — and `content/guards.js` already catches errors generically through
`[role="alert"]` and `[aria-invalid="true"]`, so a placeholder there costs
nothing but a less specific message.

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

**Visa status explanation.** A paragraph, for applications that ask you to *explain*
your visa status in prose rather than Yes/No. That question does not appear on My
Information — it turns up later in the flow, on a page the registry does not
recognise — so it is handled by its own page-agnostic path. See below.

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

## The visa status explanation

The one thing here that does not go through the selector map, and the reason is
worth knowing:

**Where it lives.** Some applications ask "Please explain your visa status" as a
textarea rather than a Yes/No. That question appears *later* in the application,
on a page `AF.currentPage()` returns `null` for — no adapter entry, no field map,
nothing for `filler.js` to resolve. So `content/free-text.js` works from what is
on screen instead, discovering prose fields structurally the same way
`radio-groups.js` discovers Yes/No ones.

**What makes a match.** A question needs a visa/work-authorisation **topic** *and*
a request for an **explanation**. Both, never one:

| Question | Wants prose? |
|---|---|
| "Will you now or in the future require visa sponsorship?" | no — Yes/No, the `sponsorship` rule owns it |
| "If you require sponsorship, please provide details" | yes |

Both say "sponsorship". Matching on topic alone would paste a personal legal
statement over a Yes/No question that is already answered correctly.

**It is never filled automatically.** The pill offers; a click accepts. It also
never overwrites an answer you typed, and never fills a box whose `maxlength` is
too short to hold the text — that would truncate silently and send half a
sentence.

**It never submits.** On an unrecognised page there is no `page.submit` and no
`errorSelectors`, so `AF.runGuards()` cannot run — no CAPTCHA check, no
empty-required-field check, no validation-error check. A submit button there
would be the only one in the extension with no safety scan behind it. Fill,
review, click Continue yourself.

**When the pill doesn't appear.** The question is written per company, so
detection will miss sometimes. **Copy** on the Profile tab is the fallback and
does not depend on any of the above.

## The email verification link

Create a Workday account and the page says "An email has been sent to you.
Please verify your account." — and stops. The mail contains a one-time link:

```
Click this link to confirm your email address and complete setup for your
candidate account
https://acmeinsurance.wd5.myworkdayjobs.com/Careers_External/activate/upkhm…/?redirect=…
The link will expire after 24 hours.
```

**Two places, one lookup.** **Login → Verify email** in the popup finds that mail
in Gmail and shows you the link — and so does the floating widget, on the
verification page itself, where you already are. Both run the same 5s/90s poll
against the same `gmailFindLink` handler, and both offer **Stop** while it runs.

The widget only offers it when the registry recognises no form on the page
**and** the page says something like "an email has been sent" / "verify your
account", on a `*.myworkdayjobs.com` host. That text check reads one rendered
block of the tenant's main content at a time, never the page flattened into one
string, because a match stitched together out of two unrelated sentences is a
lookup offered on a page that has nothing to do with verification. It errs
toward missing: if it does, the popup is still there. If Gmail is not connected
the widget says so in one line and offers no button.

**It never opens it.** A URL that arrived by email is untrusted input — anything
in a mailbox can claim to be an activation mail. An extension that followed such
a link automatically would be clicking on your behalf, with your cookies, on a
URL chosen by whoever sent the mail. So the extension renders the address and
you click **Open** — a real anchor in the widget, `chrome.tabs.create` from the
popup's button, and a programmatic navigation in neither. The address is shown
in full on hover and cut from the middle with an ellipsis when it is too long
for the panel; **Copy** always copies the whole thing.

**What can come back.** `extractActivationLinks()` in `background/gmail.js` pulls
every URL out of a message — plain text and `<a href>` alike — and then discards
all but the ones that are **all three** of:

| Rule | Rejects |
|---|---|
| scheme is exactly `https:` | `http://…myworkdayjobs.com/activate/…` |
| hostname **ends with** `.myworkdayjobs.com` | `myworkdayjobs.com.evil.example` |
| path contains `/activate/` | an ordinary job or "view application" link |

No "probably fine" branch, no `http://` branch. `test/gmail.test.mjs` is mostly
rejection cases, because the interesting bug here is never a missed link — it is
a returned one that should not have been.

**Privacy.** The OAuth token is never copied into `chrome.storage`; Chrome's own
identity cache holds it. The scope is `gmail.readonly`. Message bodies are never
stored, never logged, and never leave the service worker — they are local
variables for the length of one scan. Of the one message that matches, only the
URL and its sender, subject and date are returned. **Disconnect** both clears
Chrome's cached token and revokes the grant at Google, and tells you which
succeeded.

Searching covers Spam and Trash (`in:anywhere`) on purpose: a first mail from a
tenant you have never corresponded with is exactly the one that gets filed as
spam, and "it isn't in my inbox" is the problem this solves.

### Google Cloud setup

The OAuth client is bound to your extension's ID, so it cannot ship in the repo.
Until you paste one in, `manifest.json` carries `REPLACE_ME` and the popup shows
these steps instead of a Connect button — nothing calls `chrome.identity`.

**First, pin the extension ID — do this before creating the client.** An unpacked
extension's ID is derived from its path, and it changes if you move the folder or
load it on another machine. The OAuth client is registered against one ID, so a
changed ID silently breaks sign-in. Pin it:

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. **Pack extension** (leave the private key field empty). Chrome writes
   `Autocomplete.crx` and `Autocomplete.pem` beside the folder. Keep the `.pem`;
   it is what the ID is derived from.
3. Get the public key as base64:

   ```
   openssl rsa -in Autocomplete.pem -pubout -outform DER \
     | openssl base64 -A
   ```

4. Add it to `manifest.json` as a top-level `"key": "<that base64>"`, then reload.
   The ID shown on `chrome://extensions` is now fixed.

Then:

1. [console.cloud.google.com](https://console.cloud.google.com) → **New project**.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → User type **External** →
   fill in an app name and your own email → on the **Test users** step, **add
   your own Gmail address**. Leave it in Testing; publishing would require
   Google verification for a `gmail.readonly` scope, and you are the only user.
4. **Scopes** → add `https://www.googleapis.com/auth/gmail.readonly`, nothing else.
5. **Credentials → Create credentials → OAuth client ID** → application type
   **Chrome Extension** → paste the extension ID from `chrome://extensions`.
6. Copy the generated client ID and paste it into `manifest.json`:

   ```json
   "oauth2": {
     "client_id": "123456789012-abc….apps.googleusercontent.com",
     "scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
   }
   ```

7. Reload the extension. The popup now shows **Connect Gmail**.

If sign-in fails with `bad client id` or the consent window closes immediately,
the ID Chrome is reporting no longer matches the one on the OAuth client — check
`chrome://extensions` against step 5.

## Tests

No framework, no npm. Node's built-in WebCrypto is the same implementation
Chrome's service worker uses, so these exercise the real thing.

```
node test/crypto.test.mjs     # 11 checks — key derivation, round-trip, tampering
node test/vault.test.mjs      # 17 checks — default vs. per-host credential lookup
node test/match.test.mjs      # 48 checks — the fuzzy option matcher
node test/questions.test.mjs  # 60 checks — how each question is classified
node test/free-text.test.mjs  # 11 checks — which fields can hold a paragraph
node test/widget.test.mjs     # 24 checks — widget positioning arithmetic
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
  ├─ two-step page, or autoSubmit off?  → STOP HERE, button becomes "Submit"
  ├─ safety scan:  CAPTCHA visible?  field still empty?  validation error?
  │                unmapped required field?  submit button disabled?
  │        any hit → ABORT, widget says exactly which
  └─ clear → click submit
```

Re-clicking is safe. Fields already holding the right value are skipped, so a
partial fill finishes cleanly on a second click.

**Two-step pages.** A page definition can set `confirmBeforeSubmit: true` and
then it always takes two clicks — fill, look, submit — no matter what the
autoSubmit setting says. My Information has it: that page is a live application
rather than a signup form, and it is the one where a wrong dropdown answer
cannot be taken back once the next step has loaded. The safety scan still runs,
on the second click, against the DOM as it stands then. Turning off **Submit
automatically** in the popup's Settings tab does the same thing for every page.

## Files

| File | Job |
|---|---|
| `manifest.json` | MV3 config. Host patterns and content-script load order. |
| `background/crypto.js` | PBKDF2 + AES-GCM. |
| `background/storage.js` | `chrome.storage` wrapper. Profile, vault, session key. |
| `background/gmail.js` | Finds the activation link in Gmail. Shows it, never opens it. |
| `background/service-worker.js` | Message router. The only place plaintext passwords exist. |
| `content/react-set.js` | **The React-safe setter.** Start here if filling breaks. |
| `content/filler.js` | Selector → element resolution, isolated writes, run report. |
| `content/guards.js` | The pre-submit safety scan. |
| `content/registry.js` | Which site / which page. |
| `content/radio-groups.js` | Finds Yes/No questions structurally. |
| `content/free-text.js` | Finds prose questions the same way. Visa explanation. |
| `content/widget.js` | The floating button. Shadow DOM. |
| `content/pill.js` | The field-anchored "use my saved answer" chip. Shadow DOM. |
| `content/main.js` | Orchestration. |
| `sites/workday.js` | **All Workday selectors.** The only file Workday changes affect. |
| `tools/harvest.js` | Console snippet for finding real automation-ids. |
| `test/harness.html` | Proves the setter drives React state. |
| `test/free-text-harness.html` | Visa question discovery + the live pill, in a real DOM. |
| `test/crypto.test.mjs` | Key derivation, encryption, tamper detection. |
| `test/vault.test.mjs` | Default vs. per-host credential lookup. |

## manifest.json — why it has no comments

Chrome validates every top-level manifest key and warns on ones it does not
recognise, so the usual `"//": "note"` trick is not available. An earlier version
carried two such keys and Chrome flagged both on load. Manifest notes live here
instead.

**`host_permissions`** is separate from `content_scripts.matches` and is genuinely
needed: the popup reads `tab.url` to prefill the override host, and messages
content scripts filtered by URL. `content_scripts.matches` alone does not grant
either. **Keep the two lists in sync.**

**`oauth2` and `identity`** exist only for the Gmail lookup, and
`https://gmail.googleapis.com/*` is in `host_permissions` for the same reason —
`identity` grants the token, not the right to call the API with it. The
`client_id` ships as `REPLACE_ME`, the same marker `sites/*.js` uses for an
unharvested selector, and every path checks for it before touching
`chrome.identity`. An optional top-level `"key"` pins the extension ID; see the
Google Cloud setup above for why that matters.

**`content_scripts.js` order matters.** MV3 content scripts declared in the
manifest cannot use `import`, so the files share a `window.AF` namespace and run
in array order. `content/00-namespace.js` must be first; `sites/*.js` must come
before `content/registry.js`, which reads `AF.SITES`.

## Adding another site

Three edits, plus a host pattern:

1. Create `sites/greenhouse.js` following the shape of `sites/workday.js`.
2. Add it to `AF.SITES` in `sites/index.js`.
3. Add it to the `js` array in `manifest.json` (before `content/registry.js`).
4. Add its host to **both** `content_scripts.matches` and `host_permissions`.

Nothing in `content/` or `background/` is Workday-specific, so nothing else changes.

## Deliberately not automated

- **CAPTCHA.** If one is on screen, the extension fills and stops.
- **Opening the verification link.** It is found and shown — in the popup and in
  the widget — and you click it in either. See above for why that line is where
  it is.

## Security notes

- Passwords: AES-GCM, key derived with PBKDF2-SHA256 at 250k iterations.
- The key lives in `chrome.storage.session` (memory only, wiped when Chrome
  closes) and is readable only from trusted contexts — content scripts cannot
  reach it. They receive a decrypted password for one immediate use.
- Profile details (name, address, phone) are stored in **plain text**.
- This protects against someone reading your Chrome profile directory. It does
  not protect against malware already running as you.
