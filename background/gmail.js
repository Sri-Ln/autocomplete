/**
 * gmail.js — find the Workday account-activation link in your Gmail.
 *
 * After you create a Workday candidate account the tenant emails you a link and
 * the page just says "An email has been sent to you." This module finds that
 * email and hands back the URL. It does NOT open it.
 *
 * ── Why it never navigates ──────────────────────────────────────────
 * A URL that arrived by email is untrusted input. Anything in the mailbox can
 * claim to be an activation mail, and an extension that follows such a link
 * automatically is a confused deputy: it would be clicking on the user's behalf,
 * with the user's cookies, on a URL chosen by whoever sent the mail. So this
 * module returns a string, the popup shows it, and the click stays the user's.
 *
 * The other half of that defence is extractActivationLinks(), which throws away
 * everything that is not an https Workday activation URL. See its comment.
 *
 * ── Privacy ─────────────────────────────────────────────────────────
 *   - The OAuth token is NEVER copied into chrome.storage. Chrome's identity
 *     cache already holds it; a second copy is a second thing to leak, and it
 *     would outlive the cache's own expiry handling.
 *   - Message bodies are never stored, never logged, and never leave this
 *     worker. They exist as local variables for the length of one scan.
 *   - Errors are reported as codes, never with a response body attached, so a
 *     failed request cannot spill mail content into the console.
 *   - Of the one message that matches, only the extracted URL and its sender,
 *     subject and date are returned. Nothing about the other messages scanned
 *     is returned or kept.
 *
 * Service-worker only (ES module), same as storage.js and crypto.js.
 */

/* ------------------------------------------------------------------ */
/* the filter                                                          */
/* ------------------------------------------------------------------ */

/* Hostname must END WITH this, so `myworkdayjobs.com.evil.example` fails:
 * that host ends with `.evil.example`, and the leading dot here is what stops
 * a suffix match from being a substring match. */
const ALLOWED_HOST_SUFFIX = '.myworkdayjobs.com';

/* Workday activation URLs are /<tenant site>/activate/<token>. A plain job
 * posting or a "view your application" link has no such segment, and offering
 * one as the activation link would be wrong in a way the user cannot see. */
const REQUIRED_PATH_SEGMENT = '/activate/';

/**
 * Both shapes a link can arrive in, scanned in one pass so the result stays in
 * document order: an HTML href, or a bare URL sitting in text.
 *
 * The bare-URL branch excludes < > " ' ` and backslash, which is what makes
 * `<https://…>` and `href="https://…"` terminate correctly rather than eating
 * the closing delimiter.
 */
const URL_SCAN = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'|(https?:\/\/[^\s<>"'`\\]+)/gi;

/* Sentence punctuation and closing brackets that live AFTER a URL, not in it.
 * "…/activate/abc." and "[…/activate/abc]" are both common in mail. `/` is
 * deliberately absent — a trailing slash is part of the path. */
const TRAILING_JUNK = /[.,;:!?'")\]>}<]+$/;

/** HTML-escaped ampersands, in the three forms that actually turn up. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&');
}

/**
 * The whole trust boundary, in four checks.
 *
 * A mailbox is full of links — newsletters, receipts, phishing. This function
 * is what makes it impossible for the popup to be handed one of those. Anything
 * that is not an https Workday activation URL is discarded silently; there is
 * no "probably fine" branch, and no http:// branch, because a plaintext link is
 * a link an on-path attacker can rewrite.
 */
function isActivationLink(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false; // not a URL at all
  }

  if (u.protocol !== 'https:') return false;

  /* userinfo is a classic disguise — `https://tenant.myworkdayjobs.com@evil/`
   * already fails the hostname check, but `https://user:pw@tenant…` reads as a
   * legitimate Workday link and has no business being one. */
  if (u.username || u.password) return false;

  // URL lowercases the hostname for us, so no case-folding needed here.
  if (!u.hostname.endsWith(ALLOWED_HOST_SUFFIX)) return false;

  /* The path, though, keeps its case: the tenant's site segment is routinely
   * capitalised ("/Careers_External/"). Every link seen so far spells the
   * segment "/activate/" in lower case, but a tenant that does not would have
   * produced "no link found" and no way to tell why. Case-folding here costs
   * nothing — the hostname check above is what does the security work. */
  return u.pathname.toLowerCase().includes(REQUIRED_PATH_SEGMENT);
}

/**
 * Pull Workday activation links out of one message body — plain text or HTML.
 *
 * PURE: no network, no storage, no globals. This is the function the unit tests
 * hammer, because it is the one that decides what the user can be shown.
 *
 * Returns a deduped array in the order the links appeared. Usually length 0 or 1.
 */
export function extractActivationLinks(body) {
  const text = typeof body === 'string' ? body : '';
  if (!text) return [];

  const out = [];
  const seen = new Set();

  URL_SCAN.lastIndex = 0; // the regex is module-level and /g — reset before use
  for (let m = URL_SCAN.exec(text); m; m = URL_SCAN.exec(text)) {
    const candidate = m[1] ?? m[2] ?? m[3] ?? '';
    const url = decodeEntities(candidate).trim().replace(TRAILING_JUNK, '');

    if (!isActivationLink(url)) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    out.push(url);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* message decoding                                                    */
/* ------------------------------------------------------------------ */

/** Gmail hands body data back base64url-encoded, unpadded. */
export function decodeBase64Url(data) {
  const b64 = String(data ?? '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  // Via bytes rather than atob's output directly, so a £ or an em dash in the
  // mail does not come back mojibake.
  return new TextDecoder().decode(bytes);
}

/**
 * Walk a message's MIME tree and return every activation link found in it.
 *
 * Recursive because multipart/alternative nests: the real body is often
 * multipart/alternative{text/plain, text/html} wrapped in multipart/mixed with
 * the tenant's logo alongside. Only text/plain and text/html are decoded —
 * attachments are skipped, since an activation link is never inside one and
 * decoding a PDF here would be pointless work on untrusted bytes.
 *
 * PURE with respect to the network; takes a Gmail message object as-is.
 */
export function extractLinksFromMessage(message) {
  const found = [];
  const seen = new Set();

  const visit = (part) => {
    if (!part) return;

    const mime = String(part.mimeType ?? '');
    if (mime === 'text/plain' || mime === 'text/html') {
      const data = part.body?.data;
      if (data) {
        let decoded = '';
        try {
          decoded = decodeBase64Url(data);
        } catch {
          return; // truncated or malformed part — skip it, never throw upward
        }
        for (const url of extractActivationLinks(decoded)) {
          if (seen.has(url)) continue;
          seen.add(url);
          found.push(url);
        }
      }
    }

    for (const child of part.parts ?? []) visit(child);
  };

  visit(message?.payload);
  return found;
}

/** Case-insensitive header lookup — Gmail's casing is not guaranteed. */
function header(message, name) {
  const wanted = name.toLowerCase();
  for (const h of message?.payload?.headers ?? []) {
    if (String(h.name ?? '').toLowerCase() === wanted) return String(h.value ?? '');
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * The OAuth client id is per-installation — it is bound to the extension's own
 * id, so it cannot be shipped in the repo. Until the user pastes theirs in,
 * every path here must refuse early and chrome.identity must never be touched:
 * calling it with a placeholder id produces an opaque Chrome error dialog, and
 * "not set up yet" is a thing to say plainly, not to discover from a failure.
 */
export function clientId() {
  try {
    return chrome.runtime.getManifest()?.oauth2?.client_id ?? '';
  } catch {
    return '';
  }
}

export function isConfigured() {
  const id = clientId();
  return !!id && !id.includes('REPLACE_ME');
}

/* ------------------------------------------------------------------ */
/* tokens                                                              */
/* ------------------------------------------------------------------ */

const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * chrome.identity.getAuthToken, promisified.
 *
 * Callback form rather than the promise form because lastError has to be read
 * on the failure path — leaving it unread makes Chrome log "Unchecked
 * runtime.lastError" for a case we are handling deliberately.
 */
function getAuthToken(interactive) {
  return new Promise((resolve) => {
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chrome.runtime.lastError?.message;
        resolve(token ? { token } : { token: null, error: err ?? 'NO_TOKEN' });
      });
    } catch (e) {
      resolve({ token: null, error: String(e?.message ?? e) });
    }
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    try {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        void chrome.runtime.lastError;
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------------ */
/* connect / status / disconnect                                       */
/* ------------------------------------------------------------------ */

/** Ask Gmail who we are. Also the cheapest proof the token actually works. */
async function accountEmail(token) {
  try {
    const me = await gmailGet(token, 'profile');
    return String(me.emailAddress ?? '');
  } catch {
    return ''; // a working connection with an unknown address is still connected
  }
}

/**
 * Interactive sign-in. The Google account chooser and consent screen are
 * Chrome's, not ours — this never sees a password.
 */
export async function connect() {
  if (!isConfigured()) return { ok: false, reason: 'NO_CLIENT_ID' };

  const { token, error } = await getAuthToken(true);
  if (!token) {
    /* Only a real dismissal counts as cancelled.
     *
     * This used to match /user|cancel|closed/, which swallowed most of the
     * setup failures: Chrome words "The user is not signed in" and "User
     * interaction required" with the same word as an actual dismissal, so a
     * mismatched client id or an unsigned-in profile was reported to the user
     * as "Sign-in cancelled" — an answer that sends them looking at the wrong
     * thing entirely. Anything not clearly a dismissal now carries its message
     * up, because that message names the problem. */
    const dismissed =
      /did not approve|cancel|canceled|cancelled|closed by/i.test(error ?? '');

    return { ok: false, reason: dismissed ? 'CANCELLED' : 'AUTH_FAILED', error };
  }

  return { ok: true, connected: true, email: await accountEmail(token) };
}

/**
 * Non-interactive: are we already connected? Never pops a window, so it is safe
 * to call on every popup open.
 */
export async function status() {
  if (!isConfigured()) {
    return { ok: true, configured: false, connected: false, poll: POLL };
  }

  const { token } = await getAuthToken(false);
  if (!token) return { ok: true, configured: true, connected: false, poll: POLL };

  return {
    ok: true,
    configured: true,
    connected: true,
    email: await accountEmail(token),
    poll: POLL,
  };
}

/**
 * Disconnect properly, which is two separate things:
 *
 *   1. removeCachedAuthToken — drops Chrome's local copy. Without this the next
 *      getAuthToken hands back the same token from cache and nothing changed.
 *   2. the revoke endpoint — tells Google the grant is over. Without this the
 *      token stays valid at Google for up to an hour and the extension is still
 *      listed under the account's third-party access.
 *
 * Neither implies the other, so both run and the caller is told which worked.
 */
export async function disconnect() {
  if (!isConfigured()) return { ok: false, reason: 'NO_CLIENT_ID' };

  const { token } = await getAuthToken(false);
  if (!token) return { ok: true, connected: false, cleared: false, revoked: false };

  let revoked = false;
  try {
    const res = await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    });
    revoked = res.ok;
  } catch {
    revoked = false; // offline. The local cache is still worth clearing.
  }

  const cleared = await removeCachedAuthToken(token);

  return { ok: true, connected: false, cleared, revoked };
}

/* ------------------------------------------------------------------ */
/* Gmail REST v1                                                       */
/* ------------------------------------------------------------------ */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';

/**
 * One GET against the Gmail API.
 *
 * On failure it throws a bare code — never the response body. A Gmail error
 * body can quote the request, and the request can name a mailbox; there is no
 * version of that which belongs in a log line.
 */
async function gmailGet(token, path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`HTTP_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * The search.
 *
 * `newer_than` is the only recency operator Gmail exposes and its finest unit
 * is a day, so the real time window is applied afterwards against each
 * message's internalDate. This just keeps the result set small.
 *
 * `in:anywhere` includes Spam and Trash on purpose: a first mail from a tenant
 * nobody in your address book has ever written to is exactly the mail that gets
 * filed as spam, and "it's not in my inbox" is the problem this feature exists
 * to solve.
 */
const SEARCH_QUERY =
  'in:anywhere newer_than:1d ' +
  '(activate OR activation OR "verify your account" OR "confirm your email" ' +
  'OR "candidate account")';

const MAX_MESSAGES = 25;

/** Poll timing. Exported so the popup can use the same numbers, not its own. */
export const POLL = { intervalMs: 5000, timeoutMs: 90000 };

/**
 * Find the newest Workday activation link in recent mail.
 *
 * @param hostname      the Workday host the user is actually on, if known.
 *                      Used to PREFER a link on the same tenant — the result
 *                      says which happened, because "here is an activation link
 *                      for some other company" is a different answer.
 * @param windowMinutes how far back to look. Older mail is ignored: these links
 *                      expire in 24 hours and a stale one fails confusingly.
 *
 * Returns { ok, link|null, reason }. Never throws at the caller.
 */
export async function findActivationLink({ hostname = '', windowMinutes = 60 } = {}) {
  if (!isConfigured()) return { ok: false, link: null, reason: 'NO_CLIENT_ID' };

  const { token } = await getAuthToken(false);
  if (!token) return { ok: false, link: null, reason: 'NOT_CONNECTED' };

  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const matches = [];

  try {
    const list = await gmailGet(token, 'messages', {
      q: SEARCH_QUERY,
      maxResults: MAX_MESSAGES,
    });

    for (const stub of list.messages ?? []) {
      const message = await gmailGet(token, `messages/${stub.id}`, { format: 'full' });

      const receivedMs = Number(message.internalDate ?? 0);
      if (receivedMs && receivedMs < cutoff) continue;

      const urls = extractLinksFromMessage(message);
      if (!urls.length) continue;

      /* Only these four values escape the scan. The body that produced them is
       * a local variable inside extractLinksFromMessage and is gone by now. */
      for (const url of urls) {
        matches.push({
          url,
          from: header(message, 'From'),
          subject: header(message, 'Subject'),
          receivedAt: receivedMs ? new Date(receivedMs).toISOString() : '',
          receivedMs,
          tenant: new URL(url).hostname,
        });
      }
    }
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      // The cached token is stale or the scope was withdrawn at Google.
      await removeCachedAuthToken(token);
      return { ok: false, link: null, reason: 'NOT_CONNECTED' };
    }
    return { ok: false, link: null, reason: String(err?.message ?? 'REQUEST_FAILED') };
  }

  if (!matches.length) return { ok: true, link: null, reason: 'NO_MATCH' };

  matches.sort((a, b) => b.receivedMs - a.receivedMs); // newest first

  const onTenant = hostname ? matches.find((m) => m.tenant === hostname) : null;
  const best = onTenant ?? matches[0];

  return {
    ok: true,
    reason: 'FOUND',
    link: {
      url: best.url,
      from: best.from,
      subject: best.subject,
      receivedAt: best.receivedAt,
      tenant: best.tenant,
      // false means "newest Workday activation link we could find", which the
      // popup has to say out loud — it may belong to a different application.
      matchedTenant: !!onTenant,
    },
  };
}

/**
 * Poll until the mail turns up.
 *
 * The mail usually lands within seconds, occasionally up to about a minute, so
 * a single lookup right after signup finds nothing and looks broken. Polls
 * every 5s for at most 90s and stops on the first hit.
 *
 * Fatal reasons stop the loop immediately: waiting 90 seconds to find out the
 * user was never connected is just a slower error message.
 *
 * `signal` is an AbortSignal so a caller can give up — a popup that closes, or
 * a user who clicks Cancel, should not leave a timer running in the worker.
 */
export async function pollForActivationLink(opts = {}) {
  const {
    hostname = '',
    windowMinutes = 60,
    intervalMs = POLL.intervalMs,
    timeoutMs = POLL.timeoutMs,
    signal,
  } = opts;

  const deadline = Date.now() + timeoutMs;
  let last = { ok: true, link: null, reason: 'NO_MATCH' };

  while (!signal?.aborted) {
    last = await findActivationLink({ hostname, windowMinutes });
    if (last.link) return last;
    if (!last.ok && last.reason !== 'NO_MATCH') return last;

    if (Date.now() + intervalMs >= deadline) break;
    await sleep(intervalMs, signal);
  }

  if (signal?.aborted) return { ok: false, link: null, reason: 'ABORTED' };
  return { ok: true, link: null, reason: 'TIMED_OUT' };
}

/** setTimeout that also wakes on abort, so a cancel is felt at once. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}
