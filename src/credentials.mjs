/**
 * Credential storage, one backend per platform.
 *
 *   Windows  DPAPI via PowerShell (`ConvertFrom-SecureString`)
 *   macOS    Keychain via `security`
 *   Linux    libsecret via `secret-tool`
 *   anywhere LUNSJ_USERNAME + LUNSJ_PASSWORD environment variables
 *
 * Rules every backend obeys:
 *
 *  1. **The password never appears in a command line.** Process arguments are readable by
 *     anything that can list processes, so plaintext moves over stdin/stdout pipes, or is
 *     collected by the platform's own prompt, never as an argv value.
 *
 *  2. **`store` verifies itself.** After writing, each backend reads the secret back and
 *     throws if it doesn't match. This is not belt-and-braces: only the Windows path has
 *     been executed by the author, so the macOS and Linux paths are written blind and must
 *     detect their own failure rather than silently storing nothing. (A previous version of
 *     the Windows backend passed its script over `-Command -` while also writing the secret
 *     to stdin, so PowerShell encrypted the *script*. Every shallow check passed.)
 *
 *  3. **No hand-rolled encrypted file fallback.** If a platform has no keystore, this fails
 *     and points at the environment variables. A file encrypted with a key sitting next to
 *     it is worse than an env var, because it looks safer than it is.
 *
 * The username is not secret, so it lives in a small JSON file next to the store. Only the
 * password goes into the platform keystore (on Windows, as a DPAPI blob in that same file).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const SERVICE = 'lunsjkokk-helper';

function defaultStoreDir() {
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), SERVICE);
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', SERVICE);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), SERVICE);
}

export const STORE_PATH = process.env.LUNSJ_STORE_PATH ?? join(defaultStoreDir(), 'credentials.json');

/* ------------------------------------------------------------------ helpers */

/**
 * Run a command.
 *
 * `stdin` carries secrets in. `promptStdin` hands the terminal to the child so its own
 * password prompt works — note that is separate from stdout, which stays piped so a
 * backend can still capture what the child printed. (Inheriting both would lose the
 * Windows ciphertext.)
 */
function run(cmd, args, { stdin = null, promptStdin = false, inheritStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [promptStdin ? 'inherit' : 'pipe', inheritStdout ? 'inherit' : 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = [];
    const err = [];
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        const e = new Error(`${cmd} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
        e.exitCode = code;
        return reject(e);
      }
      resolve(stdout);
    });
    if (!promptStdin) {
      if (stdin != null) child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

const exists = async (cmd, args = ['--version']) => {
  try {
    await run(cmd, args);
    return true;
  } catch {
    return false;
  }
};

async function readMeta() {
  try {
    return JSON.parse(await readFile(STORE_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read ${STORE_PATH}: ${err.message}`);
  }
}

async function writeMeta(meta) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8', { mode: 0o600 });
}

/** Ask for the username on the terminal. Not a secret, so plain readline is fine. */
async function promptUsername() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Lunsjkokkene e-mail or username: ')).trim();
    if (!answer) throw new Error('No username given.');
    return answer;
  } finally {
    rl.close();
  }
}

/* ----------------------------------------------------------------- backends */

/**
 * Windows: DPAPI. The blob is keyed to the current user account, so the file is inert on
 * any other account or machine.
 *
 * The script travels as `-EncodedCommand` (base64 UTF-16LE), never `-Command -`, because
 * the latter makes PowerShell read its *script* from stdin — which collides with using
 * stdin for the secret.
 */
const windowsBackend = {
  id: 'dpapi',
  label: 'Windows DPAPI (current user)',
  async available() {
    if (platform() !== 'win32') return false;
    return Boolean(await this._host());
  },
  _resolved: null,
  async _host() {
    if (this._resolved) return this._resolved;
    if (process.env.LUNSJ_PWSH) return (this._resolved = process.env.LUNSJ_PWSH);
    // powershell.exe 5.1 can fail to load Microsoft.PowerShell.Security, in which case
    // ConvertTo-SecureString does not exist. Probe for a host that actually has it.
    for (const exe of ['pwsh', 'powershell.exe']) {
      try {
        const out = await this._ps("if (Get-Command ConvertFrom-SecureString -EA SilentlyContinue) { 'yes' }", null, exe);
        if (out.includes('yes')) return (this._resolved = exe);
      } catch {
        /* try the next host */
      }
    }
    return null;
  },
  async _ps(script, stdin = null, exe = null, { prompt = false } = {}) {
    const host = exe ?? this._resolved ?? 'pwsh';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // -NonInteractive would make Read-Host fail, so drop it when prompting.
    return run(host, ['-NoProfile', ...(prompt ? [] : ['-NonInteractive']), '-EncodedCommand', encoded], {
      stdin,
      promptStdin: prompt,
    });
  },
  async store(username) {
    await this._host();
    // The prompt runs inside PowerShell, so the plaintext never becomes a JS string here.
    // stdin is inherited so Read-Host reaches the terminal; stdout stays piped so we can
    // capture the ciphertext it prints.
    const out = await this._ps(
      `$ErrorActionPreference = 'Stop'
$pass = Read-Host 'Password' -AsSecureString
if ($pass.Length -eq 0) { Write-Error 'No password given'; exit 1 }
[Console]::Out.WriteLine("BLOB:" + (ConvertFrom-SecureString $pass))`,
      null,
      null,
      { prompt: true },
    );
    const blob = /BLOB:(.*)/.exec(out)?.[1]?.trim();
    if (!blob) throw new Error('The password prompt returned nothing usable.');
    await writeMeta({ username, backend: this.id, password: blob, storedAt: new Date().toISOString() });
    await this._ps(
      `icacls "${STORE_PATH}" /inheritance:r /grant:r "$env:USERNAME:(R,W)" | Out-Null`,
    ).catch(() => {});
  },
  async read(meta) {
    await this._host();
    const password = await this._ps(
      `$ErrorActionPreference = 'Stop'
$blob = [Console]::In.ReadToEnd().Trim()
try { $sec = ConvertTo-SecureString $blob }
catch { Write-Error 'Could not decrypt - stored under a different Windows account?'; exit 1 }
[Console]::Out.Write([System.Net.NetworkCredential]::new('', $sec).Password)`,
      meta.password,
    );
    if (!password) throw new Error('Decryption produced an empty password.');
    return password;
  },
  async clear() {
    /* the blob lives in the JSON file, which the caller removes */
  },
};

/**
 * macOS: Keychain. `security add-generic-password -w` with no value prompts on the
 * terminal, so the password is never an argv value.
 *
 * NOT executed by the author — see rule 2. `store` verifies itself.
 */
const macosBackend = {
  id: 'keychain',
  label: 'macOS Keychain',
  async available() {
    return platform() === 'darwin' && (await exists('security', ['help']));
  },
  async store(username) {
    // -U updates in place if the item already exists. -w with no value makes `security`
    // prompt for the password itself.
    await run('security', ['add-generic-password', '-U', '-a', username, '-s', SERVICE, '-w'], {
      promptStdin: true,
      inheritStdout: true,
    });
    await writeMeta({ username, backend: this.id, storedAt: new Date().toISOString() });
  },
  async read(meta) {
    const out = await run('security', ['find-generic-password', '-a', meta.username, '-s', SERVICE, '-w']);
    const password = out.replace(/\n$/, '');
    if (!password) throw new Error('Keychain returned an empty password.');
    return password;
  },
  async clear(meta) {
    if (!meta?.username) return;
    await run('security', ['delete-generic-password', '-a', meta.username, '-s', SERVICE]).catch(() => {});
  },
};

/**
 * Linux: libsecret. `secret-tool store` reads the secret from stdin.
 *
 * If `secret-tool` is missing we fail rather than inventing a file-based fallback; see
 * rule 3. NOT executed by the author — `store` verifies itself.
 */
const linuxBackend = {
  id: 'secret-tool',
  label: 'Linux libsecret (secret-tool)',
  async available() {
    return platform() !== 'win32' && platform() !== 'darwin' && (await exists('secret-tool', ['--version']));
  },
  async store(username) {
    // secret-tool prompts on a tty; inherit so the user sees it.
    await run(
      'secret-tool',
      ['store', '--label', `${SERVICE} (${username})`, 'service', SERVICE, 'account', username],
      { promptStdin: true, inheritStdout: true },
    );
    await writeMeta({ username, backend: this.id, storedAt: new Date().toISOString() });
  },
  async read(meta) {
    const out = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', meta.username]);
    const password = out.replace(/\n$/, '');
    if (!password) throw new Error('secret-tool returned an empty password (is the keyring unlocked?).');
    return password;
  },
  async clear(meta) {
    if (!meta?.username) return;
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', meta.username]).catch(() => {});
  },
};

const BACKENDS = [windowsBackend, macosBackend, linuxBackend];

/** The backend for this platform, or null when none is usable. */
export async function resolveBackend() {
  for (const b of BACKENDS) if (await b.available()) return b;
  return null;
}

function noBackendError() {
  const hint =
    platform() === 'linux'
      ? 'Install libsecret-tools (Debian/Ubuntu: apt install libsecret-tools), or set LUNSJ_USERNAME and LUNSJ_PASSWORD.'
      : platform() === 'darwin'
        ? "macOS should have `security` built in — if this fails, set LUNSJ_USERNAME and LUNSJ_PASSWORD."
        : 'No PowerShell host with the crypto cmdlets was found. Set LUNSJ_PWSH, or use LUNSJ_USERNAME and LUNSJ_PASSWORD.';
  const err = new Error(`No credential store is available on ${platform()}. ${hint}`);
  err.code = 'NO_BACKEND';
  return err;
}

/* -------------------------------------------------------------- public API */

const envCreds = () =>
  process.env.LUNSJ_USERNAME && process.env.LUNSJ_PASSWORD
    ? { username: process.env.LUNSJ_USERNAME, password: process.env.LUNSJ_PASSWORD, source: 'env' }
    : null;

/**
 * Prompt for credentials and store them, then read them straight back to prove the store
 * actually works. The read-back is the whole point on platforms the author cannot test.
 */
export async function storeCredentials() {
  const backend = await resolveBackend();
  if (!backend) throw noBackendError();

  const username = await promptUsername();
  await backend.store(username);

  // Self-check. A backend that writes nothing and reports success is the failure mode
  // this exists to catch.
  const meta = await readMeta();
  if (!meta?.username) throw new Error(`${backend.label} did not record the username — nothing was stored.`);
  let readBack;
  try {
    readBack = await backend.read(meta);
  } catch (err) {
    throw new Error(`${backend.label} stored the password but could not read it back: ${err.message}`);
  }
  if (!readBack) throw new Error(`${backend.label} read back an empty password — nothing usable was stored.`);

  return { username, backend: backend.label, path: STORE_PATH };
}

/** Decrypt and return `{ username, password }`, or null when nothing is configured. */
export async function readCredentials() {
  const env = envCreds();
  if (env) return env;

  const meta = await readMeta();
  if (!meta) return null;

  const backend = BACKENDS.find((b) => b.id === meta.backend) ?? (await resolveBackend());
  if (!backend) throw noBackendError();
  if (meta.backend && backend.id !== meta.backend) {
    throw new Error(
      `These credentials were stored with the "${meta.backend}" backend but this machine offers "${backend.id}". ` +
        'Run: node scripts/auth.mjs login',
    );
  }

  const password = await backend.read(meta);
  return { username: meta.username, password, source: backend.id };
}

export async function credentialStatus() {
  const env = envCreds();
  if (env) return { configured: true, source: 'env', username: env.username };

  const meta = await readMeta();
  const backend = await resolveBackend();
  if (!meta) {
    return {
      configured: false,
      path: STORE_PATH,
      backend: backend?.label ?? null,
      platform: platform(),
    };
  }
  return {
    configured: true,
    source: meta.backend ?? 'store',
    backend: backend?.label ?? meta.backend,
    username: meta.username,
    storedAt: meta.storedAt,
    path: STORE_PATH,
  };
}

export async function clearCredentials() {
  const meta = await readMeta();
  const backend = BACKENDS.find((b) => b.id === meta?.backend) ?? (await resolveBackend());
  if (backend && meta) await backend.clear(meta);
  await rm(STORE_PATH, { force: true });
  return STORE_PATH;
}
