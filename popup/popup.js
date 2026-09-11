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
  'city', 'state', 'zip', 'country',
];

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
  await Promise.all([loadProfile(), loadCredentials(), loadSettings()]);
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
}

$('saveProfileBtn').addEventListener('click', async () => {
  const profile = {};
  for (const key of PROFILE_FIELDS) profile[key] = $(key).value;

  const res = await send({ type: 'saveProfile', profile });
  toast(res.ok ? 'Profile saved.' : (res.error ?? 'Save failed.'), res.ok ? 'ok' : 'err');
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
