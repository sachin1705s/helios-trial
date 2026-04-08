/**
 * Odyssey Stream Isolator — test-stream.ts
 *
 * Loaded by test-stream.html (served by Vite at http://localhost:5173/test-stream.html).
 * Vite proxies /api → http://localhost:8787, so both endpoints resolve correctly.
 *
 * Purpose: Isolate whether connectWithCredentials breaks startStream vs the old apiKey approach.
 */

import { Odyssey, credentialsFromDict } from '@odysseyml/odyssey';

// ── Timeouts ──────────────────────────────────────────────────────────────────
const CONNECT_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS  = 15_000;

// ── Tiny log helper ───────────────────────────────────────────────────────────
type LogLevel = 'info' | 'ok' | 'warn' | 'err';

function makeLogger(logEl: HTMLElement) {
  return function log(level: LogLevel, msg: string) {
    const now = new Date().toISOString().slice(11, 23);
    const line = document.createElement('div');
    line.innerHTML = `<span class="ts">${now}</span> <span class="${level}">${escHtml(msg)}</span>`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    console.log(`[odyssey-test] [${level}] ${msg}`);
  };
}

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setBadge(el: HTMLElement, text: string, cls: string) {
  el.textContent = text;
  el.className = `status-badge ${cls}`;
}

function setVerdict(el: HTMLElement, pass: boolean, msg: string) {
  el.textContent = pass ? `✓ PASS — ${msg}` : `✗ FAIL — ${msg}`;
  el.className = `verdict ${pass ? 'pass' : 'fail'}`;
}

// ── Test A: connectWithCredentials ────────────────────────────────────────────
const credRunBtn  = document.getElementById('cred-run')  as HTMLButtonElement;
const credStopBtn = document.getElementById('cred-stop') as HTMLButtonElement;
const credLogEl   = document.getElementById('cred-log')  as HTMLElement;
const credVideo   = document.getElementById('cred-video') as HTMLVideoElement;
const credStatus  = document.getElementById('cred-status') as HTMLElement;
const credVerdict = document.getElementById('cred-verdict') as HTMLElement;

let credClient: Odyssey | null = null;
let credLeaseId: string | null = null;

credRunBtn.addEventListener('click', async () => {
  credRunBtn.disabled = true;
  credStopBtn.disabled = false;
  credVerdict.className = 'verdict';

  const log = makeLogger(credLogEl);
  credLogEl.innerHTML = '';

  setBadge(credStatus, 'fetching token…', '');

  try {
    // ── Step 1: Fetch credentials from server ──────────────────────────────
    log('info', 'GET /api/odyssey/token…');
    const tokenRes = await fetch('/api/odyssey/token');
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Token fetch failed ${tokenRes.status}: ${err}`);
    }
    const { credentials: credDict, leaseId } = await tokenRes.json();
    credLeaseId = leaseId;
    log('ok', `Got credentials (leaseId: ${leaseId})`);
    log('info', `credentials keys: ${Object.keys(credDict).join(', ')}`);

    const credentials = credentialsFromDict(credDict);

    // ── Step 2: Connect ────────────────────────────────────────────────────
    credClient = new Odyssey({});
    // Pre-set i2v capability — connectWithCredentials doesn't propagate it (SDK gap).
    (credClient as unknown as { capabilities: { image_to_video: boolean } }).capabilities.image_to_video = true;
    log('info', 'new Odyssey({}) created (capabilities.image_to_video forced true)');
    setBadge(credStatus, 'connecting…', '');

    const connected = await new Promise<MediaStream | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('onConnected timeout')), CONNECT_TIMEOUT_MS);

      credClient!.connectWithCredentials(credentials, {
        onConnected(stream) {
          clearTimeout(timeout);
          log('ok', `onConnected fired — stream tracks: ${stream?.getTracks().length ?? 'null'}`);
          resolve(stream ?? null);
        },
        onDisconnected() {
          log('warn', 'onDisconnected fired');
        },
        onStreamStarted() {
          log('ok', '🟢 onStreamStarted fired — character should be animating');
        },
        onStreamEnded() {
          log('warn', 'onStreamEnded fired');
        },
        onStatusChange(status) {
          log('info', `onStatusChange → ${status}`);
        },
        onError(err) {
          log('err', `onError: ${err?.message ?? String(err)}`);
        },
      });
    });

    if (connected) {
      credVideo.srcObject = connected;
      setBadge(credStatus, 'connected', 'connected');
    }

    // ── Step 3: Fetch character image (mirrors app's loadImageFile) ───────
    log('info', 'Fetching /images/characters/Alexander.png…');
    const imgRes = await fetch('/images/characters/Alexander.png');
    if (!imgRes.ok) throw new Error(`Image fetch failed ${imgRes.status}`);
    const imgBlob = await imgRes.blob();
    const imgFile = new File([imgBlob], 'alexander.png', { type: imgBlob.type || 'image/png' });
    log('ok', `Image loaded — ${(imgBlob.size / 1024).toFixed(1)} KB`);

    // ── Step 4: startStream (with image, same as app) ─────────────────────
    log('info', 'Calling startStream({ prompt: "Animate it", image })…');
    setBadge(credStatus, 'startStream…', '');

    const streamStarted = await Promise.race([
      credClient.startStream({ prompt: 'Animate it', image: imgFile }).then(() => {
        log('ok', 'startStream() resolved');
        return true;
      }),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error(`startStream timeout after ${STREAM_TIMEOUT_MS}ms`)), STREAM_TIMEOUT_MS)
      ),
    ]);

    if (streamStarted) {
      setBadge(credStatus, 'streaming', 'streaming');
      setVerdict(credVerdict, true, 'startStream resolved — check video for animation');
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('err', msg);
    setBadge(credStatus, 'error', 'error');
    setVerdict(credVerdict, false, msg);
  } finally {
    credRunBtn.disabled = false;
    credStopBtn.disabled = true;
  }
});

credStopBtn.addEventListener('click', async () => {
  if (credClient) {
    try { credClient.disconnect(); } catch { /* ignore */ }
    credClient = null;
  }
  if (credLeaseId) {
    await fetch('/api/odyssey/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: credLeaseId }),
    }).catch(() => undefined);
    credLeaseId = null;
  }
  credVideo.srcObject = null;
  setBadge(credStatus, 'stopped', '');
  credRunBtn.disabled = false;
  credStopBtn.disabled = true;
});

// ── Test B: apiKey (old approach) ─────────────────────────────────────────────
const keyRunBtn  = document.getElementById('key-run')   as HTMLButtonElement;
const keyStopBtn = document.getElementById('key-stop')  as HTMLButtonElement;
const keyLogEl   = document.getElementById('key-log')   as HTMLElement;
const keyVideo   = document.getElementById('key-video')  as HTMLVideoElement;
const keyStatus  = document.getElementById('key-status') as HTMLElement;
const keyVerdict = document.getElementById('key-verdict') as HTMLElement;
const keyInput   = document.getElementById('key-input')  as HTMLInputElement;

let keyClient: Odyssey | null = null;

keyRunBtn.addEventListener('click', async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    alert('Paste an API key first.');
    return;
  }

  keyRunBtn.disabled = true;
  keyStopBtn.disabled = false;
  keyVerdict.className = 'verdict';

  const log = makeLogger(keyLogEl);
  keyLogEl.innerHTML = '';

  setBadge(keyStatus, 'connecting…', '');

  try {
    // ── Step 1: Connect with apiKey ────────────────────────────────────────
    keyClient = new Odyssey({ apiKey });
    log('info', 'new Odyssey({ apiKey }) created');

    const connected = await new Promise<MediaStream | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('onConnected timeout')), CONNECT_TIMEOUT_MS);

      keyClient!.connect({
        onConnected(stream) {
          clearTimeout(timeout);
          log('ok', `onConnected fired — stream tracks: ${stream?.getTracks().length ?? 'null'}`);
          resolve(stream ?? null);
        },
        onDisconnected() {
          log('warn', 'onDisconnected fired');
        },
        onStreamStarted() {
          log('ok', '🟢 onStreamStarted fired — character should be animating');
        },
        onStreamEnded() {
          log('warn', 'onStreamEnded fired');
        },
        onStatusChange(status) {
          log('info', `onStatusChange → ${status}`);
        },
        onError(err) {
          log('err', `onError: ${err?.message ?? String(err)}`);
        },
      });
    });

    if (connected) {
      keyVideo.srcObject = connected;
      setBadge(keyStatus, 'connected', 'connected');
    }

    // ── Step 2: startStream ────────────────────────────────────────────────
    log('info', 'Calling startStream({ prompt: "say hello" })…');
    setBadge(keyStatus, 'startStream…', '');

    const streamStarted = await Promise.race([
      keyClient.startStream({ prompt: 'say hello' }).then(() => {
        log('ok', 'startStream() resolved');
        return true;
      }),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error(`startStream timeout after ${STREAM_TIMEOUT_MS}ms`)), STREAM_TIMEOUT_MS)
      ),
    ]);

    if (streamStarted) {
      setBadge(keyStatus, 'streaming', 'streaming');
      setVerdict(keyVerdict, true, 'startStream resolved — check video for animation');
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('err', msg);
    setBadge(keyStatus, 'error', 'error');
    setVerdict(keyVerdict, false, msg);
  } finally {
    keyRunBtn.disabled = false;
    keyStopBtn.disabled = true;
  }
});

keyStopBtn.addEventListener('click', async () => {
  if (keyClient) {
    try { keyClient.disconnect(); } catch { /* ignore */ }
    keyClient = null;
  }
  keyVideo.srcObject = null;
  setBadge(keyStatus, 'stopped', '');
  keyRunBtn.disabled = false;
  keyStopBtn.disabled = true;
});
