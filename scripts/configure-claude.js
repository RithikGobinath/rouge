'use strict';
// Run with Electron. Receive a JSON credential object over a local pipe;
// the key is never an argument, environment variable, or plaintext file.
const path = require('path');
const net = require('net');
const { app, safeStorage } = require('electron');
const { createStore } = require('../src/store');
const brand = require('../src/brand');
let phase = 'startup';

app.setName(brand.name);
app.setAppUserModelId(brand.appId);
app.setPath('userData', path.join(app.getPath('appData'), brand.dataDir));
app.disableHardwareAcceleration();

async function credentialInput() {
  let input = '';
  const option = process.argv.find((value) => value.startsWith('--credential-pipe='));
  const pipeName = option && option.slice('--credential-pipe='.length);
  if (!/^clippy-config-[a-f0-9]{32}$/.test(pipeName || '')) throw new Error('Invalid local credential pipe.');
  const stream = net.createConnection('\\\\.\\pipe\\' + pipeName);
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    input += chunk;
    if (input.length > 4096) throw new Error('Invalid credential input.');
  }
  const payload = JSON.parse(input.trim());
  input = '';
  if (!payload || typeof payload.anthropic !== 'string' || !payload.anthropic.trim()) throw new Error('No credential supplied.');
  return payload;
}

function finish(result, code) {
  process.stdout.write(JSON.stringify(result) + '\n', () => app.exit(code));
}

app.whenReady().then(async () => {
  phase = 'credential-input';
  const payload = await credentialInput();
  phase = 'store';
  const store = createStore({
    dir: app.getPath('userData'),
    cipher: {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptStringAsync(value),
      decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
    },
  });
  await store.init();
  phase = 'encrypt';
  const saved = await store.setKeys({ anthropic: payload.anthropic });
  payload.anthropic = '';
  if (!saved.ok) { finish({ saved: false, error: 'The credential could not be saved with local encryption.' }, 1); return; }
  phase = 'settings';
  const configured = store.patch({
    useClaudeCode: false,
    models: { anthropicA: 'claude-haiku-5-5', anthropicB: 'claude-sonnet-5-5', anthropicC: 'claude-opus-5-5' },
  });
  finish({ saved: true, rolesConfigured: configured.ok, encrypted: true }, configured.ok ? 0 : 1);
}).catch((error) => finish({ saved: false, phase, kind: error instanceof TypeError ? 'type' : error instanceof SyntaxError ? 'input' : 'setup', error: 'Local credential setup failed.' }, 1));
