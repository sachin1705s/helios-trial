import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/odyssey';
import { applySeo, SEO_PAGES } from '../../lib/seo';
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

// ── Canvas score card ─────────────────────────────────────────────────────────
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number,
  maxWidth: number, lineHeight: number,
): void {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line.trim(), x, y);
      line = word + ' ';
      y += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line.trim(), x, y);
}

function drawScoreCard(
  canvas: HTMLCanvasElement,
  score: number,
  encouragement: string,
  einsteinImg: HTMLImageElement,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = 1080, H = 1080;

  // Background
  ctx.fillStyle = '#0E1614';
  ctx.fillRect(0, 0, W, H);

  // Inset panel fill
  ctx.fillStyle = '#19251F';
  roundRectPath(ctx, 60, 60, 960, 960, 32);
  ctx.fill();

  // Inset panel border
  ctx.strokeStyle = '#2F5E48';
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, 60, 60, 960, 960, 32);
  ctx.stroke();

  // Einstein portrait
  ctx.drawImage(einsteinImg, W / 2 - 160, 100, 320, 320);

  // Score numeral
  ctx.font = '700 200px Fraunces, Georgia, serif';
  ctx.fillStyle = '#F5F1E8';
  ctx.textAlign = 'center';
  ctx.fillText(String(score), W / 2, 590);

  // /10
  ctx.font = '400 48px Fraunces, Georgia, serif';
  ctx.fillStyle = '#6B7B72';
  ctx.fillText('/ 10', W / 2, 650);

  // Encouragement (word-wrapped)
  ctx.font = '400 36px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#F5F1E8';
  wrapText(ctx, encouragement, W / 2, 720, 640, 44);

  // Divider
  ctx.strokeStyle = '#2F5E48';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(200, 800); ctx.lineTo(880, 800);
  ctx.stroke();

  // URL footer
  ctx.font = '500 28px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#6B7B72';
  ctx.fillText('interactstudio.space/lab/gesture', W / 2, 850);

  // CTA pill
  ctx.fillStyle = '#2F5E48';
  roundRectPath(ctx, 340, 890, 400, 64, 32);
  ctx.fill();
  ctx.font = '600 26px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#F5F1E8';
  ctx.fillText('Can you beat me?', W / 2, 931);
}

type GameState = 'idle' | 'playing' | 'finished';

export default function GestureExperiment() {
  const navigate   = useNavigate();
  const { status, error, videoRef: odysseyVideoRef, startStream, interact, disconnect } = useOdysseyStream();

  const webcamVideoRef    = useRef<HTMLVideoElement | null>(null);
  const webcamCanvasRef   = useRef<HTMLCanvasElement | null>(null);
  const scorecardCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pollingRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);

  // Existing detection state
  const [webcamActive, setWebcamActive] = useState(false);
  const [lastGesture, setLastGesture]   = useState<string | null>(null);
  const [isPolling, setIsPolling]       = useState(false);
  const detectingRef                    = useRef(false);

  // ── Game state ──────────────────────────────────────────────────────────────
  const [gameState, setGameState]         = useState<GameState>('idle');
  const [discovered, setDiscovered]       = useState<Set<string>>(new Set());
  const [timeLeft, setTimeLeft]           = useState(GAME_DURATION_S);
  const [alreadyPlayed, setAlreadyPlayed] = useState<{ score: number; finishedAt: string } | null>(null);
  const [lastFlash, setLastFlash]         = useState<string | null>(null);
  const [shareCopied, setShareCopied]     = useState(false);

  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const discoveredRef = useRef<Set<string>>(new Set()); // mirrors state — safe in callbacks

  // ── SEO ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    applySeo(SEO_PAGES.gesture);
  }, []);

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

  // ── Score card: draw when game finishes ───────────────────────────────────
  useEffect(() => {
    if (gameState !== 'finished') return;
    const canvas = scorecardCanvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.src = CHARACTER_IMAGE;
    img.onload = () => {
      drawScoreCard(canvas, discoveredRef.current.size, getEncouragement(discoveredRef.current.size), img);
    };
  }, [gameState]); // discoveredRef.current is stable once finished

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

  // ── Game: finish (declared before stopWebcam so it can be referenced) ─────
  const finishGame = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    stopPolling();
    const result = { score: discoveredRef.current.size, finishedAt: new Date().toISOString() };
    localStorage.setItem(getTodayKey(), JSON.stringify(result));
    setGameState('finished');
  }, [stopPolling]);

  const stopWebcam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (webcamVideoRef.current) webcamVideoRef.current.srcObject = null;
    setWebcamActive(false);
    stopPolling();
    if (gameState === 'playing') finishGame();
  }, [stopPolling, gameState, finishGame]);

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
    if (detectingRef.current) return;
    const dataUrl = captureFrame();
    if (!dataUrl) return;

    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';

    detectingRef.current = true;
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
      detectingRef.current = false;
    }
  }, [captureFrame, lastGesture, interact, stopPolling, gameState, finishGame]);

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

    // Get score card as a shareable File
    const canvas = scorecardCanvasRef.current;
    let imageFile: File | null = null;
    if (canvas) {
      imageFile = await new Promise<File | null>((resolve) => {
        canvas.toBlob(
          (blob) => resolve(blob ? new File([blob], 'einstein-score.png', { type: 'image/png' }) : null),
          'image/png',
        );
      });
    }

    // Build share payload — include image only if the platform supports file sharing
    const shareData: ShareData = { text };
    if (imageFile && navigator.canShare?.({ files: [imageFile] })) {
      shareData.files = [imageFile];
    }

    // Web Share API — native OS sheet (mobile + some desktop)
    if (navigator.share && navigator.canShare?.(shareData)) {
      try {
        await navigator.share(shareData);
        return; // OS sheet provides its own feedback
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return; // user cancelled
        // fall through to clipboard
      }
    }

    // Clipboard fallback (desktop Firefox, unsupported browsers)
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
                {shareCopied ? 'Copied to clipboard!' : 'Share Result'}
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

              {/* Brief flash on new find */}
              {lastFlash && <div className="bl-flash">New reaction found!</div>}
            </>
          )}

        </aside>
      </div>

      {/* Hidden score card canvas — drawn when game finishes, used for sharing */}
      <canvas ref={scorecardCanvasRef} width={1080} height={1080} style={{ display: 'none' }} />
    </div>
  );
}
