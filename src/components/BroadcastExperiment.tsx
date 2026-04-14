import { useState, useEffect, useRef } from 'react';
import { Odyssey, credentialsFromDict } from '../lib/odyssey';
import type { ClientCredentials } from '../lib/odyssey';

// ─── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'choose' | 'host' | 'audience';
type HostStatus = 'idle' | 'creating' | 'connecting' | 'ready' | 'starting' | 'live';
type AudienceStatus = 'idle' | 'joining' | 'live' | 'disconnected';

interface IncomingPrompt {
  id: string;
  text: string;
  username: string;
  timestamp: number;
  fired?: boolean;
}

interface BroadcastExperimentProps {
  onBack: () => void;
}

const POLL_INTERVAL_MS = 2000;

// ─── Component ────────────────────────────────────────────────────────────────

export function BroadcastExperiment({ onBack }: BroadcastExperimentProps) {
  const [mode, setMode] = useState<Mode>('choose');

  // ── Host state ──
  const [hostStatus, setHostStatus]     = useState<HostStatus>('idle');
  const [roomCode, setRoomCode]         = useState<string | null>(null);
  const [incomingPrompts, setIncomingPrompts] = useState<IncomingPrompt[]>([]);
  const [hostError, setHostError]       = useState<string | null>(null);
  const [isStreaming, setIsStreaming]   = useState(false);

  // ── Audience state ──
  const [audienceStatus, setAudienceStatus] = useState<AudienceStatus>('idle');
  const [joinCode, setJoinCode]     = useState('');
  const [username, setUsername]     = useState('');
  const [promptText, setPromptText] = useState('');
  const [sentPrompts, setSentPrompts] = useState<string[]>([]);
  const [audienceError, setAudienceError] = useState<string | null>(null);

  // ── Refs ──
  const hostVideoRef     = useRef<HTMLVideoElement>(null);
  const audienceVideoRef = useRef<HTMLVideoElement>(null);
  const odysseyRef       = useRef<InstanceType<typeof Odyssey> | null>(null);
  const spectatorRef     = useRef<{ stream: MediaStream; onDisconnect: () => void } | null>(null);
  const pollRef          = useRef<number | null>(null);
  const lastPollRef      = useRef<number>(0);
  const activeCodeRef    = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
      void teardownHost();
      teardownAudience();
    };
  }, []);

  // ── Shared helpers ──────────────────────────────────────────────────────────

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const teardownHost = async () => {
    stopPolling();
    if (odysseyRef.current) {
      try { await odysseyRef.current.endStream(); } catch { /* ignore */ }
      try { await odysseyRef.current.disconnect(); } catch { /* ignore */ }
      odysseyRef.current = null;
    }
    const code = activeCodeRef.current;
    if (code) {
      fetch(`/api/broadcast/room/${code}`, { method: 'DELETE' }).catch(() => undefined);
      activeCodeRef.current = null;
    }
  };

  const teardownAudience = () => {
    if (spectatorRef.current) {
      try { spectatorRef.current.onDisconnect(); } catch { /* ignore */ }
      spectatorRef.current = null;
    }
    if (audienceVideoRef.current) {
      audienceVideoRef.current.srcObject = null;
    }
  };

  // ── Host flow ────────────────────────────────────────────────────────────────

  const startHostSession = async () => {
    setHostError(null);
    setHostStatus('creating');

    // 1. Create room on server
    let code: string;
    try {
      const res = await fetch('/api/broadcast/room', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to create room.');
      const data = await res.json() as { code: string };
      code = data.code;
      setRoomCode(code);
      activeCodeRef.current = code;
    } catch (err) {
      setHostError(err instanceof Error ? err.message : 'Failed to create room.');
      setHostStatus('idle');
      return;
    }

    // 2. Fetch Odyssey credentials
    setHostStatus('connecting');
    let credentials: ClientCredentials;
    try {
      const res = await fetch('/api/odyssey/token');
      if (!res.ok) throw new Error('Odyssey not available right now.');
      const data = await res.json() as { credentials?: unknown };
      if (!data.credentials) throw new Error('No credentials received.');
      credentials = credentialsFromDict(data.credentials as Record<string, unknown>);
    } catch (err) {
      setHostError(err instanceof Error ? err.message : 'Failed to connect to Odyssey.');
      setHostStatus('idle');
      return;
    }

    // 3. Connect Odyssey client
    const client = new Odyssey({});
    // Pre-set i2v capability (same fix as OdysseyService)
    (client as unknown as { capabilities: { image_to_video: boolean } }).capabilities.image_to_video = true;
    odysseyRef.current = client;

    try {
      await client.connectWithCredentials(credentials, {
        onConnected: (stream: MediaStream) => {
          // Attach stream to host video
          const attach = () => {
            if (hostVideoRef.current) {
              hostVideoRef.current.srcObject = stream;
              hostVideoRef.current.play().catch(() => undefined);
            } else {
              setTimeout(attach, 100);
            }
          };
          attach();
          setHostStatus('ready');
        },
        onDisconnected: () => {
          setIsStreaming(false);
          setHostStatus('idle');
          stopPolling();
        },
        onBroadcastReady: async (info: { webrtcUrl: string; spectatorToken: string; hlsUrl?: string }) => {
          const currentCode = activeCodeRef.current;
          if (!currentCode) return;
          try {
            await fetch(`/api/broadcast/room/${currentCode}/ready`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(info),
            });
            setHostStatus('live');
            setIsStreaming(true);
            startPolling(currentCode);
          } catch {
            setHostError('Failed to register broadcast with server.');
          }
        },
        onStreamStarted: () => {
          // Video is already attached via onConnected — nothing extra needed
        },
      });
    } catch (err) {
      setHostError(err instanceof Error ? err.message : 'Odyssey connection failed.');
      setHostStatus('idle');
    }
  };

  const startBroadcast = async () => {
    if (!odysseyRef.current || hostStatus !== 'ready') return;
    setHostStatus('starting');
    try {
      await odysseyRef.current.startStream({ broadcast: true } as Parameters<typeof odysseyRef.current.startStream>[0]);
    } catch (err) {
      setHostError(err instanceof Error ? err.message : 'Failed to start broadcast.');
      setHostStatus('ready');
    }
  };

  const startPolling = (code: string) => {
    stopPolling();
    lastPollRef.current = Date.now();
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/broadcast/room/${code}/prompts?since=${lastPollRef.current}`);
        if (!res.ok) return;
        const data = await res.json() as { prompts: IncomingPrompt[]; serverTime: number };
        if (data.prompts.length > 0) {
          setIncomingPrompts((prev) => {
            const known = new Set(prev.map((p) => p.id));
            const fresh = data.prompts.filter((p) => !known.has(p.id));
            return [...prev, ...fresh];
          });
        }
        lastPollRef.current = data.serverTime;
      } catch { /* ignore */ }
    }, POLL_INTERVAL_MS);
  };

  const firePrompt = async (p: IncomingPrompt) => {
    if (!odysseyRef.current) return;
    try {
      await odysseyRef.current.interact({ prompt: p.text });
      setIncomingPrompts((prev) => prev.map((q) => q.id === p.id ? { ...q, fired: true } : q));
    } catch (err) {
      setHostError(err instanceof Error ? err.message : 'Failed to fire prompt.');
    }
  };

  const dismissPrompt = (id: string) => {
    setIncomingPrompts((prev) => prev.filter((p) => p.id !== id));
  };

  // ── Audience flow ────────────────────────────────────────────────────────────

  const joinRoom = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setAudienceError(null);
    setAudienceStatus('joining');

    try {
      const res = await fetch(`/api/broadcast/room/${code}`);
      if (res.status === 404) throw new Error('Room not found. Double-check the code.');
      if (res.status === 202) throw new Error('Broadcast not live yet — wait for the host to start.');
      if (!res.ok) throw new Error('Could not join room.');
      const data = await res.json() as { webrtcUrl: string; spectatorToken: string };

      const connection = await (Odyssey as unknown as {
        connectToStream: (url: string, token: string) => Promise<{ stream: MediaStream; onDisconnect: () => void }>;
      }).connectToStream(data.webrtcUrl, data.spectatorToken);

      spectatorRef.current = connection;

      const attach = () => {
        if (audienceVideoRef.current) {
          audienceVideoRef.current.srcObject = connection.stream;
          audienceVideoRef.current.play().catch(() => undefined);
        } else {
          setTimeout(attach, 100);
        }
      };
      attach();

      connection.onDisconnect = () => {
        setAudienceStatus('disconnected');
        setAudienceError('Broadcast ended.');
      };

      setAudienceStatus('live');
    } catch (err) {
      setAudienceError(err instanceof Error ? err.message : 'Failed to join broadcast.');
      setAudienceStatus('idle');
    }
  };

  const sendPrompt = async () => {
    const code = joinCode.trim().toUpperCase();
    const text = promptText.trim();
    if (!text || !code) return;

    try {
      await fetch(`/api/broadcast/room/${code}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, username: username.trim() || 'Guest' }),
      });
      setSentPrompts((prev) => [...prev, text]);
      setPromptText('');
    } catch { /* ignore */ }
  };

  // ── Render: mode picker ──────────────────────────────────────────────────────

  if (mode === 'choose') {
    return (
      <div className="broadcast-experiment">
        <button className="btn ghost back-btn" onClick={onBack}>← Back</button>
        <div className="broadcast-choose">
          <h1 className="broadcast-title">Broadcast</h1>
          <p className="broadcast-subtitle">One character. One room. Everyone fires prompts.</p>
          <div className="broadcast-mode-cards">
            <button className="broadcast-mode-card" onClick={() => setMode('host')}>
              <div className="mode-icon">📡</div>
              <h2>Host</h2>
              <p>Create a room, share the code, and let your audience fire prompts at the character in real time.</p>
            </button>
            <button className="broadcast-mode-card" onClick={() => setMode('audience')}>
              <div className="mode-icon">👥</div>
              <h2>Join</h2>
              <p>Enter a room code to watch the live stream and send your own prompts.</p>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: host ────────────────────────────────────────────────────────────

  if (mode === 'host') {
    return (
      <div className="broadcast-experiment">
        <button
          className="btn ghost back-btn"
          onClick={() => {
            void teardownHost();
            setMode('choose');
            setHostStatus('idle');
            setRoomCode(null);
            setIncomingPrompts([]);
            setHostError(null);
            setIsStreaming(false);
          }}
        >
          ← Back
        </button>

        <div className="broadcast-host">
          {/* Room code badge */}
          {roomCode && (
            <div className="room-code-badge">
              <span className="room-code-label">Room Code</span>
              <span className="room-code-value">{roomCode}</span>
              <button
                className="btn ghost small"
                onClick={() => navigator.clipboard?.writeText(roomCode)}
              >
                Copy
              </button>
            </div>
          )}

          {/* Video */}
          <div className="broadcast-video-wrap">
            <video
              ref={hostVideoRef}
              autoPlay
              playsInline
              muted
              className={`broadcast-video ${isStreaming ? '' : 'hidden'}`}
            />
            {!isStreaming && (
              <div className="broadcast-video-placeholder">
                {hostStatus === 'idle' ? 'Stream preview will appear here' : 'Starting…'}
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="broadcast-controls">
            {hostStatus === 'idle' && (
              <button className="btn primary" onClick={startHostSession}>
                Create Room
              </button>
            )}
            {(hostStatus === 'creating' || hostStatus === 'connecting') && (
              <div className="status-text">Connecting to Odyssey…</div>
            )}
            {hostStatus === 'ready' && (
              <button className="btn primary" onClick={startBroadcast}>
                Go Live
              </button>
            )}
            {hostStatus === 'starting' && (
              <div className="status-text">Starting broadcast…</div>
            )}
            {hostStatus === 'live' && (
              <div className="status-live">🔴 Live — Share code <strong>{roomCode}</strong> with your audience</div>
            )}
          </div>

          {hostError && <div className="broadcast-error">{hostError}</div>}

          {/* Incoming prompt queue */}
          {incomingPrompts.length > 0 && (
            <div className="prompt-queue">
              <h3 className="prompt-queue-title">Audience Prompts</h3>
              {incomingPrompts.slice(-15).map((p) => (
                <div key={p.id} className={`prompt-item ${p.fired ? 'prompt-item--fired' : ''}`}>
                  <span className="prompt-username">{p.username}</span>
                  <span className="prompt-text">{p.text}</span>
                  <div className="prompt-actions">
                    {!p.fired && (
                      <button className="btn primary small" onClick={() => void firePrompt(p)}>
                        Fire
                      </button>
                    )}
                    {p.fired && <span className="prompt-fired-badge">Fired</span>}
                    <button className="btn ghost small" onClick={() => dismissPrompt(p.id)}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Render: audience ────────────────────────────────────────────────────────

  return (
    <div className="broadcast-experiment">
      <button
        className="btn ghost back-btn"
        onClick={() => {
          teardownAudience();
          setMode('choose');
          setAudienceStatus('idle');
          setSentPrompts([]);
          setAudienceError(null);
          setJoinCode('');
        }}
      >
        ← Back
      </button>

      <div className="broadcast-audience">
        {(audienceStatus === 'idle' || audienceStatus === 'joining') ? (
          <div className="join-form">
            <h1 className="broadcast-title">Join a Broadcast</h1>
            <p className="broadcast-subtitle">Get the room code from the host.</p>
            <input
              className="room-code-input"
              placeholder="ROOM CODE"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              autoCapitalize="characters"
            />
            <input
              className="username-input"
              placeholder="Your name (optional)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={32}
            />
            <button
              className="btn primary"
              onClick={() => void joinRoom()}
              disabled={audienceStatus === 'joining' || joinCode.trim().length !== 6}
            >
              {audienceStatus === 'joining' ? 'Joining…' : 'Join'}
            </button>
            {audienceError && <div className="broadcast-error">{audienceError}</div>}
          </div>
        ) : (
          <div className="audience-live">
            {/* Live stream */}
            <div className="broadcast-video-wrap">
              <video
                ref={audienceVideoRef}
                autoPlay
                playsInline
                className="broadcast-video"
              />
              {audienceStatus === 'disconnected' && (
                <div className="broadcast-video-placeholder">Broadcast ended.</div>
              )}
            </div>

            {audienceStatus === 'live' && (
              <>
                {/* Prompt input */}
                <div className="audience-prompt-form">
                  <input
                    className="prompt-input"
                    placeholder="Send a prompt to the character…"
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void sendPrompt(); }}
                    maxLength={200}
                  />
                  <button
                    className="btn primary"
                    onClick={() => void sendPrompt()}
                    disabled={!promptText.trim()}
                  >
                    Send
                  </button>
                </div>

                {/* Sent prompts log */}
                {sentPrompts.length > 0 && (
                  <div className="sent-prompts">
                    <div className="sent-prompts-label">Your prompts:</div>
                    {sentPrompts.slice(-5).map((t, i) => (
                      <div key={i} className="sent-prompt-item">{t}</div>
                    ))}
                  </div>
                )}
              </>
            )}

            {audienceError && <div className="broadcast-error">{audienceError}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
