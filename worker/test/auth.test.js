import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore, configuration, oauth, sessionFor, seal, open } from '../src/auth.js';

import { environment } from './helpers.js';
async function start(env, remembered = false) {
  const response = await oauth(new Request('https://api.example/oauth/start' + (remembered ? '?remember=1' : '')), env);
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
    assert.equal(options.redirect, 'manual');
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
test('remembered login restores from a protected cookie without another token exchange', async () => {
  const { env } = environment();
  const flow = await start(env, true); let exchanges = 0;
  const response = await oauth(callback(flow), env, async () => {
    exchanges++;
    return Response.json({ access_token: 'remembered-test-token', token_type: 'Bearer', expires_in: 7200 });
  });
  const cookies = response.headers.getSetCookie();
  const resume = cookies.find(c => c.startsWith('__Host-moe_session='));
  assert.ok(resume.includes('Secure') && resume.includes('HttpOnly') && resume.includes('SameSite=Lax'));
  const maxAge = Number(/Max-Age=(\d+)/.exec(resume)[1]);
  assert.ok(maxAge > 3600 && maxAge <= 7200);
  const sid = new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1)).get('session');
  const restoreRequest = new Request('https://api.example/oauth/restore', { headers: { Cookie: resume.split(';')[0] } });
  const restored = await oauth(restoreRequest, env, () => { throw new Error('must not call provider'); });
  assert.equal(new URLSearchParams(new URL(restored.headers.get('Location')).hash.slice(1)).get('session'), sid);
  assert.ok(!restored.headers.get('Location').includes('remembered-test-token'));
  const authenticated = await sessionFor(new Request('https://api.example/api/session', { headers: { Authorization: `Bearer ${sid}` } }), env);
  assert.equal(authenticated.remembered, true);
  assert.equal(exchanges, 1);
  await authenticated.destroy();
  const loggedOut = await oauth(restoreRequest, env);
  assert.equal(new URLSearchParams(new URL(loggedOut.headers.get('Location')).hash.slice(1)).get('auth'), 'expired');
  assert.ok(loggedOut.headers.get('Set-Cookie').includes('Max-Age=0'));
});
test('cookie restoration fails closed for missing, forged or expired sessions', async () => {
  const { env, records } = environment();
  for (const cookie of ['', '__Host-moe_session=' + 'x'.repeat(43)]) {
    const response = await oauth(new Request('https://api.example/oauth/restore', { headers: { Cookie: cookie } }), env);
    assert.equal(new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1)).get('auth'), 'expired');
  }
  const flow = await start(env, true);
  const response = await oauth(callback(flow), env, async () => Response.json({ access_token: 'test-expiring-token', token_type: 'bearer', expires_in: 3600 }));
  const resume = response.headers.getSetCookie().find(c => c.startsWith('__Host-moe_session='));
  for (const map of records.values()) for (const [key, value] of map) map.set(key, { ...value, expiresAt: Date.now() - 1 });
  const expired = await oauth(new Request('https://api.example/oauth/restore', { headers: { Cookie: resume.split(';')[0] } }), env);
  assert.equal(new URLSearchParams(new URL(expired.headers.get('Location')).hash.slice(1)).get('auth'), 'expired');
});
test('remembered session never outlives one day or the provider token', async () => {
  const { env } = environment(); const flow = await start(env, true);
  const response = await oauth(callback(flow), env, async () => Response.json({ access_token: 'test-long-token', token_type: 'bearer', expires_in: 10 * 86400 }));
  const sid = new URLSearchParams(new URL(response.headers.get('Location')).hash.slice(1)).get('session');
  const authenticated = await sessionFor(new Request('https://api.example/api/session', { headers: { Authorization: `Bearer ${sid}` } }), env);
  assert.ok(authenticated.expiresAt <= Date.now() + 86400000);
});
