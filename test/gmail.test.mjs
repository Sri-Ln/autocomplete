/**
 * gmail.test.mjs — what the activation-link filter will and will not hand back.
 *
 *   node test/gmail.test.mjs
 *
 * extractActivationLinks() is the trust boundary for this whole feature: it is
 * the only thing standing between "a link arrived in your mailbox" and "the
 * extension offered you a button that opens it". So most of this file is
 * rejection cases — the interesting bug is never a missed link, it is a
 * returned one that should not have been.
 *
 * chrome and fetch are stubbed before gmail.js is imported. The token below is
 * synthetic; nothing here talks to Google.
 */

/* ---- stubs -------------------------------------------------------- */

const TOKEN = 'ya29.SYNTHETIC-NOT-A-REAL-TOKEN';

let manifestClientId = 'REPLACE_ME.apps.googleusercontent.com';
let cachedToken = null; // what chrome.identity pretends to hold
let identityTouched = false;

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    getManifest: () => ({ oauth2: { client_id: manifestClientId } }),
  },
  identity: {
    getAuthToken(_opts, cb) {
      identityTouched = true;
      chrome.runtime.lastError = cachedToken ? undefined : { message: 'NO_TOKEN' };
      cb(cachedToken ?? undefined);
    },
    removeCachedAuthToken(_opts, cb) {
      cachedToken = null;
      cb();
    },
  },
};

let fetchRoutes = {};
globalThis.fetch = async (input) => {
  const url = String(input);
  for (const [needle, body] of Object.entries(fetchRoutes)) {
    if (url.includes(needle)) {
      return { ok: true, status: 200, async json() { return body; } };
    }
  }
  return { ok: false, status: 404, async json() { return {}; } };
};

const G = await import('../background/gmail.js');

/* ---- tiny assert -------------------------------------------------- */

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`}`);
  ok ? passed++ : failed++;
}

/* ---- the real thing ----------------------------------------------- */

const HOST = 'acmeinsurance.wd5.myworkdayjobs.com';
const TOKEN_PATH =
  'upkhm6qduh6i3vifqzp21xm53pcmnt8renidhgbxgtymeqdunecpd4n53mrlqsvmyoggv3fcxmnymy2unsphtluq1qbxl8839ps';
const REDIRECT =
  '?redirect=%2Fen-US%2FCareers_External%2Fjob%2FSpringfield-IL%2FSoftware-Engineer_R0000001%2Fapply%2FautofillWithResume';
const ACTIVATE = `https://${HOST}/Careers_External/activate/${TOKEN_PATH}/${REDIRECT}`;

/* The mail the user actually gets. */
const PLAIN_EXAMPLE = `
Click this link to confirm your email address and complete setup for your candidate account
${ACTIVATE}
The link will expire after 24 hours.
`;

check('the real plain-text mail', G.extractActivationLinks(PLAIN_EXAMPLE), [ACTIVATE]);

/* ---- the HTML form ------------------------------------------------ */

check('html href',
  G.extractActivationLinks(`<p>Hello</p><a href="${ACTIVATE}">Activate</a>`),
  [ACTIVATE]);

check("html href, single quotes",
  G.extractActivationLinks(`<a href='${ACTIVATE}'>Activate</a>`),
  [ACTIVATE]);

/* An anchor whose visible text is the URL yields it twice. One is enough. */
check('href and its own link text dedupe',
  G.extractActivationLinks(`<a href="${ACTIVATE}">${ACTIVATE}</a>`),
  [ACTIVATE]);

/* ---- entity decoding ---------------------------------------------- */

const ENTITY_URL = `https://${HOST}/Careers_External/activate/abc123/?a=1&b=2`;

check('&amp; decoded in an href',
  G.extractActivationLinks(
    `<a href="https://${HOST}/Careers_External/activate/abc123/?a=1&amp;b=2">go</a>`),
  [ENTITY_URL]);

check('&amp; decoded in bare text',
  G.extractActivationLinks(
    `visit https://${HOST}/Careers_External/activate/abc123/?a=1&amp;b=2 today`),
  [ENTITY_URL]);

check('numeric &#38; decoded',
  G.extractActivationLinks(
    `https://${HOST}/Careers_External/activate/abc123/?a=1&#38;b=2`),
  [ENTITY_URL]);

/* ---- punctuation clinging to the end ------------------------------ */

const BARE = `https://${HOST}/Careers_External/activate/abc123/`;

check('angle brackets stripped', G.extractActivationLinks(`Go here: <${BARE}>`), [BARE]);
check('full stop stripped', G.extractActivationLinks(`Go to ${BARE}. It expires.`), [BARE]);
check('closing paren stripped', G.extractActivationLinks(`(see ${BARE})`), [BARE]);
check('closing bracket stripped', G.extractActivationLinks(`[${BARE}]`), [BARE]);
check('comma stripped', G.extractActivationLinks(`${BARE}, then sign in`), [BARE]);
check('trailing slash survives',
  G.extractActivationLinks(BARE)[0].endsWith('/'), true);

/* ---- more than one link in a mail --------------------------------- */

const SECOND = `https://acme.wd1.myworkdayjobs.com/External/activate/zzz999/`;

check('two activation links, in document order',
  G.extractActivationLinks(`first ${BARE} then ${SECOND}`),
  [BARE, SECOND]);

check('activation links survive a mail full of other links',
  G.extractActivationLinks(`
    <a href="https://www.workday.com/">About Workday</a>
    <a href="https://unsubscribe.example.com/u/123">Unsubscribe</a>
    <a href="${BARE}">Activate your account</a>
    <a href="https://twitter.com/workday">Follow us</a>
  `),
  [BARE]);

/* ---- rejection: this is the part that matters --------------------- */

check('non-Workday link rejected',
  G.extractActivationLinks('https://evil.example.com/activate/abc123/'), []);

check('http:// Workday link rejected',
  G.extractActivationLinks(`http://${HOST}/Careers_External/activate/abc123/`), []);

check('Workday link with no /activate/ rejected',
  G.extractActivationLinks(
    `https://${HOST}/en-US/Careers_External/job/Springfield-IL/Software-Engineer_R0000001`), []);

check('lookalike host rejected',
  G.extractActivationLinks('https://myworkdayjobs.com.evil.example/x/activate/abc123/'), []);

check('lookalike host rejected in an href too',
  G.extractActivationLinks(
    '<a href="https://myworkdayjobs.com.evil.example/x/activate/abc123/">Activate</a>'), []);

check('suffix without the dot rejected',
  G.extractActivationLinks('https://notmyworkdayjobs.com/x/activate/abc123/'), []);

check('userinfo disguise rejected',
  G.extractActivationLinks(`https://${HOST}@evil.example/Careers_External/activate/abc/`), []);

check('credentials in a genuine-looking Workday URL rejected',
  G.extractActivationLinks(`https://user:pw@${HOST}/Careers_External/activate/abc/`), []);

check('"activate" as a word, not a path segment, rejected',
  G.extractActivationLinks(`https://${HOST}/Careers_External/activate-now`), []);

/* Case in the PATH, which URL does not normalise the way it does the host.
 * Every link seen so far spells the segment in lower case, but the tenant's own
 * site segment is routinely capitalised, so a tenant that capitalised this one
 * too would have produced "no link found" and no way to tell why. Rejecting it
 * buys no safety: the hostname check is what does that work. */
const UPPER = `https://${HOST}/Careers_External/Activate/abc123/`;
check('a capitalised path segment is still an activation link',
  G.extractActivationLinks(UPPER), [UPPER]);
check('and a shouted host resolves too',
  G.extractActivationLinks(`https://${HOST.toUpperCase()}/Careers_External/activate/abc123/`),
  [`https://${HOST.toUpperCase()}/Careers_External/activate/abc123/`]);

check('mailto and other schemes rejected',
  G.extractActivationLinks(`<a href="mailto:noreply@${HOST}">mail us</a>`), []);

/* The phishing shape this feature has to survive: a real-looking mail whose
 * link goes somewhere else entirely. Nothing comes back, so nothing is shown. */
check('spoofed activation mail yields nothing',
  G.extractActivationLinks(`
    Click this link to confirm your email address and complete setup for your
    candidate account
    https://acmeinsurance.wd5.myworkdayjobs.com.login-verify.example/activate/abc/
    The link will expire after 24 hours.
  `), []);

/* ---- empty and nonsense input ------------------------------------- */

check('empty string', G.extractActivationLinks(''), []);
check('undefined', G.extractActivationLinks(undefined), []);
check('null', G.extractActivationLinks(null), []);
check('a number', G.extractActivationLinks(12345), []);
check('an object', G.extractActivationLinks({ body: ACTIVATE }), []);
check('prose with no links', G.extractActivationLinks('An email has been sent to you.'), []);

/* ---- base64url decoding ------------------------------------------- */

const b64url = (s) =>
  Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

check('base64url round-trips', G.decodeBase64Url(b64url(PLAIN_EXAMPLE)), PLAIN_EXAMPLE);
check('base64url handles non-ASCII', G.decodeBase64Url(b64url('café — £5')), 'café — £5');

/* ---- a whole multipart message, end to end ------------------------ */

/* The real shape: multipart/mixed wrapping multipart/alternative, the link in
 * both the text and the HTML alternative, plus an attachment to walk past. */
const MULTIPART = {
  internalDate: '1758500000000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Workday <noreply@acmeinsurance.example>' },
      { name: 'Subject', value: 'Activate your candidate account' },
    ],
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url(PLAIN_EXAMPLE) } },
          {
            mimeType: 'text/html',
            body: {
              data: b64url(
                `<html><body><p>Click this link</p>` +
                `<a href="${ACTIVATE}">confirm your email address</a>` +
                `<a href="https://tracker.example.com/open?id=9">.</a>` +
                `</body></html>`
              ),
            },
          },
        ],
      },
      {
        mimeType: 'application/pdf',
        filename: 'logo.pdf',
        body: { data: b64url('not a link, and never decoded') },
      },
    ],
  },
};

check('multipart message decodes to the one link',
  G.extractLinksFromMessage(MULTIPART), [ACTIVATE]);

check('a message with no payload is empty, not an error',
  G.extractLinksFromMessage({}), []);

check('a malformed part does not throw',
  G.extractLinksFromMessage({
    payload: { mimeType: 'text/plain', body: { data: '!!!not base64!!!' } },
  }), []);

/* ---- the placeholder client id ------------------------------------ */

check('placeholder client id is not configured', G.isConfigured(), false);

identityTouched = false;
check('status refuses while unconfigured',
  (await G.status()).configured, false);
check('status did not touch chrome.identity', identityTouched, false);

identityTouched = false;
check('connect refuses while unconfigured',
  (await G.connect()).reason, 'NO_CLIENT_ID');
check('connect did not touch chrome.identity', identityTouched, false);

identityTouched = false;
check('findActivationLink refuses while unconfigured',
  await G.findActivationLink({ hostname: HOST }),
  { ok: false, link: null, reason: 'NO_CLIENT_ID' });
check('find did not touch chrome.identity', identityTouched, false);

/* ---- configured, but not signed in -------------------------------- */

manifestClientId = '1234567890-abcdef.apps.googleusercontent.com';
cachedToken = null;

check('a real client id is configured', G.isConfigured(), true);
check('not connected without a token', (await G.status()).connected, false);
check('find reports NOT_CONNECTED',
  (await G.findActivationLink({ hostname: HOST })).reason, 'NOT_CONNECTED');

/* ---- configured and signed in: the whole lookup ------------------- */

cachedToken = TOKEN;

const now = Date.now();
const msg = (id, host, ms) => ({
  id,
  internalDate: String(ms),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: `Workday <noreply@${host}>` },
      { name: 'Subject', value: 'Activate your account' },
    ],
    body: { data: b64url(`Click here https://${host}/Ext/activate/${id}/ to finish.`) },
  },
});

fetchRoutes = {
  'messages/old': msg('old', HOST, now - 5 * 60 * 60 * 1000),      // 5h ago
  'messages/other': msg('other', 'acme.wd1.myworkdayjobs.com', now - 4 * 60 * 1000),
  'messages/mine': msg('mine', HOST, now - 9 * 60 * 1000),
  'users/me/messages?': { messages: [{ id: 'old' }, { id: 'other' }, { id: 'mine' }] },
};

const found = await G.findActivationLink({ hostname: HOST, windowMinutes: 60 });
check('a link is found', found.ok && !!found.link, true);
check('the tenant you are on wins over the newer other one',
  found.link?.url, `https://${HOST}/Ext/activate/mine/`);
check('it says the tenant matched', found.link?.matchedTenant, true);
check('sender comes back', found.link?.from, `Workday <noreply@${HOST}>`);
check('subject comes back', found.link?.subject, 'Activate your account');
check('tenant comes back', found.link?.tenant, HOST);

/* No hostname to prefer: newest wins, and the caller is told it is not a
 * tenant match so the popup can say so. */
const newest = await G.findActivationLink({ windowMinutes: 60 });
check('with no hostname the newest wins',
  newest.link?.url, 'https://acme.wd1.myworkdayjobs.com/Ext/activate/other/');
check('and it admits the tenant did not match', newest.link?.matchedTenant, false);

/* The 5-hour-old mail is the only candidate inside a 1-minute window — and it
 * is outside it, so nothing is offered rather than something expired. */
const narrow = await G.findActivationLink({ hostname: HOST, windowMinutes: 1 });
check('mail older than the window is ignored', narrow.link, null);
check('and the reason says so', narrow.reason, 'NO_MATCH');

/* A mailbox with nothing matching is a clean answer, not an error. */
fetchRoutes = { 'users/me/messages?': { messages: [] } };
check('empty result set', await G.findActivationLink({ hostname: HOST }),
  { ok: true, link: null, reason: 'NO_MATCH' });

/* ---- polling ------------------------------------------------------ */

/* Abort is felt immediately — the popup closing must not leave a 90s timer
 * ticking in the worker. */
const ac = new AbortController();
ac.abort();
check('an aborted poll returns at once',
  await G.pollForActivationLink({ hostname: HOST, signal: ac.signal }),
  { ok: false, link: null, reason: 'ABORTED' });

/* A fatal reason stops the loop rather than burning 90 seconds on it. */
cachedToken = null;
const t0 = Date.now();
const fatal = await G.pollForActivationLink({ hostname: HOST });
check('a fatal reason stops the poll', fatal.reason, 'NOT_CONNECTED');
check('and it stopped immediately', Date.now() - t0 < 1000, true);

check('poll timings are exported for the popup', G.POLL,
  { intervalMs: 5000, timeoutMs: 90000 });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
