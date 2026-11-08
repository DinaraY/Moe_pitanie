import { AuthStore } from '../src/auth.js';
export function environment() {
  const records = new Map();
  const instances = new Map();
  const namespace = {
    idFromName: name => name,
    get(id) {
      if (!instances.has(id)) {
        const map = new Map(); records.set(id, map);
        let lock = Promise.resolve();
        const storage = {
          get: async key => map.get(key), put: async (key, value) => map.set(key, value),
          delete: async key => map.delete(key), deleteAll: async () => map.clear(), setAlarm: async () => {},
          transaction: fn => { const result = lock.then(() => fn(storage)); lock = result.catch(() => {}); return result; }
        };
        const store = new AuthStore({ storage });
        instances.set(id, { fetch: (url, options) => store.fetch(new Request(url, options)) });
      }
      return instances.get(id);
    }
  };
  return { records, env: {
    AUTH_STORE: namespace, OAUTH_ENABLED: 'true', VV_CLIENT_ID: 'test-client', VV_CLIENT_SECRET: 'test-secret',
    TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', VV_SCOPE: 'test-scope',
    VV_TOKEN_AUTH_METHOD: 'client_secret_basic', VV_AUTHORIZATION_ENDPOINT: 'https://oauth.vkusvill.ru/test-authorize',
    VV_TOKEN_ENDPOINT: 'https://oauth.vkusvill.ru/test-token', VV_REDIRECT_URI: 'https://api.example/oauth/callback',
    APP_RETURN_URL: 'https://dinaray.github.io/Moe_pitanie/connect.html', ALLOWED_ORIGIN: 'https://dinaray.github.io'
  }};
}
