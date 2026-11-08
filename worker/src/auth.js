const RESOURCE = 'https://mcp.vkusvill.ru/mcp';
const SESSION_MS = 60 * 60 * 1000;
const FLOW_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async value => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));

export function configuration(env) {
  if (env.OAUTH_ENABLED !== 'true') throw new Error('OAUTH_DISABLED');
  for (const name of ['AUTH_STORE', 'VV_CLIENT_ID', 'VV_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'VV_SCOPE']) {
    if (!env[name]) throw new Error('OAUTH_NOT_CONFIGURED');
  }
  const endpoint = name => {
    const url = new URL(env[name]);
    if (url.protocol !== 'https:' || url.hostname !== 'oauth.vkusvill.ru' || url.port || url.username || url.password || url.hash || url.search) throw new Error('OAUTH_NOT_CONFIGURED');
    return url.href;
  };
  const callback = new URL(env.VV_REDIRECT_URI);
  if (callback.protocol !== 'https:' || callback.pathname !== '/oauth/callback' || callback.search || callback.hash || callback.username || callback.password) throw new Error('OAUTH_NOT_CONFIGURED');
  const returnUrl = new URL(env.APP_RETURN_URL);
  if (returnUrl.origin !== env.ALLOWED_ORIGIN || returnUrl.search || returnUrl.hash) throw new Error('OAUTH_NOT_CONFIGURED');
  if (!['client_secret_basic', 'client_secret_post'].includes(env.VV_TOKEN_AUTH_METHOD)) throw new Error('OAUTH_NOT_CONFIGURED');
  if (unb64(env.TOKEN_ENCRYPTION_KEY).length !== 32) throw new Error('OAUTH_NOT_CONFIGURED');
  return { authorize: endpoint('VV_AUTHORIZATION_ENDPOINT'), token: endpoint('VV_TOKEN_ENDPOINT'), callback: callback.href, returnUrl: returnUrl.href };
}

async function key(env) {
  return crypto.subtle.importKey('raw', unb64(env.TOKEN_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await key(env), encoder.encode(JSON.stringify(value)));
  return { iv: b64(iv), data: b64(new Uint8Array(ciphertext)) };
}
export async function open(env, value, context) {
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(value.iv), additionalData: encoder.encode(context) }, await key(env), unb64(value.data));
  return JSON.parse(new TextDecoder().decode(clear));
}

// All state lives in Durable Objects, never in shared Worker globals.
export class AuthStore {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const { action, value } = await request.json();
    if (action === 'create') {
      const created = await this.ctx.storage.transaction(async tx => {
        if (await tx.get('record')) return false;
        await tx.put('record', value); return true;
      });
      if (created) await this.ctx.storage.setAlarm(value.expiresAt);
      return Response.json({ ok: created });
    }
    if (action === 'delete') { await this.ctx.storage.deleteAll(); return Response.json({ ok: true }); }
    if (['claim', 'finish', 'fail'].includes(action)) {
      const outcome = await this.ctx.storage.transaction(async tx => {
        const record = await tx.get('record');
        if (!record || record.kind !== 'cart' || record.expiresAt <= Date.now()) return { record: null, claimed: false };
        if (action === 'claim') {
          if (record.status !== 'pending') return { record, claimed: false };
          const updated = { ...record, status: 'processing' };
          await tx.put('record', updated); return { record: updated, claimed: true };
        }
        if (record.status !== 'processing') return { record, claimed: false };
        const updated = { ...record, status: action === 'finish' ? 'done' : 'failed', result: value || null };
        await tx.put('record', updated); return { record: updated };
      });
      return Response.json(outcome);
    }
    const record = await this.ctx.storage.transaction(async tx => {
      const found = await tx.get('record');
      if (!found || found.expiresAt <= Date.now()) { await tx.delete('record'); return null; }
      if (action === 'consume') await tx.delete('record');
      return found;
    });
    return Response.json({ record });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

export async function storage(env, identifier, action, value) {
  const id = env.AUTH_STORE.idFromName(await digest(identifier));
  const response = await env.AUTH_STORE.get(id).fetch('https://auth-store.internal/', { method: 'POST', body: JSON.stringify({ action, value }) });
  if (!response.ok) throw new Error('AUTH_STORE_UNAVAILABLE');
  return response.json();
}
const cookie = (value, age) => `__Host-vv_state=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const redirect = (location, extra = {}) => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...extra } });

export async function oauth(request, env, transport = fetch) {
  const config = configuration(env);
  const url = new URL(request.url);
  if (url.origin !== new URL(config.callback).origin) throw new Error('OAUTH_WRONG_ORIGIN');
  if (url.pathname === '/oauth/start' && request.method === 'GET') {
    const state = random(), verifier = random(), browser = random();
    const payload = await seal(env, { verifier, browserHash: await digest(browser) }, state);
    const created = await storage(env, state, 'create', { expiresAt: Date.now() + FLOW_MS, payload });
    if (!created.ok) throw new Error('AUTH_STORE_UNAVAILABLE');
    const target = new URL(config.authorize);
    target.search = new URLSearchParams({ response_type: 'code', client_id: env.VV_CLIENT_ID, redirect_uri: config.callback, scope: env.VV_SCOPE, state, code_challenge: await digest(verifier), code_challenge_method: 'S256', resource: RESOURCE }).toString();
    return redirect(target.href, { 'Set-Cookie': cookie(browser, 600) });
  }
  if (url.pathname !== '/oauth/callback' || request.method !== 'GET') return new Response(null, { status: 404 });
  const state = url.searchParams.get('state');
  const browser = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('__Host-vv_state='))?.slice('__Host-vv_state='.length);
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new Error('INVALID_OAUTH_STATE');
  // Check the browser binding before consuming state; arbitrary callers cannot burn it.
  const { record } = await storage(env, state, 'read');
  if (!record) throw new Error('INVALID_OAUTH_STATE');
  const flow = await open(env, record.payload, state);
  if (flow.browserHash !== await digest(browser)) throw new Error('INVALID_OAUTH_STATE');
  const consumed = await storage(env, state, 'consume');
  if (!consumed.record) throw new Error('INVALID_OAUTH_STATE');
  const serverName = ['production', 'staging', 'testing'].includes(env.APP_SERVER) ? env.APP_SERVER : env.APP_ENV === 'staging' ? 'staging' : 'production';
  const server = serverName === 'production' ? '' : '&server=' + serverName;
  if (url.searchParams.has('error')) return redirect(config.returnUrl + '#auth=denied' + server, { 'Set-Cookie': cookie('', 0) });
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('INVALID_OAUTH_CODE');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.callback, code_verifier: flow.verifier, resource: RESOURCE });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (env.VV_TOKEN_AUTH_METHOD === 'client_secret_basic') {
    headers.Authorization = 'Basic ' + btoa(`${encodeURIComponent(env.VV_CLIENT_ID)}:${encodeURIComponent(env.VV_CLIENT_SECRET)}`);
  } else { body.set('client_id', env.VV_CLIENT_ID); body.set('client_secret', env.VV_CLIENT_SECRET); }
  const response = await transport(config.token, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) throw new Error('OAUTH_EXCHANGE_FAILED');
  // Bound sensitive upstream data, including chunked responses.
  const reader = response.body.getReader(); let text = '', size = 0; const decoder = new TextDecoder();
  try { while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 32768) throw new Error('OAUTH_EXCHANGE_FAILED');
    text += decoder.decode(value, { stream: true });
  }} finally { await reader.cancel().catch(() => {}); }
  const tokens = JSON.parse(text + decoder.decode());
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || /[\r\n]/.test(tokens.access_token) || tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('OAUTH_EXCHANGE_FAILED');
  const session = random();
  const expiresAt = Date.now() + Math.min(SESSION_MS, tokens.expires_in * 1000);
  // Refresh token deliberately discarded: re-consent on expiry until refresh is verified.
  const payload = await seal(env, { accessToken: tokens.access_token, scope: tokens.scope || env.VV_SCOPE }, session);
  if (!(await storage(env, session, 'create', { expiresAt, payload })).ok) throw new Error('AUTH_STORE_UNAVAILABLE');
  return redirect(config.returnUrl + '#session=' + session + server, { 'Set-Cookie': cookie('', 0) });
}

export async function sessionFor(request, env) {
  if (!request.headers.has('Authorization')) return null;
  configuration(env);
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization'));
  if (!match) throw new Error('SESSION_EXPIRED');
  const session = match[1];
  const { record } = await storage(env, session, 'read');
  if (!record) throw new Error('SESSION_EXPIRED');
  const secret = await open(env, record.payload, session);
  return { accessToken: secret.accessToken, expiresAt: record.expiresAt, owner: await digest(session), destroy: () => storage(env, session, 'delete') };
}
