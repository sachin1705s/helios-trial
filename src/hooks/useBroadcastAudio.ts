import { useEffect, useRef, useState } from 'react';

/**
 * Subscribes to a broadcast room's audio SSE stream and plays incoming PCM
 * chunks through a dedicated Web Audio context. Used by both the host (for
 * return-path monitoring) and the audience (primary playback).
 *
 * `extraDelayMs` shifts playback later to compensate for WebRTC video lag on
 * the audience side. Host should use 0; audience should use ~400ms to match
 * Odyssey WHEP latency. Same source, same scheduling code — only the offset
 * differs, so host and audience stay in sync with each other within ~10ms of
 * network jitter.
 */
export function useBroadcastAudio(
  roomCode: string | null,
  options: { enabled: boolean; extraDelayMs?: number } = { enabled: false },
): { isReceiving: boolean; error: string | null } {
  const { enabled, extraDelayMs = 0 } = options;

  const [isReceiving, setIsReceiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Next scheduled start time in AudioContext.currentTime coordinates. We
  // advance it by each chunk's duration so consecutive chunks play seamlessly.
  // Reset when an utterance ends so the next utterance starts at "now + delay".
  const playbackTimeRef = useRef(0);

  useEffect(() => {
    if (!enabled || !roomCode) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setIsReceiving(false);
      return;
    }

    const ctx = ctxRef.current ?? new AudioContext({ sampleRate: 24000 });
    ctxRef.current = ctx;
    ctx.resume().catch(() => undefined);

    const es = new EventSource(`/api/broadcast/room/${roomCode}/audio/stream`);
    eventSourceRef.current = es;

    es.addEventListener('hello', () => setIsReceiving(true));

    es.addEventListener('utterance-start', () => {
      // Schedule the next chunk for "now + delay" so this utterance starts
      // fresh rather than queueing behind silence from a previous one.
      const startAt = ctx.currentTime + (extraDelayMs / 1000) + 0.05;
      if (playbackTimeRef.current < startAt) playbackTimeRef.current = startAt;
    });

    es.addEventListener('audio', (ev) => {
      let payload: { sampleRate?: number; pcm?: string };
      try { payload = JSON.parse((ev as MessageEvent<string>).data); } catch { return; }
      const sampleRate = payload.sampleRate ?? 24000;
      const pcmB64 = payload.pcm;
      if (!pcmB64) return;

      // Base64 → bytes
      const bin = atob(pcmB64);
      const usable = bin.length - (bin.length % 2);
      if (usable === 0) return;
      const bytes = new Uint8Array(usable);
      for (let i = 0; i < usable; i++) bytes[i] = bin.charCodeAt(i);

      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

      const buffer = ctx.createBuffer(1, float32.length, sampleRate);
      buffer.copyToChannel(float32, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      // Schedule seamlessly after the previous chunk; never start in the past.
      const earliestStart = ctx.currentTime + (extraDelayMs / 1000) + 0.02;
      if (playbackTimeRef.current < earliestStart) playbackTimeRef.current = earliestStart;
      source.start(playbackTimeRef.current);
      playbackTimeRef.current += buffer.duration;
    });

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors. Only surface a hard error
      // when the connection is closed (readyState === 2).
      if (es.readyState === EventSource.CLOSED) {
        setError('Audio stream disconnected.');
        setIsReceiving(false);
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsReceiving(false);
    };
  }, [enabled, roomCode, extraDelayMs]);

  // Tear down the AudioContext only on unmount (not when toggling enabled), so
  // it survives quick re-mounts in dev StrictMode.
  useEffect(() => () => {
    ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, []);

  return { isReceiving, error };
}
