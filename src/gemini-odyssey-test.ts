/**
 * Gemini Live + Odyssey Integration Test
 * Runs in isolation to confirm both work end-to-end before porting to App.tsx.
 */
import { Odyssey, credentialsFromDict } from '@odysseyml/odyssey';

// ── State ─────────────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let odyssey: Odyssey | null = null;
let captureCtx: AudioContext | null = null;
let playCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let micActive = false;
let sessionReady = false;
let pcmSent = 0;
let pcmRecv = 0;
let nextPlayAt = 0;
let odysseyLeaseId: string | null = null;
let odysseyStreamStarted = false;

// ── Characters ────────────────────────────────────────────────────────────────
const CHAR_CONFIG: Record<string, { image: string; prompt: string; sysPrompt: string }> = {
  einstein: {
    image: '/images/characters/einstein.png',
    prompt: 'Animate it',
    sysPrompt: 'You are Albert Einstein. Curious, imaginative, with dry wit. Keep replies under 40 words.',
  },
  alexander: {
    image: '/images/characters/Alexander.png',
    prompt: 'Animate it',
    sysPrompt: 'You are Alexander the Great. Bold, strategic, inspiring. Keep replies under 40 words.',
  },
  bear: {
    image: '/images/characters/bear.png',
    prompt: 'Animate it',
    sysPrompt: 'You are a friendly bear named Steve. Warm, playful, gentle. Keep replies under 40 words.',
  },
  cleopatra: {
    image: '/images/characters/cleopatra.png',
    prompt: 'Animate it',
    sysPrompt: 'You are Cleopatra. Regal, intelligent, commanding. Keep replies under 40 words.',
  },
  'da-vinci': {
    image: '/images/characters/da vinci.png',
    prompt: 'Animate it',
    sysPrompt: 'You are Leonardo da Vinci. Creative, curious, inventive. Keep replies under 40 words.',
  },
};

// ── Logging ───────────────────────────────────────────────────────────────────
function log(panel: 'gl' | 'ody' | 'transcript', level: string, msg: string) {
  const el = document.getElementById(`${panel}-log`);
  if (!el) return;
  const now = new Date().toISOString().slice(11, 23);
  const line = document.createElement('div');
  line.innerHTML = `<span class="ts">${now}</span> <span class="${level}">${esc(msg)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  console.log(`[${panel}][${level}] ${msg}`);
}

function esc(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setBadge(id: string, txt: string, cls: string) {
  document.querySelectorAll(`#${id}`).forEach((el) => {
    el.textContent = txt;
    el.className = `badge ${cls}`;
  });
}

function updateStats() {
  const el = document.getElementById('stats');
  if (el) el.textContent = `Audio sent: ${pcmSent} chunks | Audio received: ${pcmRecv} chunks`;
}

function btn(id: string) { return document.getElementById(id) as HTMLButtonElement; }

// ── Utilities ─────────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

async function fetchImageFile(url: string, name: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const blob = await res.blob();
  return new File([blob], `${name}.png`, { type: blob.type || 'image/png' });
}

const ACTION_MAP: Array<[RegExp, string]> = [
  [/\b(yes|correct|exactly|absolutely|indeed)\b/i, 'nod enthusiastically'],
  [/\b(no|wrong|incorrect|not quite)\b/i, 'shake head and gesture correction'],
  [/\b(imagine|picture|think of|consider)\b/i, 'gesture thoughtfully and look upward'],
  [/\b(look at|observe|see|notice)\b/i, 'point and gesture toward viewer'],
  [/\b(discovered|found|realized|eureka)\b/i, 'gesture excitedly and look animated'],
  [/\b(simple|easy|basic)\b/i, 'nod and gesture simply'],
];

function deriveAction(transcript: string): string {
  for (const [pattern, action] of ACTION_MAP) {
    if (pattern.test(transcript)) return action;
  }
  return 'nod thoughtfully and gesture gently';
}

// ── Playback ──────────────────────────────────────────────────────────────────
function playPCMChunk(base64Data: string, sampleRate: number) {
  if (!playCtx) return;
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  const buf = playCtx.createBuffer(1, float32.length, sampleRate);
  buf.copyToChannel(float32, 0);
  const source = playCtx.createBufferSource();
  source.buffer = buf;
  source.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (nextPlayAt < now + 0.05) nextPlayAt = now + 0.05;
  source.start(nextPlayAt);
  nextPlayAt += buf.duration;
}

// ── Mic ───────────────────────────────────────────────────────────────────────
async function startMic() {
  if (!sessionReady || !ws || !captureCtx) { log('gl', 'err', 'Not ready — connect first'); return; }
  try {
    log('gl', 'info', 'Requesting mic…');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    log('gl', 'ok', `Mic granted — AudioContext state: ${captureCtx.state}`);
    if (captureCtx.state === 'suspended') {
      await captureCtx.resume();
      log('gl', 'info', `AudioContext resumed → ${captureCtx.state}`);
    }
    const micSrc = captureCtx.createMediaStreamSource(micStream);
    scriptNode = captureCtx.createScriptProcessor(2048, 1, 1);
    scriptNode.onaudioprocess = (ev) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const f32 = ev.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(JSON.stringify({
        realtimeInput: { audio: { data: arrayBufferToBase64(int16.buffer), mimeType: 'audio/pcm;rate=16000' } },
      }));
      pcmSent++;
      if (pcmSent % 8 === 0) updateStats();
    };
    micSrc.connect(scriptNode);
    scriptNode.connect(captureCtx.destination);
    micActive = true;
    log('gl', 'ok', 'Mic streaming — speak now');
  } catch (err) {
    log('gl', 'err', `Mic failed: ${(err as Error).name}: ${(err as Error).message}`);
  }
}

function stopMic() {
  if (scriptNode) { scriptNode.disconnect(); scriptNode.onaudioprocess = null; scriptNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  micActive = false;
  log('gl', 'ok', 'Mic stopped');
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function doDisconnect() {
  stopMic();
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
      ws.close(1000, 'user disconnected');
    } catch { /* ignore */ }
    ws = null;
  }
  if (odyssey) {
    try { odyssey.endStream(); } catch { /* ignore */ }
    try { odyssey.disconnect(); } catch { /* ignore */ }
    odyssey = null;
  }
  if (odysseyLeaseId) {
    fetch('/api/odyssey/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: odysseyLeaseId }),
    }).catch(() => undefined);
    odysseyLeaseId = null;
  }
  sessionReady = false;
  odysseyStreamStarted = false;
  micActive = false;
  pcmSent = 0; pcmRecv = 0;
  updateStats();
  setBadge('gl-badge', 'disconnected', '');
  setBadge('gl-panel-badge', 'disconnected', '');
  setBadge('ody-badge', 'disconnected', '');
  setBadge('ody-panel-badge', 'disconnected', '');
  const video = document.getElementById('ody-video') as HTMLVideoElement;
  if (video) { video.srcObject = null; video.style.display = 'none'; }
  const placeholder = document.getElementById('video-placeholder') as HTMLElement;
  if (placeholder) placeholder.style.display = 'flex';
  btn('btn-connect').disabled = false;
  btn('btn-mic').disabled = true;
  btn('btn-disconnect').disabled = true;
  btn('btn-mic').textContent = 'Start Mic';
  log('gl', 'ok', 'Disconnected');
  log('ody', 'ok', 'Disconnected');
}

// ── Connect Both ─────────────────────────────────────────────────────────────
async function doConnect() {
  const charId = (document.getElementById('char-sel') as HTMLSelectElement).value;
  const char = CHAR_CONFIG[charId];

  btn('btn-connect').disabled = true;
  log('gl', 'info', `Connecting — character: ${charId}`);
  log('ody', 'info', `Connecting Odyssey — character: ${charId}`);

  // Create BOTH AudioContexts within user gesture so they start RUNNING (not suspended)
  captureCtx = new AudioContext({ sampleRate: 16000 });
  captureCtx.resume().catch(() => undefined);
  if (!playCtx) playCtx = new AudioContext({ sampleRate: 24000 });
  playCtx.resume().catch(() => undefined);

  // Fetch tokens in parallel
  let apiKey: string;
  let odyCredentials: ReturnType<typeof credentialsFromDict>;
  try {
    const [glRes, odyRes] = await Promise.all([
      fetch('/api/gemini-live-token', { method: 'POST' }),
      fetch('/api/odyssey/token'),
    ]);
    if (!glRes.ok) throw new Error(`Gemini token: ${glRes.status}`);
    if (!odyRes.ok) throw new Error(`Odyssey token: ${odyRes.status}`);
    const glData = await glRes.json() as { token?: string };
    const odyData = await odyRes.json() as { credentials?: unknown; leaseId?: string };
    if (!glData.token) throw new Error('Empty Gemini token');
    if (!odyData.credentials) throw new Error('Empty Odyssey credentials');
    apiKey = glData.token;
    odyCredentials = credentialsFromDict(odyData.credentials as Parameters<typeof credentialsFromDict>[0]);
    odysseyLeaseId = odyData.leaseId ?? null;
    log('gl', 'ok', `Gemini token (len=${apiKey.length})`);
    log('ody', 'ok', `Odyssey credentials OK — lease: ${odysseyLeaseId ?? 'none'}`);
  } catch (err) {
    log('gl', 'err', `Token fetch: ${(err as Error).message}`);
    log('ody', 'err', `Token fetch: ${(err as Error).message}`);
    setBadge('gl-badge', 'error', 'err');
    btn('btn-connect').disabled = false;
    return;
  }

  // ── Odyssey ───────────────────────────────────────────────────────────────
  try {
    odyssey = new Odyssey({});
    setBadge('ody-badge', 'connecting…', 'mid');
    setBadge('ody-panel-badge', 'connecting…', 'mid');

    await odyssey.connectWithCredentials(odyCredentials, {
      onConnected: async (stream) => {
        log('ody', 'ok', '✓ onConnected — stream received');
        setBadge('ody-badge', 'connected', 'ok');
        setBadge('ody-panel-badge', 'connected', 'ok');

        const video = document.getElementById('ody-video') as HTMLVideoElement;
        const placeholder = document.getElementById('video-placeholder') as HTMLElement;
        video.srcObject = stream;
        placeholder.style.display = 'none';
        video.style.display = 'block';
        video.play().catch((e: unknown) => {
          log('ody', 'warn', `video.play: ${(e as Error).name}`);
          setTimeout(() => video.play().catch(() => undefined), 150);
        });

        log('ody', 'info', 'Calling startStream (no image — model does not support i2v)…');
        try {
          await odyssey!.startStream({ prompt: char.prompt });
          odysseyStreamStarted = true;
          log('ody', 'ok', '✓ startStream resolved');
        } catch (err) {
          log('ody', 'err', `startStream: ${(err as Error).message}`);
        }
      },
      onStatusChange: (status) => {
        log('ody', 'info', `status → ${status}`);
        if (status !== 'connected') {
          setBadge('ody-badge', status, 'mid');
          setBadge('ody-panel-badge', status, 'mid');
        }
      },
      onStreamStarted: () => { log('ody', 'ok', '✓ onStreamStarted'); },
      onStreamEnded:   () => { log('ody', 'warn', 'onStreamEnded'); },
      onStreamError:   (r, m) => { log('ody', 'err', `onStreamError: ${r} — ${m}`); },
      onError:         (e) => { log('ody', 'err', `onError: ${e.message}`); },
    });
  } catch (err) {
    log('ody', 'err', `connect failed: ${(err as Error).message}`);
  }

  // ── Gemini Live WebSocket ─────────────────────────────────────────────────
  setBadge('gl-badge', 'connecting…', 'mid');
  setBadge('gl-panel-badge', 'connecting…', 'mid');
  log('gl', 'info', 'Opening WebSocket…');

  ws = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`
  );

  ws.onopen = () => {
    log('gl', 'ok', 'WS open — sending setup');
    setBadge('gl-badge', 'setup…', 'mid');
    ws!.send(JSON.stringify({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
        systemInstruction: { parts: [{ text: char.sysPrompt }] },
      },
    }));
  };

  ws.onmessage = async (event) => {
    const text: string = event.data instanceof Blob ? await (event.data as Blob).text() : event.data as string;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }

    if (msg.setupComplete !== undefined) {
      log('gl', 'ok', '✓ setupComplete — click "Start Mic" to speak');
      setBadge('gl-badge', 'ready', 'ok');
      setBadge('gl-panel-badge', 'ready', 'ok');
      sessionReady = true;
      btn('btn-mic').disabled = false;
      btn('btn-disconnect').disabled = false;
      return;
    }

    if (msg.goAway !== undefined) { log('gl', 'warn', 'goAway'); doDisconnect(); return; }

    const content = msg.serverContent as Record<string, unknown> | undefined;
    if (!content) return;

    // Audio chunks
    const parts = ((content.modelTurn as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>;
    for (const part of parts) {
      const inlineData = part.inlineData as Record<string, string> | undefined;
      if (inlineData?.mimeType?.startsWith('audio/pcm')) {
        pcmRecv++;
        if (pcmRecv % 5 === 0) { log('gl', 'audio', `Audio chunk #${pcmRecv}`); updateStats(); }
        playPCMChunk(inlineData.data, 24000);
      }
    }

    if (content.interrupted) {
      log('gl', 'warn', 'Interrupted (barge-in)');
      nextPlayAt = 0;
      if (odysseyStreamStarted && odyssey) odyssey.interact({ prompt: 'stand idle' });
    }

    // Transcript → Odyssey
    const transcription = (content.outputTranscription as Record<string, string> | undefined)?.text;
    if (transcription) {
      log('transcript', 'tscript', `Gemini: "${transcription}"`);
      if (odysseyStreamStarted && odyssey) {
        const action = deriveAction(transcription);
        log('transcript', 'info', `→ Odyssey: "${action}"`);
        try { odyssey.interact({ prompt: action }); } catch { /* ignore */ }
      }
    }

    if (content.turnComplete) log('gl', 'ok', 'Turn complete');
  };

  ws.onerror = () => { log('gl', 'err', 'WS error'); setBadge('gl-badge', 'error', 'err'); };
  ws.onclose = (e) => {
    log('gl', e.code === 1000 ? 'ok' : 'err', `WS closed code=${e.code} reason="${e.reason || '(none)'}"`);
    setBadge('gl-badge', 'disconnected', '');
    setBadge('gl-panel-badge', 'disconnected', '');
    sessionReady = false;
    ws = null;
    btn('btn-mic').disabled = true;
    btn('btn-connect').disabled = false;
  };
}

// ── Mic toggle ────────────────────────────────────────────────────────────────
async function doToggleMic() {
  if (micActive) {
    stopMic();
    btn('btn-mic').textContent = 'Start Mic';
  } else {
    await startMic();
    if (micActive) btn('btn-mic').textContent = 'Stop Mic';
  }
}

function clearLogs() {
  ['gl-log', 'ody-log', 'transcript-log'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

// ── Expose to HTML onclick handlers ───────────────────────────────────────────
declare global { interface Window { doConnect: typeof doConnect; doToggleMic: typeof doToggleMic; doDisconnect: typeof doDisconnect; clearLogs: typeof clearLogs; } }
window.doConnect = doConnect;
window.doToggleMic = doToggleMic;
window.doDisconnect = doDisconnect;
window.clearLogs = clearLogs;
