import { useCallback, useEffect, useRef, useState } from 'react';
import { buildBearPrompt } from '../../lib/objectCategories';
import './DripCheckOverlay.css';

type VisionMode = 'drip-check' | 'item-grab';

interface DripCheckOverlayProps {
  runCharacterInteraction: (userText: string, slideId: string, characterName: string, opts?: { hideFromChat?: boolean }) => Promise<void>;
  characterId: string;
  characterName: string;
  isStreamingReady: boolean;
}

const VISION_CONFIG: Record<VisionMode, {
  endpoint: string;
  noResultField: string;
  fallbackPrompt: string;
  successTemplate: (desc: string) => string;
}> = {
  'drip-check': {
    endpoint: '/api/vision-describe',
    noResultField: 'noPerson',
    fallbackPrompt: '[Drip Check: I stepped in front of your camera but you can\'t see me clearly. React in one short sentence. Respond in English.]',
    successTemplate: (desc) =>
      `[Drip Check: take a quick look at me through your camera and comment on my style. Here's what you see: ${desc}. Reply in ONE sentence — under 20 words — playful and in character. Respond in English.]`,
  },
  'item-grab': {
    endpoint: '/api/vision-describe',
    noResultField: 'noObject',
    fallbackPrompt: '[Item Grab: I tried to show you something but you can\'t see it clearly. Ask me to hold it closer in one short sentence. Respond in English.]',
    successTemplate: (desc) => buildBearPrompt(desc),
  },
};

// Shared cooldown between drip-check AND item-grab clicks. After any vision
// action fires, both buttons lock for this duration. This keeps per-user
// request rate under control of the shared Gemini quota and shows the user
// a visible countdown so they don't feel the UI is broken.
const ACTION_COOLDOWN_MS = 10000;
// Extra backoff added on top of the normal cooldown when Gemini returns 429.
// On free tier the quota is shared globally, so a slightly longer wait gives
// the rolling window time to drain.
const RATE_LIMIT_EXTRA_BACKOFF_MS = 5000;

export default function DripCheckOverlay({ runCharacterInteraction, characterId, characterName, isStreamingReady }: DripCheckOverlayProps) {
  const [webcamActive, setWebcamActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ms epoch when the buttons become clickable again. 0 = ready now.
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number>(0);
  // re-render every 250ms while a cooldown is active so the countdown ticks
  const [tickNow, setTickNow] = useState<number>(Date.now());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Total ms of the currently-active cooldown. Stored so the progress strip
  // knows what fraction of the wait remains regardless of normal vs 429 wait.
  const cooldownDurationRef = useRef<number>(0);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 4000);
  }, []);

  const stopWebcam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setWebcamActive(false);
  }, []);

  const ensureWebcam = useCallback(async () => {
    if (streamRef.current) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    streamRef.current = stream;
    setWebcamActive(true);
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 500));
    return stream;
  }, []);

  useEffect(() => {
    void ensureWebcam().catch((err) => console.warn('[drip] auto-start failed:', err));
    return () => { stopWebcam(); };
  }, [ensureWebcam, stopWebcam]);

  useEffect(() => {
    return () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current); };
  }, []);

  // Tick while a cooldown is active so the countdown label updates.
  // Stops itself once the cooldown clears to avoid burning CPU at idle.
  useEffect(() => {
    if (cooldownEndsAt <= Date.now()) return;
    const id = setInterval(() => {
      const t = Date.now();
      setTickNow(t);
      if (t >= cooldownEndsAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [cooldownEndsAt]);

  const cooldownSecondsLeft = Math.max(0, Math.ceil((cooldownEndsAt - tickNow) / 1000));
  const inCooldown = cooldownSecondsLeft > 0;
  // Fraction of cooldown remaining (1.0 → 0.0). Drives the progress strip
  // width via CSS variable. Re-computed each tick so it drains continuously.
  const cooldownProgress = inCooldown && cooldownDurationRef.current > 0
    ? Math.max(0, (cooldownEndsAt - tickNow) / cooldownDurationRef.current)
    : 0;

  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    await ensureWebcam().catch(() => undefined);
    const video = videoRef.current;
    if (!video) return null;
    if (video.readyState < 2) await new Promise((r) => setTimeout(r, 400));
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
  }, [ensureWebcam]);

  const handleVisionAction = useCallback(async (mode: VisionMode) => {
    // Defensive guard. The `disabled` attribute on the button is the primary
    // mechanism that prevents clicks during cooldown / loading, but if some
    // edge case lets a click through (e.g. keyboard activation) this still
    // silently drops it.
    if (busy) return;
    if (Date.now() < cooldownEndsAt) return;
    // Start the cooldown as soon as the user commits to the action — clicking
    // again during the request shouldn't bypass the timer.
    cooldownDurationRef.current = ACTION_COOLDOWN_MS;
    setCooldownEndsAt(Date.now() + ACTION_COOLDOWN_MS);
    setTickNow(Date.now());
    setBusy(true);
    setError(null);
    const config = VISION_CONFIG[mode];
    try {
      const blob = await captureFrame();
      if (!blob) throw new Error('No frame captured.');
      const fd = new FormData();
      fd.append('image', blob, `${mode}.jpg`);
      fd.append('mode', mode);
      const res = await fetch(config.endpoint, { method: 'POST', body: fd, signal: AbortSignal.timeout(12000) });
      if (!res.ok) {
        if (res.status === 429) {
          // Extend the cooldown a bit longer to let the Gemini quota window drain.
          const total = ACTION_COOLDOWN_MS + RATE_LIMIT_EXTRA_BACKOFF_MS;
          cooldownDurationRef.current = total;
          setCooldownEndsAt(Date.now() + total);
          throw new Error('RATE_LIMITED');
        }
        throw new Error(`Request failed (${res.status})`);
      }
      const data = await res.json();
      if (data[config.noResultField] || !data.description) {
        await runCharacterInteraction(config.fallbackPrompt, characterId, characterName, { hideFromChat: true });
        return;
      }
      await runCharacterInteraction(config.successTemplate(data.description), characterId, characterName, { hideFromChat: true });
    } catch (err) {
      console.error(`[${mode}] failed:`, err);
      // 429 is honestly framed as "service is busy" since on the free tier
      // the Gemini quota is shared across all users — it's not the user's fault.
      const msg = err instanceof Error && err.message === 'RATE_LIMITED'
        ? 'The bear is busy right now — try again in a few seconds.'
        : mode === 'drip-check'
          ? "Couldn't check your look — try again."
          : "Couldn't see the item — try again.";
      showError(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, cooldownEndsAt, captureFrame, runCharacterInteraction, characterId, characterName, showError]);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="drip-webcam"
        style={{ display: webcamActive ? 'block' : 'none' }}
      />
      <div className="drip-controls">
        <button
          type="button"
          className={`drip-btn ${inCooldown && !busy ? 'is-cooldown' : ''}`}
          style={inCooldown && !busy ? { ['--cooldown-progress' as string]: cooldownProgress } : undefined}
          onClick={() => handleVisionAction('drip-check')}
          disabled={busy || inCooldown || !isStreamingReady}
          aria-label={inCooldown && !busy ? `Drip Check — ready in ${cooldownSecondsLeft} seconds` : 'Drip Check'}
        >
          {busy
            ? 'Looking…'
            : inCooldown
              ? `👀 ${cooldownSecondsLeft}s`
              : '👀 Drip Check'}
        </button>
        <button
          type="button"
          className={`drip-btn ${inCooldown && !busy ? 'is-cooldown' : ''}`}
          style={inCooldown && !busy ? { ['--cooldown-progress' as string]: cooldownProgress } : undefined}
          onClick={() => handleVisionAction('item-grab')}
          disabled={busy || inCooldown || !isStreamingReady}
          aria-label={inCooldown && !busy ? `Item Grab — ready in ${cooldownSecondsLeft} seconds` : 'Item Grab'}
        >
          {busy
            ? 'Looking…'
            : inCooldown
              ? `✋ ${cooldownSecondsLeft}s`
              : '✋ Item Grab'}
        </button>
        {error && <span className="drip-error">{error}</span>}
      </div>
    </>
  );
}
