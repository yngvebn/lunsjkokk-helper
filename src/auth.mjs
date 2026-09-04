/**
 * Authentication, reverse-engineered from the Faust.js client in `_app-*.js`.
 *
 * It is NOT a `login` mutation — `login` doesn't exist on `RootMutation` here. It's
 * Faust's two-step authorization-code exchange:
 *
 *   1. `generateAuthorizationCode(input: {email|username, password})` -> { code, error }
 *      on the WPGraphQL endpoint. Note `error` comes back in the *data*, not in
 *      `errors`, so a wrong password is a 200 with a Norwegian message inside.
 *   2. `GET https://lunsjkokkene.no/api/faust/auth/token?code=<code>`
 *      -> { accessToken, accessTokenExpiration }
 *   3. `Authorization: Bearer <accessToken>` on subsequent GraphQL requests.
 *
 * The client distinguishes email from username by whether the value looks like an
 * address, and sends the matching field — so we do the same.
 */

import { GRAPHQL_ENDPOINT, SITE, gql } from './api.mjs';
import { readCredentials } from './credentials.mjs';

const TOKEN_ENDPOINT = `${SITE}/api/faust/auth/token`;

const AUTH_CODE = `
mutation GenerateAuthorizationCode($email: String, $username: String, $password: String!) {
  generateAuthorizationCode(input: {email: $email, username: $username, password: $password}) {
    code
    error
  }
}`;

const AUTH_CUSTOMER = `
query GetAuthCustomer {
  viewer { id databaseId username email firstName lastName roles { nodes { name } } }
  customer { id databaseId email }
}`;

const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim());

/** Exchange credentials for an access token. Returns { accessToken, expiresAt }. */
export async function fetchAccessToken({ username, password }) {
  const variables = { password, ...(isEmail(username) ? { email: username } : { username }) };
  const data = await gql(AUTH_CODE, variables);
  const result = data.generateAuthorizationCode;

  // The API reports bad credentials in `data`, not `errors` — check it explicitly or a
  // wrong password looks like a success with a null code.
  if (result?.error) throw new Error(`Login rejected: ${stripTags(result.error)}`);
  if (!result?.code) throw new Error('Login returned no authorization code and no error.');

  const res = await fetch(`${TOKEN_ENDPOINT}?code=${encodeURIComponent(result.code)}`, {
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  if (!body.accessToken) throw new Error('Token exchange returned no accessToken.');
  return {
    accessToken: body.accessToken,
    expiresAt: body.accessTokenExpiration ? new Date(body.accessTokenExpiration * 1000).toISOString() : null,
  };
}

const stripTags = (s) =>
  String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A session bound to one process run. Tokens are held in memory only — never written
 * to disk, so there's nothing to leak or expire badly between runs. Logging in costs
 * two requests, which is cheap next to persisting a bearer token.
 */
export async function createSession() {
  const creds = await readCredentials();
  if (!creds) {
    const err = new Error('No credentials configured. Run: node scripts/auth.mjs login');
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  const { accessToken, expiresAt } = await fetchAccessToken(creds);

  const authedGql = (query, variables) =>
    gql(query, variables, { endpoint: GRAPHQL_ENDPOINT, headers: { authorization: `Bearer ${accessToken}` } });

  const identity = await authedGql(AUTH_CUSTOMER);
  const viewer = identity.viewer;
  const customer = identity.customer;
  if (!viewer?.databaseId) throw new Error('Authenticated, but the viewer came back empty.');

  return {
    gql: authedGql,
    expiresAt,
    viewer,
    customer,
    // CheckExistingOrder wants the Woo customer id. It's normally the same integer as
    // the WP user id, but prefer the customer record when it's there.
    customerId: customer?.databaseId ?? viewer.databaseId,
    roles: viewer.roles?.nodes?.map((r) => r.name) ?? [],
  };
}

/** Verify credentials work, without doing anything else. */
export async function verifyLogin() {
  const session = await createSession();
  return {
    username: session.viewer.username,
    email: session.viewer.email,
    name: [session.viewer.firstName, session.viewer.lastName].filter(Boolean).join(' ') || null,
    customerId: session.customerId,
    roles: session.roles,
    tokenExpiresAt: session.expiresAt,
  };
}
