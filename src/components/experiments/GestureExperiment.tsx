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

// Gestures validated via A/B test (leaning_forward + leaning_back removed —
// failed across all prompt variants).
const GESTURE_EMOJI: Record<string, string> = {
  hello: '\u{1F44B}', thumbs_up: '\u{1F44D}', victory: '✌️',
  namaste: '\u{1F64F}', pointing: '\u{1F449}', thinking: '\u{1F914}',
  shrug: '\u{1F937}', crossed_arms: '\u{1F645}', facepalm: '\u{1F926}',
  clapping: '\u{1F44F}',
};

// ── Game constants ────────────────────────────────────────────────────────────
const TOTAL_GESTURES  = Object.keys(GESTURE_EMOJI).length; // 10
const GAME_DURATION_S = 180; // 3 minutes

const getTodayKey = () =>
  `gesture-game-${new Date().toISOString().slice(0, 10)}`;

const getEncouragement = (score: number): string => {
  if (score === 10) return 'Perfect — Einstein has no secrets from you.';
  if (score >= 7)   return 'Sharp. A few reactions still hiding.';
  if (score >= 4)   return "Good run. Einstein's holding back.";
  return 'Einstein kept most of his cards close.';
};

type GameState = 'idle' | 'playing' | 'finished';

export default function GestureExperiment() {
  const navigate   = useNavigate();
  const { status, error, videoRef: odysseyVideoRef, startStream, interact, disconnect } = useOdysseyStream();

  const webcamVideoRef  = useRef<HTMLVideoElement | null>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pollingRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef       = useRef<MediaStream | null>(null);

  // Existing detection state
  const [webcamActive, setWebcamActive] = useState(false);
  const [lastGesture, setLastGesture]   = useState<string | null>(null);
  const [isPolling, setIsPolling]       = useState(false);
  const [detecting, setDetecting]       = useState(false);

  // ── Game state ──────────────────────────────────────────────────────────────
  const [gameState, setGameState]         = useState<GameState>('idle');
  const [discovered, setDiscovered]       = useState<Set<string>>(new Set());
  const [timeLeft, setTimeLeft]           = useState(GAME_DURATION_S);
  const [alreadyPlayed, setAlreadyPlayed] = useState<{ score: number; finishedAt: string } | null>(null);
  const [lastFlash, setLastFlash]         = useState<string | null>(null);
  const [shareCopied, setShareCopied]     = useState(false);

  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const discoveredRef = useRef<Set<string>>(new Set()); // mirrors state — safe in callbacks

  // ── Odyssey: start stream when ready ─────────────────────────────────────
  useEffect(() => {
    if (status !== 'ready') return;
    const run = async () => {
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: true });
    };
    void run();
  }, [status, startStream]);

  // ── Game: check if already played today ──────────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem(getTodayKey());
    if (stored) {
      try { setAlreadyPlayed(JSON.parse(stored) as { score: number; finishedAt: string }); }
      catch { /* malformed — ignore */ }
    }
  }, []);

  // ── Webcam helpers ────────────────────────────────────────────────────────
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

  // ── Game: finish ──────────────────────────────────────────────────────────
  const finishGame = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    stopPolling();
    const result = { score: discoveredRef.current.size, finishedAt: new Date().toISOString() };
    localStorage.setItem(getTodayKey(), JSON.stringify(result));
    setGameState('finished');
  }, [stopPolling]);

  // ── Game: timer expiry watcher ────────────────────────────────────────────
  useEffect(() => {
    if (timeLeft === 0 && gameState === 'playing') finishGame();
  }, [timeLeft, gameState, finishGame]);

  // ── Game: start ───────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    if (gameState !== 'idle') return;
    // Record attempt immediately — prevents refresh exploit
    localStorage.setItem(getTodayKey(), JSON.stringify({ score: 0, finishedAt: new Date().toISOString() }));
    discoveredRef.current = new Set();
    setDiscovered(new Set());
    setTimeLeft(GAME_DURATION_S);
    setGameState('playing');
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => Math.max(0, prev - 1));
    }, 1000);
    // startPolling is defined below — we call it indirectly via ref to avoid circular dep
    pollingRef.current = setInterval(() => void pollGestureRef.current?.(), POLL_INTERVAL_MS);
    setIsPolling(true);
  }, [gameState]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopGame = useCallback(() => { finishGame(); }, [finishGame]);

  // ── Gesture polling ───────────────────────────────────────────────────────
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

      if (res.status === 429) { stopPolling(); return; }
      if (!res.ok) return;

      const { gesture } = await res.json() as { gesture: string };

      // ── Game: track new discoveries ────────────────────────────────────
      if (gesture && gesture !== 'none' && gameState === 'playing') {
        if (!discoveredRef.current.has(gesture)) {
          discoveredRef.current.add(gesture);
          setDiscovered(new Set(discoveredRef.current));
          setLastFlash(gesture);
          setTimeout(() => setLastFlash(null), 1200);
          if (discoveredRef.current.size >= TOTAL_GESTURES) finishGame();
        }
      }

      // ── Existing: react when gesture changes ───────────────────────────
      if (gesture && gesture !== 'none' && gesture !== lastGesture) {
        setLastGesture(gesture);
        const label = gesture.replace(/_/g, ' ');
        await interact(`The user just did ${label}. React!`);
      }
    } catch { /* network error — skip this cycle */ } finally {
      setDetecting(false);
    }
  }, [detecting, captureFrame, lastGesture, interact, stopPolling, gameState, finishGame]);

  // Keep a ref so startGame can reference pollGesture without a circular dep
  const pollGestureRef = useRef(pollGesture);
  pollGestureRef.current = pollGesture;

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(() => void pollGesture(), POLL_INTERVAL_MS);
    setIsPolling(true);
  }, [pollGesture]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      stopPolling();
      stopWebcam();
    };
  }, [stopPolling, stopWebcam]);

  // ── Navigation ────────────────────────────────────────────────────────────
  const handleBack = useCallback(async () => {
    stopPolling(); stopWebcam();
    await disconnect();
    navigate('/labs');
  }, [disconnect, navigate, stopPolling, stopWebcam]);

  // ── Share ─────────────────────────────────────────────────────────────────
  const handleShare = useCallback(async (score: number) => {
    const text = `I found ${score}/10 of Einstein's reactions in 3 minutes. Can you beat me? interactstudio.space/lab/gesture`;
    try {
      await navigator.clipboard.writeText(text);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch { /* silent — clipboard unavailable */ }
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const timerDisplay = `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;
  const timerUrgent  = timeLeft <= 30 && gameState === 'playing';

  // Suppress unused-variable warning for handleBack — keep for future nav needs
  void handleBack; void startPolling; void isPolling;

  return (
    <div className="atrium body-language">
      <AtriumNav />

      <main className="bl-main">
        <div className="bl-intro">
          <span className="eyebrow">
            <span className="eyebrow__dot" /> The Lab
          </span>
          <h1 className="bl-heading">Body Language</h1>
          <p className="lede">Einstein has baked-in reactions to 10 gestures. You have 3 minutes to find them all.</p>
        </div>
      </main>

      <div className="bl-body">
        <div className="bl-video-panel">
          <video ref={odysseyVideoRef} autoPlay playsInline muted />
        </div>

        <aside className="bl-side-panel">

          {/* ── Already played today ──────────────────────────────────── */}
          {alreadyPlayed && gameState === 'idle' ? (
            <div className="bl-already-played">
              <p className="bl-already-played__score">
                You found <strong>{alreadyPlayed.score} / {TOTAL_GESTURES}</strong> today.
              </p>
              <p className="bl-already-played__sub">Come back tomorrow for another attempt.</p>
            </div>

          ) : gameState === 'finished' ? (
            /* ── Results screen ─────────────────────────────────────── */
            <div className="bl-results">
              <div className="bl-results__score">{discovered.size} / {TOTAL_GESTURES}</div>
              <p className="bl-results__encouragement">{getEncouragement(discovered.size)}</p>
              <button
                className="bl-btn bl-btn--primary"
                onClick={() => void handleShare(discovered.size)}
              >
                {shareCopied ? 'Copied!' : 'Share Result'}
              </button>
              <p className="bl-results__return">Come back tomorrow for another attempt.</p>
            </div>

          ) : (
            /* ── Active game UI ─────────────────────────────────────── */
            <>
              <div className="bl-status">
                {status === 'connecting' ? 'Waking up Einstein…' :
                 status === 'ready' || status === 'streaming' ? 'Turn on your webcam to start.' :
                 status === 'error' ? `Error: ${error}` : status}
              </div>

              <div className="bl-webcam-box">
                {webcamActive ? (
                  <video ref={webcamVideoRef} autoPlay playsInline muted />
                ) : (
                  <span className="bl-webcam-placeholder">Camera off</span>
                )}
              </div>

              {/* Hidden ref for webcam — needed when not yet active */}
              {!webcamActive && <video ref={webcamVideoRef} style={{ display: 'none' }} />}
              <canvas ref={webcamCanvasRef} style={{ display: 'none' }} />

              {!webcamActive ? (
                <button
                  className="bl-btn bl-btn--primary"
                  onClick={startWebcam}
                  disabled={status !== 'streaming' && status !== 'ready'}
                >
                  Turn on Webcam
                </button>
              ) : (
                <>
                  {gameState === 'idle' ? (
                    <button className="bl-btn bl-btn--primary" onClick={startGame}>
                      Start Detecting
                    </button>
                  ) : (
                    <button className="bl-btn bl-btn--danger" onClick={stopGame}>
                      Stop
                    </button>
                  )}
                  <button className="bl-btn bl-btn--ghost" onClick={stopWebcam}>
                    Turn off Webcam
                  </button>
                </>
              )}

              {/* Timer + counter row — only visible while playing */}
              {gameState === 'playing' && (
                <div className="bl-game-row">
                  <div className={`bl-timer${timerUrgent ? ' bl-timer--urgent' : ''}`}>
                    {timerDisplay}
                  </div>
                  {/* key={discovered.size} forces remount so animation replays on each find */}
                  <div
                    key={discovered.size}
                    className={`bl-counter${lastFlash ? ' bl-counter-bump' : ''}`}
                  >
                    {discovered.size} / {TOTAL_GESTURES}
                  </div>
                </div>
              )}

              {/* Brief flash on new find — replaces old .bl-detected card */}
              {lastFlash && <div className="bl-flash">New reaction found!</div>}
            </>
          )}

        </aside>
      </div>
    </div>
  );
}
