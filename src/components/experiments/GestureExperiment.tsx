import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/odyssey';

const POLL_INTERVAL_MS = 1500;
const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. React expressively to the user\'s gestures and body language. Keep every reply under 20 words.';

export default function GestureExperiment() {
  const navigate   = useNavigate();
  const { status, error, videoRef: odysseyVideoRef, startStream, interact, disconnect } = useOdysseyStream();

  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pollingRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);

  const [webcamActive, setWebcamActive] = useState(false);
  const [lastGesture, setLastGesture] = useState<string | null>(null);
  const [lastReply,   setLastReply]   = useState<string | null>(null);
  const [detecting,   setDetecting]   = useState(false);

  // Start character stream once Odyssey is ready
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

  const stopWebcam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (webcamVideoRef.current) webcamVideoRef.current.srcObject = null;
    setWebcamActive(false);
    stopPolling();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const captureFrame = useCallback((): Blob | null => {
    const video  = webcamVideoRef.current;
    const canvas = webcamCanvasRef.current;
    if (!video || !canvas) return null;
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    let result: Blob | null = null;
    canvas.toBlob((b) => { result = b; }, 'image/jpeg', 0.7);
    return result;
  }, []);

  const pollGesture = useCallback(async () => {
    if (detecting) return;
    const blob = captureFrame();
    if (!blob) return;

    setDetecting(true);
    try {
      const fd = new FormData();
      fd.append('image', blob, 'frame.jpg');
      const res = await fetch('/api/gesture-vision', { method: 'POST', body: fd });
      if (!res.ok) return;
      const { gesture } = await res.json() as { gesture: string };
      if (gesture && gesture !== lastGesture) {
        setLastGesture(gesture);
        const prompt = `The user is ${gesture}. React to that gesture expressively in one sentence.`;
        await interact(prompt);
        setLastReply(gesture);
      }
    } catch { /* ignore */ } finally {
      setDetecting(false);
    }
  }, [detecting, captureFrame, lastGesture, interact]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(() => void pollGesture(), POLL_INTERVAL_MS);
  }, [pollGesture]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }, []);

  useEffect(() => { return () => { stopPolling(); stopWebcam(); }; }, [stopPolling, stopWebcam]);

  const handleBack = useCallback(async () => {
    stopPolling(); stopWebcam();
    await disconnect();
    navigate('/characters');
  }, [disconnect, navigate, stopPolling, stopWebcam]);

  return (
    <div className="experiment-shell">
      <header className="experiment-topbar">
        <button className="btn ghost" onClick={handleBack}>← Back</button>
        <h1>Gesture Detection</h1>
        <span className="exp-badge">Experiment 2</span>
      </header>

      <div className="experiment-body">
        {/* Odyssey character */}
        <div className="experiment-video-panel">
          <video ref={odysseyVideoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        {/* Webcam + controls */}
        <aside className="experiment-side-panel">
          <div className="experiment-status">
            {status === 'connecting' ? 'Waking up Einstein…' :
             status === 'ready' || status === 'streaming' ? 'Turn on your webcam to start.' :
             status === 'error' ? `Error: ${error}` : status}
          </div>

          {/* Small webcam preview */}
          <div className="webcam-preview-box">
            <video
              ref={webcamVideoRef}
              autoPlay
              playsInline
              muted
              style={{ width: '100%', borderRadius: 8, background: '#111', display: webcamActive ? 'block' : 'none' }}
            />
            {!webcamActive && (
              <div className="webcam-placeholder">Camera off</div>
            )}
          </div>

          <canvas ref={webcamCanvasRef} style={{ display: 'none' }} />

          {!webcamActive ? (
            <button className="exp-btn primary" onClick={startWebcam} disabled={status !== 'streaming' && status !== 'ready'}>
              Turn on Webcam
            </button>
          ) : (
            <>
              {!pollingRef.current ? (
                <button className="exp-btn primary" onClick={startPolling}>Start Detecting</button>
              ) : (
                <button className="exp-btn danger" onClick={stopPolling}>Stop Detecting</button>
              )}
              <button className="exp-btn ghost" onClick={stopWebcam}>Turn off Webcam</button>
            </>
          )}

          {lastGesture && (
            <div className="exp-reply">
              <strong style={{ display: 'block', marginBottom: 4, fontSize: '0.75rem', color: 'rgba(121,150,255,0.8)' }}>Detected gesture</strong>
              {lastGesture}
            </div>
          )}
          {lastReply && (
            <div className="exp-reply">
              <strong style={{ display: 'block', marginBottom: 4, fontSize: '0.75rem', color: 'rgba(121,150,255,0.8)' }}>Einstein reacted to</strong>
              {lastReply}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
