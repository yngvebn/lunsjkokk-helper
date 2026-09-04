#!/usr/bin/env node
/**
 * Credential setup and login check.
 *
 *   node scripts/auth.mjs login     prompt for credentials, store them encrypted
 *   node scripts/auth.mjs status    is anything configured, and does it still work
 *   node scripts/auth.mjs logout    delete the stored credentials
 *
 * `login` must be run by you, in your own terminal — the prompt is a PowerShell
 * `Read-Host -AsSecureString`, so the password is never echoed, never lands in shell
 * history, and never passes through an agent's context.
 */

import { clearCredentials, credentialStatus, storeCredentials } from '../src/credentials.mjs';
import { verifyLogin } from '../src/auth.mjs';

const USAGE = `usage: node scripts/auth.mjs <login|status|logout>

  login    prompt for your Lunsjkokkene e-mail/username and password, store encrypted
           (Windows DPAPI, current user only) and verify them against the API
  status   show what's configured and whether it still authenticates
  logout   delete the stored credentials

Alternative for CI or non-Windows: set LUNSJ_USERNAME and LUNSJ_PASSWORD.`;

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'login') {
    console.log('Credentials are encrypted with your Windows account key and stored locally.');
    console.log('Nothing is sent anywhere except lunsjkokkene.no when logging in.\n');
    const { username, path } = await storeCredentials();
    console.log(`\nStored ${username} at ${path}`);
    process.stdout.write('Verifying against the API... ');
    const who = await verifyLogin();
    console.log('ok');
    console.log(`  signed in as ${who.name ?? who.username} <${who.email}>`);
    console.log(`  customerId ${who.customerId}, roles: ${who.roles.join(', ') || 'none'}`);
    return;
  }

  if (cmd === 'status') {
    const status = await credentialStatus();
    if (!status.configured) {
      console.log(`No credentials configured.\n  expected at: ${status.path}\n  run: node scripts/auth.mjs login`);
      process.exitCode = 1;
      return;
    }
    console.log(`Configured via ${status.source}: ${status.username}`);
    if (status.storedAt) console.log(`  stored ${status.storedAt}`);
    process.stdout.write('  verifying... ');
    try {
      const who = await verifyLogin();
      console.log(`ok — ${who.name ?? who.username}, customerId ${who.customerId}`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'logout') {
    console.log(`Deleted ${await clearCredentials()}`);
    return;
  }

  console.log(USAGE);
  if (cmd) process.exitCode = 1;
}

main().catch((err) => {
  // Never let a stack trace print — a credential-handling error can carry the input that caused it.
  console.error(err.message);
  process.exitCode = 1;
});
