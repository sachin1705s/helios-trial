import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePostHog } from 'posthog-js/react';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/odyssey';
import { applySeo, SEO_PAGES } from '../../lib/seo';
import { trackEvent } from '../../lib/analytics';
import '../../demo/shared/tokens.css';
import './GestureExperiment.css';

// Each poll sends one image to Gemini Vision. Gemini's free tier is 10 RPM
// per API key, shared across ALL users. Polling every 6s = 10 RPM per user,
// which leaves zero headroom — but anything faster makes us the bottleneck
// for drip-check/item-grab users on a different page sharing the same key.
const POLL_INTERVAL_MS = 6000;
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
// CORE: the 10 reactions that count toward the win condition (tied to GESTURE_EMOJI).
// BONUS: extras unlocked after reviewing log data — empty on launch day.
//        To expand tomorrow: add the label here + an emoji entry in GESTURE_EMOJI.
const CORE_GESTURE_KEYS  = Object.keys(GESTURE_EMOJI);
// To add bonus gestures tomorrow: declare BONUS_GESTURE_KEYS = ['waving', 'dab', ...]
// paired with BONUS_GESTURES in server/index.js, then add entries to GESTURE_EMOJI above.

const TOTAL_GESTURES  = CORE_GESTURE_KEYS.length; // 10 — win condition never changes
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
  const posthog    = usePostHog();
  const { status, videoRef: odysseyVideoRef, startStream, interact, disconnect } = useOdysseyStream();

  const webcamVideoRef    = useRef<HTMLVideoElement | null>(null);
  const webcamCanvasRef   = useRef<HTMLCanvasElement | null>(null);
  const scorecardCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pollingRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef         = useRef<MediaStream | null>(null);

  // Existing detection state
  const [webcamActive, setWebcamActive] = useState(false);
  const [lastGesture, setLastGesture]   = useState<string | null>(null);
  const detectingRef                    = useRef(false);

  // ── Game state ──────────────────────────────────────────────────────────────
  const [gameState, setGameState]         = useState<GameState>('idle');
  const [discovered, setDiscovered]       = useState<Set<string>>(new Set());
  const [discoveredBonus, setDiscoveredBonus] = useState<Set<string>>(new Set());
  const [timeLeft, setTimeLeft]           = useState(GAME_DURATION_S);
  const [alreadyPlayed, setAlreadyPlayed] = useState<{ score: number; bonus: number; finishedAt: string } | null>(null);
  const [lastFlash, setLastFlash]         = useState<string | null>(null);
  const [lastFlashIsBonus, setLastFlashIsBonus] = useState(false);
  const [shareCopied, setShareCopied]     = useState(false);

  const timerRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const discoveredRef     = useRef<Set<string>>(new Set()); // mirrors state — safe in callbacks
  const discoveredBonusRef = useRef<Set<string>>(new Set());

  // ── SEO ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    applySeo(SEO_PAGES.gesture);
  }, []);

  // ── Odyssey: start stream only after camera is granted ───────────────────
  // Deferring startStream until webcamActive saves the 5-minute Odyssey
  // stream limit — no time is burned while the user decides to turn on their camera.
  useEffect(() => {
    if (status !== 'ready' || !webcamActive) return;
    const run = async () => {
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: false });
    };
    void run();
  }, [status, startStream, webcamActive]);

  // ── Game: check if already played today ──────────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem(getTodayKey());
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { score?: number; bonus?: number; finishedAt?: string; started?: boolean };
        if (parsed.finishedAt) {
          setAlreadyPlayed({ score: parsed.score ?? 0, bonus: parsed.bonus ?? 0, finishedAt: parsed.finishedAt });
        }
        // started but not finished (crash/refresh) — allow replay
      }
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
  }, [gameState]); // discoveredRef / discoveredBonusRef are stable once finished

  // ── Webcam helpers ────────────────────────────────────────────────────────
  const startWebcam = useCallback(async () => {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      streamRef.current = ms;
      // Video element is always in the DOM (hidden), so attach directly
      if (webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = ms;
        webcamVideoRef.current.play().catch(() => undefined);
      }
      setWebcamActive(true);
    } catch (err) {
      console.error('[gesture] webcam denied:', err);
      alert('Webcam access denied.');
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // ── Game: finish (declared before stopWebcam so it can be referenced) ─────
  const finishGame = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    stopPolling();
    const result = {
      score: discoveredRef.current.size,
      bonus: discoveredBonusRef.current.size,
      finishedAt: new Date().toISOString(),
    };
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

  // ── Game: auto-start when webcam turns on ──────────────────────────────────
  useEffect(() => {
    if (!webcamActive || gameState !== 'idle' || alreadyPlayed) return;
    // Mark started — final score written only in finishGame so crash/refresh allows replay
    localStorage.setItem(getTodayKey(), JSON.stringify({ started: true }));
    discoveredRef.current = new Set();
    discoveredBonusRef.current = new Set();
    setDiscovered(new Set());
    setDiscoveredBonus(new Set());
    setTimeLeft(GAME_DURATION_S);
    setGameState('playing');
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => Math.max(0, prev - 1));
    }, 1000);
    pollingRef.current = setInterval(() => void pollGestureRef.current?.(), POLL_INTERVAL_MS);
  }, [webcamActive, gameState, alreadyPlayed]); // eslint-disable-line react-hooks/exhaustive-deps


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

      if (res.status === 429) { console.warn('[gesture] 429 rate-limited — stopping polling'); stopPolling(); return; }
      if (!res.ok) { console.warn('[gesture] API error:', res.status); return; }

      const { gesture, isBonus, raw } = await res.json() as { gesture: string; isBonus?: boolean; raw?: string };
      if (raw && raw !== 'none' && gesture === 'none') {
        trackEvent('gesture_unmapped', { raw });
      }

      // ── Score on detection ───────────────────────────────────────────────
      if (gesture && gesture !== 'none' && gameState === 'playing') {
        if (isBonus) {
          if (!discoveredBonusRef.current.has(gesture)) {
            discoveredBonusRef.current.add(gesture);
            setDiscoveredBonus(new Set(discoveredBonusRef.current));
            setLastFlashIsBonus(true);
            setLastFlash(gesture);
            setTimeout(() => { setLastFlash(null); setLastFlashIsBonus(false); }, 1200);
          }
        } else {
          if (!discoveredRef.current.has(gesture)) {
            discoveredRef.current.add(gesture);
            setDiscovered(new Set(discoveredRef.current));
            setLastFlashIsBonus(false);
            setLastFlash(gesture);
            setTimeout(() => setLastFlash(null), 1200);
            if (discoveredRef.current.size >= TOTAL_GESTURES) finishGame();
          }
        }
      }

      // ── Einstein reacts when gesture changes (fire and forget) ──────────
      if (gesture && gesture !== 'none' && gesture !== lastGesture) {
        setLastGesture(gesture);
        const label = gesture.replace(/_/g, ' ');
        interact(`React to seeing someone do: ${label}!`).catch(() => undefined);
      }
    } catch (err) { console.error('[gesture] pollGesture network/parse error:', err); } finally {
      detectingRef.current = false;
    }
  }, [captureFrame, lastGesture, interact, stopPolling, gameState, finishGame]);

  // Keep a ref so startGame can reference pollGesture without a circular dep
  const pollGestureRef = useRef(pollGesture);
  pollGestureRef.current = pollGesture;


  // ── Cleanup on unmount ────────────────────────────────────────────────────
  // Use refs so the cleanup only runs on actual unmount, not on every
  // stopPolling/stopWebcam identity change (which caused the game to stop
  // immediately when gameState changed from idle → playing).
  const stopPollingRef = useRef(stopPolling);
  stopPollingRef.current = stopPolling;
  const stopWebcamRef = useRef(stopWebcam);
  stopWebcamRef.current = stopWebcam;
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      stopPollingRef.current();
      stopWebcamRef.current();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigation ────────────────────────────────────────────────────────────
  const handleBack = useCallback(async () => {
    stopPolling(); stopWebcam();
    await disconnect();
    navigate('/labs');
  }, [disconnect, navigate, stopPolling, stopWebcam]);

  // ── Share ─────────────────────────────────────────────────────────────────
  const handleShare = useCallback(async (score: number, bonus: number) => {
    const bonusSuffix = bonus > 0 ? ` + ${bonus} bonus` : '';
    const text = `I found ${score}/10${bonusSuffix} of Einstein's reactions in 3 minutes. Can you beat me? interactstudio.space/lab/gesture`;

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
        posthog?.capture('gesture_share', { score, bonus, method: 'web_share' });
        return; // OS sheet provides its own feedback
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return; // user cancelled
        // fall through to clipboard
      }
    }

    // Clipboard fallback (desktop Firefox, unsupported browsers)
    try {
      await navigator.clipboard.writeText(text);
      posthog?.capture('gesture_share', { score, bonus, method: 'clipboard' });
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch { /* silent — clipboard unavailable */ }
  }, [posthog]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const timerDisplay = `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;
  const timerUrgent  = timeLeft <= 30 && gameState === 'playing';


  return (
    <div className="body-language">
      {/* ── Video layer — fills viewport ───────────────────────────────── */}
      <div className="bl-video-layer">
        <video ref={odysseyVideoRef} autoPlay playsInline muted />
        <div className="bl-video-overlay" />
      </div>

      {/* ── UI layer — overlays on video ───────────────────────────────── */}
      <div className="bl-ui">

        {/* Top bar */}
        <header className="bl-top-bar">
          <button className="bl-back-btn" onClick={handleBack}>Back</button>
        </header>

        {/* Hidden webcam elements — video feeds captureFrame(), no PIP needed */}
        <video ref={webcamVideoRef} autoPlay playsInline muted style={{ display: 'none' }} />
        <canvas ref={webcamCanvasRef} style={{ display: 'none' }} />

        {/* Center area — landing / results / already-played overlays */}
        <div className="bl-center">
          {alreadyPlayed && gameState === 'idle' ? (
            <div className="bl-overlay">
              <p className="bl-already-played__score">
                You found <strong>{alreadyPlayed.score} / {TOTAL_GESTURES}</strong> today.
                {(alreadyPlayed.bonus ?? 0) > 0 && (
                  <> + <strong className="bl-bonus">{alreadyPlayed.bonus} bonus</strong></>
                )}
              </p>
              <p className="bl-already-played__sub">Come back tomorrow for another attempt.</p>
            </div>

          ) : gameState === 'finished' ? (
            <div className="bl-overlay">
              <div className="bl-results__score">{discovered.size} / {TOTAL_GESTURES}</div>
              {discoveredBonus.size > 0 && (
                <div className="bl-results__bonus">+{discoveredBonus.size} bonus</div>
              )}
              <p className="bl-results__encouragement">{getEncouragement(discovered.size)}</p>
              <button
                className="bl-btn bl-btn--primary"
                onClick={() => void handleShare(discovered.size, discoveredBonus.size)}
              >
                {shareCopied ? 'Copied to clipboard!' : 'Share Result'}
              </button>
              <button
                className="bl-btn bl-btn--ghost"
                onClick={() => {
                  const canvas = scorecardCanvasRef.current;
                  if (!canvas) return;
                  const link = document.createElement('a');
                  link.download = 'einstein-score.png';
                  link.href = canvas.toDataURL('image/png');
                  link.click();
                  posthog?.capture('gesture_share', { score: discovered.size, bonus: discoveredBonus.size, method: 'download' });
                }}
              >
                Download Card
              </button>
              <p className="bl-results__return">Come back tomorrow for another attempt.</p>
            </div>

          ) : !webcamActive && gameState === 'idle' ? (
            /* Landing — no stream yet, prompt user to turn on camera */
            <div className="bl-overlay">
              <div className="bl-landing__title">Body Language</div>
              <p className="bl-landing__desc">
                Find Einstein&apos;s {TOTAL_GESTURES} secret reactions using your webcam.
                You have 3 minutes. One attempt per day.
              </p>
              <button
                className="bl-btn bl-btn--primary"
                onClick={startWebcam}
              >
                Turn on Camera to Start
              </button>
            </div>
          ) : null}
        </div>

        {/* Bottom bar — timer pill (always visible, covers Odyssey watermark) */}
        <div className="bl-bottom-bar">
          {/* Flash notification above the pill */}
          {lastFlash && (
            <div className={`bl-flash${lastFlashIsBonus ? ' bl-flash--bonus' : ''}`}>
              {lastFlashIsBonus ? 'Bonus reaction!' : 'New reaction found!'}
            </div>
          )}

          <div className="bl-bar-pill">
            {webcamActive && status !== 'streaming' ? (
              /* Camera on, waiting for Odyssey to connect + stream */
              <span className="bl-bar-status">Waking up Einstein…</span>
            ) : (
              /* Timer + counter — visible in all other states */
              <>
                <div className={`bl-timer${timerUrgent ? ' bl-timer--urgent' : ''}`}>
                  {timerDisplay}
                </div>
                <span className="bl-bar-dot" />
                <div
                  key={discovered.size + discoveredBonus.size}
                  className={`bl-counter${lastFlash ? ' bl-counter-bump' : ''}`}
                >
                  {discovered.size} / {TOTAL_GESTURES}
                  {discoveredBonus.size > 0 && (
                    <span className="bl-counter__bonus"> +{discoveredBonus.size}</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Hidden score card canvas */}
      <canvas ref={scorecardCanvasRef} width={1080} height={1080} style={{ display: 'none' }} />
    </div>
  );
}
