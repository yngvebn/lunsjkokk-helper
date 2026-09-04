#!/usr/bin/env node
/**
 * End-to-end check of the credential store, using a throwaway secret.
 *
 * Deliberately NOT part of `npm test`: it needs a working PowerShell and it touches the
 * real store path (backing up and restoring anything already there). Run it after
 * changing anything in src/credentials.mjs.
 *
 *   node scripts/test-credentials.mjs
 *
 * It exists because the failure mode here is silent. The first version of this module
 * passed the script over `-Command -` while also writing the secret to stdin — so
 * PowerShell read the *script* as its input and cheerfully encrypted that instead. Every
 * surface-level check passed: a file appeared, it contained ciphertext, no error was
 * raised. Only a full round-trip catches it.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { STORE_PATH, credentialStatus, readCredentials, resolveBackend } from '../src/credentials.mjs';

// Awkward on purpose: non-ASCII, both quote styles, a pipe and a dollar sign are exactly
// what a naive shell-interpolating implementation would mangle.
const SECRET = 'throwaway-p@ss åæø "double" \'single\' |pipe| $notavar';
const USERNAME = 'credential-test@example.invalid';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
  if (!ok) failures++;
};

const ps = (script, stdin) =>
  new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString('utf8'))
        : reject(new Error(Buffer.concat(err).toString('utf8').slice(0, 300))),
    );
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });

let backup = null;
try {
  backup = await readFile(STORE_PATH, 'utf8');
  console.log('note: an existing store was found; it will be restored at the end\n');
} catch {}

try {
  const blob = (
    await ps(
      `$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd()
[Console]::Out.Write((ConvertTo-SecureString $plain -AsPlainText -Force | ConvertFrom-SecureString))`,
      SECRET,
    )
  ).trim();

  check('encryption produced ciphertext', blob.length > 100, `length ${blob.length}`);

  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(
    STORE_PATH,
    JSON.stringify({ username: USERNAME, password: blob, storedAt: new Date().toISOString(), scheme: 'dpapi-currentuser' }, null, 2),
    'utf8',
  );

  const onDisk = await readFile(STORE_PATH, 'utf8');
  check('plaintext never reaches the file', !onDisk.includes(SECRET));
  check('the file does not contain the script either', !onDisk.includes('ConvertTo-SecureString'));

  const status = await credentialStatus();
  check('status reports configured', status.configured === true && status.source === 'store');

  const creds = await readCredentials();
  check('username round-trips', creds.username === USERNAME);
  check(
    'password round-trips exactly',
    creds.password === SECRET,
    `expected ${JSON.stringify(SECRET)}\n       got      ${JSON.stringify(creds.password)}`,
  );
} finally {
  if (backup) await writeFile(STORE_PATH, backup, 'utf8');
  else await rm(STORE_PATH, { force: true });
  console.log(`\n${backup ? 'restored the previous store' : 'removed the test store'}`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('credential store verified end-to-end');
}
