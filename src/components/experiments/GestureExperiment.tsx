import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/odyssey';
import { AtriumNav } from '../../demo/atrium/Layout';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';
import './GestureExperiment.css';

const POLL_INTERVAL_MS = 1500;
const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. React expressively to the user\'s gestures and body language. Keep every reply under 20 words.';

const GESTURE_EMOJI: Record<string, string> = {
  hello: '\u{1F44B}', thumbs_up: '\u{1F44D}', victory: '✌️',
  namaste: '\u{1F64F}', pointing: '\u{1F449}', thinking: '\u{1F914}',
  shrug: '\u{1F937}', crossed_arms: '\u{1F645}', leaning_forward: '\u{1F9D0}',
  leaning_back: '\u{1F60C}', facepalm: '\u{1F926}', clapping: '\u{1F44F}',
};

export default function GestureExperiment() {
  const navigate   = useNavigate();
  const { status, error, videoRef: odysseyVideoRef, startStream, interact, disconnect } = useOdysseyStream();

  const webcamVideoRef  = useRef<HTMLVideoElement | null>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pollingRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef       = useRef<MediaStream | null>(null);

  const [webcamActive, setWebcamActive] = useState(false);
  const [lastGesture, setLastGesture]   = useState<string | null>(null);
  const [isPolling, setIsPolling]       = useState(false);
  const [detecting, setDetecting]       = useState(false);

  useEffect(() => {
    if (status !== 'ready') return;
    const run = async () => {
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: true });
    };
    void run();
  }, [status, startStream]);

  const startWebcam = useCallback(async () => {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      streamRef.current = ms;
      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = ms;
        await webcamVideoRef.current.play();
      }
      setWebcamActive(true);
    } catch {
      alert('Webcam access denied.');
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    setIsPolling(false);
  }, []);

  const stopWebcam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (webcamVideoRef.current) webcamVideoRef.current.srcObject = null;
    setWebcamActive(false);
    stopPolling();
  }, [stopPolling]);

  const captureFrame = useCallback((): string | null => {
    const video  = webcamVideoRef.current;
    const canvas = webcamCanvasRef.current;
    if (!video || !canvas) return null;
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.7);
  }, []);

  const pollGesture = useCallback(async () => {
    if (detecting) return;
    const dataUrl = captureFrame();
    if (!dataUrl) return;

    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';

    setDetecting(true);
    try {
      const res = await fetch('/api/gesture-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, mimeType }),
      });

      if (res.status === 429) {
        stopPolling();
        return;
      }
      if (!res.ok) return;

      const { gesture } = await res.json() as { gesture: string };
      if (gesture && gesture !== 'none' && gesture !== lastGesture) {
        setLastGesture(gesture);
        const label = gesture.replace(/_/g, ' ');
        await interact(`The user is ${label}. React to this body language expressively in one sentence.`);
      }
    } catch { /* network error — skip this cycle */ } finally {
      setDetecting(false);
    }
  }, [detecting, captureFrame, lastGesture, interact, stopPolling]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(() => void pollGesture(), POLL_INTERVAL_MS);
    setIsPolling(true);
  }, [pollGesture]);

  useEffect(() => { return () => { stopPolling(); stopWebcam(); }; }, [stopPolling, stopWebcam]);

  const handleBack = useCallback(async () => {
    stopPolling(); stopWebcam();
    await disconnect();
    navigate('/labs');
  }, [disconnect, navigate, stopPolling, stopWebcam]);

  return (
    <div className="atrium body-language">
      <AtriumNav />

      <main className="bl-main">
        <div className="bl-intro">
          <span className="eyebrow">
            <span className="eyebrow__dot" /> The Lab
          </span>
          <h1 className="bl-heading">Body Language</h1>
          <p className="lede">Move your hands, lean in, point — Einstein reads your body and responds.</p>
        </div>
      </main>

      <div className="bl-body">
        <div className="bl-video-panel">
          <video ref={odysseyVideoRef} autoPlay playsInline muted />
        </div>

        <aside className="bl-side-panel">
          <div className="bl-status">
            {status === 'connecting' ? 'Waking up Einstein…' :
             status === 'ready' || status === 'streaming' ? 'Turn on your webcam to start.' :
             status === 'error' ? `Error: ${error}` : status}
          </div>

          <div className="bl-webcam-box">
            {webcamActive ? (
              <video
                ref={webcamVideoRef}
                autoPlay
                playsInline
                muted
              />
            ) : (
              <span className="bl-webcam-placeholder">Camera off</span>
            )}
          </div>

          {/* Hidden ref for webcam — needed when not yet active */}
          {!webcamActive && <video ref={webcamVideoRef} style={{ display: 'none' }} />}
          <canvas ref={webcamCanvasRef} style={{ display: 'none' }} />

          {!webcamActive ? (
            <button className="bl-btn bl-btn--primary" onClick={startWebcam} disabled={status !== 'streaming' && status !== 'ready'}>
              Turn on Webcam
            </button>
          ) : (
            <>
              {!isPolling ? (
                <button className="bl-btn bl-btn--primary" onClick={startPolling}>Start Detecting</button>
              ) : (
                <button className="bl-btn bl-btn--danger" onClick={stopPolling}>Stop Detecting</button>
              )}
              <button className="bl-btn bl-btn--ghost" onClick={stopWebcam}>Turn off Webcam</button>
            </>
          )}

          {lastGesture && (
            <div className="bl-detected">
              <span className="bl-detected__emoji">{GESTURE_EMOJI[lastGesture] ?? ''}</span>
              <div className="bl-detected__info">
                <span className="bl-detected__label">Detected</span>
                <span className="bl-detected__gesture">{lastGesture.replace(/_/g, ' ')}</span>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
