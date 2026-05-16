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

// Voice clones with under ~15s of audio are unreliable — Smallest itself recommends
// 15–30s. Enforce that as a hard floor for live recordings.
const MIN_RECORD_SECONDS = 15;
const MAX_RECORD_SECONDS = 60;

function formatSeconds(n: number): string {
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function CustomCharacterExperiment() {
  const navigate = useNavigate();
  const { status, error, videoRef, startStream, interact, disconnect, connect } = useOdysseyStream({ autoConnect: false });

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

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const [promptText, setPromptText] = useState('');

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const voiceInputRef = useRef<HTMLInputElement | null>(null);

  // ── Image / character ──────────────────────────────────────────────────────
  const handleImagePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setOriginalImageFile(file);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setCloneStatus('idle');
    setCloneError(null);
  }, []);

  const cloneCharacter = useCallback(async () => {
    const source = originalImageFile ?? imageFile;
    if (!source) {
      setCloneError('Upload a photo first.');
      setCloneStatus('error');
      return;
    }
    setCloneStatus('cloning');
    setCloneError(null);
    try {
      const fd = new FormData();
      fd.append('image', source);
      fd.append('framing', framing);
      const res = await fetch('/api/character-clone', { method: 'POST', body: fd });
      let data: { imageBase64?: string; mimeType?: string; error?: string; details?: string } = {};
      try { data = await res.json(); } catch { /* non-JSON */ }
      if (!res.ok || !data.imageBase64) {
        throw new Error(data.error ?? `Character generation failed (HTTP ${res.status})`);
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
    } catch (err) {
      setCloneStatus('error');
      if (err instanceof TypeError) {
        setCloneError("Couldn't reach the image service. Check your connection and try again.");
      } else {
        setCloneError(err instanceof Error ? err.message : 'Character generation failed.');
      }
    }
  }, [originalImageFile, imageFile, framing]);

  // ── Voice: file upload ─────────────────────────────────────────────────────
  const handleVoicePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVoiceFile(file);
    setVoiceCloneId(null);
    setVoiceStatus('idle');
    setVoiceError(file.size > VOICE_MAX_BYTES
      ? `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Pick a clip under ${VOICE_MAX_BYTES / 1024 / 1024} MB or record one.`
      : null);
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

  const handleSend = useCallback(async () => {
    if (!promptText.trim()) return;
    await interact(promptText.trim());
    setPromptText('');
  }, [promptText, interact]);

  const handleBack = useCallback(async () => {
    await disconnect();
    navigate('/characters');
  }, [disconnect, navigate]);

  const handleStartOver = useCallback(() => {
    hasStartedRef.current = false;
    setStep('setup');
  }, []);

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
  const statusVariant =
    status === 'streaming' ? 'live'
      : status === 'error' ? 'error'
        : 'connecting';
  const statusText =
    status === 'idle' || status === 'connecting' ? `Bringing ${characterName} to life…`
      : status === 'ready' ? 'Stream ready — starting…'
        : status === 'streaming' ? `${characterName} is live.`
          : status === 'error' ? `Error: ${error}`
            : status;

  return (
    <div className="atrium atrium-character-live">
      <AtriumNav />

      <div className="acb-live-header">
        <button type="button" className="btn btn--ghost btn--sm" onClick={handleBack}>
          ← Back to the cast
        </button>
        <span className="eyebrow">
          <span className="eyebrow__dot" /> Live
        </span>
      </div>

      <main className="acb-stage">
        <section>
          <div className="acb-stage__video">
            <video ref={videoRef} autoPlay playsInline muted />
          </div>
          <h2 className="acb-stage__title">{characterName}</h2>
        </section>

        <aside className="acb-panel">
          <div className={`acb-status acb-status--${statusVariant}`}>
            <span className="acb-status__dot" />
            <span>{statusText}</span>
          </div>

          <div className="acb-prompt-row">
            <input
              type="text"
              className="acb-input"
              placeholder={`Say something to ${characterName}…`}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSend(); }}
              disabled={status !== 'streaming'}
            />
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={handleSend}
              disabled={status !== 'streaming'}
            >
              Send
            </button>
          </div>

          <button
            type="button"
            className="btn btn--ghost btn--sm btn--block"
            onClick={handleStartOver}
          >
            Start over
          </button>
        </aside>
      </main>

      <AtriumFooter />
    </div>
  );
}
