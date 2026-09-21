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
