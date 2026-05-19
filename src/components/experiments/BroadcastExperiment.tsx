import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Odyssey, type SpectatorConnection } from '@odysseyml/odyssey';
import type { BroadcastInfo } from '@odysseyml/odyssey';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { useBroadcastAudio } from '../../hooks/useBroadcastAudio';
import { loadImageFile } from '../../lib/odyssey';
import { characters as ALL_CHARACTERS, type DemoCharacter } from '../../demo/shared/characters';

const DEFAULT_CHARACTER_ID  = 'einstein';
const BROADCAST_SUFFIX      = ' You are broadcasting live to an audience. Be engaging, witty, and respond to questions from the audience. Keep replies under 30 words.';
const POLL_INTERVAL_MS      = 3000;
const HEARTBEAT_INTERVAL_MS = 15000;
const FIRE_COOLDOWN_MS      = 3000;
// Audience's Odyssey WHEP video typically lags ~400ms behind the host's WebRTC
// stream. Audio plays through the same SSE fanout for both, so we delay the
// audience's audio by this much to keep lip-sync approximately right.
const AUDIENCE_AUDIO_DELAY_MS = 400;

const buildBroadcastPrompt = (c: DemoCharacter): string => `${c.prompt.trim()}${BROADCAST_SUFFIX}`;

type Role = 'choose' | 'host' | 'audience';
type HostPhase = 'setup' | 'live';
type AudiencePhase = 'enter' | 'waiting' | 'watching';

type AudiencePrompt = { id: string; text: string; username: string; timestamp: number };

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: { [index: number]: { isFinal: boolean; 0: { transcript: string } }; length: number } }) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const win = window as typeof window & {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

// ─── Reusable icons ───────────────────────────────────────────────────────────
const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2L11 13" />
    <path d="M22 2l-7 20-4-9-9-4 20-7z" />
  </svg>
);

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 15 12 9 18 15" />
  </svg>
);

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
  </svg>
);

// ─── Host view ────────────────────────────────────────────────────────────────

function HostView({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<HostPhase>('setup');
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>(DEFAULT_CHARACTER_ID);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<AudiencePrompt[]>([]);
  const [firedIds, setFiredIds] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const [hostText, setHostText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0); // seconds; 0 = idle
  // Auto-fire mode: when on, every audience prompt is enqueued the moment it
  // arrives (still subject to the 3s cooldown between dispatches). When off,
  // the host moderates manually by clicking questions in the drawer.
  const [autoFire, setAutoFire] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const hasSR = typeof window !== 'undefined' && !!getSpeechRecognition();

  // FIFO queue of pending prompts. Worker dequeues one at a time, calls
  // interact(), then waits FIRE_COOLDOWN_MS before pulling the next.
  const queueRef = useRef<Array<{ id: string; text: string }>>([]);
  const inflightRef = useRef(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedCharacter = useMemo(
    () => ALL_CHARACTERS.find((c) => c.id === selectedCharacterId) ?? ALL_CHARACTERS[0],
    [selectedCharacterId],
  );
  const characterName = selectedCharacter.title;

  const sinceRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const hostTokenRef = useRef<string | null>(null);

  const onBroadcastReady = useCallback(async (info: BroadcastInfo) => {
    const code = roomCodeRef.current;
    const hostToken = hostTokenRef.current;
    if (!code || !hostToken) return;
    await fetch(`/api/broadcast/room/${code}/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webrtcUrl: info.webrtcUrl, spectatorToken: info.spectatorToken, hlsUrl: info.hlsUrl, hostToken }),
    }).catch(() => undefined);
  }, []);

  const { status, error, videoRef, startStream, interact, disconnect } = useOdysseyStream({ onBroadcastReady });

  // Return-path monitoring: host subscribes to the same SSE audio fanout the
  // audience uses, so host hears Einstein speak in sync with the audience
  // (rather than the host's local speakers getting an instant copy).
  useBroadcastAudio(roomCode, { enabled: phase === 'live' && !!roomCode, extraDelayMs: 0 });

  const createRoom = useCallback(async () => {
    setCreatingRoom(true);
    setRoomError(null);
    try {
      const res = await fetch('/api/broadcast/room', { method: 'POST' });
      const data = await res.json() as { code?: string; hostToken?: string; error?: string };
      if (!res.ok || !data.code || !data.hostToken) throw new Error(data.error ?? 'Could not create room.');
      setRoomCode(data.code);
      roomCodeRef.current = data.code;
      hostTokenRef.current = data.hostToken;
      setPhase('live');
    } catch (err) {
      setRoomError(err instanceof Error ? err.message : 'Could not create room.');
    } finally {
      setCreatingRoom(false);
    }
  }, []);

  const copyCode = useCallback(async () => {
    if (!roomCode) return;
    try { await navigator.clipboard.writeText(roomCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* ignore */ }
  }, [roomCode]);

  useEffect(() => {
    if (status !== 'ready' || phase !== 'live') return;
    const run = async () => {
      const image = await loadImageFile(selectedCharacter.image, `${selectedCharacter.id}.png`);
      await startStream({ image, prompt: buildBroadcastPrompt(selectedCharacter), portrait: false, broadcast: true });
    };
    void run();
  }, [status, phase, startStream, selectedCharacter]);

  const pollPrompts = useCallback(async () => {
    const code = roomCodeRef.current;
    if (!code) return;
    try {
      const res = await fetch(`/api/broadcast/room/${code}/prompts?since=${sinceRef.current}`);
      if (!res.ok) return;
      const data = await res.json() as { prompts: AudiencePrompt[]; serverTime: number };
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

  useEffect(() => {
    if (phase !== 'live' || !roomCode) return;
    const ping = () => {
      const code = roomCodeRef.current;
      const hostToken = hostTokenRef.current;
      if (!code || !hostToken) return;
      void fetch(`/api/broadcast/room/${code}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostToken }),
      }).catch(() => undefined);
    };
    ping();
    heartbeatRef.current = setInterval(ping, HEARTBEAT_INTERVAL_MS);
    return () => { if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; } };
  }, [phase, roomCode]);

  // Drains one item from the queue: server runs chat + TTS, fans the audio out
  // to all subscribers (host + audience) over SSE; we drive Odyssey animation
  // with the returned action so the character's face moves alongside the voice.
  // Then a 3-second cooldown before the next item.
  const drainQueue = useCallback(async () => {
    if (inflightRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    inflightRef.current = true;
    setQueueDepth(queueRef.current.length);

    const code = roomCodeRef.current;
    const hostToken = hostTokenRef.current;
    try {
      if (!code || !hostToken) throw new Error('Room not ready');
      const res = await fetch(`/api/broadcast/room/${code}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: next.text,
          hostToken,
          character: characterName,
          history: [],
        }),
      });
      if (res.ok) {
        const data = await res.json() as { action?: string };
        const action = data.action?.trim();
        if (action) {
          // Animation in parallel with the audio fanout. Don't block the
          // cooldown timer on Odyssey's response.
          void interact(action).catch(() => undefined);
        }
      }
    } catch { /* fall through to cooldown */ }

    let remaining = Math.ceil(FIRE_COOLDOWN_MS / 1000);
    setCooldownLeft(remaining);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (cooldownTimerRef.current) { clearInterval(cooldownTimerRef.current); cooldownTimerRef.current = null; }
        setCooldownLeft(0);
        inflightRef.current = false;
        void drainQueue();
      } else {
        setCooldownLeft(remaining);
      }
    }, 1000);
  }, [interact, characterName]);

  const enqueuePrompt = useCallback((id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    queueRef.current.push({ id, text: trimmed });
    setQueueDepth(queueRef.current.length);
    void drainQueue();
  }, [drainQueue]);

  const handlePromptSelect = useCallback((id: string, text: string) => {
    if (firedIds.has(id)) return;
    setFiredIds((prev) => { const next = new Set(prev); next.add(id); return next; });
    enqueuePrompt(id, text);
  }, [firedIds, enqueuePrompt]);

  // Auto-fire: whenever `autoFire` is on, any prompt not yet fired gets
  // enqueued. The queue's 3s cooldown still throttles dispatch, so a burst
  // of audience prompts plays out serially rather than overlapping. When the
  // host flips the toggle on mid-session, the backlog of unfired prompts
  // drains in arrival order.
  useEffect(() => {
    if (!autoFire || status !== 'streaming') return;
    for (const p of prompts) {
      if (firedIds.has(p.id)) continue;
      setFiredIds((prev) => { const next = new Set(prev); next.add(p.id); return next; });
      enqueuePrompt(p.id, p.text);
    }
  }, [autoFire, prompts, firedIds, enqueuePrompt, status]);

  const handleHostSend = useCallback(() => {
    const text = hostText.trim();
    if (!text || status !== 'streaming') return;
    setHostText('');
    enqueuePrompt(`host-${Date.now()}`, text);
  }, [hostText, status, enqueuePrompt]);

  const toggleListening = useCallback(() => {
    const SR = getSpeechRecognition();
    if (!SR) return;
    if (isListening) { recognitionRef.current?.stop(); return; }
    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript || '';
      if (!transcript) return;
      if (status === 'streaming') {
        enqueuePrompt(`host-${Date.now()}`, transcript);
        setHostText('');
      } else {
        setHostText(transcript);
      }
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.start();
    setIsListening(true);
  }, [isListening, status, enqueuePrompt]);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    if (cooldownTimerRef.current) { clearInterval(cooldownTimerRef.current); cooldownTimerRef.current = null; }
  }, []);

  const handleClose = useCallback(async () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    const code = roomCodeRef.current;
    const hostToken = hostTokenRef.current;
    if (code) {
      await fetch(`/api/broadcast/room/${code}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostToken }),
      }).catch(() => undefined);
    }
    await disconnect();
    onBack();
  }, [disconnect, onBack]);

  // ── Setup screen ────────────────────────────────────────────────────────────
  if (phase === 'setup') {
    return (
      <div className="atrium app broadcast-setup-shell">
        <div className="ui">
          <header className="top-bar">
            <button className="btn ghost" onClick={onBack}>← Back</button>
          </header>
          <main className="broadcast-setup">
            <h1 className="broadcast-title">Pick a character to host.</h1>

            <div className="broadcast-char-grid">
              {ALL_CHARACTERS.map((c) => {
                const selected = c.id === selectedCharacterId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`broadcast-char ${selected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedCharacterId(c.id)}
                    aria-pressed={selected}
                  >
                    <span
                      className="broadcast-char__portrait"
                      style={{ backgroundImage: `url("${c.image}")` }}
                      aria-hidden
                    />
                    <span className="broadcast-char__name">{c.title}</span>
                  </button>
                );
              })}
            </div>

            <fieldset className="broadcast-mode-picker">
              <legend className="broadcast-mode-picker__legend">How should audience questions work?</legend>
              <div className="broadcast-mode-picker__options">
                <button
                  type="button"
                  className={`broadcast-mode-option ${!autoFire ? 'is-selected' : ''}`}
                  onClick={() => setAutoFire(false)}
                  aria-pressed={!autoFire}
                >
                  <span className="broadcast-mode-option__kicker">Moderated</span>
                  <span className="broadcast-mode-option__desc">
                    You curate which audience questions fire. Click each one in the drawer to send it.
                  </span>
                </button>
                <button
                  type="button"
                  className={`broadcast-mode-option ${autoFire ? 'is-selected is-auto' : ''}`}
                  onClick={() => setAutoFire(true)}
                  aria-pressed={autoFire}
                >
                  <span className="broadcast-mode-option__kicker">Auto-fire</span>
                  <span className="broadcast-mode-option__desc">
                    Every audience question fires automatically, 3 seconds apart. No curation.
                  </span>
                </button>
              </div>
              <p className="broadcast-mode-picker__lock">This is locked once you go live.</p>
            </fieldset>

            {roomError && <p className="broadcast-error-msg">{roomError}</p>}
            <button className="btn primary broadcast-go-live" onClick={createRoom} disabled={creatingRoom}>
              {creatingRoom ? 'Creating room…' : `Go live with ${characterName}`}
            </button>
          </main>
        </div>
      </div>
    );
  }

  // ── Live screen ─────────────────────────────────────────────────────────────
  const pending = prompts.filter((p) => !firedIds.has(p.id));
  const pendingCount = pending.length;
  const streaming = status === 'streaming';

  return (
    <div className="atrium app broadcast-live-shell">
      <div className="video-layer">
        <div className="stream-placeholder" style={{ backgroundImage: `url("${selectedCharacter.image}")` }} aria-hidden />
        <video
          ref={videoRef}
          className={`video-element ${streaming ? '' : 'is-hidden'}`}
          autoPlay
          playsInline
          muted
        />
        <div className="video-overlay" />
      </div>

      <div className="ui">
        <header className="top-bar">
          <button className="btn ghost back-to-landing" onClick={handleClose}>← End Broadcast</button>
          <div className="broadcast-top-right">
            {roomCode && (
              <button type="button" className="broadcast-code-chip" onClick={copyCode} title="Click to copy">
                <span className="broadcast-code-chip__label">Room</span>
                <span className="broadcast-code-chip__code">{roomCode}</span>
                <span className="broadcast-code-chip__hint">{copied ? 'Copied ✓' : 'Copy'}</span>
              </button>
            )}
          </div>
        </header>

        <main className="slide-shell" />

        <div className="story-bar-wrap">
          <div className="chat-drawer-shell">
            <div className={`chat-drawer ${drawerOpen ? 'chat-drawer--open' : ''}`} aria-hidden={!drawerOpen}>
              <div className="chat-drawer__body">
                {prompts.length === 0 && (
                  <p className="chat-drawer__empty">No audience questions yet — share the room code.</p>
                )}
                {[...prompts].reverse().map((p) => {
                  const fired = firedIds.has(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`broadcast-question ${fired ? 'broadcast-question--fired' : ''}`}
                      onClick={() => { if (!fired) void handlePromptSelect(p.id, p.text); }}
                      disabled={fired || !streaming}
                      title={fired ? 'Already sent' : `Send to ${characterName}`}
                    >
                      <span className="broadcast-question__who">
                        {p.username}{fired && <span className="broadcast-question__check"> ✓</span>}
                      </span>
                      <span className="broadcast-question__text">{p.text}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              className={`chat-history-toggle ${drawerOpen ? 'chat-history-toggle--open' : ''}`}
              onClick={() => setDrawerOpen((v) => !v)}
              aria-expanded={drawerOpen}
            >
              <ChevronIcon />
              <span className="chat-history-toggle__label">
                {drawerOpen
                  ? 'Hide'
                  : cooldownLeft > 0 && queueDepth > 0
                    ? `Next in ${cooldownLeft}s · ${queueDepth} queued`
                    : cooldownLeft > 0
                      ? `Sending… ${cooldownLeft}s`
                      : pendingCount > 0
                        ? `${pendingCount} new`
                        : `${prompts.length} question${prompts.length === 1 ? '' : 's'}`}
              </span>
            </button>
          </div>

          <footer className="story-bar story-bar--compact">
            <div className={`chat-pill ${!streaming ? 'chat-pill--waking' : ''}`}>
              <input
                className="chat-pill__input"
                type="text"
                value={hostText}
                onChange={(e) => setHostText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleHostSend(); }}
                placeholder={
                  status === 'error' ? `Error: ${error ?? 'unknown'}` :
                  !streaming ? `Waking up ${characterName}…` :
                  isListening ? 'Listening…' :
                  cooldownLeft > 0 && queueDepth > 0 ? `Next in ${cooldownLeft}s · ${queueDepth} queued` :
                  cooldownLeft > 0 ? `Sending… ${cooldownLeft}s` :
                  `Ask ${characterName} something…`
                }
                disabled={!streaming || isListening}
                aria-label="Send a prompt"
                aria-busy={!streaming}
              />
              {isListening ? (
                <button
                  type="button"
                  className="chat-pill__action chat-pill__mic chat-pill__mic--recording chat-pill__mic--listening"
                  onClick={toggleListening}
                  aria-label="Stop listening"
                >
                  <span className="chat-pill__mic-pulse" aria-hidden />
                </button>
              ) : hostText.trim().length > 0 ? (
                <button
                  type="button"
                  className="chat-pill__action chat-pill__send"
                  onClick={handleHostSend}
                  disabled={!streaming}
                  aria-label="Send"
                >
                  <SendIcon />
                </button>
              ) : (
                <button
                  type="button"
                  className="chat-pill__action chat-pill__mic"
                  onClick={toggleListening}
                  disabled={!streaming || !hasSR}
                  aria-label={hasSR ? `Talk to ${characterName}` : 'Voice unsupported in this browser'}
                  title={hasSR ? 'Speak to send' : 'Voice unsupported'}
                >
                  <MicIcon />
                </button>
              )}
            </div>
          </footer>
        </div>
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
  const [phase, setPhase] = useState<AudiencePhase>('enter');
  const [username, setUsername] = useState('');
  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);
  const [sentFlash, setSentFlash] = useState(false);
  // State copy of the room code (refs don't trigger re-render → hook can't re-subscribe).
  const [connectedCode, setConnectedCode] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const connectionRef = useRef<SpectatorConnection | null>(null);
  const codeRef = useRef<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Audio fanout playback (with delay to match Odyssey video lag).
  useBroadcastAudio(connectedCode, {
    enabled: phase === 'watching' && !!connectedCode,
    extraDelayMs: AUDIENCE_AUDIO_DELAY_MS,
  });

  const stopWatching = useCallback((message: string) => {
    if (watchPollRef.current) { clearInterval(watchPollRef.current); watchPollRef.current = null; }
    connectionRef.current?.close();
    connectionRef.current = null;
    setConnectedCode(null);
    setJoinError(message);
    setPhase('enter');
  }, []);

  const connectSpectator = useCallback(async (webrtcUrl: string, spectatorToken: string) => {
    try {
      const conn = await Odyssey.connectToStream(webrtcUrl, spectatorToken);
      connectionRef.current = conn;
      if (videoRef.current) {
        videoRef.current.srcObject = conn.stream;
        videoRef.current.play().catch(() => undefined);
      }
      conn.onDisconnect(() => stopWatching('Host ended the broadcast.'));
      setConnectedCode(codeRef.current);
      setPhase('watching');
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Could not connect to stream.');
      setPhase('enter');
    }
  }, [stopWatching]);

  useEffect(() => {
    if (phase !== 'watching') return;
    const check = async () => {
      try {
        const res = await fetch(`/api/broadcast/room/${codeRef.current}`);
        if (res.status === 410 || res.status === 404) stopWatching('Host ended the broadcast.');
      } catch { /* ignore */ }
    };
    watchPollRef.current = setInterval(() => void check(), 5000);
    return () => { if (watchPollRef.current) { clearInterval(watchPollRef.current); watchPollRef.current = null; } };
  }, [phase, stopWatching]);

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
      if (res.status === 410) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setJoinError('Host ended the broadcast.');
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
      if (res.status === 410) { setJoinError('Host ended the broadcast.'); setJoining(false); return; }
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
      const res = await fetch(`/api/broadcast/room/${codeRef.current}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, username: username.trim() || 'Guest' }),
      });
      if (res.ok) {
        setPromptText('');
        setSentFlash(true);
        setTimeout(() => setSentFlash(false), 1400);
      }
    } catch { /* ignore */ } finally {
      setSending(false);
    }
  }, [promptText, username, sending]);

  useEffect(() => () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (watchPollRef.current) { clearInterval(watchPollRef.current); watchPollRef.current = null; }
    connectionRef.current?.close();
  }, []);

  const handleBack = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (watchPollRef.current) { clearInterval(watchPollRef.current); watchPollRef.current = null; }
    connectionRef.current?.close();
    onBack();
  }, [onBack]);

  // ── Enter screen ────────────────────────────────────────────────────────────
  if (phase === 'enter') {
    return (
      <div className="atrium app broadcast-setup-shell">
        <div className="ui">
          <header className="top-bar">
            <button className="btn ghost" onClick={() => navigate('/labs')}>← Back</button>
          </header>
          <main className="broadcast-setup">
            <p className="broadcast-eyebrow">Experiment 5 · Watch</p>
            <h1 className="broadcast-title">Join a broadcast.</h1>
            <p className="broadcast-lede">Drop in with a room code. Watch live — and ask anything.</p>

            <div className="broadcast-join-fields">
              <label className="broadcast-field">
                <span className="broadcast-field__label">Room code</span>
                <input
                  type="text"
                  className="broadcast-code-input"
                  placeholder="ABCDEF"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') void joinRoom(); }}
                  maxLength={6}
                />
              </label>
              <label className="broadcast-field">
                <span className="broadcast-field__label">Your name <span className="broadcast-field__hint">(optional)</span></span>
                <input
                  type="text"
                  className="broadcast-name-input"
                  placeholder="Guest"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  maxLength={32}
                />
              </label>
            </div>

            {joinError && <p className="broadcast-error-msg">{joinError}</p>}
            <button className="btn primary broadcast-go-live" onClick={joinRoom} disabled={!codeInput.trim() || joining}>
              {joining ? 'Joining…' : 'Join'}
            </button>
          </main>
        </div>
      </div>
    );
  }

  // ── Waiting screen ──────────────────────────────────────────────────────────
  if (phase === 'waiting') {
    return (
      <div className="atrium app broadcast-setup-shell">
        <div className="ui">
          <header className="top-bar">
            <button className="btn ghost" onClick={handleBack}>← Back</button>
          </header>
          <main className="broadcast-setup">
            <p className="broadcast-eyebrow">Room {codeRef.current}</p>
            <h1 className="broadcast-title">Waiting for the host…</h1>
            <p className="broadcast-lede">The host hasn't started yet. Hang tight — we'll connect you as soon as it goes live.</p>
            <span className="broadcast-loading-dot" aria-hidden />
          </main>
        </div>
      </div>
    );
  }

  // ── Watching screen ─────────────────────────────────────────────────────────
  return (
    <div className="atrium app broadcast-live-shell">
      <div className="video-layer">
        <video ref={videoRef} className="video-element" autoPlay playsInline muted />
        <div className="video-overlay" />
      </div>

      <div className="ui">
        <header className="top-bar">
          <button className="btn ghost back-to-landing" onClick={handleBack}>← Leave</button>
          <span className="broadcast-code-chip" title="Room code">
            <span className="broadcast-code-chip__label">Room</span>
            <span className="broadcast-code-chip__code">{codeRef.current}</span>
          </span>
        </header>

        <main className="slide-shell" />

        <div className="story-bar-wrap">
          <footer className="story-bar story-bar--compact">
            <div className="chat-pill">
              <input
                className="chat-pill__input"
                type="text"
                placeholder={sentFlash ? 'Sent — host will see it' : 'Ask anything…'}
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void sendPrompt(); }}
                disabled={sending}
                aria-label="Send a question"
              />
              <button
                type="button"
                className="chat-pill__action chat-pill__send"
                onClick={sendPrompt}
                disabled={!promptText.trim() || sending}
                aria-label="Send"
              >
                <SendIcon />
              </button>
            </div>
          </footer>
        </div>
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
    <div className="atrium app broadcast-setup-shell">
      <div className="ui">
        <header className="top-bar">
          <button className="btn ghost" onClick={() => navigate('/labs')}>← Back</button>
        </header>
        <main className="broadcast-setup">
          <h1 className="broadcast-title">Open the room. Anyone can walk in.</h1>

          <div className="broadcast-role-grid">
            <button type="button" className="broadcast-role host" onClick={() => setRole('host')}>
              <span className="broadcast-role__kicker">Host</span>
              <span className="broadcast-role__title">Go live with a character</span>
              <span className="broadcast-role__desc">Start a stream and take questions from your audience.</span>
            </button>
            <button type="button" className="broadcast-role audience" onClick={() => setRole('audience')}>
              <span className="broadcast-role__kicker">Audience</span>
              <span className="broadcast-role__title">Join with a room code</span>
              <span className="broadcast-role__desc">Watch the stream and send your questions.</span>
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
