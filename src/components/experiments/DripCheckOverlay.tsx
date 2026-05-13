import { useCallback, useEffect, useRef, useState } from 'react';
import { buildBearPrompt } from '../../lib/objectCategories';
import './DripCheckOverlay.css';

type VisionMode = 'drip-check' | 'item-grab';

interface DripCheckOverlayProps {
  runCharacterInteraction: (userText: string, slideId: string, characterName: string) => Promise<void>;
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
    fallbackPrompt: '[Drip Check: I stepped in front of your camera but you can\'t see me clearly. React in one short sentence.]',
    successTemplate: (desc) =>
      `[Drip Check: take a quick look at me through your camera and comment on my style. Here's what you see: ${desc}. Reply in ONE sentence — under 20 words — playful and in character.]`,
  },
  'item-grab': {
    endpoint: '/api/vision-describe',
    noResultField: 'noObject',
    fallbackPrompt: '[Item Grab: I tried to show you something but you can\'t see it clearly. Ask me to hold it closer in one short sentence.]',
    successTemplate: (desc) => buildBearPrompt(desc),
  },
};

export default function DripCheckOverlay({ runCharacterInteraction, characterId, characterName, isStreamingReady }: DripCheckOverlayProps) {
  const [webcamActive, setWebcamActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (busy) return;
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
        if (res.status === 429) throw new Error('RATE_LIMITED');
        throw new Error(`Request failed (${res.status})`);
      }
      const data = await res.json();
      if (data[config.noResultField] || !data.description) {
        await runCharacterInteraction(config.fallbackPrompt, characterId, characterName);
        return;
      }
      await runCharacterInteraction(config.successTemplate(data.description), characterId, characterName);
    } catch (err) {
      console.error(`[${mode}] failed:`, err);
      const msg = err instanceof Error && err.message === 'RATE_LIMITED'
        ? 'Too many requests — wait a moment and try again.'
        : mode === 'drip-check'
          ? "Couldn't check your look — try again."
          : "Couldn't see the item — try again.";
      showError(msg);
    } finally {
      setBusy(false);
    }
  }, [busy, captureFrame, runCharacterInteraction, characterId, characterName, showError]);

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
          className="drip-btn"
          onClick={() => handleVisionAction('drip-check')}
          disabled={busy || !isStreamingReady}
        >
          {busy ? 'Looking…' : '👀 Drip Check'}
        </button>
        <button
          type="button"
          className="drip-btn"
          onClick={() => handleVisionAction('item-grab')}
          disabled={busy || !isStreamingReady}
        >
          {busy ? 'Looking…' : '✋ Item Grab'}
        </button>
        {error && <span className="drip-error">{error}</span>}
      </div>
    </>
  );
}
