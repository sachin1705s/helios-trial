import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { supabase } from '../../lib/supabase';
import { AtriumNav, AtriumFooter } from '../../demo/atrium/Layout';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';
import './CustomCharacterExperiment.css';

type Step = 'setup' | 'live';
type VoiceMode = 'preset-male' | 'preset-female' | 'clone';
type CloneSource = 'upload' | 'record';

// Smallest.ai preset voice IDs — same provider used by every other character on the site.
// `magnus` is the platform default fallback (see server/api/character/tts).
const PRESET_VOICES: Record<Exclude<VoiceMode, 'clone'>, { id: string; label: string }> = {
  'preset-male':   { id: 'magnus', label: 'Male voice' },
  'preset-female': { id: 'aanya',  label: 'Female voice' },
};

// Vercel serverless functions cap request bodies around 4.5 MB. Reject anything
// bigger client-side so users get a clear message instead of a network failure.
const VOICE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

// Voice clones with under ~15s of audio are unreliable — Smallest itself recommends
// 15–30s. Enforce that as a hard floor for live recordings.
const MIN_RECORD_SECONDS = 15;
const MAX_RECORD_SECONDS = 60;

function formatSeconds(n: number): string {
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Downscale + recompress a photo so it fits under `maxBytes`. Returns the
 * original file unchanged if it's already small enough. Walks resolution and
 * JPEG quality down in steps until it fits, so iPhone HEIC exports and
 * 50-megapixel originals end up as something Gemini can actually ingest.
 */
async function compressImage(file: File, maxBytes: number): Promise<File> {
  if (file.size <= maxBytes) return file;

  const url = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not decode image — try a different file.'));
      i.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  for (const maxDim of [1536, 1280, 1024, 768]) {
    const scale = Math.min(1, maxDim / longest);
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Browser cannot resize images here.');
    ctx.drawImage(img, 0, 0, w, h);

    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
      if (blob && blob.size <= maxBytes) {
        const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
        return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
      }
    }
  }
  throw new Error('Photo is too large to compress automatically. Resize it to under 4 MB and try again.');
}

export default function CustomCharacterExperiment() {
  const navigate = useNavigate();
  const { status, videoRef, startStream, interact, disconnect, connect } = useOdysseyStream({ autoConnect: false });

  const [step, setStep] = useState<Step>('setup');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [originalImageFile, setOriginalImageFile] = useState<File | null>(null);
  const [framing, setFraming] = useState<'full' | 'headshot'>('headshot');
  const [cloneStatus, setCloneStatus] = useState<'idle' | 'cloning' | 'done' | 'error'>('idle');
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [characterName, setCharacterName] = useState('');
  const [characterDesc, setCharacterDesc] = useState('');

  // Voice selection — default to the male preset so users aren't blocked if cloning fails.
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('preset-male');
  const [cloneSource, setCloneSource] = useState<CloneSource>('record');
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceCloneId, setVoiceCloneId] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'cloning' | 'done' | 'error'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Live recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartAtRef = useRef<number>(0);
  const recordMaxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolved voice id that will speak as the character — cloned (if successful) or a preset.
  const resolvedVoiceId =
    voiceMode === 'clone' && voiceCloneId ? voiceCloneId
      : voiceMode === 'preset-female' ? PRESET_VOICES['preset-female'].id
        : PRESET_VOICES['preset-male'].id;

  const [imageInfo, setImageInfo] = useState<string | null>(null);

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const [promptText, setPromptText] = useState('');

  // ── Voice loop (STT → LLM → TTS via Smallest) ─────────────────────────────
  // The whole point of the custom-character flow is to use Smallest's voice
  // (preset or cloned) instead of Gemini Live's locked voices. Pipeline:
  //   mic → /api/character/stt → /api/character/chat → /api/character/tts → AudioContext PCM playback
  type VoiceLoopState = 'idle' | 'listening' | 'thinking' | 'speaking';
  const [voiceLoop, setVoiceLoop] = useState<VoiceLoopState>('idle');
  const [voiceLoopError, setVoiceLoopError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);

  const ttsAudioCtxRef = useRef<AudioContext | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const voiceLoopGenRef = useRef(0); // bumped on cancel/cleanup so in-flight steps bail
  const voiceMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceMediaStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const voiceInputRef = useRef<HTMLInputElement | null>(null);

  // ── Image / character ──────────────────────────────────────────────────────
  const handleImagePick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setCloneStatus('error');
      setCloneError('That file is not an image. Pick a JPG, PNG, or HEIC photo.');
      input.value = '';
      return;
    }
    setCloneError(null);
    setCloneStatus('idle');
    setImageInfo(null);
    try {
      const processed = await compressImage(file, IMAGE_MAX_BYTES);
      setOriginalImageFile(processed);
      setImageFile(processed);
      setImagePreview(URL.createObjectURL(processed));
      if (processed !== file) {
        setImageInfo(`Auto-resized your ${formatMB(file.size)} photo to ${formatMB(processed.size)} so it fits the upload limit.`);
      }
    } catch (err) {
      setCloneStatus('error');
      setCloneError(err instanceof Error ? err.message : 'Could not process that photo.');
      input.value = '';
    }
  }, []);

  const cloneCharacter = useCallback(async () => {
    const source = originalImageFile ?? imageFile;
    if (!source) {
      setCloneError('Upload a photo first.');
      setCloneStatus('error');
      return;
    }
    // Defensive: should never trigger because handleImagePick already
    // compresses, but keep the guard so we never send something we know
    // the server cannot accept.
    if (source.size > IMAGE_MAX_BYTES) {
      setCloneStatus('error');
      setCloneError(`That photo is ${formatMB(source.size)} — over the ${IMAGE_MAX_BYTES / 1024 / 1024} MB upload limit. Pick a smaller file.`);
      return;
    }
    setCloneStatus('cloning');
    setCloneError(null);
    const t0 = Date.now();
    try {
      const fd = new FormData();
      fd.append('image', source);
      fd.append('framing', framing);
      const res = await fetch('/api/character-clone', { method: 'POST', body: fd });
      let data: { imageBase64?: string; mimeType?: string; error?: string; details?: string; upstreamStatus?: number; aborted?: boolean } = {};
      try { data = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !data.imageBase64) {
        // Surface the server's actual message — it now includes upstreamStatus,
        // aborted, and elapsedMs so the user knows whether to retry, wait, or
        // pick a different photo.
        const detail = data.details ? ` — ${data.details.slice(0, 160)}` : '';
        const sizeMsg = res.status === 413 ? ' Your photo was rejected by the server as too large.' : '';
        throw new Error((data.error ?? `Character generation failed (HTTP ${res.status}).`) + sizeMsg + detail);
      }
      const mime = data.mimeType || 'image/png';
      const byteString = atob(data.imageBase64);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const cloned = new File([blob], `character-clone.${mime.includes('jpeg') ? 'jpg' : 'png'}`, { type: mime });
      setImageFile(cloned);
      setImagePreview(URL.createObjectURL(cloned));
      setCloneStatus('done');
      console.log('[character-clone] success in', Date.now() - t0, 'ms');
    } catch (err) {
      setCloneStatus('error');
      const elapsedSec = Math.round((Date.now() - t0) / 1000);
      const sizeMB = source.size / 1024 / 1024;
      const sizeNote = sizeMB >= 3
        ? ` Your photo is ${sizeMB.toFixed(1)} MB — Vercel may have rejected it at the edge (cap is ~4.5 MB). Try a smaller file.`
        : '';
      if (err instanceof TypeError) {
        // fetch threw — no HTTP response at all. We DON'T know what killed it
        // so we report what we do know (elapsed, online state, file size).
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setCloneError("You're offline. Reconnect to Wi-Fi or cellular and try again.");
        } else if (elapsedSec >= 55) {
          setCloneError(`The image service didn't respond before the request timed out (${elapsedSec}s). Wait a moment and try again — Gemini may be overloaded.${sizeNote}`);
        } else if (elapsedSec <= 5) {
          setCloneError(`The request was dropped before reaching the server (${elapsedSec}s, photo ${sizeMB.toFixed(1)} MB). Likely a network blip — try again.${sizeNote}`);
        } else {
          setCloneError(`The connection dropped while sending your ${sizeMB.toFixed(1)} MB photo (${elapsedSec}s). Try again, or check your network.${sizeNote}`);
        }
        console.warn('[character-clone] fetch failed:', { elapsedSec, sizeMB, online: typeof navigator !== 'undefined' ? navigator.onLine : null, err });
      } else {
        setCloneError(err instanceof Error ? err.message : 'Character generation failed.');
      }
    }
  }, [originalImageFile, imageFile, framing]);

  // ── Voice: file upload ─────────────────────────────────────────────────────
  const handleVoicePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    // Hard reject anything over the limit — don't let the user proceed thinking
    // they have a valid file when the upload will fail at the network edge.
    if (file.size > VOICE_MAX_BYTES) {
      setVoiceFile(null);
      setVoiceStatus('error');
      setVoiceError(`That file is ${formatMB(file.size)}. Audio uploads must be under ${VOICE_MAX_BYTES / 1024 / 1024} MB — try a shorter clip, or record one live below.`);
      input.value = '';
      return;
    }
    if (!file.type.startsWith('audio/')) {
      setVoiceFile(null);
      setVoiceStatus('error');
      setVoiceError('That file is not audio. Pick an MP3, WAV, M4A, or WebM clip.');
      input.value = '';
      return;
    }
    setVoiceFile(file);
    setVoiceCloneId(null);
    setVoiceStatus('idle');
    setVoiceError(null);
  }, []);

  // ── Voice: live recording ─────────────────────────────────────────────────
  const stopRecordingTracks = useCallback(() => {
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
    if (recordIntervalRef.current) { clearInterval(recordIntervalRef.current); recordIntervalRef.current = null; }
    if (recordMaxTimeoutRef.current) { clearTimeout(recordMaxTimeoutRef.current); recordMaxTimeoutRef.current = null; }
  }, []);

  const startRecording = useCallback(async () => {
    setVoiceError(null);
    setVoiceStatus('idle');
    setVoiceCloneId(null);
    setVoiceFile(null);
    setRecordSeconds(0);

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceError('Your browser does not support voice recording. Upload an audio file instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      // Pick the first supported mime type — Safari/Chrome differ on what MediaRecorder accepts.
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];

      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onstop = () => {
        stopRecordingTracks();
        const effectiveMime = mr.mimeType || mime || 'audio/webm';
        const ext = effectiveMime.includes('mp4') ? 'mp4' : effectiveMime.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(audioChunksRef.current, { type: effectiveMime });
        const file = new File([blob], `voice-recording.${ext}`, { type: effectiveMime });
        setVoiceFile(file);
        setIsRecording(false);
      };

      mr.start();
      recordStartAtRef.current = Date.now();
      setIsRecording(true);
      recordIntervalRef.current = setInterval(() => {
        setRecordSeconds(Math.floor((Date.now() - recordStartAtRef.current) / 1000));
      }, 250);
      // Auto-stop at the maximum so we don't blow past the size cap.
      recordMaxTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      }, MAX_RECORD_SECONDS * 1000);
    } catch (err) {
      stopRecordingTracks();
      setIsRecording(false);
      const msg = err instanceof Error ? err.message : String(err);
      if (/Permission|denied|NotAllowed/i.test(msg)) {
        setVoiceError('Microphone permission was denied. Allow it in your browser settings, or upload an audio file.');
      } else if (/NotFound|DevicesNotFound/i.test(msg)) {
        setVoiceError('No microphone found. Plug one in, or upload an audio file.');
      } else {
        setVoiceError(`Recording failed: ${msg}`);
      }
    }
  }, [stopRecordingTracks]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    } else {
      stopRecordingTracks();
      setIsRecording(false);
    }
  }, [stopRecordingTracks]);

  // Cleanup any in-flight recording when the component unmounts.
  useEffect(() => () => { stopRecordingTracks(); }, [stopRecordingTracks]);

  // ── Voice: send to /api/voice-clone ───────────────────────────────────────
  const cloneVoice = useCallback(async () => {
    if (!voiceFile) return;
    if (voiceFile.size > VOICE_MAX_BYTES) {
      setVoiceStatus('error');
      setVoiceError(`That clip is ${(voiceFile.size / 1024 / 1024).toFixed(1)} MB. Trim to under ${VOICE_MAX_BYTES / 1024 / 1024} MB or use a preset voice.`);
      return;
    }
    setVoiceStatus('cloning');
    setVoiceError(null);
    const t0 = Date.now();
    try {
      const fd = new FormData();
      fd.append('audio', voiceFile);
      fd.append('display_name', characterName || 'Custom Character');
      fd.append('provider', 'smallest');

      const sessionResult = await supabase?.auth.getSession();
      const token = sessionResult?.data.session?.access_token;
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

      let res: Response;
      try {
        res = await fetch('/api/voice-clone', { method: 'POST', headers, body: fd });
      } catch (networkErr) {
        setVoiceStatus('error');
        setVoiceError("Couldn't reach the voice service. Pick a preset voice, or try again in a moment.");
        if (voiceMode === 'clone') setVoiceMode('preset-male');
        console.warn('[voice-clone] network error after', Date.now() - t0, 'ms:', networkErr);
        return;
      }

      let data: { voiceId?: string; error?: string; details?: string } = {};
      try { data = await res.json(); } catch { /* non-JSON */ }

      if (!res.ok || !data.voiceId) {
        const detail = data.details ? ` — ${data.details.slice(0, 160)}` : '';
        const sizeMsg = res.status === 413 ? ' (file too large)' : '';
        throw new Error((data.error ?? `Voice clone failed (HTTP ${res.status})${sizeMsg}`) + detail);
      }
      setVoiceCloneId(data.voiceId);
      setVoiceStatus('done');
      console.log('[voice-clone] success in', Date.now() - t0, 'ms — voiceId:', data.voiceId);
    } catch (err) {
      setVoiceStatus('error');
      setVoiceError(err instanceof Error ? err.message : 'Voice clone failed.');
    }
  }, [voiceFile, characterName, voiceMode]);

  const selectVoicePreset = useCallback((mode: VoiceMode) => {
    setVoiceMode(mode);
    if (mode !== 'clone') {
      setVoiceError(null);
      if (voiceStatus === 'error') setVoiceStatus('idle');
      // Also stop recording if it's running.
      if (isRecording) stopRecording();
    }
  }, [voiceStatus, isRecording, stopRecording]);

  // ── Build / live ───────────────────────────────────────────────────────────
  const buildCharacter = useCallback(async () => {
    if (!imageFile || !characterName.trim()) { setBuildError('Image and name are required.'); return; }
    setBuilding(true);
    setBuildError(null);
    await disconnect();
    void connect();
    setStep('live');
    setBuilding(false);
  }, [imageFile, characterName, disconnect, connect]);

  const hasStartedRef = useRef(false);
  const startLiveStream = useCallback(async () => {
    if (hasStartedRef.current || status !== 'ready' || !imageFile) return;
    hasStartedRef.current = true;
    const systemPrompt = [
      `You are ${characterName || 'a custom character'}.`,
      characterDesc ? `Personality: ${characterDesc}` : '',
      'Keep every reply under 30 words. Stay in character.',
    ].filter(Boolean).join(' ');
    console.log('[wear-the-character] voice id selected:', resolvedVoiceId, '(mode:', voiceMode, ')');
    await startStream({ image: imageFile, prompt: systemPrompt, portrait: true });
  }, [status, imageFile, characterName, characterDesc, startStream, resolvedVoiceId, voiceMode]);

  const startLiveRef = useRef(startLiveStream);
  startLiveRef.current = startLiveStream;
  if (step === 'live' && status === 'ready') void startLiveRef.current();

  // ── Voice loop helpers ────────────────────────────────────────────────────
  const stopAllSpeech = useCallback(() => {
    voiceLoopGenRef.current += 1; // invalidate any in-flight TTS / chat / STT
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    ttsSourceNodesRef.current.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
    ttsSourceNodesRef.current = [];
  }, []);

  const playPcmStream = useCallback(async (ttsRes: Response, gen: number): Promise<void> => {
    if (!ttsAudioCtxRef.current) ttsAudioCtxRef.current = new AudioContext();
    const ctx = ttsAudioCtxRef.current;
    await ctx.resume().catch(() => undefined);
    if (gen !== voiceLoopGenRef.current) return;
    const sampleRate = parseInt(ttsRes.headers.get('x-sample-rate') ?? '24000', 10);
    if (!ttsRes.body) throw new Error('TTS returned no audio body');
    const reader = ttsRes.body.getReader();
    let playbackTime = ctx.currentTime + 0.05;
    let leftover = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (gen !== voiceLoopGenRef.current) return;
      let data: Uint8Array;
      if (leftover.length > 0) {
        data = new Uint8Array(leftover.length + value.length);
        data.set(leftover);
        data.set(value, leftover.length);
      } else {
        data = value;
      }
      const usable = data.length - (data.length % 2);
      leftover = data.slice(usable);
      if (!usable) continue;
      const int16 = new Int16Array(data.buffer, data.byteOffset, usable / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
      const buf = ctx.createBuffer(1, float32.length, sampleRate);
      buf.copyToChannel(float32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      ttsSourceNodesRef.current.push(src);
      src.onended = () => { ttsSourceNodesRef.current = ttsSourceNodesRef.current.filter((n) => n !== src); };
      src.start(playbackTime);
      playbackTime += buf.duration;
    }
    // Wait for the scheduled tail to actually finish playing.
    const tailMs = Math.max(0, (playbackTime - ctx.currentTime) * 1000);
    await new Promise((r) => setTimeout(r, tailMs));
  }, []);

  const speakReply = useCallback(async (text: string, gen: number) => {
    if (!text || gen !== voiceLoopGenRef.current) return;
    setVoiceLoop('speaking');
    ttsAbortRef.current?.abort();
    const abort = new AbortController();
    ttsAbortRef.current = abort;
    try {
      const ttsRes = await fetch('/api/character/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId: resolvedVoiceId, character: characterName || 'Character' }),
        signal: abort.signal,
      });
      if (!ttsRes.ok) {
        let detail = ''; try { const j = await ttsRes.json(); detail = j?.details || j?.error || ''; } catch { /* non-JSON */ }
        throw new Error(`TTS HTTP ${ttsRes.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
      }
      await playPcmStream(ttsRes, gen);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      console.error('[character/tts] failed:', err);
      setVoiceLoopError(err instanceof Error ? err.message : 'Voice playback failed.');
    } finally {
      if (gen === voiceLoopGenRef.current) setVoiceLoop('idle');
    }
  }, [resolvedVoiceId, characterName, playPcmStream]);

  const runTurn = useCallback(async (userText: string) => {
    const text = userText.trim();
    if (!text) return;
    stopAllSpeech();
    const gen = voiceLoopGenRef.current;
    setVoiceLoopError(null);
    setVoiceLoop('thinking');
    setHistory((h) => [...h, { role: 'user', content: text }]);
    try {
      const chatRes = await fetch('/api/character/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          character: characterName || 'Character',
          // The chat endpoint appends `roleSlice` to the system prompt at the
          // very end — perfect injection point for our custom personality.
          roleSlice: characterDesc.trim() ? `You are ${characterName || 'Character'}. Personality: ${characterDesc.trim()}` : '',
          history: history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
        }),
      });
      if (gen !== voiceLoopGenRef.current) return;
      if (!chatRes.ok) {
        let detail = ''; try { const j = await chatRes.json(); detail = j?.details || j?.error || ''; } catch { /* non-JSON */ }
        throw new Error(`Chat HTTP ${chatRes.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
      }
      const data = await chatRes.json() as { reply?: string; error?: string };
      const reply = (data.reply || '').trim();
      if (!reply) throw new Error('No reply from the model.');
      setHistory((h) => [...h, { role: 'assistant', content: reply }]);
      await speakReply(reply, gen);
    } catch (err) {
      if (gen !== voiceLoopGenRef.current) return;
      setVoiceLoopError(err instanceof Error ? err.message : 'Chat failed.');
      setVoiceLoop('idle');
    }
  }, [characterName, characterDesc, history, speakReply, stopAllSpeech]);

  const stopRecordingTracksVoice = useCallback(() => {
    voiceMediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    voiceMediaStreamRef.current = null;
  }, []);

  const startMic = useCallback(async () => {
    if (voiceLoop === 'listening') return;
    setVoiceLoopError(null);
    stopAllSpeech();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceLoopError('Voice input is not supported in this browser. Type your message instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceMediaStreamRef.current = stream;
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      voiceMediaRecorderRef.current = mr;
      voiceChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) voiceChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stopRecordingTracksVoice();
        const effectiveMime = mr.mimeType || mime || 'audio/webm';
        const blob = new Blob(voiceChunksRef.current, { type: effectiveMime });
        if (blob.size < 1500) {
          // Less than ~50ms of audio — almost certainly an accidental tap.
          setVoiceLoop('idle');
          return;
        }
        const gen = voiceLoopGenRef.current;
        setVoiceLoop('thinking');
        try {
          const fd = new FormData();
          fd.append('audio', blob, `recording.${effectiveMime.includes('mp4') ? 'mp4' : effectiveMime.includes('ogg') ? 'ogg' : 'webm'}`);
          const sttRes = await fetch('/api/character/stt', { method: 'POST', body: fd });
          if (gen !== voiceLoopGenRef.current) return;
          if (!sttRes.ok) {
            let detail = ''; try { const j = await sttRes.json(); detail = j?.details || j?.error || ''; } catch { /* non-JSON */ }
            throw new Error(`STT HTTP ${sttRes.status}${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
          }
          const { text } = (await sttRes.json()) as { text?: string };
          const transcribed = (text || '').trim();
          if (!transcribed) {
            setVoiceLoop('idle');
            setVoiceLoopError("Didn't catch that. Try again — speak a bit louder or closer to the mic.");
            return;
          }
          await runTurn(transcribed);
        } catch (err) {
          if (gen !== voiceLoopGenRef.current) return;
          setVoiceLoopError(err instanceof Error ? err.message : 'Transcription failed.');
          setVoiceLoop('idle');
        }
      };
      mr.start();
      setVoiceLoop('listening');
    } catch (err) {
      stopRecordingTracksVoice();
      const msg = err instanceof Error ? err.message : String(err);
      if (/Permission|denied|NotAllowed/i.test(msg)) {
        setVoiceLoopError('Microphone permission was denied. Allow it in your browser settings.');
      } else if (/NotFound|DevicesNotFound/i.test(msg)) {
        setVoiceLoopError('No microphone found. Plug one in or type your message.');
      } else {
        setVoiceLoopError(`Recording failed: ${msg}`);
      }
      setVoiceLoop('idle');
    }
  }, [voiceLoop, stopAllSpeech, runTurn, stopRecordingTracksVoice]);

  const stopMic = useCallback(() => {
    if (voiceMediaRecorderRef.current?.state === 'recording') {
      voiceMediaRecorderRef.current.stop();
    } else {
      stopRecordingTracksVoice();
      setVoiceLoop('idle');
    }
  }, [stopRecordingTracksVoice]);

  // Cleanup on unmount
  useEffect(() => () => {
    stopAllSpeech();
    stopRecordingTracksVoice();
    ttsAudioCtxRef.current?.close().catch(() => undefined);
    ttsAudioCtxRef.current = null;
  }, [stopAllSpeech, stopRecordingTracksVoice]);

  const handleSend = useCallback(async () => {
    const txt = promptText.trim();
    if (!txt) return;
    setPromptText('');
    await runTurn(txt);
    // `interact` is intentionally unused here — Odyssey owns its own voice; we
    // drive replies through Smallest so the user's selected/cloned voice is used.
    void interact;
  }, [promptText, runTurn, interact]);

  const handleBack = useCallback(async () => {
    stopAllSpeech();
    stopRecordingTracksVoice();
    await disconnect();
    navigate('/characters');
  }, [disconnect, navigate, stopAllSpeech, stopRecordingTracksVoice]);

  // ----- Setup screen ------------------------------------------------------
  if (step === 'setup') {
    const previewReady = cloneStatus === 'done' && Boolean(imageFile) && characterName.trim().length > 0;
    const previewDisabled = !previewReady || building;
    const previewTitle = characterName.trim() || 'Your character';
    const previewBody = characterDesc.trim()
      || (cloneStatus === 'done'
        ? 'Stylized and ready. Click the card to step inside.'
        : 'A new face joins the cast.');
    const previewCta = building
      ? 'Building…'
      : previewReady
        ? `Talk to ${previewTitle} →`
        : cloneStatus === 'done'
          ? 'Give them a name to continue →'
          : 'Generate your character to continue →';

    const onPreviewKey = (e: KeyboardEvent<HTMLDivElement>) => {
      if (previewDisabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void buildCharacter();
      }
    };

    const canStopRecording = recordSeconds >= MIN_RECORD_SECONDS;
    const recordHint = isRecording
      ? canStopRecording
        ? `Sounds good — stop any time.`
        : `Keep talking for ${MIN_RECORD_SECONDS - recordSeconds} more second${MIN_RECORD_SECONDS - recordSeconds === 1 ? '' : 's'}.`
      : voiceFile && cloneSource === 'record'
        ? `Recorded ${formatSeconds(recordSeconds)} (${(voiceFile.size / 1024).toFixed(0)} KB)`
        : `Read a short paragraph aloud — at least ${MIN_RECORD_SECONDS} seconds. The character will speak in your voice.`;

    return (
      <div className="atrium atrium-character-builder">
        <AtriumNav />

        <main className="acb-page">
          <header className="acb-hero">
            <span className="eyebrow">
              <span className="eyebrow__dot" /> Wear the character
            </span>
            <h1>
              Become someone <em>new.</em>
            </h1>
            <p className="lede">
              Upload a photo, give them a name and personality, pick or record a voice.
              We'll meet them on the other side.
            </p>
          </header>

          <div className="acb-form">
            {/* Photo upload */}
            <div className="acb-field">
              <label className="acb-label">Character photo *</label>
              <div
                className={`acb-drop-zone${imagePreview ? ' acb-drop-zone--filled' : ''}`}
                onClick={() => imageInputRef.current?.click()}
                style={{ backgroundImage: imagePreview ? `url(${imagePreview})` : undefined }}
              >
                {!imagePreview && <span>Click to upload a photo</span>}
              </div>
              <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImagePick} />
              {imageInfo && <p className="acb-hint">{imageInfo}</p>}
              {cloneError && cloneStatus === 'error' && !originalImageFile && (
                <p className="acb-note acb-note--error">{cloneError}</p>
              )}
            </div>

            {/* Name */}
            <div className="acb-field">
              <label className="acb-label">Character name *</label>
              <input
                type="text"
                className="acb-input"
                placeholder="e.g. Alex, Mentor, Mom"
                value={characterName}
                onChange={(e) => setCharacterName(e.target.value)}
                maxLength={60}
              />
            </div>

            {/* Personality */}
            <div className="acb-field">
              <label className="acb-label">Personality / description</label>
              <textarea
                className="acb-input"
                placeholder="e.g. A wise mentor who speaks in short, direct sentences. Loves asking questions back."
                value={characterDesc}
                onChange={(e) => setCharacterDesc(e.target.value)}
                rows={3}
                maxLength={400}
                style={{ resize: 'vertical' }}
              />
            </div>

            {/* Voice — pick a preset, or clone your own (upload OR record live) */}
            <div className="acb-field">
              <label className="acb-label">Voice</label>
              <p className="acb-hint">Pick a preset voice, or clone your own.</p>
              <div className="acb-toggle-row acb-toggle-row--three">
                <button
                  type="button"
                  className={`btn btn--ghost btn--sm${voiceMode === 'preset-male' ? ' is-on' : ''}`}
                  onClick={() => selectVoicePreset('preset-male')}
                  disabled={voiceStatus === 'cloning'}
                >
                  {PRESET_VOICES['preset-male'].label}
                </button>
                <button
                  type="button"
                  className={`btn btn--ghost btn--sm${voiceMode === 'preset-female' ? ' is-on' : ''}`}
                  onClick={() => selectVoicePreset('preset-female')}
                  disabled={voiceStatus === 'cloning'}
                >
                  {PRESET_VOICES['preset-female'].label}
                </button>
                <button
                  type="button"
                  className={`btn btn--ghost btn--sm${voiceMode === 'clone' ? ' is-on' : ''}`}
                  onClick={() => selectVoicePreset('clone')}
                  disabled={voiceStatus === 'cloning'}
                >
                  Clone my voice
                </button>
              </div>

              {voiceMode === 'clone' && (
                <div className="acb-clone-sub">
                  <div className="acb-toggle-row">
                    <button
                      type="button"
                      className={`btn btn--ghost btn--sm${cloneSource === 'record' ? ' is-on' : ''}`}
                      onClick={() => setCloneSource('record')}
                      disabled={isRecording || voiceStatus === 'cloning'}
                    >
                      Record now
                    </button>
                    <button
                      type="button"
                      className={`btn btn--ghost btn--sm${cloneSource === 'upload' ? ' is-on' : ''}`}
                      onClick={() => { if (isRecording) stopRecording(); setCloneSource('upload'); }}
                      disabled={voiceStatus === 'cloning'}
                    >
                      Upload audio
                    </button>
                  </div>

                  {cloneSource === 'record' ? (
                    <>
                      <p className="acb-hint">{recordHint}</p>
                      <div className="acb-record">
                        {isRecording ? (
                          <>
                            <div className="acb-record__live">
                              <span className="acb-record__dot" aria-hidden="true" />
                              <span className="acb-record__timer">{formatSeconds(recordSeconds)}</span>
                              <span className="acb-record__min">/ min {formatSeconds(MIN_RECORD_SECONDS)}</span>
                            </div>
                            <button
                              type="button"
                              className="btn btn--primary acb-action--fixed"
                              onClick={stopRecording}
                              disabled={!canStopRecording}
                              title={canStopRecording ? 'Stop recording' : `${MIN_RECORD_SECONDS - recordSeconds}s more required`}
                            >
                              {canStopRecording ? 'Stop' : `${MIN_RECORD_SECONDS - recordSeconds}s more`}
                            </button>
                          </>
                        ) : voiceFile && cloneSource === 'record' ? (
                          <div className="acb-actions">
                            <button
                              type="button"
                              className="btn btn--ghost"
                              onClick={startRecording}
                              disabled={voiceStatus === 'cloning'}
                            >
                              Re-record
                            </button>
                            <button
                              type="button"
                              className="btn btn--primary acb-action--fixed"
                              onClick={cloneVoice}
                              disabled={voiceStatus === 'cloning' || voiceStatus === 'done'}
                            >
                              {voiceStatus === 'cloning' ? 'Cloning…' : voiceStatus === 'done' ? '✓ Done' : 'Clone'}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--primary btn--block"
                            onClick={startRecording}
                          >
                            ● Start recording
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="acb-hint">Upload a 15–60 second clip (under {VOICE_MAX_BYTES / 1024 / 1024} MB).</p>
                      <div className="acb-actions">
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => voiceInputRef.current?.click()}
                          disabled={voiceStatus === 'cloning'}
                        >
                          {voiceFile && cloneSource === 'upload' ? voiceFile.name : 'Choose audio file'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary acb-action--fixed"
                          disabled={!voiceFile || voiceStatus === 'cloning' || voiceStatus === 'done' || (voiceFile?.size ?? 0) > VOICE_MAX_BYTES}
                          onClick={cloneVoice}
                        >
                          {voiceStatus === 'cloning' ? 'Cloning…' : voiceStatus === 'done' ? '✓ Done' : 'Clone'}
                        </button>
                      </div>
                      <input ref={voiceInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleVoicePick} />
                    </>
                  )}

                  {voiceStatus === 'done' && <p className="acb-note acb-note--success">Voice cloned. {previewTitle} will speak in your voice.</p>}
                  {voiceError && <p className="acb-note acb-note--error">{voiceError}</p>}
                  {voiceStatus !== 'done' && !voiceCloneId && !voiceError && !isRecording && (
                    <p className="acb-hint">Sign in to save this voice for future sessions.</p>
                  )}
                </div>
              )}
            </div>

            {/* Generate character (Pixar-style via Gemini) — only when a photo is uploaded */}
            {originalImageFile && (
              <div className="acb-field">
                <label className="acb-label">Generate your character</label>
                <p className="acb-hint">Turn the photo into a Pixar-style 3D character.</p>
                <div className="acb-toggle-row">
                  <button
                    type="button"
                    className={`btn btn--ghost btn--sm${framing === 'headshot' ? ' is-on' : ''}`}
                    onClick={() => setFraming('headshot')}
                    disabled={cloneStatus === 'cloning'}
                  >
                    Headshot
                  </button>
                  <button
                    type="button"
                    className={`btn btn--ghost btn--sm${framing === 'full' ? ' is-on' : ''}`}
                    onClick={() => setFraming('full')}
                    disabled={cloneStatus === 'cloning'}
                  >
                    Full body
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn--primary btn--block"
                  disabled={cloneStatus === 'cloning'}
                  onClick={cloneCharacter}
                >
                  {cloneStatus === 'cloning' ? 'Generating…' : cloneStatus === 'done' ? 'Regenerate character' : 'Generate character'}
                </button>
                {cloneStatus === 'done' && <p className="acb-note acb-note--success">Character generated. Preview below.</p>}
                {cloneError && <p className="acb-note acb-note--error">{cloneError}</p>}
              </div>
            )}

            {/* Generated character preview — cast-card style, acts as the primary CTA */}
            <div className="acb-preview-wrap">
              <div
                className="acb-preview"
                role="button"
                tabIndex={previewDisabled ? -1 : 0}
                aria-disabled={previewDisabled}
                onClick={() => { if (!previewDisabled) void buildCharacter(); }}
                onKeyDown={onPreviewKey}
              >
                <div className={`acb-preview__photo${cloneStatus === 'done' && imagePreview ? '' : ' acb-preview__photo--empty'}`}>
                  {cloneStatus === 'done' && imagePreview ? (
                    <img src={imagePreview} alt={previewTitle} />
                  ) : (
                    <span>{cloneStatus === 'cloning' ? 'Stylizing your character…' : 'Your stylized character will appear here'}</span>
                  )}
                </div>
                <div className="acb-preview__meta">
                  <h3>{previewTitle}</h3>
                  <p>{previewBody}</p>
                </div>
                <span className="acb-preview__cta">{previewCta}</span>
              </div>
              {buildError && <p className="acb-note acb-note--error">{buildError}</p>}
            </div>
          </div>
        </main>

        <AtriumFooter />
      </div>
    );
  }

  // ----- Live screen -------------------------------------------------------
  // Mirrors the main character UI (src/App.tsx): full-bleed video layer with
  // the stylized poster as a fallback, a single "Back" pill top-left, and a
  // floating .chat-pill at the bottom — same global classes from src/App.css,
  // so visual parity is structural, not skin-deep.
  //
  // Voice loop is wired through Smallest STT → LLM (Gemini text) → Smallest
  // TTS so the user's chosen / cloned voice is used end-to-end. Odyssey is
  // kept for the idle visual; it never sees the conversation audio.
  const poster = imagePreview;
  const placeholderClass = `stream-placeholder ${status === 'streaming' ? 'hidden' : ''} ${status !== 'streaming' && status !== 'error' ? 'is-loading' : ''}`;
  const isRecordingVoice = voiceLoop === 'listening';
  const isCharacterThinking = voiceLoop === 'thinking';
  const isCharacterSpeaking = voiceLoop === 'speaking';
  const isCharacterBusy = isRecordingVoice || isCharacterThinking || isCharacterSpeaking;

  const placeholderText =
    voiceLoopError ? voiceLoopError
      : status === 'error' ? 'Reconnecting…'
        : isRecordingVoice ? 'Listening… tap to send'
          : isCharacterThinking ? `${characterName || 'Character'} is thinking…`
            : isCharacterSpeaking ? `${characterName || 'Character'} is speaking…`
              : status !== 'streaming' ? `Waking up ${characterName || 'your character'}…`
                : `Talk to ${characterName || 'your character'}, or type…`;

  const isPillBusy = status !== 'streaming' && status !== 'idle';
  const isInputDisabled = isCharacterBusy || (status !== 'streaming' && status !== 'idle');

  return (
    <div className="app">
      <div className="video-layer">
        {poster && (
          <div className="background-fallback" style={{ backgroundImage: `url("${poster}")` }} aria-hidden />
        )}
        <div
          className={placeholderClass}
          style={poster ? { backgroundImage: `url("${poster}")` } : undefined}
          aria-hidden
        />
        <video
          ref={videoRef}
          className={`video-element ${status === 'streaming' ? '' : 'is-hidden'}`}
          autoPlay
          playsInline
          muted
        />
        <div className="video-overlay" />
      </div>

      <div className="ui">
        <header className="top-bar">
          <button type="button" className="btn ghost back-to-landing" onClick={handleBack}>
            Back
          </button>
        </header>

        <main className="slide-shell" />

        <div className="story-bar-wrap">
          <footer className="story-bar story-bar--compact">
            <div className={`chat-pill ${isPillBusy ? 'chat-pill--waking' : ''}`}>
              <input
                className="chat-pill__input"
                type="text"
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSend(); }}
                placeholder={placeholderText}
                disabled={isInputDisabled}
                aria-label={`Message ${characterName || 'your character'}`}
                aria-busy={isCharacterBusy}
              />
              {/* WhatsApp-style toggle: recording > send (when text) > mic.
                  Mic now drives the STT→LLM→TTS pipeline through Smallest. */}
              {isRecordingVoice ? (
                <button
                  type="button"
                  className="chat-pill__action chat-pill__mic chat-pill__mic--recording chat-pill__mic--listening"
                  onClick={stopMic}
                  aria-label="Stop recording and send"
                  title="Stop and send"
                >
                  <span className="chat-pill__mic-pulse" aria-hidden />
                </button>
              ) : promptText.trim().length > 0 ? (
                <button
                  type="button"
                  className="chat-pill__action chat-pill__send"
                  onClick={handleSend}
                  disabled={isCharacterBusy}
                  aria-label="Send message"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M22 2L11 13" />
                    <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className={`chat-pill__action chat-pill__mic ${isCharacterThinking ? 'chat-pill__mic--thinking' : ''} ${isCharacterSpeaking ? 'chat-pill__mic--speaking' : ''}`}
                  onClick={isCharacterSpeaking ? stopAllSpeech : startMic}
                  disabled={isCharacterThinking}
                  aria-label={
                    isCharacterSpeaking
                      ? `${characterName || 'Character'} is speaking — tap to stop`
                      : isCharacterThinking
                        ? 'Thinking…'
                        : `Talk to ${characterName || 'your character'}`
                  }
                  title={
                    isCharacterSpeaking
                      ? 'Tap to stop'
                      : isCharacterThinking
                        ? 'Thinking…'
                        : `Tap to talk`
                  }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="12" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
                  </svg>
                </button>
              )}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
