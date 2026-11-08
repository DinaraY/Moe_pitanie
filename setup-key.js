const generate = document.getElementById('generate');
const output = document.getElementById('key');
const status = document.getElementById('status');
const result = document.getElementById('result');
const reveal = document.getElementById('reveal');

async function copyKey() {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
    status.textContent = 'Ключ скопирован. Вставьте его в Value записи TOKEN_ENCRYPTION_KEY в Cloudflare.';
  } catch {
    // Safari can deny clipboard access. Selecting a plain input permits manual copying.
    output.type = 'text';
    reveal.textContent = 'Скрыть';
    output.focus(); output.select(); output.setSelectionRange(0, output.value.length);
    status.textContent = 'Автоматическое копирование недоступно. Выделите ключ и выберите «Скопировать», затем вставьте его в Cloudflare. Не отправляйте его в чат.';
  }
}
if (!globalThis.isSecureContext || !globalThis.crypto?.getRandomValues) {
  generate.disabled = true;
  status.textContent = 'Откройте эту страницу по HTTPS в Safari или другом современном браузере.';
}
generate.addEventListener('click', async () => {
  if (generate.disabled) return;
  generate.disabled = true;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  output.value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  bytes.fill(0);
  result.hidden = false;
  await copyKey();
});
document.getElementById('copy').addEventListener('click', copyKey);
reveal.addEventListener('click', () => {
  output.type = output.type === 'password' ? 'text' : 'password';
  reveal.textContent = output.type === 'password' ? 'Показать' : 'Скрыть';
});
