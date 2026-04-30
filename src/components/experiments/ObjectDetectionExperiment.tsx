import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ObjectDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/odyssey';

const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. React with genuine curiosity and wit to everyday objects the user shows you. Keep every reply under 25 words.';
const DETECT_INTERVAL_MS = 1200;

export default function ObjectDetectionExperiment() {
  const navigate = useNavigate();
  const { status, error, videoRef: odysseyVideoRef, startStream, interact, disconnect } = useOdysseyStream();

  const webcamRef    = useRef<HTMLVideoElement | null>(null);
  const canvasRef    = useRef<HTMLCanvasElement | null>(null);
  const detectorRef  = useRef<ObjectDetector | null>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const lastObjectsRef = useRef<string>('');
  const detectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [webcamActive, setWebcamActive] = useState(false);
  const [objects, setObjects] = useState<string[]>([]);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // Load MediaPipe ObjectDetector
  useEffect(() => {
    const loadModel = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm'
        );
        const detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
            delegate: 'GPU',
          },
          runningMode:   'VIDEO',
          scoreThreshold: 0.45,
          maxResults:    5,
        });
        detectorRef.current = detector;
        setModelLoaded(true);
      } catch (err) {
        setModelError(err instanceof Error ? err.message : 'Model load failed.');
      }
    };
    void loadModel();
    return () => { detectorRef.current?.close(); };
  }, []);

  // Start character stream when Odyssey is ready
  useEffect(() => {
    if (status !== 'ready') return;
    const run = async () => {
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: true });
    };
    void run();
  }, [status, startStream]);

  const startWebcam = useCallback(async () => {
    const ms = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    streamRef.current = ms;
    if (webcamRef.current) {
      webcamRef.current.srcObject = ms;
      await webcamRef.current.play();
    }
    setWebcamActive(true);
  }, []);

  const stopWebcam = useCallback(() => {
    if (detectTimerRef.current) { clearInterval(detectTimerRef.current); detectTimerRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (webcamRef.current) webcamRef.current.srcObject = null;
    setWebcamActive(false);
  }, []);

  const detectFrame = useCallback(() => {
    const detector = detectorRef.current;
    const video    = webcamRef.current;
    const canvas   = canvasRef.current;
    if (!detector || !video || video.readyState < 2 || !canvas) return;

    const now = performance.now();
    const result = detector.detectForVideo(video, now);
    const detected = result.detections.map((d) => d.categories[0]?.categoryName ?? '').filter(Boolean);
    setObjects(detected);

    // Draw bounding boxes
    const ctx = canvas.getContext('2d');
    if (ctx) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      ctx.strokeStyle = '#7996ff';
      ctx.lineWidth   = 2;
      ctx.font        = '14px sans-serif';
      ctx.fillStyle   = '#7996ff';
      for (const det of result.detections) {
        const bb = det.boundingBox!;
        ctx.strokeRect(bb.originX, bb.originY, bb.width, bb.height);
        const label = `${det.categories[0]?.categoryName ?? ''} ${((det.categories[0]?.score ?? 0) * 100).toFixed(0)}%`;
        ctx.fillText(label, bb.originX + 4, bb.originY + 16);
      }
    }

    // React when detected set changes
    const key = [...detected].sort().join(',');
    if (key && key !== lastObjectsRef.current) {
      lastObjectsRef.current = key;
      const prompt = detected.length === 1
        ? `The user is holding up a ${detected[0]}. React with genuine curiosity in one vivid sentence.`
        : `The user is showing you: ${detected.join(', ')}. Comment on the most interesting one in one sentence.`;
      void interact(prompt);
    }
  }, [interact]);

  const startDetecting = useCallback(() => {
    if (detectTimerRef.current) return;
    detectTimerRef.current = setInterval(detectFrame, DETECT_INTERVAL_MS);
  }, [detectFrame]);

  const stopDetecting = useCallback(() => {
    if (detectTimerRef.current) { clearInterval(detectTimerRef.current); detectTimerRef.current = null; }
  }, []);

  useEffect(() => { return () => { stopDetecting(); stopWebcam(); }; }, [stopDetecting, stopWebcam]);

  const handleBack = useCallback(async () => {
    stopDetecting(); stopWebcam();
    await disconnect();
    navigate('/characters');
  }, [disconnect, navigate, stopDetecting, stopWebcam]);

  return (
    <div className="experiment-shell">
      <header className="experiment-topbar">
        <button className="btn ghost" onClick={handleBack}>← Back</button>
        <h1>Object Detection</h1>
        <span className="exp-badge">Experiment 3</span>
      </header>

      <div className="experiment-body">
        {/* Character + webcam overlay */}
        <div className="experiment-video-panel" style={{ flexDirection: 'column' }}>
          <video ref={odysseyVideoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
          {/* Canvas shows webcam with detected bounding boxes */}
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              bottom: 16,
              right: 16,
              width: 220,
              height: 165,
              borderRadius: 10,
              border: '1px solid rgba(121,150,255,0.4)',
              background: '#000',
              display: webcamActive ? 'block' : 'none',
            }}
          />
          <video ref={webcamRef} autoPlay playsInline muted style={{ display: 'none' }} />
        </div>

        <aside className="experiment-side-panel">
          <div className="experiment-status">
            {!modelLoaded && !modelError && 'Loading object detection model…'}
            {modelError && `Model error: ${modelError}`}
            {modelLoaded && status === 'connecting' && 'Waking up Einstein…'}
            {modelLoaded && (status === 'ready' || status === 'streaming') && 'Turn on webcam and hold something up.'}
            {status === 'error' && `Odyssey error: ${error}`}
          </div>

          {!webcamActive ? (
            <button
              className="exp-btn primary"
              onClick={startWebcam}
              disabled={!modelLoaded || (status !== 'streaming' && status !== 'ready')}
            >
              Turn on Webcam
            </button>
          ) : (
            <>
              {!detectTimerRef.current ? (
                <button className="exp-btn primary" onClick={startDetecting}>Start Detecting</button>
              ) : (
                <button className="exp-btn danger" onClick={stopDetecting}>Pause</button>
              )}
              <button className="exp-btn ghost" onClick={stopWebcam}>Turn off Webcam</button>
            </>
          )}

          {objects.length > 0 && (
            <div className="exp-reply">
              <strong style={{ display: 'block', marginBottom: 6, fontSize: '0.75rem', color: 'rgba(121,150,255,0.8)' }}>Detected objects</strong>
              {objects.map((o, i) => (
                <div key={i} style={{ fontSize: '0.85rem', padding: '3px 0' }}>• {o}</div>
              ))}
            </div>
          )}

          <p style={{ fontSize: '0.75rem', color: 'rgba(231,237,246,0.35)', marginTop: 'auto' }}>
            Powered by MediaPipe EfficientDet — runs fully in your browser, nothing sent to a server.
          </p>
        </aside>
      </div>
    </div>
  );
}
