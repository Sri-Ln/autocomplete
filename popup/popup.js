/**
 * popup.js — setup, unlock, and editing your saved details.
 *
 * Opens straight to your details. The passphrase guards only the saved
 * password, so it is asked for on the Login tab, not in front of everything.
 *
 * The popup is a trusted context, so it can talk to the service worker directly.
 * It still never handles the encryption key itself: it hands the worker a
 * passphrase or a plaintext password and gets back only booleans and emails.
 */

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const PROFILE_FIELDS = [
  'firstName', 'lastName', 'phone', 'phoneExtension', 'address1', 'address2',
  'city', 'state', 'zip', 'county', 'country', 'source', 'noticePeriod',
  'email', 'startDate',
  'expectedSalary', 'visaExplanation',
  /* <select>s — .value reads and writes them the same as an input. */
  'eeoGender', 'eeoEthnicity', 'eeoHispanic', 'eeoVeteran', 'eeoDisability',
];

/** Rendered as one-per-line textareas, stored as arrays. */
const PROFILE_LIST_FIELDS = ['employers'];

/**
 * Tri-state fields rendered as segmented controls rather than <select>.
 * Values are '' | 'yes' | 'no'; '' means "leave it blank, I'll answer it".
 */
const PROFILE_SEG_FIELDS = [
  'over18', 'willingToRelocate', 'willingToTravel',
  'workAuthorized', 'needsSponsorshipNow', 'needsSponsorshipFuture',
  'workAuthBasis', // not Yes/No: '' | 'citizen' | 'permanentResident' | 'visa'
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
  $('saveStatus').classList.remove('show'); // same corner; the toast wins
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  await paintVault();
  await Promise.all([
    loadProfile(), loadCredentials(), loadSettings(), loadGmail(), loadResume(),
  ]);
}

/**
 * Lock state touches only the header and the Login tab's form. Kept apart from
 * boot() so unlocking does not repaint — and wipe — what you are typing on the
 * other tabs.
 */
async function paintVault() {
  const status = await send({ type: 'status' });

  $('lockBtn').hidden = !status.unlocked;
  $('headerSub').textContent = !status.configured
    ? 'No login saved yet'
    : status.unlocked
      ? 'Unlocked for this session'
      : 'Password locked';

  // Only the login form needs the key; everything else is plaintext.
  $('vaultSetup').hidden = status.configured;
  $('vaultLocked').hidden = !status.configured || status.unlocked;
  $('credForm').hidden = !status.unlocked;
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

  $('setupPass').value = $('setupPass2').value = '';
  toast('Ready. Now save your login.', 'ok');
  paintVault();
});

$('unlockBtn').addEventListener('click', unlock);
$('unlockPass').addEventListener('keydown', (e) => e.key === 'Enter' && unlock());

async function unlock() {
  const res = await send({ type: 'unlock', passphrase: $('unlockPass').value });
  if (!res.ok) return toast(res.error ?? 'Wrong passphrase.', 'err');
  $('unlockPass').value = '';
  paintVault();
}

$('lockBtn').addEventListener('click', async () => {
  await send({ type: 'lock' });
  paintVault();
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

/**
 * Last profile known to be in storage.
 *
 * The Profile and Experience tabs save separately (see autosave below), and
 * saveProfile writes the whole object — so each needs a base to patch that is
 * not "whatever is typed into the other tab". The popup is the only writer, so
 * a cache taken at load stays correct for its lifetime.
 */
let storedProfile = {};

async function loadProfile() {
  const { profile } = await send({ type: 'getProfile' });
  cancelAutosave();
  storedProfile = profile;
  visaSaved = profile.visaExplanation ?? '';

  for (const key of PROFILE_FIELDS) $(key).value = profile[key] ?? '';
  for (const key of PROFILE_LIST_FIELDS) {
    $(key).value = (profile[key] ?? []).join('\n');
  }
  /* A profile saved before sponsorship was split has one answer for both. */
  const legacy = { needsSponsorshipNow: profile.needsSponsorship, needsSponsorshipFuture: profile.needsSponsorship };
  for (const key of PROFILE_SEG_FIELDS) setSeg(key, profile[key] || legacy[key]);
  paintDate();
  paintVisaCount();
  paintExperience(profile);
  paintQuick(profile);
}

/* An empty date shows "mm/dd/yyyy" in full colour; dim it like a placeholder.
 * A half-typed one is badInput, not empty, and stays bright. */
function paintDate() {
  const el = $('startDate');
  el.classList.toggle('empty', !el.value && !el.validity.badInput);
}
$('startDate').addEventListener('input', paintDate);

/* ------------------------------------------------------------------ */
/* quick copy                                                          */
/* ------------------------------------------------------------------ */

/**
 * Links and the visa paragraph, one click from opening the popup.
 *
 * Painted from what is SAVED, not from the boxes on the other tabs: a chip that
 * copied a half-typed URL would paste something you never meant to keep.
 */
const QUICK_LINKS = [
  ['linkedin', 'LinkedIn'],
  ['github', 'GitHub'],
  ['portfolio', 'Portfolio'],
  ['other', 'Website'],
];
const YES_NO = { yes: 'Yes', no: 'No' };

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Same silent-miss risk as the visa Copy button; fall back to execCommand.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast(`Could not copy ${what}.`, 'err');
  }
  toast(`${what} copied.`, 'ok');
}

function paintQuick(profile) {
  const chips = [];
  for (const [k, label] of QUICK_LINKS) {
    const url = profile.websites?.[k]?.trim();
    if (url) chips.push([label, url, url]);
  }
  const visa = profile.visaExplanation?.trim();
  if (visa) chips.push(['Visa', visa, `Visa explanation · ${visa.length} characters`]);

  $('quickChips').replaceChildren(...chips.map(([label, text, title]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => copyText(text, label));
    return b;
  }));

  const auth = YES_NO[profile.workAuthorized];
  const asks = [profile.needsSponsorshipNow, profile.needsSponsorshipFuture];
  const sponsor = YES_NO[asks.includes('yes') ? 'yes' : asks.find(Boolean)];
  $('quickAuth').textContent = chips.length
    ? [auth && `Authorized: ${auth}`, sponsor && `Needs sponsorship: ${sponsor}`]
        .filter(Boolean).join(' · ')
    : 'Links and visa text you save appear here.';
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

let visaSaved = ''; // the value currently in storage

/** state: 'saved' | 'unsaved' | 'saving' — inferred from the value if omitted. */
function paintVisaCount(state) {
  const box = $('visaExplanation');
  const text = box.value.trim();
  const status = state ?? (box.value === visaSaved ? 'saved' : 'unsaved');
  $('visaCount').textContent = text
    ? `${text.length} characters · ${status === 'saving' ? 'saving…' : status}`
    : '';
}

$('visaExplanation').addEventListener('input', () => paintVisaCount());

/* ------------------------------------------------------------------ */
/* experience — the My Experience page                                 */
/* ------------------------------------------------------------------ */

/**
 * Education, languages, skills and links, on their own tab, saved on their own:
 * the autosave below patches these keys onto `storedProfile` and leaves the
 * rest as stored.
 *
 * Ladders (degree, field of study) are one rung per line; language levels are
 * semantic values from a segmented control, never free text — the page maps
 * them onto each company's own scale (content/experience.js).
 */

const LANG_LEVELS = [
  ['', '–', 'Not set'],
  ['beginner', 'Beg', 'Beginner'],
  ['intermediate', 'Int', 'Intermediate'],
  ['advanced', 'Adv', 'Advanced'],
  ['fluent', 'Flu', 'Fluent'],
  ['native', 'Nat', 'Native'],
];
const LANG_SKILLS = [
  ['reading', 'Reading'],
  ['writing', 'Writing'],
  ['speaking', 'Speaking'],
  ['comprehension', 'Comprehension'],
];
const WEB_KINDS = ['linkedin', 'github', 'portfolio', 'other'];

const ladderText = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).join('\n');
const ladderOf = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

/** A segmented level control. `blankLabel` titles the "–" segment. */
function levelSeg(key, value, blankTitle) {
  const seg = document.createElement('div');
  seg.className = 'seg lvl';
  seg.setAttribute('role', 'radiogroup');
  seg.dataset.k = key;
  for (const [v, short, title] of LANG_LEVELS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.value = v;
    b.textContent = short;
    b.title = v ? title : blankTitle;
    const on = (value ?? '') === v;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    seg.append(b);
  }
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of seg.querySelectorAll('button')) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  });
  return seg;
}

function levelRow(label, seg) {
  const row = document.createElement('div');
  row.className = 'qrow lvl';
  const span = document.createElement('span');
  span.className = 'qlabel';
  span.textContent = label;
  seg.setAttribute('aria-label', label);
  row.append(span, seg);
  return row;
}

/** One language card. Built with textContent only — a name is never markup. */
function languageCard(lang = {}) {
  const card = document.createElement('div');
  card.className = 'card lang';

  const head = document.createElement('div');
  head.className = 'lang-head';
  const name = document.createElement('input');
  name.type = 'text';
  name.dataset.k = 'language';
  name.placeholder = 'Language';
  name.value = lang.language ?? '';
  name.setAttribute('aria-label', 'Language');
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '×';
  del.title = 'Remove this language';
  del.addEventListener('click', () => card.remove());
  head.append(name, del);

  const stack = document.createElement('div');
  stack.className = 'stack tight';
  stack.append(head, levelRow('Overall', levelSeg('overall', lang.overall, 'Leave it for me')));

  const details = document.createElement('details');
  details.className = 'per-skill';
  const summary = document.createElement('summary');
  summary.textContent = 'Per skill — blank means same as overall';
  details.append(summary);
  for (const [k, label] of LANG_SKILLS) {
    details.append(levelRow(label, levelSeg(k, lang[k], 'Same as overall')));
  }
  // Open it when a per-skill level is set, so it is not hidden from the user.
  details.open = LANG_SKILLS.some(([k]) => lang[k]);
  stack.append(details);

  card.append(stack);
  return card;
}

function paintExperience(profile) {
  const edu = profile.education ?? [];
  for (const card of document.querySelectorAll('.card.edu')) {
    const e = edu[Number(card.dataset.edu)] ?? {};
    for (const el of card.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      el.value = k === 'degree' || k === 'fieldOfStudy' ? ladderText(e[k] ?? []) : (e[k] ?? '');
    }
  }

  const list = $('langList');
  list.replaceChildren(...(profile.languages ?? []).map(languageCard));

  $('skills').value = (profile.skills ?? []).join('\n');
  for (const k of WEB_KINDS) $(`web_${k}`).value = profile.websites?.[k] ?? '';
}

function readExperience() {
  const education = [...document.querySelectorAll('.card.edu')].map((card) => {
    const get = (k) => card.querySelector(`[data-k="${k}"]`).value;
    return {
      school: get('school').trim(),
      degree: ladderOf(get('degree')),
      fieldOfStudy: ladderOf(get('fieldOfStudy')),
      gpa: get('gpa').trim(),
      from: get('from').trim(),
      to: get('to').trim(),
    };
  });

  const languages = [...$('langList').querySelectorAll('.card.lang')].map((card) => {
    const lang = { language: card.querySelector('[data-k="language"]').value.trim() };
    for (const seg of card.querySelectorAll('.seg[data-k]')) {
      lang[seg.dataset.k] = seg.querySelector('button.active')?.dataset.value ?? '';
    }
    return lang;
  }).filter((l) => l.language);

  const websites = {};
  for (const k of WEB_KINDS) websites[k] = $(`web_${k}`).value.trim();

  return { education, languages, skills: ladderOf($('skills').value), websites };
}

$('addLangBtn').addEventListener('click', () => {
  const card = languageCard();
  $('langList').append(card);
  card.querySelector('input').focus();
});

/* ------------------------------------------------------------------ */
/* autosave — the Profile and Experience tabs                          */
/* ------------------------------------------------------------------ */

/**
 * Both tabs save themselves; there is no Save button to forget.
 *
 * The popup vanishes on close with no "are you sure", and both panels are long
 * enough that their Save buttons sat out of sight. So typing saves after a
 * short pause, a pick — select, date, segment, a language removed — or leaving
 * a box saves at once, and closing the popup flushes whatever is pending.
 *
 * Each tab sends exactly what its old button sent: one saveProfile with the
 * whole object, its own keys patched onto `storedProfile`, so neither tab's
 * save carries the other's half-typed boxes. Saves run one at a time and build
 * their object when their turn comes, so back-to-back saves from both tabs
 * each start from the other's result instead of a stale copy.
 */
const AUTOSAVE_MS = 500;

const saveTimer = { profile: 0, experience: 0 };
const dirty = { profile: false, experience: false };
let saveQueue = Promise.resolve();

/** The Profile tab as the old Save profile button built it. */
function readProfile() {
  /* Starts from what is stored, not from nothing. saveProfile writes the whole
   * object and the worker whitelists every known key, so a key missing here is
   * a key WIPED — and the Experience tab's fields are not on this tab. */
  const profile = { ...storedProfile };
  const skipped = [];
  for (const key of PROFILE_FIELDS) {
    /* A box the browser rejects keeps what is stored. A half-typed date reads
     * as '' and an email mid-word is a mismatch; saving either on a debounce
     * would wipe a good value with a draft. */
    const el = $(key);
    const valid = el.validity.valid;
    el.classList.toggle('invalid', !valid);
    if (valid) profile[key] = el.value;
    else skipped.push(fieldLabel(el));
  }
  for (const key of PROFILE_SEG_FIELDS) profile[key] = segValue(key);
  delete profile.needsSponsorship; // split into Now / Future; a later "–" must not bring it back
  for (const key of PROFILE_LIST_FIELDS) {
    profile[key] = $(key)
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return { profile, skipped };
}

const fieldLabel = (el) => {
  const label = el.closest('label');
  return (label?.querySelector('.qlabel') ?? label?.firstChild)?.textContent.trim() || el.id;
};

const BUILD = {
  profile: readProfile,
  experience: () => ({ profile: { ...storedProfile, ...readExperience() }, skipped: [] }),
};

/** An edit on `which` tab: save after the pause, or straight away if `now`. */
function touch(which, now = false) {
  dirty[which] = true;
  clearTimeout(saveTimer[which]);
  if (now) flush(which);
  else saveTimer[which] = setTimeout(() => flush(which), AUTOSAVE_MS);
}

/**
 * Write `which` tab now, if it has unsaved edits.
 *
 * Called from the close handlers too, where nothing after the `send` will run —
 * the popup's JS context is already going away. That is fine: the message has
 * left for the service worker by then, and the reply is only a status.
 */
function flush(which) {
  clearTimeout(saveTimer[which]);
  if (!dirty[which]) return;
  dirty[which] = false;
  if (which === 'profile') paintVisaCount('saving');

  saveQueue = saveQueue
    .then(async () => {
      const { profile, skipped } = BUILD[which]();
      // Leaving a box you already paused in fires `change` with nothing new.
      if (!skipped.length && JSON.stringify(profile) === JSON.stringify(storedProfile)) {
        return paintVisaCount();
      }

      const res = await send({ type: 'saveProfile', profile });
      if (!res?.ok) {
        dirty[which] = true; // tried again on the next edit, or on close
        paintVisaCount('unsaved');
        return toast(res?.error ?? 'Save failed.', 'err');
      }
      storedProfile = profile;
      visaSaved = profile.visaExplanation ?? '';
      paintVisaCount();
      paintQuick(profile);
      showSaved(skipped);
      // Open tabs cache the profile for the pill; tell them it moved.
      await broadcast({ type: 'profileChanged' });
    })
    .catch(() => {});
}

/** Drop pending edits — the form is about to be repainted from storage. */
function cancelAutosave() {
  for (const which of Object.keys(dirty)) {
    clearTimeout(saveTimer[which]);
    dirty[which] = false;
  }
  for (const el of document.querySelectorAll('.invalid')) el.classList.remove('invalid');
}

/**
 * The quiet "Saved" in the corner. One element, its text replaced, so a burst
 * of saves reads as one status rather than a stack of toasts.
 */
let savedTimer;
function showSaved(skipped = []) {
  const el = $('saveStatus');
  el.textContent = skipped.length ? `${skipped.join(', ')}: not saved — check it` : 'Saved';
  el.className = 'save-status show ' + (skipped.length ? 'err' : 'ok');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), skipped.length ? 3000 : 1400);
}

for (const which of ['profile', 'experience']) {
  const panel = document.querySelector(`.panel[data-panel="${which}"]`);
  panel.addEventListener('input', () => touch(which));
  // A pick, or leaving a box: nothing more is coming, so don't wait.
  panel.addEventListener('change', () => touch(which, true));
  /* Segments and a language card's × are clicks, not input. The × click still
   * reaches the panel after it removed its card: the path is fixed at dispatch. */
  panel.addEventListener('click', (e) => {
    if (e.target.closest('.seg button, .lang-head button')) touch(which, true);
  });
}

/* Closing the popup. Both events are listened for because which one a popup
 * gets on dismissal is not something to bet a paragraph on. */
const flushAll = () => { flush('profile'); flush('experience'); };
window.addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', flushAll);

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
  const tabs = await chrome.tabs.query({
    url: chrome.runtime.getManifest().content_scripts.flatMap((c) => c.matches),
  });
  await Promise.all(
    tabs.map((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => {}))
  );
}

$('wipeBtn').addEventListener('click', async () => {
  if (!confirm('Erase your passphrase, profile, saved logins, remembered answers and per-company picks? This cannot be undone.')) {
    return;
  }
  /* storage.wipeAll clears chrome.storage.local outright, so af_answers and
   * af_picks go with everything else — they have no tab of their own now. */
  await send({ type: 'wipe' });
  boot();
});

/* ------------------------------------------------------------------ */
/* backup — export to a file, import from one                          */
/* ------------------------------------------------------------------ */

/**
 * Everything you typed in, in one JSON file, so a reinstall is one click.
 *
 * Why it is needed at all: chrome.storage belongs to the extension's ID.
 * Reloading an unpacked extension keeps it, but removing it and loading it
 * again — or loading a second copy from another folder — is a NEW extension
 * with empty storage, and the profile has to be typed in again.
 *
 * What is deliberately LEFT OUT: the vault. Passwords are encrypted with a key
 * derived from your passphrase and a salt stored next to them, and a backup
 * that carried them would be a file whose only protection is a passphrase
 * someone could try offline as often as they liked. Re-entering one login is
 * a smaller cost than that. The Gmail connection is Chrome's, not ours, so it
 * is not here either.
 *
 * Import goes through the same saveProfile / saveAnswers / savePick /
 * saveSettings messages the popup always uses, so the worker's whitelisting
 * applies to a file exactly as it does to typing: an unknown key in the file
 * is dropped, never stored.
 */
const BACKUP_FORMAT = 'autocomplete-backup';
const BACKUP_VERSION = 1;

async function buildBackup() {
  const [profile, answers, picks, settings] = await Promise.all([
    send({ type: 'getProfile' }),
    send({ type: 'getAnswers' }),
    send({ type: 'listPicks' }),
    send({ type: 'getSettings' }),
  ]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profile: profile?.profile ?? {},
    answers: answers?.answers ?? {},
    picks: picks?.picks ?? {},
    settings: settings?.settings ?? {},
  };
}

/**
 * A file's text → the parts worth importing, or { error }.
 *
 * Strict about the envelope and loose about the rest: a file that is not one
 * of ours is refused outright (importing someone's random JSON as a profile
 * would silently blank every field), while inside it each part is optional
 * and shape-checked, so a backup from before a field existed still loads.
 */
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'That file is not valid JSON.' };
  }
  if (data?.format !== BACKUP_FORMAT) return { error: 'That is not an Autocomplete backup file.' };
  if (!(data.version <= BACKUP_VERSION)) {
    return { error: 'That backup is from a newer version of the extension.' };
  }

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const out = {};
  if (isObj(data.profile)) out.profile = data.profile;

  if (isObj(data.answers)) {
    out.answers = Object.fromEntries(
      Object.entries(data.answers).filter(([, e]) => isObj(e) && typeof e.answer === 'string')
    );
  }

  if (isObj(data.picks)) {
    out.picks = [];
    for (const [host, keys] of Object.entries(data.picks)) {
      if (!isObj(keys)) continue;
      for (const [key, entry] of Object.entries(keys)) {
        const value = isObj(entry) ? entry.value : entry;
        if (typeof value === 'string' && value.trim()) out.picks.push({ host, key, value });
      }
    }
  }

  if (isObj(data.settings)) {
    out.settings = {};
    for (const k of ['autoSubmit', 'showWidget']) {
      if (typeof data.settings[k] === 'boolean') out.settings[k] = data.settings[k];
    }
  }
  return out;
}

async function applyBackup(parts) {
  if (parts.profile) await send({ type: 'saveProfile', profile: parts.profile });
  // Merged over what is here: an answer learned since the export is kept.
  if (parts.answers) {
    const current = (await send({ type: 'getAnswers' }))?.answers ?? {};
    await send({ type: 'saveAnswers', answers: { ...current, ...parts.answers } });
  }
  for (const p of parts.picks ?? []) {
    await send({ type: 'savePick', hostname: p.host, key: p.key, value: p.value });
  }
  if (parts.settings && Object.keys(parts.settings).length) {
    await send({ type: 'saveSettings', patch: parts.settings });
  }
}

$('exportBtn').addEventListener('click', async () => {
  const backup = await buildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `autocomplete-backup-${backup.exportedAt.slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported. Keep the file somewhere private.', 'ok');
});

/* The picker opens in the popup itself. The confirmation is in the page
 * (importConfirm), never window.confirm, which wedges the toolbar popup. */
$('importBtn').addEventListener('click', () => $('importFile').click());

/* ------------------------------------------------------------------ */
/* résumé                                                              */
/* ------------------------------------------------------------------ */

/* The popup sees only the file's name and size; the bytes stay in the worker
 * until a content script asks for them to attach. */
const RESUME_MAX_BYTES = 5 * 1024 * 1024;
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function loadResume() {
  const r = (await send({ type: 'getResumeInfo' }))?.resume ?? null;
  $('resumeName').textContent = r ? r.name : 'No résumé saved';
  $('resumeMeta').textContent = r
    ? `${fileSize(r.size)} · saved ${new Date(r.updated).toLocaleDateString()}`
    : 'PDF or Word, up to 5 MB';
  $('resumeBtn').textContent = r ? 'Replace' : 'Choose file';
  $('resumeRemoveBtn').hidden = !r;
}

/* The picker opens right here. The popup is the only place the saved résumé
 * changes: a file attached on an application page is never taken from it. */
$('resumeBtn').addEventListener('click', () => $('resumeFile').click());

const readBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

$('resumeFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // so choosing the same file again still fires
  if (!file) return;
  if (file.size > RESUME_MAX_BYTES) return toast('That file is over 5 MB.', 'err');
  const res = await send({ type: 'saveResume', name: file.name, fileType: file.type, data: await readBase64(file) });
  if (!res?.ok) return toast(res?.error ?? 'Could not save the résumé.', 'err');
  await loadResume();
  toast('Résumé saved.', 'ok');
});

$('resumeRemoveBtn').addEventListener('click', async () => {
  await send({ type: 'clearResume' });
  await loadResume();
  toast('Résumé removed.', 'ok');
});


/* The parsed file waits here for the in-page Replace / Cancel. */
let pendingImport = null;

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // so choosing the same file again still fires
  if (!file) return;

  const parts = parseBackup(await file.text());
  if (parts.error) return toast(parts.error, 'err');

  pendingImport = parts;
  $('importConfirm').hidden = false;
});

$('importCancel').addEventListener('click', () => {
  pendingImport = null;
  $('importConfirm').hidden = true;
});

$('importReplace').addEventListener('click', async () => {
  const parts = pendingImport;
  pendingImport = null;
  $('importConfirm').hidden = true;
  if (!parts) return;

  await applyBackup(parts);
  await broadcast({ type: 'profileChanged' });
  await boot(); // repaint every tab from storage
  toast('Imported.', 'ok');
});

/* Test hooks, alongside __afBoot below. */
window.__afBackup = { buildBackup, parseBackup, applyBackup };

/* Test hook: test/popup-harness.html drives this file, not a copy of it, and
 * re-runs boot() to stand in for reopening the popup. */
window.__afBoot = boot;

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
