import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { supabase } from '../../lib/supabase';

type Step = 'setup' | 'live';

export default function CustomCharacterExperiment() {
  const navigate = useNavigate();
  const { status, error, videoRef, startStream, interact, disconnect, connect } = useOdysseyStream({ autoConnect: false });

  const [step, setStep] = useState<Step>('setup');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [characterName, setCharacterName] = useState('');
  const [characterDesc, setCharacterDesc] = useState('');

  // Voice clone state
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceCloneId, setVoiceCloneId] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'cloning' | 'done' | 'error'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const [promptText, setPromptText] = useState('');

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const voiceInputRef = useRef<HTMLInputElement | null>(null);

  const handleImagePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }, []);

  const handleVoicePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVoiceFile(file);
  }, []);

  const cloneVoice = useCallback(async () => {
    if (!voiceFile) return;
    setVoiceStatus('cloning');
    setVoiceError(null);
    try {
      const fd = new FormData();
      fd.append('audio', voiceFile);
      fd.append('display_name', characterName || 'Custom Character');
      fd.append('provider', 'smallest');

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

      const res = await fetch('/api/voice-clone', { method: 'POST', headers, body: fd });
      const data = await res.json() as { voiceId?: string; error?: string };
      if (!res.ok || !data.voiceId) throw new Error(data.error ?? 'Voice clone failed.');
      setVoiceCloneId(data.voiceId);
      setVoiceStatus('done');
    } catch (err) {
      setVoiceStatus('error');
      setVoiceError(err instanceof Error ? err.message : 'Voice clone failed.');
    }
  }, [voiceFile, characterName]);

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
    await startStream({ image: imageFile, prompt: systemPrompt, portrait: true });
  }, [status, imageFile, characterName, characterDesc, startStream]);

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

  if (step === 'setup') {
    return (
      <div className="experiment-shell">
        <header className="experiment-topbar">
          <button className="btn ghost" onClick={() => navigate('/characters')}>← Back</button>
          <h1>Custom Characters</h1>
          <span className="exp-badge">Experiment 4</span>
        </header>

        <div style={{ maxWidth: 520, margin: '48px auto', padding: '0 24px' }}>
          <h2 style={{ marginBottom: 8 }}>Build your character</h2>
          <p style={{ color: 'rgba(231,237,246,0.5)', marginBottom: 32 }}>
            Upload a photo, give it a name and personality, and optionally clone a voice.
          </p>

          {/* Image upload */}
          <div className="setup-field">
            <label className="setup-label">Character photo *</label>
            <div
              className="image-drop-zone"
              onClick={() => imageInputRef.current?.click()}
              style={{ backgroundImage: imagePreview ? `url(${imagePreview})` : undefined }}
            >
              {!imagePreview && <span>Click to upload photo</span>}
            </div>
            <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImagePick} />
          </div>

          {/* Name */}
          <div className="setup-field">
            <label className="setup-label">Character name *</label>
            <input
              type="text"
              className="exp-text-input"
              placeholder="e.g. Alex, Mentor, Mom"
              value={characterName}
              onChange={(e) => setCharacterName(e.target.value)}
              maxLength={60}
            />
          </div>

          {/* Personality */}
          <div className="setup-field">
            <label className="setup-label">Personality / description</label>
            <textarea
              className="exp-text-input"
              placeholder="e.g. A wise mentor who speaks in short, direct sentences. Loves asking questions back."
              value={characterDesc}
              onChange={(e) => setCharacterDesc(e.target.value)}
              rows={3}
              maxLength={400}
              style={{ resize: 'vertical' }}
            />
          </div>

          {/* Voice clone (optional) */}
          <div className="setup-field">
            <label className="setup-label">Clone a voice <span style={{ color: 'rgba(231,237,246,0.4)', fontWeight: 400 }}>(optional)</span></label>
            <p style={{ fontSize: '0.78rem', color: 'rgba(231,237,246,0.4)', margin: '0 0 8px' }}>
              Upload a 10–30 second audio clip. The character will speak in that voice.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="exp-btn ghost" style={{ flex: 1 }} onClick={() => voiceInputRef.current?.click()}>
                {voiceFile ? voiceFile.name : 'Choose audio file'}
              </button>
              <button
                className="exp-btn primary"
                style={{ flexShrink: 0 }}
                disabled={!voiceFile || voiceStatus === 'cloning' || voiceStatus === 'done'}
                onClick={cloneVoice}
              >
                {voiceStatus === 'cloning' ? 'Cloning…' : voiceStatus === 'done' ? '✓ Done' : 'Clone'}
              </button>
            </div>
            <input ref={voiceInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleVoicePick} />
            {voiceStatus === 'done' && <p style={{ color: '#6fcf97', fontSize: '0.8rem', margin: '6px 0 0' }}>Voice cloned successfully.</p>}
            {voiceError && <p style={{ color: '#ff6b6b', fontSize: '0.8rem', margin: '6px 0 0' }}>{voiceError}</p>}
            {voiceStatus !== 'done' && !voiceCloneId && (
              <p style={{ fontSize: '0.75rem', color: 'rgba(231,237,246,0.3)', margin: '6px 0 0' }}>
                Sign in to save this voice for future sessions.
              </p>
            )}
          </div>

          {buildError && <p style={{ color: '#ff6b6b', marginBottom: 12 }}>{buildError}</p>}
          <button
            className="exp-btn primary"
            style={{ marginTop: 8, width: '100%' }}
            disabled={!imageFile || !characterName.trim() || building}
            onClick={buildCharacter}
          >
            {building ? 'Building…' : 'Create Character ✨'}
          </button>
        </div>
      </div>
    );
  }

  // Live character view
  return (
    <div className="experiment-shell">
      <header className="experiment-topbar">
        <button className="btn ghost" onClick={handleBack}>← Back</button>
        <h1>{characterName}</h1>
        <span className="exp-badge">Experiment 4</span>
      </header>

      <div className="experiment-body">
        <div className="experiment-video-panel">
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        <aside className="experiment-side-panel">
          <div className="experiment-status">
            {status === 'idle' || status === 'connecting' ? `Bringing ${characterName} to life…` :
             status === 'ready'     ? 'Stream ready — starting…' :
             status === 'streaming' ? `${characterName} is live.` :
             status === 'error'     ? `Error: ${error}` : status}
          </div>

          <div className="exp-prompt-row">
            <input
              type="text"
              className="exp-text-input"
              placeholder={`Say something to ${characterName}…`}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSend(); }}
              disabled={status !== 'streaming'}
            />
            <button className="exp-btn primary" onClick={handleSend} disabled={status !== 'streaming'}>Send</button>
          </div>

          <button className="exp-btn ghost" onClick={() => { hasStartedRef.current = false; setStep('setup'); }}>
            Start over
          </button>
        </aside>
      </div>
    </div>
  );
}
