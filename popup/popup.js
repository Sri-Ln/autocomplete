/**
 * popup.js — setup, unlock, and editing your saved details.
 *
 * The popup is a trusted context, so it can talk to the service worker directly.
 * It still never handles the encryption key itself: it hands the worker a
 * passphrase or a plaintext password and gets back only booleans and emails.
 */

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const PROFILE_FIELDS = [
  'firstName', 'lastName', 'phone', 'address1', 'address2',
  'city', 'state', 'zip', 'country', 'source', 'noticePeriod',
  'visaExplanation',
];

/** Rendered as one-per-line textareas, stored as arrays. */
const PROFILE_LIST_FIELDS = ['employers', 'relativesAt'];

/**
 * Tri-state fields rendered as segmented controls rather than <select>.
 * Values are '' | 'yes' | 'no'; '' means "leave it blank, I'll answer it".
 */
const PROFILE_SEG_FIELDS = [
  'over18', 'willingToRelocate', 'willingToTravel',
  'workAuthorized', 'needsSponsorship',
];

/* ------------------------------------------------------------------ */
/* segmented controls                                                  */
/* ------------------------------------------------------------------ */

const segValue = (id) =>
  $(id).querySelector('button.active')?.dataset.value ?? '';

function setSeg(id, value) {
  const group = $(id);
  const wanted = value ?? '';
  for (const btn of group.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.value === wanted);
    btn.setAttribute('aria-checked', String(btn.dataset.value === wanted));
  }
}

for (const id of PROFILE_SEG_FIELDS) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setSeg(id, btn.dataset.value);
  });
}

let toastTimer;
function toast(text, kind = 'info') {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function showView(name) {
  for (const v of ['setupView', 'lockedView', 'mainView']) $(v).hidden = v !== name;
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  const status = await send({ type: 'status' });

  $('lockBtn').hidden = !status.unlocked;
  $('headerSub').textContent = !status.configured
    ? 'Set up to get started'
    : status.unlocked
      ? 'Unlocked for this session'
      : 'Locked';

  if (!status.configured) {
    showView('setupView');
    $('setupPass').focus();
    return;
  }
  if (!status.unlocked) {
    showView('lockedView');
    $('unlockPass').focus();
    return;
  }

  showView('mainView');
  await Promise.all([loadProfile(), loadCredentials(), loadSettings(), loadAnswers()]);
}

/* ------------------------------------------------------------------ */
/* setup / unlock / lock                                              */
/* ------------------------------------------------------------------ */

$('setupBtn').addEventListener('click', async () => {
  const a = $('setupPass').value;
  const b = $('setupPass2').value;

  if (a !== b) return toast('Passphrases do not match.', 'err');
  if (a.length < 4) return toast('Use at least 4 characters.', 'err');

  const res = await send({ type: 'setup', passphrase: a });
  if (!res.ok) return toast(res.error ?? 'Setup failed.', 'err');

  toast('Ready.', 'ok');
  boot();
});

$('unlockBtn').addEventListener('click', unlock);
$('unlockPass').addEventListener('keydown', (e) => e.key === 'Enter' && unlock());

async function unlock() {
  const res = await send({ type: 'unlock', passphrase: $('unlockPass').value });
  if (!res.ok) return toast(res.error ?? 'Wrong passphrase.', 'err');
  $('unlockPass').value = '';
  boot();
}

$('lockBtn').addEventListener('click', async () => {
  await send({ type: 'lock' });
  boot();
});

/* ------------------------------------------------------------------ */
/* tabs                                                               */
/* ------------------------------------------------------------------ */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.panel')) {
      p.hidden = p.dataset.panel !== tab.dataset.tab;
    }
  });
}

/* ------------------------------------------------------------------ */
/* profile                                                            */
/* ------------------------------------------------------------------ */

async function loadProfile() {
  const { profile } = await send({ type: 'getProfile' });
  for (const key of PROFILE_FIELDS) $(key).value = profile[key] ?? '';
  for (const key of PROFILE_LIST_FIELDS) {
    $(key).value = (profile[key] ?? []).join('\n');
  }
  for (const key of PROFILE_SEG_FIELDS) setSeg(key, profile[key]);
  paintVisaCount();
}

/* ------------------------------------------------------------------ */
/* visa explanation                                                    */
/* ------------------------------------------------------------------ */

/**
 * The Copy button is the fallback that has to work when nothing else does.
 *
 * The pill on the page depends on recognising the question, and the question is
 * written per company — so it will miss sometimes. When it does, this is how the
 * text gets out of the extension, and it must not itself depend on anything
 * clever.
 */
$('copyVisaBtn').addEventListener('click', async () => {
  const text = $('visaExplanation').value.trim();
  if (!text) return toast('Nothing to copy — write your explanation first.', 'err');

  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. Paste it into the application.', 'ok');
  } catch {
    /* The async clipboard API needs a permissions check that can fail, and a
     * failed copy is invisible — you paste and get whatever was there before.
     * Select the text instead so Ctrl+C still works, and say so. */
    const box = $('visaExplanation');
    box.focus();
    box.select();
    toast('Could not copy automatically — press Ctrl+C.', 'err');
  }
});

/* An unsaved edit is the likeliest reason the pill offers stale text, so show
 * the count and mark the field dirty until it is saved. */
function paintVisaCount() {
  const text = $('visaExplanation').value.trim();
  $('visaCount').textContent = text ? `${text.length} characters` : '';
}

$('visaExplanation').addEventListener('input', () => {
  paintVisaCount();
  $('visaCount').textContent += ' · unsaved';
});

$('saveProfileBtn').addEventListener('click', async () => {
  const profile = {};
  for (const key of PROFILE_FIELDS) profile[key] = $(key).value;
  for (const key of PROFILE_SEG_FIELDS) profile[key] = segValue(key);
  for (const key of PROFILE_LIST_FIELDS) {
    profile[key] = $(key)
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const res = await send({ type: 'saveProfile', profile });
  toast(res.ok ? 'Profile saved.' : (res.error ?? 'Save failed.'), res.ok ? 'ok' : 'err');

  if (res.ok) {
    paintVisaCount(); // clears the "unsaved" marker
    // Open tabs cache the profile for the pill; tell them it moved.
    await broadcast({ type: 'profileChanged' });
  }
});

/* ------------------------------------------------------------------ */
/* learned answers                                                     */
/* ------------------------------------------------------------------ */

async function loadAnswers() {
  const res = await send({ type: 'getAnswers' });
  const list = $('answersList');
  list.innerHTML = '';

  const entries = Object.entries(res.answers ?? {});
  $('answersLabel').hidden = entries.length === 0;
  $('forgetAllBtn').hidden = entries.length === 0;

  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'fine';
    p.textContent = 'Nothing remembered yet. Answer a question on an application and it will show up here.';
    list.append(p);
    return;
  }

  // Most-used first: those are the ones worth checking are right.
  entries.sort((a, b) => (b[1].seen ?? 0) - (a[1].seen ?? 0));

  for (const [signature, entry] of entries) {
    const row = document.createElement('div');
    row.className = 'item';

    const who = document.createElement('div');
    who.className = 'who';

    const q = document.createElement('span');
    q.className = 'scope';
    q.textContent = signature;
    q.title = signature;

    const a = document.createElement('span');
    a.className = 'email';
    a.textContent = `${entry.answer} · seen ${entry.seen ?? 1}×`;

    who.append(q, a);
    row.append(who);

    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Forget this answer';
    del.addEventListener('click', async () => {
      await send({ type: 'forgetAnswer', signature });
      loadAnswers();
    });
    row.append(del);

    list.append(row);
  }
}

$('forgetAllBtn').addEventListener('click', async () => {
  if (!confirm('Forget every remembered answer? Your profile is unaffected.')) return;
  await send({ type: 'saveAnswers', answers: {} });
  loadAnswers();
  toast('Answers cleared.', 'ok');
});

/* ------------------------------------------------------------------ */
/* credentials                                                        */
/* ------------------------------------------------------------------ */

$('credIsOverride').addEventListener('change', async (e) => {
  $('overrideHostWrap').hidden = !e.target.checked;

  // Prefill the host box with whatever tab you're looking at — that's almost
  // always the one you mean.
  if (e.target.checked && !$('credHost').value) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      $('credHost').value = new URL(tab.url).hostname;
    } catch {
      /* chrome:// pages and the like have no useful hostname */
    }
  }
});

async function loadCredentials() {
  const res = await send({ type: 'listCredentials' });
  const list = $('credList');
  list.innerHTML = '';

  const isEmpty = !res.default && res.overrides.length === 0;
  $('credListLabel').hidden = isEmpty;

  if (isEmpty) {
    const p = document.createElement('p');
    p.className = 'fine';
    p.textContent = 'No login saved yet.';
    list.append(p);
    return;
  }

  if (res.default) {
    list.append(credRow('All Workday sites', res.default.email, null, 'default'));
    $('credEmail').value = res.default.email;
  }
  for (const o of res.overrides) list.append(credRow(o.host, o.email, o.host));
}

function credRow(scopeLabel, email, hostKey, tag) {
  const row = document.createElement('div');
  row.className = 'item';

  const who = document.createElement('div');
  who.className = 'who';

  const scope = document.createElement('span');
  scope.className = 'scope';
  scope.textContent = scopeLabel;

  const mail = document.createElement('span');
  mail.className = 'email';
  mail.textContent = email;

  who.append(scope, mail);
  row.append(who);

  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = tag;
    row.append(t);
  }

  const del = document.createElement('button');
  del.textContent = '×';
  del.title = 'Delete';
  del.addEventListener('click', async () => {
    await send({ type: 'deleteCredential', host: hostKey });
    loadCredentials();
  });
  row.append(del);

  return row;
}

$('saveCredBtn').addEventListener('click', async () => {
  const isOverride = $('credIsOverride').checked;
  const host = isOverride ? $('credHost').value.trim() : null;

  if (isOverride && !host) return toast('Enter a host, or untick the box.', 'err');

  const res = await send({
    type: 'saveCredential',
    host,
    email: $('credEmail').value.trim(),
    password: $('credPass').value,
  });

  if (!res.ok) return toast(res.error ?? 'Save failed.', 'err');

  // Never leave a plaintext password sitting in the DOM.
  $('credPass').value = '';
  toast('Login saved.', 'ok');
  loadCredentials();
});

/* ------------------------------------------------------------------ */
/* verify email — the Gmail activation link                            */
/* ------------------------------------------------------------------ */

/**
 * The link is SHOWN, never followed.
 *
 * Everything below renders a URL and waits. The Open button calls
 * chrome.tabs.create, which is a click the user made; nothing on this page
 * navigates on its own. The service worker has already thrown away every URL
 * that is not an https `*.myworkdayjobs.com` `/activate/` link, so what lands
 * here is narrow — but "narrow" is not "trusted", and it still only opens on
 * a click.
 */

/* Poll timings come from background/gmail.js via gmailStatus, so the policy
 * lives in one place. These are only the fallback if the worker never answers. */
let gmailPoll = { intervalMs: 5000, timeoutMs: 90000 };

/** The current find, so a second click can cancel it. */
let gmailFind = null;
let gmailUrl = '';

async function loadGmail() {
  const res = await send({ type: 'gmailStatus' });
  gmailPoll = res?.poll ?? gmailPoll;

  const configured = !!res?.configured;
  $('gmailSetup').hidden = configured;
  $('gmailReady').hidden = !configured;

  if (!configured) {
    // The OAuth client is bound to this ID, so the setup steps have to show it.
    $('gmailExtId').textContent = chrome.runtime?.id ?? '(reload the extension)';
    return;
  }

  paintGmail(!!res.connected, res.email ?? '');
}

function paintGmail(connected, email) {
  $('gmailScope').textContent = connected ? 'Gmail connected' : 'Gmail not connected';
  $('gmailEmail').textContent = connected
    ? (email || 'signed in')
    : 'Read-only, only to find this one link';

  $('gmailConnectBtn').hidden = connected;
  $('gmailDisconnectBtn').hidden = !connected;
  $('gmailFindBtn').hidden = !connected;

  if (!connected) {
    $('gmailResult').hidden = true;
    gmailNote('');
  }
}

function gmailNote(text) {
  $('gmailNote').textContent = text;
  $('gmailNote').hidden = !text;
}

$('gmailConnectBtn').addEventListener('click', async () => {
  gmailNote('Waiting for the Google sign-in window…');
  const res = await send({ type: 'gmailConnect' });

  if (!res?.ok) {
    /* Show what Chrome actually said.
     *
     * A toast saying "could not connect" is useless here: every setup mistake
     * looks identical from the outside, and the one string that distinguishes
     * a mismatched client id from a profile that is not signed in from a
     * missing test user is the message chrome.identity hands back. It goes in
     * the note, which stays on screen, rather than a toast that vanishes. */
    const detail = res?.error ? ` ${res.error}` : '';

    if (res?.reason === 'CANCELLED') {
      gmailNote('Sign-in cancelled — the Google window was closed before you approved.');
      return toast('Sign-in cancelled.', 'err');
    }

    gmailNote(
      (res?.reason === 'NO_CLIENT_ID'
        ? 'No client id in manifest.json — reload the extension after adding it.'
        : 'Google refused the sign-in.') + detail
    );
    return toast('Could not connect to Gmail.', 'err');
  }

  gmailNote('');
  paintGmail(true, res.email ?? '');
  toast('Gmail connected.', 'ok');
});

$('gmailDisconnectBtn').addEventListener('click', async () => {
  const res = await send({ type: 'gmailDisconnect' });
  paintGmail(false, '');

  /* Say which half happened. Clearing Chrome's cached token stops this
   * extension using it; revoking is what removes the grant at Google. If the
   * revoke failed you are offline, and the grant is still live — worth knowing
   * rather than being told "disconnected" flatly. */
  if (res?.revoked) toast('Disconnected, and access revoked at Google.', 'ok');
  else if (res?.cleared) toast('Token cleared here. Revoke at Google failed — try again online.', 'err');
  else toast('Nothing to disconnect.', 'ok');
});

$('gmailFindBtn').addEventListener('click', () => {
  if (gmailFind) {
    gmailFind.cancelled = true;
    gmailFind = null;
    setFinding(false);
    gmailNote('Stopped.');
    return;
  }
  findVerificationLink();
});

function setFinding(on) {
  $('gmailFindBtn').textContent = on ? 'Stop looking' : 'Find the verification link';
}

/**
 * Poll for the mail.
 *
 * The loop lives here rather than in the service worker on purpose: MV3 is
 * free to shut the worker down, and a single message left open for 90 seconds
 * is the shape that gets killed mid-wait. One short round trip every 5s
 * survives a restart, and Stop is felt immediately instead of after the
 * current request.
 */
async function findVerificationLink() {
  const me = { cancelled: false };
  gmailFind = me;
  setFinding(true);
  $('gmailResult').hidden = true;
  gmailNote('Looking for the email…');

  // The tenant you are actually on. Used to prefer its link over some other
  // company's, not to filter — see gmail.js.
  let hostname = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    hostname = new URL(tab.url).hostname;
  } catch {
    /* chrome:// pages and the like have no useful hostname */
  }

  const deadline = Date.now() + gmailPoll.timeoutMs;

  while (!me.cancelled) {
    const res = await send({ type: 'gmailFindLink', hostname });
    if (me.cancelled) return;

    if (res?.link) {
      gmailFind = null;
      setFinding(false);
      return showActivationLink(res.link);
    }

    // NO_MATCH just means "not yet". Anything else will not fix itself by
    // waiting another 85 seconds.
    if (!res?.ok && res?.reason !== 'NO_MATCH') {
      gmailFind = null;
      setFinding(false);
      gmailNote(
        res?.reason === 'NOT_CONNECTED'
          ? 'Gmail access expired. Connect again.'
          : 'Could not search Gmail. Try again in a moment.'
      );
      if (res?.reason === 'NOT_CONNECTED') paintGmail(false, '');
      return;
    }

    if (Date.now() + gmailPoll.intervalMs >= deadline) break;
    gmailNote(`Looking for the email… ${Math.round((deadline - Date.now()) / 1000)}s left`);
    await new Promise((r) => setTimeout(r, gmailPoll.intervalMs));
  }

  gmailFind = null;
  setFinding(false);
  if (!me.cancelled) {
    gmailNote('No activation email in the last hour. Check Spam, or resend it from Workday and look again.');
  }
}

function showActivationLink(link) {
  gmailUrl = link.url;

  $('gmailResultTitle').textContent = link.matchedTenant
    ? 'Activation link for this site'
    : 'Activation link — different site';

  $('gmailUrl').textContent = link.url;

  const bits = [];
  if (link.from) bits.push(link.from);
  if (link.subject) bits.push(link.subject);
  const age = describeAge(link.receivedAt);
  if (age) bits.push(age);
  $('gmailMeta').textContent = bits.join(' · ');

  gmailNote(
    link.matchedTenant
      ? 'Check the address, then Open. It expires after 24 hours.'
      : `This link is for ${link.tenant}, not the tab you are on. Check it is the one you want.`
  );

  $('gmailResult').hidden = false;
}

/** "just now" / "4 min ago" / "2 h ago" — enough to spot a stale mail. */
function describeAge(iso) {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';

  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

/* chrome.tabs.create, not location or a redirect: a new tab the user asked
 * for, opened only from this click. */
$('gmailOpenBtn').addEventListener('click', async () => {
  if (!gmailUrl) return;
  await chrome.tabs.create({ url: gmailUrl });
  window.close();
});

$('gmailCopyBtn').addEventListener('click', async () => {
  if (!gmailUrl) return;
  try {
    await navigator.clipboard.writeText(gmailUrl);
    toast('Link copied.', 'ok');
  } catch {
    // Same failure mode as the visa Copy button: a silent miss is worse than
    // saying so, because you paste and get whatever was there before.
    toast('Could not copy — select the link and press Ctrl+C.', 'err');
  }
});

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  const { settings } = await send({ type: 'getSettings' });
  $('autoSubmit').checked = settings.autoSubmit !== false;
  $('showWidget').checked = settings.showWidget !== false;
}

$('autoSubmit').addEventListener('change', async (e) => {
  await send({ type: 'saveSettings', patch: { autoSubmit: e.target.checked } });
  toast(e.target.checked ? 'Will submit automatically.' : 'Will wait for a second click.', 'ok');
});

$('showWidget').addEventListener('change', async (e) => {
  await send({ type: 'saveSettings', patch: { showWidget: e.target.checked } });
  await broadcast({ type: 'settingsChanged' });
  toast(e.target.checked ? 'Widget shown on pages.' : 'Widget hidden.', 'ok');
});

/** Tell any open content scripts that settings moved. Failures are fine. */
async function broadcast(msg) {
  const tabs = await chrome.tabs.query({ url: 'https://*.myworkdayjobs.com/*' });
  await Promise.all(
    tabs.map((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => {}))
  );
}

$('wipeBtn').addEventListener('click', async () => {
  if (!confirm('Erase your passphrase, profile, and all saved logins? This cannot be undone.')) {
    return;
  }
  await send({ type: 'wipe' });
  boot();
});

/* ------------------------------------------------------------------ */
/* fill this page                                                     */
/* ------------------------------------------------------------------ */

$('fillBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'fillNow' });
    window.close();
  } catch {
    // No content script here — either an unmatched site, or the tab was loaded
    // before the extension was installed or reloaded.
    toast('No form handler on this tab. Reload the page and try again.', 'err');
  }
});

boot();
