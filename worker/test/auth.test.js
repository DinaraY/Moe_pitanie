import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore, configuration, oauth, sessionFor, seal, open } from '../src/auth.js';

import { environment } from './helpers.js';
async function start(env) {
  const response = await oauth(new Request('https://api.example/oauth/start'), env);
  return { url: new URL(response.headers.get('Location')), cookie: response.headers.get('Set-Cookie').split(';')[0] };
}
const callback = (flow, cookie = flow.cookie) => new Request('https://api.example/oauth/callback?' + new URLSearchParams({ state: flow.url.searchParams.get('state'), code: 'test-code' }), { headers: { Cookie: cookie } });

test('OAuth defaults closed and rejects untrusted endpoints and return origin', () => {
  const { env } = environment();
  assert.throws(() => configuration({ ...env, OAUTH_ENABLED: 'false' }));
  assert.throws(() => configuration({ ...env, VV_TOKEN_ENDPOINT: 'https://evil.example/token' }));
  assert.throws(() => configuration({ ...env, APP_RETURN_URL: 'https://evil.example/' }));
});
test('PKCE, browser binding, one-use state, encrypted session and logout', async () => {
  const { env, records } = environment();
  const flow = await start(env);
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.url.searchParams.get('resource'), 'https://mcp.vkusvill.ru/mcp');
  await assert.rejects(() => oauth(callback(flow, '__Host-vv_state=' + 'x'.repeat(43)), env), /INVALID_OAUTH_STATE/);
  let count = 0;
  const tokenExchange = async (url, options) => {
    count++;
    assert.equal(url, env.VV_TOKEN_ENDPOINT);
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('code_verifier').length, 43);
    assert.ok(options.headers.Authorization.startsWith('Basic '));
    return Response.json({ access_token: 'test-access-token', token_type: 'Bearer', expires_in: 7200, refresh_token: 'must-not-store' });
  };
  const response = await oauth(callback(flow), env, tokenExchange);
  assert.equal(response.status, 303);
  const location = response.headers.get('Location');
  assert.ok(!location.includes('test-access-token'));
  const sid = new URLSearchParams(new URL(location).hash.slice(1)).get('session');
  const request = new Request('https://api.example/api/session', { headers: { Authorization: `Bearer ${sid}` } });
  const session = await sessionFor(request, env);
  assert.equal(session.accessToken, 'test-access-token');
  assert.ok(session.expiresAt <= Date.now() + 3600000);
  const stored = JSON.stringify([...records.values()].flatMap(x => [...x.values()]));
  assert.ok(!stored.includes('test-access-token'));
  assert.ok(!stored.includes('must-not-store'));
  await assert.rejects(() => oauth(callback(flow), env, tokenExchange), /INVALID_OAUTH_STATE/);
  assert.equal(count, 1);
  await session.destroy();
  await assert.rejects(() => sessionFor(request, env), /SESSION_EXPIRED/);
});
test('encrypted records are bound to their session and tampering fails', async () => {
  const { env } = environment();
  const value = await seal(env, { token: 'private' }, 'one');
  assert.deepEqual(await open(env, value, 'one'), { token: 'private' });
  await assert.rejects(() => open(env, value, 'two'));
});
test('expired sessions are deleted, browser authorization cannot pick another user', async () => {
  const { env } = environment();
  assert.equal(await sessionFor(new Request('https://api.example/'), env), null);
  await assert.rejects(() => sessionFor(new Request('https://api.example/', { headers: { Authorization: 'Bearer arbitrary-upstream-token' } }), env), /SESSION_EXPIRED/);
  const object = env.AUTH_STORE.get('expired');
  await object.fetch('https://auth-store.internal/', { method: 'POST', body: JSON.stringify({ action: 'create', value: { expiresAt: Date.now() - 1 } }) });
  const response = await object.fetch('https://auth-store.internal/', { method: 'POST', body: JSON.stringify({ action: 'read' }) });
  assert.equal((await response.json()).record, null);
});
