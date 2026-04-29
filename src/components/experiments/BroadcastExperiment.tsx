import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Odyssey, type SpectatorConnection } from '@odysseyml/odyssey';
import type { BroadcastInfo } from '@odysseyml/odyssey';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/odyssey';

const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. You are broadcasting live to an audience. Be engaging, witty, and respond to questions from the audience. Keep replies under 30 words.';
const POLL_INTERVAL_MS = 3000;

type Role = 'choose' | 'host' | 'audience';
type HostPhase = 'setup' | 'live';

// ─── Host view ────────────────────────────────────────────────────────────────

function HostView({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<HostPhase>('setup');
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Array<{ id: string; text: string; username: string; timestamp: number }>>([]);
  const sinceRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roomCodeRef = useRef<string | null>(null);

  const onBroadcastReady = useCallback(async (info: BroadcastInfo) => {
    const code = roomCodeRef.current;
    if (!code) return;
    await fetch(`/api/broadcast/room/${code}/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webrtcUrl: info.webrtcUrl, spectatorToken: info.spectatorToken, hlsUrl: info.hlsUrl }),
    }).catch(() => undefined);
  }, []);

  const { status, error, videoRef, startStream, interact, disconnect } = useOdysseyStream({ onBroadcastReady });

  const createRoom = useCallback(async () => {
    setCreatingRoom(true);
    setRoomError(null);
    try {
      const res = await fetch('/api/broadcast/room', { method: 'POST' });
      const data = await res.json() as { code?: string; error?: string };
      if (!res.ok || !data.code) throw new Error(data.error ?? 'Could not create room.');
      setRoomCode(data.code);
      roomCodeRef.current = data.code;
      setPhase('live');
    } catch (err) {
      setRoomError(err instanceof Error ? err.message : 'Could not create room.');
    } finally {
      setCreatingRoom(false);
    }
  }, []);

  // Start stream once Odyssey is ready
  useEffect(() => {
    if (status !== 'ready' || phase !== 'live') return;
    const run = async () => {
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: true, broadcast: true });
    };
    void run();
  }, [status, phase, startStream]);

  // Poll for audience prompts
  const pollPrompts = useCallback(async () => {
    const code = roomCodeRef.current;
    if (!code) return;
    try {
      const res = await fetch(`/api/broadcast/room/${code}/prompts?since=${sinceRef.current}`);
      if (!res.ok) return;
      const data = await res.json() as { prompts: typeof prompts; serverTime: number };
      if (data.prompts.length > 0) {
        setPrompts((prev) => [...prev, ...data.prompts]);
        sinceRef.current = Math.max(...data.prompts.map((p) => p.timestamp));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (status !== 'streaming' || !roomCode) return;
    pollRef.current = setInterval(() => void pollPrompts(), POLL_INTERVAL_MS);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [status, roomCode, pollPrompts]);

  const handlePromptSelect = useCallback(async (text: string) => {
    await interact(text);
  }, [interact]);

  const handleClose = useCallback(async () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (roomCodeRef.current) {
      await fetch(`/api/broadcast/room/${roomCodeRef.current}`, { method: 'DELETE' }).catch(() => undefined);
    }
    await disconnect();
    onBack();
  }, [disconnect, onBack]);

  if (phase === 'setup') {
    return (
      <div className="experiment-shell">
        <header className="experiment-topbar">
          <button className="btn ghost" onClick={() => navigate('/home')}>← Back</button>
          <h1>Broadcast — Host</h1>
          <span className="exp-badge">Experiment 5</span>
        </header>
        <div style={{ maxWidth: 480, margin: '80px auto', padding: '0 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>📡</div>
          <h2 style={{ marginBottom: 8 }}>Start a broadcast</h2>
          <p style={{ color: 'rgba(231,237,246,0.5)', marginBottom: 32 }}>
            Einstein will go live. Share the room code with your audience so they can watch and send questions.
          </p>
          {roomError && <p style={{ color: '#ff6b6b', marginBottom: 12 }}>{roomError}</p>}
          <button className="exp-btn primary" onClick={createRoom} disabled={creatingRoom} style={{ maxWidth: 300, margin: '0 auto' }}>
            {creatingRoom ? 'Creating room…' : 'Go Live ✨'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="experiment-shell">
      <header className="experiment-topbar">
        <button className="btn ghost" onClick={handleClose}>← End Broadcast</button>
        <h1>Broadcasting Live</h1>
        <span className="exp-badge">Experiment 5</span>
      </header>

      <div className="experiment-body">
        <div className="experiment-video-panel">
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        <aside className="experiment-side-panel">
          {roomCode && (
            <div className="broadcast-room-code">
              <span style={{ fontSize: '0.72rem', color: 'rgba(231,237,246,0.4)', display: 'block', marginBottom: 4 }}>Room code — share this</span>
              <span className="room-code-display">{roomCode}</span>
            </div>
          )}

          <div className="experiment-status">
            {status === 'idle' || status === 'connecting' ? 'Connecting to Odyssey…' :
             status === 'ready'     ? 'Stream ready — starting broadcast…' :
             status === 'streaming' ? 'Live! Audience prompts will appear below.' :
             status === 'error'     ? `Error: ${error}` : status}
          </div>

          <div className="broadcast-prompts-panel">
            <strong style={{ display: 'block', marginBottom: 8, fontSize: '0.75rem', color: 'rgba(121,150,255,0.8)' }}>
              Audience questions {prompts.length > 0 && `(${prompts.length})`}
            </strong>
            {prompts.length === 0 && (
              <p style={{ fontSize: '0.8rem', color: 'rgba(231,237,246,0.3)' }}>No questions yet.</p>
            )}
            {[...prompts].reverse().map((p) => (
              <div key={p.id} className="broadcast-prompt-item" onClick={() => void handlePromptSelect(p.text)}>
                <span className="broadcast-prompt-user">{p.username}</span>
                <span className="broadcast-prompt-text">{p.text}</span>
              </div>
            ))}
          </div>

          <button className="exp-btn danger" onClick={handleClose}>End Broadcast</button>
        </aside>
      </div>
    </div>
  );
}

// ─── Audience view ────────────────────────────────────────────────────────────

function AudienceView({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [codeInput, setCodeInput] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'enter' | 'waiting' | 'watching'>('enter');
  const [username, setUsername] = useState('');
  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const connectionRef = useRef<SpectatorConnection | null>(null);
  const codeRef = useRef<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connectSpectator = useCallback(async (webrtcUrl: string, spectatorToken: string) => {
    try {
      const conn = await Odyssey.connectToStream(webrtcUrl, spectatorToken);
      connectionRef.current = conn;
      if (videoRef.current) {
        videoRef.current.srcObject = conn.stream;
        videoRef.current.play().catch(() => undefined);
      }
      conn.onDisconnect(() => setPhase('enter'));
      setPhase('watching');
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Could not connect to stream.');
      setPhase('enter');
    }
  }, []);

  const pollRoom = useCallback(async () => {
    const code = codeRef.current;
    try {
      const res = await fetch(`/api/broadcast/room/${code}`);
      if (res.status === 404) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setJoinError('Room not found or expired.');
        setPhase('enter');
        return;
      }
      const data = await res.json() as { status: string; webrtcUrl?: string; spectatorToken?: string };
      if (data.status === 'live' && data.webrtcUrl && data.spectatorToken) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        await connectSpectator(data.webrtcUrl, data.spectatorToken);
      }
    } catch { /* ignore */ }
  }, [connectSpectator]);

  const joinRoom = useCallback(async () => {
    const code = codeInput.trim().toUpperCase();
    if (!code) return;
    setJoining(true);
    setJoinError(null);
    codeRef.current = code;

    try {
      const res = await fetch(`/api/broadcast/room/${code}`);
      if (res.status === 404) { setJoinError('Room not found. Check the code and try again.'); setJoining(false); return; }
      const data = await res.json() as { status: string; webrtcUrl?: string; spectatorToken?: string };
      if (data.status === 'live' && data.webrtcUrl && data.spectatorToken) {
        await connectSpectator(data.webrtcUrl, data.spectatorToken);
      } else {
        setPhase('waiting');
        pollRef.current = setInterval(() => void pollRoom(), 2000);
      }
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Could not join room.');
    } finally {
      setJoining(false);
    }
  }, [codeInput, connectSpectator, pollRoom]);

  const sendPrompt = useCallback(async () => {
    const text = promptText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await fetch(`/api/broadcast/room/${codeRef.current}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, username: username.trim() || 'Guest' }),
      });
      setPromptText('');
    } catch { /* ignore */ } finally {
      setSending(false);
    }
  }, [promptText, username, sending]);

  useEffect(() => {
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      connectionRef.current?.close();
    };
  }, []);

  const handleBack = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    connectionRef.current?.close();
    onBack();
  }, [onBack]);

  if (phase === 'enter') {
    return (
      <div className="experiment-shell">
        <header className="experiment-topbar">
          <button className="btn ghost" onClick={() => navigate('/home')}>← Back</button>
          <h1>Broadcast — Watch</h1>
          <span className="exp-badge">Experiment 5</span>
        </header>
        <div style={{ maxWidth: 400, margin: '80px auto', padding: '0 24px' }}>
          <div style={{ fontSize: 64, textAlign: 'center', marginBottom: 16 }}>👁️</div>
          <h2 style={{ textAlign: 'center', marginBottom: 24 }}>Join a broadcast</h2>

          <div className="setup-field">
            <label className="setup-label">Room code</label>
            <input
              type="text"
              className="exp-text-input"
              placeholder="e.g. ABC123"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === 'Enter') void joinRoom(); }}
              maxLength={6}
              style={{ letterSpacing: '0.2em', textTransform: 'uppercase', textAlign: 'center' }}
            />
          </div>
          <div className="setup-field">
            <label className="setup-label">Your name <span style={{ color: 'rgba(231,237,246,0.4)', fontWeight: 400 }}>(optional)</span></label>
            <input
              type="text"
              className="exp-text-input"
              placeholder="Guest"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={32}
            />
          </div>

          {joinError && <p style={{ color: '#ff6b6b', marginBottom: 12 }}>{joinError}</p>}
          <button className="exp-btn primary" onClick={joinRoom} disabled={!codeInput.trim() || joining}>
            {joining ? 'Joining…' : 'Join'}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'waiting') {
    return (
      <div className="experiment-shell">
        <header className="experiment-topbar">
          <button className="btn ghost" onClick={handleBack}>← Back</button>
          <h1>Waiting for host…</h1>
          <span className="exp-badge">Experiment 5</span>
        </header>
        <div style={{ textAlign: 'center', marginTop: 120, color: 'rgba(231,237,246,0.5)' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📡</div>
          <p>The host hasn't started yet. Hang tight…</p>
          <button className="exp-btn ghost" onClick={handleBack} style={{ maxWidth: 200, margin: '24px auto 0' }}>Cancel</button>
        </div>
      </div>
    );
  }

  // Watching
  return (
    <div className="experiment-shell">
      <header className="experiment-topbar">
        <button className="btn ghost" onClick={handleBack}>← Leave</button>
        <h1>Live Broadcast</h1>
        <span className="exp-badge">Experiment 5</span>
      </header>

      <div className="experiment-body">
        <div className="experiment-video-panel">
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        <aside className="experiment-side-panel">
          <div className="experiment-status">You're watching live. Send a question!</div>

          <div className="exp-prompt-row">
            <input
              type="text"
              className="exp-text-input"
              placeholder="Ask Einstein something…"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void sendPrompt(); }}
              disabled={sending}
            />
            <button className="exp-btn primary" onClick={sendPrompt} disabled={!promptText.trim() || sending}>
              {sending ? '…' : 'Send'}
            </button>
          </div>

          <p style={{ fontSize: '0.75rem', color: 'rgba(231,237,246,0.3)', marginTop: 'auto' }}>
            Your question will appear in the host's queue. They decide when Einstein answers.
          </p>
        </aside>
      </div>
    </div>
  );
}

// ─── Role chooser ─────────────────────────────────────────────────────────────

export default function BroadcastExperiment() {
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>('choose');

  if (role === 'host')     return <HostView onBack={() => setRole('choose')} />;
  if (role === 'audience') return <AudienceView onBack={() => setRole('choose')} />;

  return (
    <div className="experiment-shell">
      <header className="experiment-topbar">
        <button className="btn ghost" onClick={() => navigate('/home')}>← Back</button>
        <h1>Broadcast</h1>
        <span className="exp-badge">Experiment 5</span>
      </header>

      <div style={{ maxWidth: 560, margin: '80px auto', padding: '0 24px' }}>
        <h2 style={{ textAlign: 'center', marginBottom: 8 }}>How do you want to join?</h2>
        <p style={{ textAlign: 'center', color: 'rgba(231,237,246,0.5)', marginBottom: 40 }}>
          The host streams Einstein live — the audience watches and sends questions.
        </p>

        <div style={{ display: 'flex', gap: 16 }}>
          <button
            className="broadcast-role-card"
            onClick={() => setRole('host')}
          >
            <span style={{ fontSize: 40 }}>📡</span>
            <strong>Host</strong>
            <span>Start a live session and receive questions from your audience.</span>
          </button>

          <button
            className="broadcast-role-card"
            onClick={() => setRole('audience')}
          >
            <span style={{ fontSize: 40 }}>👁️</span>
            <strong>Audience</strong>
            <span>Watch the stream with a room code and send your questions.</span>
          </button>
        </div>
      </div>
    </div>
  );
}
