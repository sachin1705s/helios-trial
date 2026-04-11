/**
 * Gemini Live + Odyssey Integration Test
 *
 * Audio flow being tested:
 *   Mic → [16kHz PCM] → Gemini Live WS (speech-to-speech)
 *                           ↓ audio chunks (24kHz PCM)  ↓ transcript
 *                        Speaker playback          Odyssey.interact(action)
 *
 * The user speaks → Gemini responds with voice → Odyssey avatar animates.
 */
import { Odyssey, credentialsFromDict } from '@odysseyml/odyssey';

// ── State ─────────────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let odyssey: Odyssey | null = null;
let captureCtx: AudioContext | null = null;   // 16kHz — mic capture
let playCtx: AudioContext | null = null;       // 24kHz — Gemini audio playback
let micStream: MediaStream | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let micActive = false;
let sessionReady = false;
let pcmSent = 0;
let pcmRecv = 0;
let nextPlayAt = 0;
let odysseyLeaseId: string | null = null;
let odysseyReady = false;   // true after onStreamStarted
let currentChar = { chatName: 'Albert Einstein' };

// ── Characters ────────────────────────────────────────────────────────────────
const CHAR_CONFIG: Record<string, { image: string; sysPrompt: string; chatName: string }> = {
  einstein:   { image: '/images/characters/einstein.png',    sysPrompt: 'You are Albert Einstein. Curious, imaginative, dry wit. Keep replies under 40 words.',           chatName: 'Albert Einstein' },
  alexander:  { image: '/images/characters/Alexander.png',   sysPrompt: 'You are Alexander the Great. Bold, strategic, inspiring. Keep replies under 40 words.',          chatName: 'Alexander' },
  bear:       { image: '/images/characters/bear.png',        sysPrompt: 'You are a friendly bear named Steve. Warm, playful, gentle. Keep replies under 40 words.',        chatName: 'Steve the Bear' },
  cleopatra:  { image: '/images/characters/cleopatra.png',   sysPrompt: 'You are Cleopatra. Regal, intelligent, commanding. Keep replies under 40 words.',                 chatName: 'Cleopatra' },
  'da-vinci': { image: '/images/characters/da vinci.png',    sysPrompt: 'You are Leonardo da Vinci. Creative, curious, inventive. Keep replies under 40 words.',           chatName: 'Da Vinci' },
};

// Takes what the USER said → calls /api/character/chat → returns the `action` field for Odyssey
async function getOdysseyAction(userText: string, charName: string): Promise<string> {
  const res = await fetch('/api/character/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: userText, character: charName, history: [] }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}`);
  const data = await res.json() as { action?: string };
  return data.action?.trim() || 'nod thoughtfully';
}

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
const esc = (s: string) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function setBadge(id: string, txt: string, cls: string) {
  document.querySelectorAll(`#${id}`).forEach(el => { el.textContent = txt; el.className = `badge ${cls}`; });
}
function updateStats() {
  const el = document.getElementById('stats');
  if (el) el.textContent = `Mic→Gemini: ${pcmSent} chunks | Gemini→Speaker: ${pcmRecv} chunks`;
}
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;

// ── Utilities ─────────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  return btoa(binary);
}

function playPCMChunk(b64: string) {
  if (!playCtx) return;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / (i16[i] < 0 ? 0x8000 : 0x7fff);
  const buf = playCtx.createBuffer(1, f32.length, 24000);
  buf.copyToChannel(f32, 0);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (nextPlayAt < now + 0.05) nextPlayAt = now + 0.05;
  src.start(nextPlayAt);
  nextPlayAt += buf.duration;
}

// ── Mic ───────────────────────────────────────────────────────────────────────
async function startMic() {
  if (!sessionReady || !ws || !captureCtx) { log('gl','err','Not ready'); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    log('gl','ok',`Mic granted — AudioContext state: ${captureCtx.state}`);

    if (captureCtx.state === 'suspended') {
      await captureCtx.resume();
      log('gl','info',`Resumed → ${captureCtx.state}`);
    }

    const src = captureCtx.createMediaStreamSource(micStream);
    scriptNode = captureCtx.createScriptProcessor(2048, 1, 1);

    scriptNode.onaudioprocess = (ev) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const f32 = ev.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // ➜ MIC PCM → GEMINI LIVE
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: arrayBufferToBase64(i16.buffer), mimeType: 'audio/pcm;rate=16000' } } }));
      pcmSent++;
      if (pcmSent % 8 === 0) updateStats();
    };

    src.connect(scriptNode);
    scriptNode.connect(captureCtx.destination);
    micActive = true;
    log('gl','ok','✓ Mic streaming → Gemini Live (speak now)');
  } catch (err) {
    log('gl','err',`Mic: ${(err as Error).name}: ${(err as Error).message}`);
  }
}

function stopMic() {
  if (scriptNode) { scriptNode.disconnect(); scriptNode.onaudioprocess = null; scriptNode = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  micActive = false;
  log('gl','ok','Mic stopped');
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function doDisconnect() {
  stopMic();
  if (ws?.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch { /* ignore */ }
  }
  try { ws?.close(1000, 'user disconnected'); } catch { /* ignore */ }
  ws = null;

  try { odyssey?.endStream(); } catch { /* ignore */ }
  try { odyssey?.disconnect(); } catch { /* ignore */ }
  odyssey = null;

  if (odysseyLeaseId) {
    fetch('/api/odyssey/release', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ leaseId: odysseyLeaseId }) }).catch(() => undefined);
    odysseyLeaseId = null;
  }

  sessionReady = false; odysseyReady = false; micActive = false;
  pcmSent = 0; pcmRecv = 0; nextPlayAt = 0;
  updateStats();

  setBadge('gl-badge','disconnected',''); setBadge('gl-panel-badge','disconnected','');
  setBadge('ody-badge','disconnected',''); setBadge('ody-panel-badge','disconnected','');

  const video = document.getElementById('ody-video') as HTMLVideoElement;
  if (video) { video.srcObject = null; video.style.display = 'none'; }
  const ph = document.getElementById('video-placeholder') as HTMLElement;
  if (ph) ph.style.display = 'flex';

  btn('btn-connect').disabled = false;
  btn('btn-mic').disabled = true;
  btn('btn-disconnect').disabled = true;
  btn('btn-mic').textContent = 'Start Mic';
  log('gl','ok','Disconnected'); log('ody','ok','Disconnected');
}

// ── Connect ───────────────────────────────────────────────────────────────────
async function doConnect() {
  const charId = (document.getElementById('char-sel') as HTMLSelectElement).value;
  const char = CHAR_CONFIG[charId];

  btn('btn-connect').disabled = true;
  currentChar = char;
  log('gl','info',`Starting — character: ${charId} (${char.chatName})`);
  log('ody','info',`Starting — character: ${charId}`);

  // ⚠️ Create BOTH AudioContexts here, inside the user gesture click.
  // Browsers suspend AudioContexts created outside user gestures → onaudioprocess never fires.
  captureCtx = new AudioContext({ sampleRate: 16000 });
  captureCtx.resume().catch(() => undefined);
  playCtx = new AudioContext({ sampleRate: 24000 });
  playCtx.resume().catch(() => undefined);
  log('gl','info',`AudioContexts created — capture: ${captureCtx.state}, play: ${playCtx.state}`);

  // Fetch both tokens in parallel
  let apiKey: string;
  let odyCredentials: ReturnType<typeof credentialsFromDict>;
  try {
    const [glRes, odyRes] = await Promise.all([
      fetch('/api/gemini-live-token', { method: 'POST' }),
      fetch('/api/odyssey/token'),
    ]);
    if (!glRes.ok) throw new Error(`Gemini token ${glRes.status}`);
    if (!odyRes.ok) throw new Error(`Odyssey token ${odyRes.status}`);
    const glData = await glRes.json() as { token?: string };
    const odyData = await odyRes.json() as { credentials?: unknown; leaseId?: string };
    if (!glData.token) throw new Error('Empty Gemini token');
    if (!odyData.credentials) throw new Error('Empty Odyssey credentials');
    apiKey = glData.token;
    odyCredentials = credentialsFromDict(odyData.credentials as Parameters<typeof credentialsFromDict>[0]);
    odysseyLeaseId = odyData.leaseId ?? null;
    log('gl','ok',`Gemini API key (len=${apiKey.length})`);
    log('ody','ok',`Odyssey credentials OK — lease: ${odysseyLeaseId ?? 'none'}`);
  } catch (err) {
    log('gl','err',`Token fetch failed: ${(err as Error).message}`);
    setBadge('gl-badge','error','err'); setBadge('ody-badge','error','err');
    btn('btn-connect').disabled = false;
    return;
  }

  // ── Odyssey: connect, then startStream with image (same as App.tsx) ────────
  try {
    odyssey = new Odyssey({});
    setBadge('ody-badge','connecting…','mid'); setBadge('ody-panel-badge','connecting…','mid');

    await odyssey.connectWithCredentials(odyCredentials, {
      onConnected: async (stream) => {
        log('ody','ok','✓ onConnected — video stream received');
        setBadge('ody-badge','connected','ok'); setBadge('ody-panel-badge','connected','ok');

        const video = document.getElementById('ody-video') as HTMLVideoElement;
        const ph = document.getElementById('video-placeholder') as HTMLElement;
        video.srcObject = stream;
        ph.style.display = 'none';
        video.style.display = 'block';
        video.play().catch((e: unknown) => {
          log('ody','warn',`video.play: ${(e as Error).name} — retrying`);
          setTimeout(() => video.play().catch(() => undefined), 150);
        });

        // Try with image first (same as App.tsx); fall back without if model rejects it
        log('ody','info','Calling startStream…');
        try {
          const res = await fetch(char.image);
          const blob = await res.blob();
          const imgFile = new File([blob], `${charId}.png`, { type: blob.type || 'image/png' });
          await odyssey!.startStream({ prompt: 'Animate it', image: imgFile });
          log('ody','ok','✓ startStream (with image) resolved');
        } catch (imgErr) {
          log('ody','warn',`startStream with image failed: ${(imgErr as Error).message}`);
          log('ody','info','Retrying startStream without image…');
          try {
            await odyssey!.startStream({ prompt: 'Animate it' });
            log('ody','ok','✓ startStream (no image) resolved');
          } catch (err2) {
            log('ody','err',`startStream failed: ${(err2 as Error).message}`);
          }
        }
      },
      onStatusChange: (status) => {
        log('ody','info',`status → ${status}`);
        if (status !== 'connected') { setBadge('ody-badge', status, 'mid'); setBadge('ody-panel-badge', status, 'mid'); }
      },
      onStreamStarted: () => {
        odysseyReady = true;
        log('ody','ok','✓ onStreamStarted — avatar is live, ready to receive interact() calls');
      },
      onStreamEnded:  () => { odysseyReady = false; log('ody','warn','onStreamEnded'); },
      onStreamError:  (r, m) => { log('ody','err',`onStreamError: ${r} — ${m}`); },
      onError:        (e) => { log('ody','err',`onError: ${e.message}`); },
    });
  } catch (err) {
    log('ody','err',`connectWithCredentials failed: ${(err as Error).message}`);
  }

  // ── Gemini Live WebSocket ─────────────────────────────────────────────────
  setBadge('gl-badge','connecting…','mid'); setBadge('gl-panel-badge','connecting…','mid');
  log('gl','info','Opening WebSocket to Gemini Live…');

  ws = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`
  );

  ws.onopen = () => {
    log('gl','ok','WS open → sending setup');
    setBadge('gl-badge','setup…','mid');
    ws!.send(JSON.stringify({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          // Request transcription of user's audio — comes back as inputTranscription
          inputAudioTranscription: {},
        },
        systemInstruction: { parts: [{ text: char.sysPrompt }] },
      },
    }));
  };

  ws.onmessage = async (event) => {
    const text: string = event.data instanceof Blob ? await (event.data as Blob).text() : event.data as string;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }

    // ── setupComplete ─────────────────────────────────────────────────────
    if (msg.setupComplete !== undefined) {
      log('gl','ok','✓ setupComplete — Gemini session ready');
      log('gl','info','Flow: Mic → 16kHz PCM → Gemini → 24kHz PCM → Speaker + transcript → Odyssey');
      setBadge('gl-badge','ready','ok'); setBadge('gl-panel-badge','ready','ok');
      sessionReady = true;
      btn('btn-mic').disabled = false;
      btn('btn-disconnect').disabled = false;
      return;
    }

    if (msg.goAway !== undefined) { log('gl','warn','goAway — disconnecting'); doDisconnect(); return; }

    const content = msg.serverContent as Record<string, unknown> | undefined;
    if (!content) return;

    // ── Audio from Gemini → speaker ────────────────────────────────────────
    const parts = ((content.modelTurn as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>;
    for (const part of parts) {
      const id = part.inlineData as Record<string, string> | undefined;
      if (id?.mimeType?.startsWith('audio/pcm')) {
        pcmRecv++;
        if (pcmRecv === 1) log('gl','audio','First audio chunk from Gemini → playing back');
        if (pcmRecv % 10 === 0) { log('gl','audio',`Audio chunk #${pcmRecv}`); updateStats(); }
        playPCMChunk(id.data);
      }
    }

    // ── Barge-in ───────────────────────────────────────────────────────────
    if (content.interrupted) {
      log('gl','warn','Barge-in — resetting playback');
      nextPlayAt = 0;
    }

    // ── User input transcript → /api/character/chat → Odyssey action ──────
    // inputTranscription = what the USER said (requires inputAudioTranscription:{} in setup)
    const inputTranscript = (content.inputTranscription as Record<string, string> | undefined)?.text;
    if (inputTranscript) {
      log('transcript','tscript',`User said: "${inputTranscript}"`);
      log('transcript','info',`→ calling /api/character/chat to get Odyssey action…`);
      if (odysseyReady && odyssey) {
        getOdysseyAction(inputTranscript, currentChar.chatName)
          .then((action) => {
            log('transcript','ok',`→ odyssey.interact("${action}")`);
            try { odyssey!.interact({ prompt: action }); } catch (e) { log('transcript','err',`interact() failed: ${(e as Error).message}`); }
          })
          .catch((err) => log('transcript','err',`chat API failed: ${(err as Error).message}`));
      } else {
        log('transcript','warn',`odysseyReady=${odysseyReady} — skipping interact()`);
      }
    }

    if (content.turnComplete) log('gl','ok','Turn complete');
  };

  ws.onerror = () => {
    log('gl','err','WS error');
    setBadge('gl-badge','error','err'); setBadge('gl-panel-badge','error','err');
  };
  ws.onclose = (e) => {
    log('gl', e.code === 1000 ? 'ok' : 'err', `WS closed code=${e.code} reason="${e.reason||'(none)'}"`);
    if (e.code !== 1000) {
      const hints: Record<number, string> = { 1007:'bad setup format', 1008:'API key or plan restriction', 1003:'model not supported' };
      if (hints[e.code]) log('gl','warn',`Hint: ${hints[e.code]}`);
    }
    setBadge('gl-badge','disconnected',''); setBadge('gl-panel-badge','disconnected','');
    sessionReady = false; ws = null;
    btn('btn-mic').disabled = true;
    btn('btn-connect').disabled = false;
  };
}

// ── Mic toggle ────────────────────────────────────────────────────────────────
async function doToggleMic() {
  if (micActive) { stopMic(); btn('btn-mic').textContent = 'Start Mic'; }
  else { await startMic(); if (micActive) btn('btn-mic').textContent = 'Stop Mic'; }
}

function clearLogs() {
  ['gl-log','ody-log','transcript-log'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
}

// ── Expose to HTML ────────────────────────────────────────────────────────────
declare global {
  interface Window { doConnect: () => void; doToggleMic: () => void; doDisconnect: () => void; clearLogs: () => void; }
}
window.doConnect = doConnect;
window.doToggleMic = doToggleMic;
window.doDisconnect = doDisconnect;
window.clearLogs = clearLogs;
