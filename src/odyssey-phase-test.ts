/**
 * Odyssey Phase Timing Test
 *
 * Tests different Phase 2 trigger strategies for odyssey.interact() to find
 * the best balance between latency and accuracy for object placement.
 *
 * Modes tested:
 *   A — first outputTranscription chunk  (fastest, least context)
 *   B — 10-word threshold
 *   C — 15-word threshold
 *   D — 20-word threshold
 *   E — 30-word threshold
 *   F — turnComplete only              (slowest, most accurate)
 *   G — double fire: 15 words + turnComplete (tests scene corruption)
 *
 * Each turn is recorded in the results table with timing deltas and
 * can be exported as JSON to share with Odyssey.
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
let odysseyReady = false;

// ── Per-turn timing state ─────────────────────────────────────────────────────
let currentUserText = '';
let outputTranscriptBuffer = '';
let phase2Fired = false;
let tSpeechStart = 0;    // timestamp of first outputTranscription chunk
let tTurnComplete = 0;   // timestamp of turnComplete
let tPhase2Call = 0;     // timestamp when interact() was called for phase 2

// ── Result records ────────────────────────────────────────────────────────────
interface TurnResult {
  turn: number;
  mode: string;
  userText: string;
  phase2Prompt: string;
  wordsAtFire: number;
  msAfterSpeechStart: number;   // tPhase2Call - tSpeechStart
  msBeforeTurnComplete: number; // tTurnComplete - tPhase2Call (negative = fired after)
  objectsReturned: string[];
  visualResult: string;         // filled in manually via table
  firedCount: number;           // how many times interact() was called this turn
}
let results: TurnResult[] = [];
let turnCounter = 0;
let currentResult: Partial<TurnResult> | null = null;

// ── Characters ────────────────────────────────────────────────────────────────
const CHAR_CONFIG: Record<string, { sysPrompt: string; chatName: string }> = {
  einstein:   { chatName: 'Albert Einstein', sysPrompt: 'You are Albert Einstein. Curious, imaginative, dry wit. Keep replies under 40 words.' },
  alexander:  { chatName: 'Alexander',        sysPrompt: 'You are Alexander the Great. Bold, strategic, inspiring. Keep replies under 40 words.' },
  cleopatra:  { chatName: 'Cleopatra',        sysPrompt: 'You are Cleopatra. Regal, intelligent, commanding. Keep replies under 40 words.' },
  'da-vinci': { chatName: 'Da Vinci',         sysPrompt: 'You are Leonardo da Vinci. Creative, curious, inventive. Keep replies under 40 words.' },
};

let currentChar = CHAR_CONFIG['einstein'];

// ── Mode helpers ──────────────────────────────────────────────────────────────
function getMode(): string {
  return (document.getElementById('mode-sel') as HTMLSelectElement).value;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    'first-chunk':  'A: first-chunk',
    'words-10':     'B: 10 words',
    'words-15':     'C: 15 words',
    'words-20':     'D: 20 words',
    'words-30':     'E: 30 words',
    'turn-complete':'F: turnComplete',
    'double-fire':  'G: double-fire',
  };
  return labels[mode] ?? mode;
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
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function setBadge(id: string, txt: string, cls: string) {
  document.querySelectorAll(`#${id}`).forEach(el => { el.textContent = txt; el.className = `badge ${cls}`; });
}
function updateStats() {
  const el = document.getElementById('stats');
  if (el) el.textContent = `Mic→Gemini: ${pcmSent} chunks | Gemini→Speaker: ${pcmRecv} chunks`;
}
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;

// ── Results table ─────────────────────────────────────────────────────────────
function addResultRow(r: TurnResult) {
  const tbody = document.getElementById('results-body')!;
  const msAfter = r.msAfterSpeechStart;
  const msBefore = r.msBeforeTurnComplete;
  const visualClass = msBefore > 500 ? 'hit' : msBefore > 0 ? 'late' : 'miss';

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${r.turn}</td>
    <td><span class="mode-pill">${esc(r.mode)}</span></td>
    <td style="max-width:120px;word-break:break-word">${esc(r.userText.slice(0, 60))}${r.userText.length > 60 ? '…' : ''}</td>
    <td style="max-width:160px;word-break:break-word">${esc(r.phase2Prompt.slice(0, 80))}…</td>
    <td>${r.wordsAtFire}</td>
    <td class="${msAfter < 300 ? 'hit' : msAfter < 800 ? 'late' : 'miss'}">${msAfter}ms</td>
    <td class="${visualClass}">${msBefore > 0 ? '+' : ''}${msBefore}ms</td>
    <td>${esc(r.objectsReturned.join(', ') || '—')}</td>
    <td class="${r.firedCount > 1 ? 'warn' : ''}">${r.firedCount > 1 ? `${r.firedCount}x fires` : '1x fire'}</td>
    <td><input class="note-input" placeholder="type observation…" /></td>
  `;
  tbody.appendChild(tr);
  tbody.scrollTop = tbody.scrollHeight;
}

// ── Phase 2 — the core under test ─────────────────────────────────────────────
function firePhase2(triggerLabel: string) {
  if (!odysseyReady || !odyssey) return;
  const userText = currentUserText;
  const partialResponse = outputTranscriptBuffer;
  const words = wordCount(partialResponse);
  const now = Date.now();
  if (tPhase2Call === 0) tPhase2Call = now; // record first fire time

  const message = `User asked: "${userText}". You responded: "${partialResponse}". Based on this, what objects should appear in the scene?`;

  log('transcript', 'phase2', `[Phase 2 — ${triggerLabel}] words: ${words} | firing LLM call`);
  if (currentResult) {
    currentResult.phase2Prompt = message;
    currentResult.wordsAtFire = words;
    currentResult.msAfterSpeechStart = tSpeechStart ? now - tSpeechStart : -1;
    currentResult.firedCount = (currentResult.firedCount ?? 0) + 1;
  }

  fetch('/api/character/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, character: currentChar.chatName, history: [] }),
  })
    .then(r => r.ok ? r.json() as Promise<{ objects?: string[] }> : Promise.reject(new Error(`${r.status}`)))
    .then((data) => {
      const objects = data.objects?.filter(Boolean) ?? [];
      const prompt = objects.length ? `add ${objects.join(', ')} to the scene` : '';
      log('transcript', 'phase2', `[Phase 2] LLM returned objects: [${objects.join(', ') || 'none'}]`);
      if (currentResult) currentResult.objectsReturned = [...(currentResult.objectsReturned ?? []), ...objects];
      if (prompt && odyssey) {
        log('transcript', 'ok', `[Phase 2] odyssey.interact("${prompt}")`);
        try { odyssey.interact({ prompt }); } catch { /* ignore */ }
      }
    })
    .catch(err => log('transcript', 'err', `[Phase 2] failed: ${(err as Error).message}`));
}

// Called each time an outputTranscription chunk arrives
function onOutputChunk() {
  const mode = getMode();
  const words = wordCount(outputTranscriptBuffer);

  if (tSpeechStart === 0) tSpeechStart = Date.now();

  // Mode A: first chunk
  if (mode === 'first-chunk' && !phase2Fired) {
    phase2Fired = true;
    firePhase2('first-chunk');
    return;
  }

  // Modes B-E: word threshold
  const thresholds: Record<string, number> = { 'words-10': 10, 'words-15': 15, 'words-20': 20, 'words-30': 30 };
  const threshold = thresholds[mode];
  if (threshold && !phase2Fired && words >= threshold) {
    phase2Fired = true;
    firePhase2(`${words}-words`);
    return;
  }

  // Mode G: double fire — 15 words first fire
  if (mode === 'double-fire' && !phase2Fired && words >= 15) {
    phase2Fired = true;
    firePhase2('double-fire:first@15words');
  }
}

// Called at turnComplete
function onTurnComplete() {
  const mode = getMode();
  tTurnComplete = Date.now();

  // Mode F: turnComplete only
  if (mode === 'turn-complete') {
    firePhase2('turnComplete');
  }

  // Mode G: second fire at turnComplete
  if (mode === 'double-fire') {
    firePhase2('double-fire:second@turnComplete');
  }

  // Record timing and push result row
  if (currentResult) {
    currentResult.msBeforeTurnComplete = tTurnComplete - tPhase2Call; // positive = fired before complete, negative = after
    const r = currentResult as TurnResult;
    results.push(r);
    addResultRow(r);
    log('transcript', 'timing', `[Turn ${r.turn}] Phase2 fired ${r.msAfterSpeechStart}ms after speech start, ${r.msBeforeTurnComplete}ms before turnComplete`);
  }
  currentResult = null;
}

// ── Phase 1: immediate listening gesture ──────────────────────────────────────
function firePhase1() {
  if (!odysseyReady || !odyssey) return;
  log('transcript', 'phase1', '[Phase 1] odyssey.interact("listen actively")');
  try { odyssey.interact({ prompt: 'listen actively' }); } catch { /* ignore */ }
}

// ── Audio ─────────────────────────────────────────────────────────────────────
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
  if (!sessionReady || !ws || !captureCtx) { log('gl', 'err', 'Not ready'); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (captureCtx.state === 'suspended') await captureCtx.resume();
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
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: arrayBufferToBase64(i16.buffer), mimeType: 'audio/pcm;rate=16000' } } }));
      pcmSent++;
      if (pcmSent % 8 === 0) updateStats();
    };
    src.connect(scriptNode);
    scriptNode.connect(captureCtx.destination);
    micActive = true;
    log('gl', 'ok', '✓ Mic streaming → Gemini Live');
  } catch (err) {
    log('gl', 'err', `Mic: ${(err as Error).message}`);
  }
}

function stopMic() {
  if (scriptNode) { scriptNode.disconnect(); scriptNode.onaudioprocess = null; scriptNode = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  micActive = false;
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
    fetch('/api/odyssey/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId: odysseyLeaseId }) }).catch(() => undefined);
    odysseyLeaseId = null;
  }
  sessionReady = false; odysseyReady = false; micActive = false;
  pcmSent = 0; pcmRecv = 0; nextPlayAt = 0;
  updateStats();
  setBadge('gl-badge', 'gl: disconnected', ''); setBadge('gl-panel-badge', 'disconnected', '');
  setBadge('ody-badge', 'ody: disconnected', ''); setBadge('ody-panel-badge', 'disconnected', '');
  const video = document.getElementById('ody-video') as HTMLVideoElement;
  if (video) { video.srcObject = null; video.style.display = 'none'; }
  const ph = document.getElementById('video-placeholder') as HTMLElement;
  if (ph) ph.style.display = 'flex';
  btn('btn-connect').disabled = false;
  btn('btn-mic').disabled = true;
  btn('btn-disconnect').disabled = true;
  btn('btn-mic').textContent = 'Start Mic';
}

// ── Connect ───────────────────────────────────────────────────────────────────
async function doConnect() {
  const charId = (document.getElementById('char-sel') as HTMLSelectElement).value;
  currentChar = CHAR_CONFIG[charId];
  btn('btn-connect').disabled = true;
  log('gl', 'info', `Connecting — char: ${charId} | mode: ${modeLabel(getMode())}`);

  // Create both AudioContexts inside user gesture
  captureCtx = new AudioContext({ sampleRate: 16000 });
  captureCtx.resume().catch(() => undefined);
  playCtx = new AudioContext({ sampleRate: 24000 });
  playCtx.resume().catch(() => undefined);

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
    log('gl', 'ok', `Tokens OK`);
  } catch (err) {
    log('gl', 'err', `Token fetch failed: ${(err as Error).message}`);
    btn('btn-connect').disabled = false;
    return;
  }

  // ── Odyssey ───────────────────────────────────────────────────────────────
  try {
    odyssey = new Odyssey({});
    // Workaround: connectWithCredentials drops capabilities — force i2v true
    (odyssey as unknown as { capabilities: { image_to_video: boolean } }).capabilities.image_to_video = true;
    setBadge('ody-badge', 'ody: connecting…', 'mid');

    await odyssey.connectWithCredentials(odyCredentials, {
      onConnected: async (stream) => {
        log('ody', 'ok', '✓ onConnected');
        setBadge('ody-badge', 'ody: connected', 'ok'); setBadge('ody-panel-badge', 'connected', 'ok');
        const video = document.getElementById('ody-video') as HTMLVideoElement;
        const ph = document.getElementById('video-placeholder') as HTMLElement;
        video.srcObject = stream;
        ph.style.display = 'none';
        video.style.display = 'block';
        video.play().catch(() => setTimeout(() => video.play().catch(() => undefined), 150));
        try {
          await odyssey!.startStream({ prompt: 'Animate it' });
          log('ody', 'ok', '✓ startStream resolved');
        } catch (err) {
          log('ody', 'err', `startStream failed: ${(err as Error).message}`);
        }
      },
      onStatusChange: (status) => {
        if (status !== 'connected') { setBadge('ody-badge', `ody: ${status}`, 'mid'); setBadge('ody-panel-badge', status, 'mid'); }
      },
      onStreamStarted: () => {
        odysseyReady = true;
        log('ody', 'ok', '✓ onStreamStarted — ready');
      },
      onStreamEnded:  () => { odysseyReady = false; log('ody', 'warn', 'onStreamEnded'); },
      onStreamError:  (r, m) => log('ody', 'err', `onStreamError: ${r} — ${m}`),
      onError:        (e) => log('ody', 'err', `onError: ${e.message}`),
    });
  } catch (err) {
    log('ody', 'err', `connectWithCredentials failed: ${(err as Error).message}`);
  }

  // ── Gemini Live WebSocket ─────────────────────────────────────────────────
  setBadge('gl-badge', 'gl: connecting…', 'mid');
  ws = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`
  );

  ws.onopen = () => {
    log('gl', 'ok', 'WS open → sending setup');
    ws!.send(JSON.stringify({
      setup: {
        model: 'models/gemini-3.1-flash-live-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
        systemInstruction: { parts: [{ text: currentChar.sysPrompt }] },
      },
    }));
  };

  ws.onmessage = async (event) => {
    const text: string = event.data instanceof Blob ? await (event.data as Blob).text() : event.data as string;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }

    if (msg.setupComplete !== undefined) {
      log('gl', 'ok', '✓ setupComplete');
      setBadge('gl-badge', 'gl: ready', 'ok'); setBadge('gl-panel-badge', 'ready', 'ok');
      sessionReady = true;
      btn('btn-mic').disabled = false;
      btn('btn-disconnect').disabled = false;
      return;
    }

    if (msg.goAway !== undefined) { doDisconnect(); return; }

    const content = msg.serverContent as Record<string, unknown> | undefined;
    if (!content) return;

    // Barge-in
    if (content.interrupted) {
      nextPlayAt = 0;
      outputTranscriptBuffer = '';
      phase2Fired = false;
      tSpeechStart = 0; tPhase2Call = 0;
      currentResult = null;
      log('gl', 'warn', 'Barge-in — buffers reset');
      return;
    }

    // Audio playback
    const parts = ((content.modelTurn as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>;
    for (const part of parts) {
      const id = part.inlineData as Record<string, string> | undefined;
      if (id?.mimeType?.startsWith('audio/pcm')) {
        pcmRecv++;
        if (pcmRecv % 10 === 0) updateStats();
        playPCMChunk(id.data);
      }
    }

    // Phase 1: inputTranscription → immediate gesture
    const inputTranscript = (content.inputTranscription as Record<string, string> | undefined)?.text;
    if (inputTranscript) {
      currentUserText = inputTranscript;
      outputTranscriptBuffer = '';
      phase2Fired = false;
      tSpeechStart = 0; tPhase2Call = 0; tTurnComplete = 0;
      turnCounter++;
      currentResult = {
        turn: turnCounter,
        mode: modeLabel(getMode()),
        userText: inputTranscript,
        phase2Prompt: '',
        wordsAtFire: 0,
        msAfterSpeechStart: -1,
        msBeforeTurnComplete: 0,
        objectsReturned: [],
        visualResult: '',
        firedCount: 0,
      };
      log('transcript', 'tscript', `[Turn ${turnCounter}] User: "${inputTranscript}"`);
      log('transcript', 'info', `[Mode: ${modeLabel(getMode())}]`);
      firePhase1();
    }

    // outputTranscription accumulation + Phase 2 trigger
    const outputTranscript = (content.outputTranscription as Record<string, string> | undefined)?.text;
    if (outputTranscript) {
      outputTranscriptBuffer += (outputTranscriptBuffer ? ' ' : '') + outputTranscript;
      log('transcript', 'tscript', `[Gemini] "${outputTranscript}" (${wordCount(outputTranscriptBuffer)} words total)`);
      onOutputChunk();
    }

    // turnComplete
    if (content.turnComplete) {
      log('gl', 'ok', `turnComplete — full response: "${outputTranscriptBuffer}"`);
      onTurnComplete();
      outputTranscriptBuffer = '';
      phase2Fired = false;
      tSpeechStart = 0; tPhase2Call = 0;
    }
  };

  ws.onerror = () => log('gl', 'err', 'WS error');
  ws.onclose = (e) => {
    log('gl', e.code === 1000 ? 'ok' : 'err', `WS closed code=${e.code} reason="${e.reason || '(none)'}"`);
    setBadge('gl-badge', 'gl: disconnected', ''); setBadge('gl-panel-badge', 'disconnected', '');
    sessionReady = false; ws = null;
    btn('btn-mic').disabled = true;
    btn('btn-connect').disabled = false;
  };
}

// ── Controls ──────────────────────────────────────────────────────────────────
async function doToggleMic() {
  if (micActive) { stopMic(); btn('btn-mic').textContent = 'Start Mic'; }
  else { await startMic(); if (micActive) btn('btn-mic').textContent = 'Stop Mic'; }
}

function clearLogs() {
  ['gl-log', 'ody-log', 'transcript-log'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

function clearResults() {
  const tbody = document.getElementById('results-body');
  if (tbody) tbody.innerHTML = '';
  results = [];
  turnCounter = 0;
}

function exportResults() {
  // Collect manual notes from the table before exporting
  const rows = document.querySelectorAll('#results-body tr');
  rows.forEach((row, i) => {
    const noteInput = row.querySelector<HTMLInputElement>('.note-input');
    if (noteInput && results[i]) results[i].visualResult = noteInput.value;
  });

  const payload = {
    exportedAt: new Date().toISOString(),
    description: 'Odyssey Phase 2 timing test — various trigger strategies for odyssey.interact()',
    modes: {
      'A: first-chunk':   'Fire on first outputTranscription chunk',
      'B: 10 words':      'Fire when buffer reaches 10 words',
      'C: 15 words':      'Fire when buffer reaches 15 words',
      'D: 20 words':      'Fire when buffer reaches 20 words',
      'E: 30 words':      'Fire when buffer reaches 30 words',
      'F: turnComplete':  'Fire only after Gemini finishes speaking',
      'G: double-fire':   'Fire at 15 words + again at turnComplete (corruption test)',
    },
    columns: {
      msAfterSpeechStart:  'Milliseconds between first outputTranscription chunk and interact() call',
      msBeforeTurnComplete:'Milliseconds between interact() call and turnComplete (positive = fired before turn ended)',
      wordsAtFire:         'Word count of accumulated transcript at time of interact() call',
      objectsReturned:     'Objects the LLM suggested to add to the scene',
      visualResult:        'Manual observation of what appeared on screen',
      firedCount:          'Number of times interact() was called this turn (> 1 = corruption test)',
    },
    results,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `odyssey-phase-test-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Expose to HTML ────────────────────────────────────────────────────────────
declare global {
  interface Window {
    doConnect: () => void;
    doToggleMic: () => void;
    doDisconnect: () => void;
    clearLogs: () => void;
    clearResults: () => void;
    exportResults: () => void;
  }
}
window.doConnect = doConnect;
window.doToggleMic = doToggleMic;
window.doDisconnect = doDisconnect;
window.clearLogs = clearLogs;
window.clearResults = clearResults;
window.exportResults = exportResults;
