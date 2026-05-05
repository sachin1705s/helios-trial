import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { OdysseyService, credentialsFromDict, type StreamState } from '../../lib/odyssey';
import { AtriumNav } from '../../demo/atrium/Layout';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';
import './DrawingExperiment.css';

type Phase = 'upload' | 'processing' | 'streaming';
type Style = 'manga' | 'comic' | 'realism' | 'ghibli-inspired';

const STYLES: { value: Style; label: string; description: string }[] = [
  { value: 'manga',           label: 'Manga',     description: 'Bold, high contrast' },
  { value: 'comic',           label: 'Comic',     description: 'Colorful, action-ready' },
  { value: 'ghibli-inspired', label: 'Ghibli',    description: 'Soft, painterly warmth' },
  { value: 'realism',         label: 'Realistic', description: 'Photo-like rendering' },
];

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: { [index: number]: { isFinal: boolean; 0: { transcript: string } }; length: number } }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const win = window as typeof window & {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export default function DrawingExperiment() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('upload');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<Style>('manga');
  const [error, setError] = useState<string | null>(null);
  const [processingStep, setProcessingStep] = useState('');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [isStreamingReady, setIsStreamingReady] = useState(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [isListening, setIsListening] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const serviceRef = useRef<OdysseyService | null>(null);
  const leaseIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const stopHeartbeat = () => {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  };

  const releaseLease = () => {
    const leaseId = leaseIdRef.current;
    if (!leaseId) return;
    stopHeartbeat();
    const payload = JSON.stringify({ leaseId });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/odyssey/release', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/odyssey/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => undefined);
    }
    leaseIdRef.current = null;
  };

  useEffect(() => {
    const onUnload = () => releaseLease();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      releaseLease();
      serviceRef.current?.disconnect().catch(() => undefined);
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 18 * 1024 * 1024) {
      setError('Photo is too large. Please choose an image under 18 MB.');
      return;
    }
    setUploadedFile(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setError(null);
  };

  const handleBringToLife = async () => {
    if (!uploadedFile) return;
    setPhase('processing');
    setError(null);

    try {
      setProcessingStep('Stylizing your photo…');
      const formData = new FormData();
      formData.append('image', uploadedFile);
      formData.append('style', selectedStyle);

      const stylizeRes = await fetch('/api/animate-drawings/stylize', { method: 'POST', body: formData });
      if (!stylizeRes.ok) {
        const errData = await stylizeRes.json().catch(() => ({ error: 'Stylization failed' }));
        throw new Error(errData.error || 'Stylization failed');
      }
      const { imageBase64, mimeType: stylizedMime } = await stylizeRes.json();

      const binary = atob(imageBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const stylizedFile = new File([bytes], 'photo.png', { type: stylizedMime || 'image/png' });

      setProcessingStep('Preparing animation…');
      const credRes = await fetch('/api/odyssey/token');
      if (!credRes.ok) {
        const errData = await credRes.json().catch(() => ({ error: 'Service unavailable' }));
        throw new Error(errData.error || 'Failed to get session');
      }
      const credData = await credRes.json();

      leaseIdRef.current = credData.leaseId ?? null;
      if (credData.leaseId) {
        heartbeatRef.current = window.setInterval(() => {
          fetch('/api/odyssey/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leaseId: credData.leaseId }),
          }).catch(() => undefined);
        }, 60_000);
      }

      const credentials = credentialsFromDict(credData.credentials);

      setProcessingStep('Bringing it to life…');
      const service = new OdysseyService(credentials);
      serviceRef.current = service;

      await new Promise<void>((resolve, reject) => {
        let settled = false;

        service.connect({
          onConnected: (stream) => {
            const attach = () => {
              if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play().catch((e: unknown) => {
                  if ((e as { name?: string })?.name === 'AbortError') {
                    setTimeout(() => videoRef.current?.play().catch(() => undefined), 150);
                  }
                });
              } else {
                setTimeout(attach, 100);
              }
            };
            attach();
            service.startStream({ image: stylizedFile }).catch((err: unknown) => {
              if (!settled) { settled = true; reject(err); }
            });
          },
          onStreamStarted: () => {
            if (!settled) {
              settled = true;
              setStreamState('streaming');
              setIsStreamingReady(true);
              setPhase('streaming');
              resolve();
            }
          },
          onStreamError: (_reason, message) => {
            if (!settled) {
              settled = true;
              reject(new Error(String(message || 'Stream failed')));
            }
          },
          onStreamEnded: () => {
            setStreamState('ended');
            setIsStreamingReady(false);
          },
          onStatusChange: () => {},
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setError(message);
      setPhase('upload');
      stopHeartbeat();
      releaseLease();
    }
  };

  const handleTryAnother = () => {
    recognitionRef.current?.stop();
    releaseLease();
    serviceRef.current?.disconnect().catch(() => undefined);
    serviceRef.current = null;
    setPhase('upload');
    setUploadedFile(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setStreamState('idle');
    setIsStreamingReady(false);
    setTextPrompt('');
    setError(null);
  };

  const handleSendPrompt = () => {
    const prompt = textPrompt.trim();
    if (!prompt || !isStreamingReady) return;
    serviceRef.current?.interact(prompt).catch(() => undefined);
    setTextPrompt('');
  };

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSendPrompt();
  };

  const toggleListening = () => {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) return;

    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript || '';
      if (transcript) setTextPrompt(transcript);
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.start();
    setIsListening(true);
  };

  const handleBack = () => {
    recognitionRef.current?.stop();
    releaseLease();
    serviceRef.current?.disconnect().catch(() => undefined);
    navigate('/labs');
  };

  // ── Streaming view ────────────────────────────────────────────────────────
  if (phase === 'streaming') {
    return (
      <div className="app">
        <div className="video-layer">
          <div className="video-overlay" />
          <video
            ref={videoRef}
            className={`video-element ${streamState === 'streaming' ? '' : 'is-hidden'}`}
            autoPlay
            playsInline
            muted
          />
        </div>

        <div className="ui">
          <header className="top-bar">
            <button className="btn ghost back-to-landing" onClick={handleBack}>
              Back
            </button>
            <button className="btn ghost" onClick={handleTryAnother} style={{ marginLeft: 'auto' }}>
              Try another
            </button>
          </header>

          <main className="slide-shell" />

          <footer className="story-bar">
            <div className="story-text">
              <p>Your photo is alive — say something</p>
            </div>
            <div className="story-actions">
              {getSpeechRecognition() && (
                isListening ? (
                  <button
                    className="voice-orb voice-orb--listening"
                    onClick={toggleListening}
                    aria-label="Stop listening"
                  >
                    <img
                      className="recording-icon"
                      src="/images/recording_icon_v3.png"
                      alt=""
                      aria-hidden="true"
                    />
                  </button>
                ) : (
                  <button
                    className="btn accent ptt-btn"
                    onClick={toggleListening}
                    aria-label="Speak your prompt"
                  >
                    <img
                      className="recording-icon"
                      src="/images/recording_icon_v3.png"
                      alt=""
                      aria-hidden="true"
                    />
                  </button>
                )
              )}
              <div className="prompt-input">
                <input
                  type="text"
                  value={textPrompt}
                  onChange={(e) => setTextPrompt(e.target.value)}
                  onKeyDown={handleTextKeyDown}
                  placeholder="say something…"
                  disabled={!isStreamingReady}
                />
                <button className="btn ghost" onClick={handleSendPrompt} disabled={!isStreamingReady}>
                  Send
                </button>
              </div>
            </div>
          </footer>
        </div>
      </div>
    );
  }

  // ── Processing view ───────────────────────────────────────────────────────
  if (phase === 'processing') {
    return (
      <div className="atrium drawn-to-life">
        <AtriumNav />
        <div className="dtl-processing">
          <div className="dtl-spinner" />
          <p className="dtl-processing-label">{processingStep}</p>
        </div>
      </div>
    );
  }

  // ── Upload view ───────────────────────────────────────────────────────────
  return (
    <div className="atrium drawn-to-life">
      <AtriumNav />
      <main className="dtl-main">
        <div className="dtl-intro">
          <span className="eyebrow">
            <span className="eyebrow__dot" /> The Lab
          </span>
          <h1 className="dtl-heading">Drawn to Life</h1>
          <p className="lede">A photo goes in. The character sees it, thinks about it, and has things to say.</p>
        </div>

        <label className={`dtl-upload${uploadedFile ? ' has-file' : ''}`}>
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          {previewUrl ? (
            <img src={previewUrl} alt="Your photo" className="dtl-upload-preview" />
          ) : (
            <div className="dtl-upload-placeholder">
              <span className="dtl-upload-icon">✏️</span>
              <span>Upload a photo</span>
              <span className="dtl-upload-hint">tap to choose</span>
            </div>
          )}
        </label>

        <div className="dtl-styles">
          {STYLES.map((s) => (
            <button
              key={s.value}
              className={`dtl-style-btn${selectedStyle === s.value ? ' selected' : ''}`}
              onClick={() => setSelectedStyle(s.value)}
              type="button"
            >
              <span className="dtl-style-label">{s.label}</span>
              <span className="dtl-style-desc">{s.description}</span>
            </button>
          ))}
        </div>

        {error && <p className="dtl-error">{error}</p>}

        <button
          className="btn btn--primary dtl-cta"
          onClick={handleBringToLife}
          disabled={!uploadedFile}
        >
          Bring to Life
        </button>
      </main>
    </div>
  );
}
