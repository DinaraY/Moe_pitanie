const ENDPOINT = 'https://mcp.vkusvill.ru/mcp';
const MAX_BYTES = 1024 * 1024;

// A fresh session for each operation: never share user/session state across requests.
export async function withMcp(operation, transport = fetch, accessToken) {
  let session;
  let version = '2025-06-18';
  let sequence = 0;
  const sessionSignal = AbortSignal.timeout(60000);
  async function rpc(method, params, notification = false) {
    const id = ++sequence;
    const response = await transport(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(15000)]),
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': version,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(session ? { 'Mcp-Session-Id': session } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params })
    });
    if (!response.ok) {
      const error = new Error('UPSTREAM_UNAVAILABLE');
      error.upstreamStatus = response.status;
      throw error;
    }
    session = response.headers.get('Mcp-Session-Id') || session;
    if (notification) { await response.body?.cancel(); return; }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '', size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error('UPSTREAM_TOO_LARGE');
        body += decoder.decode(value, { stream: true });
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const events = body.replace(/\r\n/g, '\n').split('\n\n');
          for (const event of events.slice(0, -1)) {
            const data = event.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const message = JSON.parse(data);
            if (message.id === id) {
              if (message.error) throw new Error('UPSTREAM_RPC_ERROR');
              return message.result;
            }
          }
        }
      }
      body += decoder.decode();
      const message = JSON.parse(body);
      if (message.id !== id || message.error || !('result' in message)) throw new Error('UPSTREAM_RPC_ERROR');
      return message.result;
    } finally { await reader.cancel().catch(() => {}); }
  }
  try {
    const info = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'moe-pitanie', version: '0.1.0' } });
    if (!['2025-06-18', '2025-03-26'].includes(info.protocolVersion)) throw new Error('UNSUPPORTED_PROTOCOL');
    version = info.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    return await operation(rpc);
  } finally {
    if (session) await transport(ENDPOINT, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(2000), headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': version, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) } }).then(r => r.body?.cancel()).catch(() => {});
  }
}
