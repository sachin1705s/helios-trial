import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { supabase } from '../../lib/supabase';
import { AtriumNav, AtriumFooter } from '../../demo/atrium/Layout';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';
import './CustomCharacterExperiment.css';

type Step = 'setup' | 'live';
type VoiceMode = 'preset-male' | 'preset-female' | 'clone';

// Smallest.ai preset voice IDs — same provider used by every other character on the site.
// `magnus` is the platform default fallback (see server/api/character/tts).
const PRESET_VOICES: Record<Exclude<VoiceMode, 'clone'>, { id: string; label: string }> = {
  'preset-male':   { id: 'magnus', label: 'Male voice' },
  'preset-female': { id: 'aanya',  label: 'Female voice' },
};

// Vercel serverless functions cap request bodies around 4.5 MB. Reject anything
// bigger client-side so users get a clear message instead of a network failure.
const VOICE_MAX_BYTES = 4 * 1024 * 1024;

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
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceCloneId, setVoiceCloneId] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'cloning' | 'done' | 'error'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);

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
    if (!source) return;
    setCloneStatus('cloning');
    setCloneError(null);
    try {
      const fd = new FormData();
      fd.append('image', source);
      fd.append('framing', framing);
      const res = await fetch('/api/character-clone', { method: 'POST', body: fd });
      const data = await res.json() as { imageBase64?: string; mimeType?: string; error?: string };
      if (!res.ok || !data.imageBase64) throw new Error(data.error ?? 'Character generation failed.');
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
      setCloneError(err instanceof Error ? err.message : 'Character generation failed.');
    }
  }, [originalImageFile, imageFile, framing]);

  const handleVoicePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset prior clone results when a new file is chosen.
    setVoiceFile(file);
    setVoiceCloneId(null);
    setVoiceStatus('idle');
    setVoiceError(file.size > VOICE_MAX_BYTES
      ? `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Pick a clip under ${VOICE_MAX_BYTES / 1024 / 1024} MB or use a preset voice.`
      : null);
  }, []);

  const cloneVoice = useCallback(async () => {
    if (!voiceFile) return;
    if (voiceFile.size > VOICE_MAX_BYTES) {
      setVoiceStatus('error');
      setVoiceError(`That file is ${(voiceFile.size / 1024 / 1024).toFixed(1)} MB. Pick a clip under ${VOICE_MAX_BYTES / 1024 / 1024} MB or use a preset voice.`);
      return;
    }
    setVoiceStatus('cloning');
    setVoiceError(null);
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
        // TypeError from fetch — network failure, CORS block, or server didn't respond.
        // Fall back to the preset voice silently so the user is never blocked.
        setVoiceStatus('error');
        setVoiceError("Couldn't reach the voice service. Pick a preset voice above, or try again in a moment.");
        if (voiceMode === 'clone') setVoiceMode('preset-male');
        console.warn('[voice-clone] network error:', networkErr);
        return;
      }

      let data: { voiceId?: string; error?: string } = {};
      try {
        data = await res.json() as { voiceId?: string; error?: string };
      } catch {
        // Non-JSON response (e.g. Vercel 413, gateway timeout HTML).
      }

      if (!res.ok || !data.voiceId) {
        const sizeMsg = res.status === 413 ? ' (file too large)' : '';
        throw new Error((data.error ?? `Voice clone failed (HTTP ${res.status})${sizeMsg}`));
      }
      setVoiceCloneId(data.voiceId);
      setVoiceStatus('done');
    } catch (err) {
      setVoiceStatus('error');
      setVoiceError(err instanceof Error ? err.message : 'Voice clone failed.');
    }
  }, [voiceFile, characterName, voiceMode]);

  const selectVoicePreset = useCallback((mode: VoiceMode) => {
    setVoiceMode(mode);
    if (mode !== 'clone') {
      // Switching to a preset clears any in-flight clone error — the user is unblocked.
      setVoiceError(null);
      if (voiceStatus === 'error') setVoiceStatus('idle');
    }
  }, [voiceStatus]);

  const buildCharacter = useCallback(async () => {
    if (!imageFile || !characterName.trim()) { setBuildError('Image and name are required.'); return; }
    setBuilding(true);
    setBuildError(null);
    await disconnect();
    void connect();
    setStep('live');
    setBuilding(false);
  }, [imageFile, characterName, disconnect, connect]);

  // Once step is 'live' and status becomes 'ready', kick off the stream
  const hasStartedRef = useRef(false);
  const startLiveStream = useCallback(async () => {
    if (hasStartedRef.current || status !== 'ready' || !imageFile) return;
    hasStartedRef.current = true;
    const systemPrompt = [
      `You are ${characterName || 'a custom character'}.`,
      characterDesc ? `Personality: ${characterDesc}` : '',
      'Keep every reply under 30 words. Stay in character.',
    ].filter(Boolean).join(' ');
    // Voice id is resolved here so it's ready to plumb into the TTS leg when
    // the team wires the cloned voice path. Logging now keeps it visible in dev.
    console.log('[wear-the-character] voice id selected:', resolvedVoiceId, '(mode:', voiceMode, ')');
    await startStream({ image: imageFile, prompt: systemPrompt, portrait: true });
  }, [status, imageFile, characterName, characterDesc, startStream, resolvedVoiceId, voiceMode]);

  // Trigger startLiveStream when conditions are met
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
          : 'Stylize a photo to continue →';

    const onPreviewKey = (e: KeyboardEvent<HTMLDivElement>) => {
      if (previewDisabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void buildCharacter();
      }
    };

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
              Upload a photo, give them a name and personality, optionally clone a voice.
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

            {/* Character clone (Pixar-style via Gemini) */}
            {originalImageFile && (
              <div className="acb-field">
                <label className="acb-label">Stylize as 3D character</label>
                <p className="acb-hint">Turn your photo into a Pixar-style 3D character before going live.</p>
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
                {cloneStatus === 'done' && <p className="acb-note acb-note--success">Character generated. Preview updated above.</p>}
                {cloneError && <p className="acb-note acb-note--error">{cloneError}</p>}
              </div>
            )}

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

            {/* Voice — pick a preset or clone your own */}
            <div className="acb-field">
              <label className="acb-label">Voice</label>
              <p className="acb-hint">Pick a preset voice, or clone your own from a short audio clip.</p>
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
                <>
                  <p className="acb-hint">Upload a 10–30 second clip (under {VOICE_MAX_BYTES / 1024 / 1024} MB). The character will speak in that voice.</p>
                  <div className="acb-actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => voiceInputRef.current?.click()}
                    >
                      {voiceFile ? voiceFile.name : 'Choose audio file'}
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
                  {voiceStatus === 'done' && <p className="acb-note acb-note--success">Voice cloned successfully.</p>}
                  {voiceError && <p className="acb-note acb-note--error">{voiceError}</p>}
                  {voiceStatus !== 'done' && !voiceCloneId && !voiceError && (
                    <p className="acb-hint">Sign in to save this voice for future sessions.</p>
                  )}
                </>
              )}
            </div>

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
