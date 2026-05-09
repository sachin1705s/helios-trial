import { useCallback, useEffect, useRef, useState } from 'react';
import type { BroadcastInfo } from '@odysseyml/odyssey';
import { OdysseyService, credentialsFromDict, loadImageFile } from '../lib/odyssey';

export type OdysseyStreamStatus = 'idle' | 'connecting' | 'ready' | 'streaming' | 'error';

interface UseOdysseyStreamOptions {
  /** Start fetching credentials immediately (default true). */
  autoConnect?: boolean;
  /** Called when broadcast is ready (host mode). */
  onBroadcastReady?: (info: BroadcastInfo) => void;
}

export function useOdysseyStream(options: UseOdysseyStreamOptions = {}) {
  const { autoConnect = true, onBroadcastReady } = options;
  const onBroadcastReadyRef = useRef(onBroadcastReady);
  onBroadcastReadyRef.current = onBroadcastReady;

  const [status, setStatus] = useState<OdysseyStreamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);

  const serviceRef  = useRef<OdysseyService | null>(null);
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const leaseIdRef  = useRef<string | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamActiveRef = useRef(false);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
  }, []);

  const startHeartbeat = useCallback((leaseId: string) => {
    stopHeartbeat();
    heartbeatRef.current = setInterval(async () => {
      await fetch('/api/odyssey/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId }),
      }).catch(() => undefined);
    }, 30_000);
  }, [stopHeartbeat]);

  const releaseLease = useCallback(async () => {
    stopHeartbeat();
    if (leaseIdRef.current) {
      await fetch('/api/odyssey/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId: leaseIdRef.current }),
      }).catch(() => undefined);
      leaseIdRef.current = null;
    }
  }, [stopHeartbeat]);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);
    try {
      const res = await fetch('/api/odyssey/token');
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? 'Could not get Odyssey token.');
      }
      const data = await res.json();
      if (!data.credentials) throw new Error('Missing credentials in token response.');

      const creds = credentialsFromDict(data.credentials);
      if (data.leaseId) { leaseIdRef.current = data.leaseId; startHeartbeat(data.leaseId); }

      const svc = new OdysseyService(creds);
      serviceRef.current = svc;

      await svc.connect({
        onConnected: (stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => undefined);
          }
          setStatus('ready');
        },
        onStreamStarted: () => setStatus('streaming'),
        onStreamEnded: () => { streamActiveRef.current = false; },
        onStreamError: (_, msg) => setError(msg ?? 'Stream error.'),
        onBroadcastReady: (info) => { onBroadcastReadyRef.current?.(info); },
      });
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Connection failed.');
    }
  }, [startHeartbeat]);

  const startStream = useCallback(async (opts?: {
    prompt?: string;
    portrait?: boolean;
    image?: File | Blob;
    broadcast?: boolean;
  }) => {
    if (!serviceRef.current) return;
    streamActiveRef.current = true;
    // The SDK's onConnected fires before its internal state fully settles to
    // "connected". Retry up to 5 times with 200ms backoff so callers don't
    // have to handle this timing edge case themselves.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 200;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await serviceRef.current.startStream(opts);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isConnecting = msg.includes('connecting') || msg.includes('expected connected');
        if (isConnecting && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        } else {
          throw err;
        }
      }
    }
  }, []);

  const interact = useCallback(async (prompt: string) => {
    await serviceRef.current?.interact(prompt);
  }, []);

  const disconnect = useCallback(async () => {
    stopHeartbeat();
    if (streamActiveRef.current) {
      streamActiveRef.current = false;
      await serviceRef.current?.endStream().catch(() => undefined);
    }
    await serviceRef.current?.disconnect().catch(() => undefined);
    serviceRef.current = null;
    await releaseLease();
    setStatus('idle');
  }, [stopHeartbeat, releaseLease]);

  const loadImage = useCallback((url: string, name?: string) => loadImageFile(url, name), []);

  useEffect(() => {
    if (autoConnect) void connect();
    return () => { void disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Release lease on page unload
  useEffect(() => {
    const onUnload = () => void releaseLease();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [releaseLease]);

  return {
    status,
    error,
    reply,
    setReply,
    videoRef,
    serviceRef,
    connect,
    startStream,
    interact,
    disconnect,
    loadImage,
  };
}
