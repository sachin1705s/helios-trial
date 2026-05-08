import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { OdysseyService, credentialsFromDict, type StreamState } from '../../lib/odyssey';
import { AtriumNav } from '../../demo/atrium/Layout';
import DrawCanvasModal from './DrawCanvasModal';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';
import './DrawingExperiment.css';

type Phase = 'upload' | 'processing' | 'streaming';
type Style = 'manga' | 'comic' | 'realism' | 'ghibli-inspired';
type Source = 'upload' | 'draw';

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


/**
 * Center-crop an image file to match the current viewport aspect ratio.
 * Returns a new File with the cropped result (PNG).
 */
function cropToViewport(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const viewportRatio = window.innerWidth / window.innerHeight;
      const imgRatio = img.naturalWidth / img.naturalHeight;

      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;

      if (imgRatio > viewportRatio) {
        // Image is wider than viewport — crop sides
        sw = Math.round(img.naturalHeight * viewportRatio);
        sx = Math.round((img.naturalWidth - sw) / 2);
      } else {
        // Image is taller than viewport — crop top/bottom
        sh = Math.round(img.naturalWidth / viewportRatio);
        sy = Math.round((img.naturalHeight - sh) / 2);
      }

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(file); return; }

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      canvas.toBlob(
        (blob) => {
          if (!blob) { resolve(file); return; }
          resolve(new File([blob], file.name, { type: 'image/png' }));
        },
        'image/png',
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}

export default function DrawingExperiment() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('upload');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [showDrawCanvas, setShowDrawCanvas] = useState(false);
  const [selectedStyle, setSelectedStyle] = useState<Style>('manga');
  const [error, setError] = useState<string | null>(null);
  const [processingStep, setProcessingStep] = useState('');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [isStreamingReady, setIsStreamingReady] = useState(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [skipStylize, setSkipStylize] = useState(false);

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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 18 * 1024 * 1024) {
      setError('Photo is too large. Please choose an image under 18 MB.');
      return;
    }
    setError(null);
    setSource('upload');

    try {
      const cropped = await cropToViewport(file);
      setUploadedFile(cropped);
      const url = URL.createObjectURL(cropped);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch {
      setUploadedFile(file);
      const url = URL.createObjectURL(file);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    }
  };

  const handleDrawingDone = useCallback((file: File, dataUrl: string) => {
    setUploadedFile(file);
    setSource('draw');
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return dataUrl;
    });
    setShowDrawCanvas(false);
    setError(null);
  }, []);

  const handleDrawCancel = useCallback(() => setShowDrawCanvas(false), []);

  const handleBringToLife = async () => {
    if (!uploadedFile) return;
    setPhase('processing');
    setError(null);

    try {
      let stylizedFile: File;

      if (import.meta.env.DEV && skipStylize) {
        setProcessingStep('Skipping stylization (dev mode)…');
        // Use a neutral placeholder so Odyssey's content policy never triggers.
        // We only care that the stream connects and the UI works in dev.
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 288; // 16:9
        const ctx = canvas.getContext('2d')!;
        const grad = ctx.createLinearGradient(0, 0, 512, 288);
        grad.addColorStop(0, '#2F5E48');
        grad.addColorStop(1, '#0E1614');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 512, 288);
        ctx.fillStyle = 'rgba(245,241,232,0.15)';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Dev placeholder', 256, 150);
        const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
        stylizedFile = new File([blob], 'placeholder.png', { type: 'image/png' });
      } else {
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
        stylizedFile = new File([bytes], 'photo.png', { type: stylizedMime || 'image/png' });
      }

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
            service.startStream({ image: stylizedFile, portrait: false }).catch((err: unknown) => {
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
      const raw = err instanceof Error ? err.message : '';
      const lower = raw.toLowerCase();
      const message =
        lower.includes('terms of service') || lower.includes('violates') || lower.includes('policy')
          ? "We couldn't process this image — try a different photo."
          : raw || 'Something went wrong. Please try again.';
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
    setSource(null);
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
      <div className="atrium dtl-stream">
        <video
          ref={videoRef}
          className={`dtl-stream__video ${streamState === 'streaming' ? '' : 'is-hidden'}`}
          autoPlay
          playsInline
          muted
        />

        <header className="dtl-stream__header">
          <button className="dtl-stream__btn" onClick={handleBack}>
            ← Back
          </button>
          <button className="dtl-stream__btn" onClick={handleTryAnother}>
            Try another
          </button>
        </header>

        <footer className="dtl-stream__footer">
          <div className="dtl-pill">
            <input
              type="text"
              className="dtl-pill__input"
              value={textPrompt}
              onChange={(e) => setTextPrompt(e.target.value)}
              onKeyDown={handleTextKeyDown}
              placeholder="say something…"
              disabled={!isStreamingReady}
            />
            {isListening ? (
              <button
                type="button"
                className="dtl-pill__action dtl-pill__action--listening"
                onClick={toggleListening}
                aria-label="Listening — tap to stop"
              >
                <span className="dtl-pill__pulse" aria-hidden />
              </button>
            ) : textPrompt.trim().length > 0 ? (
              <button
                type="button"
                className="dtl-pill__action dtl-pill__action--send"
                onClick={handleSendPrompt}
                disabled={!isStreamingReady}
                aria-label="Send message"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 2L11 13" />
                  <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            ) : getSpeechRecognition() ? (
              <button
                type="button"
                className="dtl-pill__action dtl-pill__action--mic"
                onClick={toggleListening}
                disabled={!isStreamingReady}
                aria-label="Speak your prompt"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="dtl-pill__action dtl-pill__action--send"
                onClick={handleSendPrompt}
                disabled={!isStreamingReady}
                aria-label="Send message"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 2L11 13" />
                  <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            )}
          </div>
        </footer>
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

        <div className="dtl-source-row">
          <label className={`dtl-upload${source === 'upload' && previewUrl ? ' has-file' : ''}`}>
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            {source === 'upload' && previewUrl ? (
              <img src={previewUrl} alt="Your photo" className="dtl-upload-preview" />
            ) : (
              <div className="dtl-upload-placeholder">
                <span className="dtl-upload-icon" aria-hidden>📷</span>
                <span>Upload a photo</span>
                <span className="dtl-upload-hint">tap to choose</span>
              </div>
            )}
          </label>

          <button
            type="button"
            className={`dtl-upload dtl-draw${source === 'draw' && previewUrl ? ' has-file' : ''}`}
            onClick={() => setShowDrawCanvas(true)}
          >
            {source === 'draw' && previewUrl ? (
              <img src={previewUrl} alt="Your drawing" className="dtl-upload-preview" />
            ) : (
              <div className="dtl-upload-placeholder">
                <span className="dtl-upload-icon" aria-hidden>✏️</span>
                <span>Draw it</span>
                <span className="dtl-upload-hint">tap to sketch</span>
              </div>
            )}
          </button>
        </div>

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

        {import.meta.env.DEV && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.78rem', color: 'var(--ink-soft)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={skipStylize}
              onChange={(e) => setSkipStylize(e.target.checked)}
            />
            Skip AI styling (dev — saves quota)
          </label>
        )}

        <button
          className="btn btn--primary dtl-cta"
          onClick={handleBringToLife}
          disabled={!uploadedFile}
        >
          Bring to Life
        </button>
      </main>

      {showDrawCanvas && createPortal(
        <DrawCanvasModal onCancel={handleDrawCancel} onDone={handleDrawingDone} />,
        document.body,
      )}
    </div>
  );
}
