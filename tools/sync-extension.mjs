/**
 * sync-extension.mjs — keeps the folder Chrome loads in step with main.
 *
 *   node tools/sync-extension.mjs             check out origin/main there
 *   node tools/sync-extension.mjs <ref>       or any branch / tag / commit
 *   node tools/sync-extension.mjs --new-key   once: make the key that pins the ID
 *
 * Chrome loads a separate folder, not this checkout: a git worktree in detached
 * HEAD, so switching branches here never changes what the browser runs. The
 * two things that must never be committed are written into it after every
 * checkout, from extension.local.json (gitignored):
 *
 *   {
 *     "dir": "C:/path/to/Autocomplete-extension",
 *     "clientId": "1234-abc.apps.googleusercontent.com",
 *     "key": "<base64 public key from --new-key>",
 *     "debug": true
 *   }
 *
 * `key` pins the extension ID, so the folder can move without Chrome treating
 * it as a new extension with empty storage. `--new-key` writes the private key
 * beside extension.local.json and prints the ID to register the OAuth client
 * against. No npm: Node built-ins and git only.
 */

import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'extension.local.json');
const PEM = join(ROOT, 'extension.local.pem');
/* The only files the local settings touch; anything else changed there is
 * someone's work, and the sync refuses rather than overwrite it. */
const PATCHED = ['manifest.json', 'content/00-namespace.js'];

const git = (args, cwd = ROOT) =>
  // trimEnd, not trim: `status --porcelain` lines start with a meaningful space.
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

function fail(msg) {
  console.error(`sync-extension: ${msg}`);
  process.exit(1);
}

/** Chrome's ID for a key: SHA-256 of the DER public key, first 32 hex digits as a–p. */
function extensionId(derBase64) {
  const hex = createHash('sha256').update(Buffer.from(derBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function newKey() {
  if (existsSync(PEM)) fail(`${PEM} already exists. Delete it first if you really want a new ID.`);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(PEM, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  console.log(`Private key: ${PEM} (gitignored, keep it)\n`);
  console.log(`"key" for extension.local.json:\n${key}\n`);
  console.log(`Extension ID: ${extensionId(key)}`);
}

function patch(dir, cfg) {
  const manifestPath = join(dir, 'manifest.json');
  let manifest = readFileSync(manifestPath, 'utf8');
  if (cfg.clientId) {
    manifest = manifest.replace(/("client_id":\s*")[^"]*(")/, `$1${cfg.clientId}$2`);
  }
  if (cfg.key) {
    // Top-level, right after "version", where the README says to put it.
    manifest = manifest.replace(/^(\s*"version":\s*"[^"]*",\r?\n)/m, `$1  "key": "${cfg.key}",\n`);
  }
  writeFileSync(manifestPath, manifest);

  if (cfg.debug) {
    const nsPath = join(dir, 'content/00-namespace.js');
    writeFileSync(nsPath, readFileSync(nsPath, 'utf8').replace(/^AF\.debug = false;/m, 'AF.debug = true;'));
  }
}

function sync(ref, cfg) {
  if (!cfg.dir) fail('extension.local.json needs "dir": the folder Chrome loads.');
  const dir = resolve(cfg.dir);
  git(['fetch', '--quiet', 'origin']);
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);

  if (!existsSync(dir)) {
    git(['worktree', 'add', '--detach', dir, commit]);
  } else {
    let common;
    try {
      common = resolve(dir, git(['rev-parse', '--git-common-dir'], dir));
    } catch {
      fail(`${dir} exists but is not a git worktree. Move it aside, then run this again.`);
    }
    if (common !== resolve(ROOT, git(['rev-parse', '--git-common-dir']))) {
      fail(`${dir} is a checkout of some other repository.`);
    }
    const changed = git(['status', '--porcelain'], dir).split('\n').filter(Boolean)
      .map((line) => line.slice(3)).filter((f) => !PATCHED.includes(f));
    if (changed.length) fail(`${dir} has changes of its own, so nothing was touched:\n  ${changed.join('\n  ')}`);
    git(['checkout', '--quiet', '--', ...PATCHED], dir);
    git(['checkout', '--quiet', '--detach', commit], dir);
  }

  patch(dir, cfg);
  const summary = git(['log', '-1', '--format=%h %s'], dir);
  const id = cfg.key ? ` (ID ${extensionId(cfg.key)})` : '';
  console.log(`${dir} is at ${summary}${id}`);
  console.log('Now reload the extension on chrome://extensions, then refresh any Workday tab.');
}

const arg = process.argv[2];
if (arg === '--new-key') {
  newKey();
} else {
  if (!existsSync(CONFIG)) fail(`no ${CONFIG}. See the top of tools/sync-extension.mjs for its shape.`);
  sync(arg ?? 'origin/main', JSON.parse(readFileSync(CONFIG, 'utf8')));
}
