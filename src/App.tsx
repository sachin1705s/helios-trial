import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import type { ConnectionStatus } from '@odysseyml/odyssey';
import type { User } from '@supabase/supabase-js';
import charactersData from './data/characters.json';
import { trackEvent } from './lib/analytics';
import { OdysseyService, credentialsFromDict, loadImageFile, type ClientCredentials, type StreamState } from './lib/odyssey';
import { SEO_PAGES, applySeo } from './lib/seo';
import { supabase } from './lib/supabase';
import { AuthModal } from './components/AuthModal';
import './App.css';

// Debug logger — silent by default in production.
// To enable in any environment, open DevTools console and run:
//   localStorage.setItem('debug', 'true')  then refresh
// To disable:
//   localStorage.removeItem('debug')       then refresh
const debug = (...args: unknown[]) => {
  if (import.meta.env.DEV || localStorage.getItem('debug') === 'true') {
    console.log(...args);
  }
};

interface Character {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  image: string;
  prompt: string;
  cta: string;
  greeting?: string;
}

type SpeechRecognitionResultEvent = Event & {
  results: {
    [index: number]: {
      isFinal: boolean;
      0: { transcript: string };
    };
    length: number;
  };
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const characters = (charactersData as { characters: Character[] }).characters;

// Concatenate Int16 PCM frames (e.g. captured from AudioWorklet) into a single
// little-endian Int16Array buffer suitable for pcmToWav.
function concatInt16Frames(frames: Int16Array[]): ArrayBuffer {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return out.buffer;
}

// Concatenate raw byte frames (Gemini Live's 24kHz Int16-LE PCM payloads) into
// one ArrayBuffer suitable for pcmToWav.
function concatUint8Frames(frames: Uint8Array[]): ArrayBuffer {
  let total = 0;
  for (const f of frames) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { out.set(f, off); off += f.length; }
  return out.buffer;
}

function pcmToWav(pcm: ArrayBuffer, sampleRate: number, channels: number, bitDepth: number): ArrayBuffer {
  const dataLen = pcm.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bitDepth / 8, true);
  v.setUint16(32, channels * bitDepth / 8, true); v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm));
  return buf;
}

function App({ initialCharacterId, dripCheck = false }: { initialCharacterId?: string; dripCheck?: boolean }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [credentials, setCredentials] = useState<ClientCredentials | undefined>(undefined);
  const [showLanding, setShowLanding] = useState(!initialCharacterId);
  const [dripWebcamActive, setDripWebcamActive] = useState(false);
  const [dripBusy, setDripBusy] = useState(false);
  const dripVideoRef = useRef<HTMLVideoElement | null>(null);
  const dripStreamRef = useRef<MediaStream | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(initialCharacterId ?? characters[0]?.id ?? null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [_error, setError] = useState<string | null>(null);
  const [isStreamingReady, setIsStreamingReady] = useState(false);
  const [sessionSecondsLeft, setSessionSecondsLeft] = useState(300);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [, setSpeechError] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState('');
  const [isCharacterRecording, setIsCharacterRecording] = useState(false);
  const [isCharacterThinking, setIsCharacterThinking] = useState(false);
  const [isCharacterSpeaking, setIsCharacterSpeaking] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [characterReply, setCharacterReply] = useState<string | null>(null);
  const [characterSources, setCharacterSources] = useState<{ title: string; url: string }[]>([]);
  const [, setCharacterError] = useState<string | null>(null);
  const [, setModerationError] = useState<string | null>(null);
  const [characterHistory, setCharacterHistory] = useState<Record<string, Array<{ role: 'user' | 'assistant'; content: string }>>>({});
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [isMusicEnabled, setIsMusicEnabled] = useState(false);
  const [, setIsMusicPlaying] = useState(false);
  const [, setVoiceError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const odysseyStreamRef = useRef<MediaStream | null>(null);
  const characterRecorderRef = useRef<MediaRecorder | null>(null);
  const characterStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const backgroundAudioRef = useRef<HTMLAudioElement | null>(null);
  const serviceRef = useRef<OdysseyService | null>(null);
  const odysseyLeaseIdRef = useRef<string | null>(null);
  const odysseyHeartbeatRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const imageCacheRef = useRef<Map<string, File>>(new Map());
  const retryStreamRef = useRef<(() => Promise<void>) | null>(null);
  const moderationRetryCountRef = useRef(0);
  const isStreamingReadyRef = useRef(false);
  const streamActiveRef = useRef(false); // Set directly in Odyssey callbacks — no React cycle
  const dataChannelReadyRef = useRef(false); // true only after onConnected fires; false when reconnecting
  const pendingStartRef = useRef<(() => Promise<void>) | null>(null); // startStream fn waiting for onConnected
  const startStreamInFlightRef = useRef(false); // true while startStream is awaited — blocks re-entrant calls
  const streamEndResolverRef = useRef<(() => void) | null>(null); // resolves when onStreamEnded fires during a transition
  const streamRequestIdRef = useRef(0); // set to requestId just before startStream — onStreamStarted checks for staleness
  const isVoiceAgentSlideRef = useRef(false);
  const greetedCharactersRef = useRef<Set<string>>(new Set()); // tracks which characters have greeted this session
  const ttsSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsHtmlAudioRef = useRef<HTMLAudioElement | null>(null);
  const handleInteractRef = useRef<(promptOverride?: string) => void>(() => undefined);
  const runCharacterInteractionRef = useRef<(userText: string, slideId: string, characterName: string) => Promise<void>>(async () => undefined);
  const ttsAudioCtxRef = useRef<AudioContext | null>(null);
  const ttsGenerationRef = useRef(0); // incremented on navigation — cancels any in-flight TTS across all await boundaries
  const characterOpenedAtRef = useRef<number | null>(null);
  const sessionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasLoggedFirstPromptRef = useRef(false);
  const currentPageRef = useRef<string | null>(null);
  const showLandingRef = useRef(showLanding); // kept in sync below — safe to read in SDK callbacks
  // Gemini Live session state
  const geminiLiveWsRef = useRef<WebSocket | null>(null);
  const geminiLiveCaptureCtxRef = useRef<AudioContext | null>(null);
  const geminiLivePlayCtxRef = useRef<AudioContext | null>(null);
  const geminiLiveGenerationRef = useRef(0);
  const geminiLiveActiveRef = useRef(false);
  const geminiLivePlaybackTimeRef = useRef(0);
  const geminiLiveSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  // Per-turn PCM buffers used to reconstruct WAV files for chat-history replay.
  // userPcmFramesRef collects 16kHz Int16 chunks the AudioWorklet/ScriptProcessor
  // hands us before they go out on the wire to Gemini Live. assistantPcmFramesRef
  // collects the 24kHz Uint8 chunks we receive from Gemini Live and play back.
  // Both are flushed (encoded → blob URL → stored) on their respective turn-end
  // events (inputTranscription for user, turnComplete for assistant).
  const userPcmFramesRef = useRef<Int16Array[]>([]);
  const assistantPcmFramesRef = useRef<Uint8Array[]>([]);
  const [audioRecordings, setAudioRecordings] = useState<Record<string, string>>({});
  const replayAudioRef = useRef<HTMLAudioElement | null>(null);
  const [replayingKey, setReplayingKey] = useState<string | null>(null);
  // Mirrors characterHistory so WS event handlers (defined at session-start
  // and frozen with stale closures) can read the *current* per-character
  // length when computing the next message's index — without doing the
  // antipattern of calling setState inside another setState's updater.
  const characterHistoryRef = useRef<Record<string, Array<{ role: 'user' | 'assistant'; content: string }>>>({});
  // Two-phase Odyssey transcript buffers — reset each turn
  const glCurrentUserTextRef = useRef('');
  const glOutputTranscriptBufferRef = useRef('');
  const glPhase2FiredRef = useRef(false); // prevents duplicate Phase 2 calls per turn
  // Odyssey context tracking — for V8/V9/V10 strategies
  const glLastAckPromptRef = useRef<string>(''); // populated by SDK's onInteractAcknowledged callback

  const logEvent = (event: string, data: Record<string, unknown>, transport: 'fetch' | 'beacon' = 'fetch') => {
    trackEvent(event, data, { transport });
  };

  const closeActiveCharacter = (reason: 'switch' | 'landing_back' | 'page_exit') => {
    if (!selectedCharacterId || characterOpenedAtRef.current === null) {
      return;
    }
    const timeSpentMs = Date.now() - characterOpenedAtRef.current;
    const currentCharacter = characters.find((c) => c.id === selectedCharacterId);
    logEvent('character_closed', {
      characterId: selectedCharacterId,
      characterName: currentCharacter?.title ?? selectedCharacterId,
      timeSpentMs,
      reason,
    }, reason === 'page_exit' ? 'beacon' : 'fetch');
    characterOpenedAtRef.current = null;
  };

  const logFirstPromptIfNeeded = (characterId: string, characterName: string, inputMethod: string) => {
    if (!hasLoggedFirstPromptRef.current && characterOpenedAtRef.current !== null) {
      logEvent('time_to_first_prompt', {
        characterId,
        characterName,
        inputMethod,
        timeMs: Date.now() - characterOpenedAtRef.current,
      });
      hasLoggedFirstPromptRef.current = true;
    }
  };

  const stopOdysseyHeartbeat = () => {
    if (odysseyHeartbeatRef.current !== null) {
      window.clearInterval(odysseyHeartbeatRef.current);
      odysseyHeartbeatRef.current = null;
    }
  };

  const startOdysseyHeartbeat = (leaseId: string) => {
    stopOdysseyHeartbeat();
    odysseyHeartbeatRef.current = window.setInterval(() => {
      fetch('/api/odyssey/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId }),
      }).catch(() => undefined);
    }, 60_000);
  };

  const releaseOdysseyLease = () => {
    const leaseId = odysseyLeaseIdRef.current;
    if (!leaseId) return;
    stopOdysseyHeartbeat();
    const payload = JSON.stringify({ leaseId });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/odyssey/release', blob);
    } else {
      fetch('/api/odyssey/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => undefined);
    }
    odysseyLeaseIdRef.current = null;
  };

  const selectedCharacter = characters.find((item) => item.id === selectedCharacterId) ?? characters[0];
  const slide = selectedCharacter;
  const slideImageUrl = encodeURI(slide?.image ?? '');

  const VOICE_AGENT_ID_BY_SLIDE: Record<string, { id: string; label: string }> = {
    'circus-lion': { id: '', label: 'Circus Lion' },
    'einstein': { id: '', label: 'Albert Einstein' }
  };
  const activeVoiceAgent = slide ? VOICE_AGENT_ID_BY_SLIDE[slide.id] : null;
  const isVoiceAgentSlide = Boolean(activeVoiceAgent);
  const activeCharacterName = slide?.title ?? 'Character';
  const activeCharacterHistory = slide ? characterHistory[slide.id] ?? [] : [];
  const slideCtaRef = useRef('');

  const handleMusicToggle = () => {
    const audio = backgroundAudioRef.current;
    if (!audio) return;

    if (isMusicEnabled) {
      setIsMusicEnabled(false);
      audio.pause();
      return;
    }

    setIsMusicEnabled(true);
    void audio.play().catch(() => undefined);
  };

  const backgroundMusicNode = (
    <audio
      ref={backgroundAudioRef}
      src="/background-music.mpeg"
      preload="none"
      aria-hidden="true"
    />
  );

  const musicToggleButton = (
    <button
      type="button"
      className={`music-toggle ${isMusicEnabled ? 'is-playing' : 'is-paused'}`}
      onClick={handleMusicToggle}
      aria-label={isMusicEnabled ? 'Pause background music' : 'Play background music'}
      aria-pressed={isMusicEnabled}
    >
      <span className="music-toggle-bars" aria-hidden="true">
        <span className="music-bar" />
        <span className="music-bar" />
        <span className="music-bar" />
        <span className="music-bar" />
        <span className="music-bar" />
      </span>
    </button>
  );


  // Auth state — subscribe to Supabase session changes (no-op when not configured)
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session) setShowAuthModal(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const syncFromLocation = () => {
      const path = window.location.pathname;
      const isAbout = path === '/about-us';
      const isContact = path === '/contact';
      setShowAbout(isAbout);
      setShowContact(isContact);
      if (isAbout || isContact) {
        setShowLanding(true);
      }
    };
    syncFromLocation();
    const onPopState = () => syncFromLocation();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const pageName = showLanding
      ? showAbout
        ? 'about'
        : showContact
          ? 'contact'
          : 'landing'
      : `character:${selectedCharacterId ?? 'unknown'}`;
    if (currentPageRef.current === pageName) {
      return;
    }
    currentPageRef.current = pageName;
    logEvent('page_view', {
      pageName,
      characterId: showLanding ? null : selectedCharacterId,
    });
  }, [selectedCharacterId, showAbout, showContact, showLanding]);

  useEffect(() => {
    if (showAbout) {
      applySeo(SEO_PAGES.about);
      return;
    }
    if (showContact) {
      applySeo(SEO_PAGES.contact);
      return;
    }
    applySeo(SEO_PAGES.home);
  }, [showAbout, showContact]);

  useEffect(() => {
    const audio = backgroundAudioRef.current;
    if (!audio) return;

    audio.volume = 1; // gain is controlled by the Web Audio graph below
    audio.loop = true;

    // Shape the background music to feel ambient and non-intrusive:
    // - Low gain so it sits well beneath any foreground sound
    // - Low-shelf cut reduces boomy low-end that feels imposing
    // - High-shelf cut softens brightness that draws attention
    // - Mid scoop pulls back the 1–3kHz "presence" range so it
    //   doesn't compete with voices or feel like it's "speaking"
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);

    const gain = ctx.createGain();
    gain.gain.value = 0.10;

    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 220;
    lowShelf.gain.value = -9;

    const highShelf = ctx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 5500;
    highShelf.gain.value = -16;

    const midScoop = ctx.createBiquadFilter();
    midScoop.type = 'peaking';
    midScoop.frequency.value = 1800;
    midScoop.Q.value = 0.8;
    midScoop.gain.value = -6;

    source.connect(lowShelf);
    lowShelf.connect(midScoop);
    midScoop.connect(highShelf);
    highShelf.connect(gain);
    gain.connect(ctx.destination);

    // AudioContext may be suspended until a user gesture — resume on first interaction
    const resume = () => { void ctx.resume(); };
    document.addEventListener('click', resume, { once: true });
    document.addEventListener('keydown', resume, { once: true });

    return () => {
      document.removeEventListener('click', resume);
      document.removeEventListener('keydown', resume);
      ctx.close();
    };
  }, []);

  useEffect(() => {
    const audio = backgroundAudioRef.current;
    if (!audio) return;

    const syncPlaybackState = () => {
      setIsMusicPlaying(!audio.paused);
    };

    audio.addEventListener('play', syncPlaybackState);
    audio.addEventListener('pause', syncPlaybackState);
    audio.addEventListener('ended', syncPlaybackState);

    return () => {
      audio.removeEventListener('play', syncPlaybackState);
      audio.removeEventListener('pause', syncPlaybackState);
      audio.removeEventListener('ended', syncPlaybackState);
    };
  }, []);

  useEffect(() => {
    const audio = backgroundAudioRef.current;
    if (!audio) return;

    const shouldPlay = showLanding && isMusicEnabled;
    if (!shouldPlay) {
      audio.pause();
      return;
    }

    const attemptPlay = () => {
      void audio.play().catch(() => undefined);
    };

    attemptPlay();

    const retryOnInteraction = () => {
      attemptPlay();
      if (!audio.paused) {
        window.removeEventListener('pointerdown', retryOnInteraction);
        window.removeEventListener('keydown', retryOnInteraction);
      }
    };

    window.addEventListener('pointerdown', retryOnInteraction);
    window.addEventListener('keydown', retryOnInteraction);

    return () => {
      window.removeEventListener('pointerdown', retryOnInteraction);
      window.removeEventListener('keydown', retryOnInteraction);
    };
  }, [showLanding, isMusicEnabled]);

  useEffect(() => {
    if (showLanding) return; // Wait until user has selected a character before connecting
    let cancelled = false;
    const requestToken = async () => {
      try {
        const response = await fetch('/api/odyssey/token');
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          const message = data?.error || 'Odyssey not available right now.';
          if (!cancelled) setError(message);
          return;
        }
        const data = await response.json();
        if (cancelled) return;
        if (data?.credentials) {
          setCredentials(credentialsFromDict(data.credentials));
        } else {
          setError('Missing Odyssey credentials. Set ODYSSEY_API_KEYS in your server environment.');
        }
        if (data?.leaseId) {
          odysseyLeaseIdRef.current = data.leaseId;
          startOdysseyHeartbeat(data.leaseId);
        }
      } catch {
        if (!cancelled) setError('Failed to reach Odyssey. Please try again.');
      }
    };
    requestToken();
    return () => {
      cancelled = true;
    };
  }, [showLanding]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      closeActiveCharacter('page_exit');
      releaseOdysseyLease();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount/unmount only — cleanup on character switch is handled by handleSelectCharacter


  useEffect(() => {
    isStreamingReadyRef.current = isStreamingReady;
  }, [isStreamingReady]);

  useEffect(() => {
    characterHistoryRef.current = characterHistory;
  }, [characterHistory]);

  useEffect(() => {
    showLandingRef.current = showLanding;
  }, [showLanding]);

  // Fire a character greeting once per session, only after the stream is ready.
  // greetedCharactersRef guards against re-firing when the effect re-runs.
  useEffect(() => {
    if (!isStreamingReady || showLandingRef.current) return;
    const charId = slide.id;
    const greeting = slide.greeting;
    if (!greeting || greetedCharactersRef.current.has(charId)) return;

    greetedCharactersRef.current.add(charId);
    setCharacterReply(greeting);
    setCharacterHistory((prev) => ({
      ...prev,
      [charId]: [...(prev[charId] ?? []), { role: 'assistant', content: greeting }],
    }));
    handleInteractRef.current('smile and wave hello warmly');
    // TTS is best-effort — AudioContext may be suspended until first user gesture
    playGreetingTTS(greeting, charId).catch(() => undefined);
  }, [isStreamingReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    isVoiceAgentSlideRef.current = isVoiceAgentSlide;
    if (!isVoiceAgentSlide && voiceStatus === 'connected') {
      setVoiceStatus('idle');
    }
  }, [isVoiceAgentSlide, voiceStatus]);

  useEffect(() => {
    if (!isStreamingReady && voiceStatus === 'connected') {
      setVoiceStatus('idle');
      setVoiceError('Stream stopped.');
    }
  }, [isStreamingReady, voiceStatus]);

  useEffect(() => {
    if (showLanding || !selectedCharacterId) {
      if (sessionTimerRef.current) {
        clearInterval(sessionTimerRef.current);
        sessionTimerRef.current = null;
      }
      return;
    }

    // Start or resume the 5-minute timer as soon as a character is selected.
    // This makes the session limit independent of stream flickers or reconnection delays.
    if (!sessionTimerRef.current) {
      sessionTimerRef.current = setInterval(() => {
        setSessionSecondsLeft((prev) => {
          if (prev <= 1) {
            if (sessionTimerRef.current) {
              clearInterval(sessionTimerRef.current);
              sessionTimerRef.current = null;
            }
            retryStreamRef.current = null;
            stopGeminiLiveSession();
            serviceRef.current?.endStream().catch(() => undefined);
            ++ttsGenerationRef.current;
            ttsAbortRef.current?.abort();
            ttsAbortRef.current = null;
            for (const node of ttsSourceNodesRef.current) { try { node.stop(); } catch { /* already stopped */ } }
            ttsSourceNodesRef.current = [];
            setIsStreamingReady(false);
            setSessionExpired(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      // We only clear the interval here if the effect is torn down (character switch or landing)
      if (sessionTimerRef.current) {
        clearInterval(sessionTimerRef.current);
        sessionTimerRef.current = null;
      }
    };
  }, [showLanding, selectedCharacterId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (voiceStatus === 'connected' && isVoiceAgentSlide) {
      return;
    }
    stopVoiceCapture();
  }, [voiceStatus, isVoiceAgentSlide]);

  useEffect(() => {
    slideCtaRef.current = slide?.cta || 'Animate it';
  }, [slide?.cta]);


  useEffect(() => {
    if (!credentials) return; // Credentials not yet fetched — wait for character selection

    const service = new OdysseyService(credentials);
    serviceRef.current = service;

    service
      .connect({
        onConnected: (stream) => {
          debug('[odyssey] onConnected — stream:', stream);
          // Set 'connected' here (not in onStatusChange) so startStream is only
          // called after the data channel is open and ready.
          dataChannelReadyRef.current = true;
          setConnectionStatus('connected');
          // If run() fired before the data channel was ready it stored its start fn here.
          // Call it directly — no React re-render, no effect re-run, exactly one startStream.
          const pending = pendingStartRef.current;
          if (pending) {
            pendingStartRef.current = null;
            pending().catch(() => undefined);
          }
          odysseyStreamRef.current = stream;
          const attach = () => {
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              videoRef.current.play().catch((e: unknown) => {
                console.warn('[odyssey] video.play failed:', e);
                // AbortError means play() was interrupted (e.g. mid-render) — retry once
                if ((e as { name?: string })?.name === 'AbortError') {
                  setTimeout(() => { videoRef.current?.play().catch(() => undefined); }, 150);
                }
              });
            } else {
              setTimeout(attach, 100);
            }
          };
          attach();
        },
        onStatusChange: (status) => {
          debug('[odyssey] status:', status);
          // 'connected' is set in onConnected instead, which fires only after
          // both the video track and data channel are ready.
          if (status !== 'connected') {
            setConnectionStatus(status);
            dataChannelReadyRef.current = false; // data channel is not ready during reconnect
          }
        },
        onStreamStarted: () => {
          debug('[odyssey] onStreamStarted');
          // User navigated back before the stream finished starting — end it and ignore.
          if (showLandingRef.current) {
            serviceRef.current?.endStream().catch(() => undefined);
            return;
          }
          // Stale stream — user switched characters before this one finished starting.
          // requestIdRef holds the latest request; streamRequestIdRef holds which request
          // called startStream. A mismatch means this onStreamStarted is for an old character.
          if (streamRequestIdRef.current !== requestIdRef.current) {
            debug('[odyssey] onStreamStarted — stale stream (requestId mismatch), discarding');
            serviceRef.current?.endStream().catch(() => undefined);
            return;
          }
          streamActiveRef.current = true;
          setStreamState('streaming');
          setIsStreamingReady(true);
          setModerationError(null);
        },
        onStreamEnded: () => {
          debug('[odyssey] onStreamEnded');
          streamActiveRef.current = false;
          setStreamState('ended');
          setIsStreamingReady(false);
          // If run() is waiting for the previous stream to fully end before calling
          // startStream on the new character, unblock it now.
          const resolve = streamEndResolverRef.current;
          streamEndResolverRef.current = null;
          if (resolve) {
            resolve();
            return; // Skip auto-restart — a new startStream is already queued
          }
          // Auto-restart the stream so interact() keeps working
          if (retryStreamRef.current) {
            debug('[odyssey] auto-restarting stream after end');
            setStreamState('starting');
            retryStreamRef.current().catch(() => {
              setStreamState('error');
              setIsStreamingReady(false);
            });
          }
        },
        onStreamError: (reason, message) => {
          console.error('[odyssey] onStreamError:', reason, message);
          streamActiveRef.current = false;
          const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
          const m = typeof message === 'string' ? message : JSON.stringify(message);
          if (r === 'moderation_failed') {
            // 'Failed to run content moderation' = the moderation service itself failed
            // (capacity/transition artifact during i2v session setup, not a content rejection).
            // The SDK will reconnect and Effect 2 will retry — suppress all error UI.
            if (m === 'Failed to run content moderation') {
              setStreamState('starting');
              return;
            }
            // Real content moderation rejection — log analytics, retry silently up to 3×, then surface.
            logEvent('moderation_blocked', {
              reason: r,
              message: m,
              characterId: slide.id,
              characterName: activeCharacterName,
            });
            setStreamState('error');
            setIsStreamingReady(false);
            if (moderationRetryCountRef.current < 3 && retryStreamRef.current) {
              moderationRetryCountRef.current++;
              debug(`[odyssey] moderation_failed — retrying (attempt ${moderationRetryCountRef.current})`);
              setStreamState('starting');
              const retry = retryStreamRef.current;
              setTimeout(() => {
                retry().catch(() => {
                  setStreamState('error');
                  setIsStreamingReady(false);
                });
              }, 1000);
            } else {
              setModerationError('Prompt blocked by moderation. Please try a different request.');
              setError(null);
            }
            return;
          }
          logEvent('stream_error', {
            reason: r,
            message: m,
            characterId: slide.id,
            characterName: activeCharacterName,
          });
          setStreamState('error');
          setIsStreamingReady(false);
          setError(`${r}: ${m}`);
        },
        onInteractAcknowledged: (prompt) => {
          glLastAckPromptRef.current = prompt;
        },
        onError: (err) => {
          console.error('[odyssey] onError:', err);
          streamActiveRef.current = false;
          setStreamState('error');
          setIsStreamingReady(false);
          if (err.message?.includes('moderation_failed')) {
            logEvent('moderation_blocked', {
              reason: 'exception',
              message: err.message,
              characterId: slide.id,
              characterName: activeCharacterName,
            });
            setModerationError('Prompt blocked by moderation. Please try a different request.');
            setError(null);
            return;
          }
          logEvent('stream_error', {
            reason: 'client_error',
            message: err.message,
            characterId: slide.id,
            characterName: activeCharacterName,
          });
          setError(err.message);
        }
      })
      .catch((err) => {
        setStreamState('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      service
        .endStream()
        .catch(() => undefined)
        .finally(() => {
          service.disconnect().catch(() => undefined);
        });
    };
  }, [credentials]);

  useEffect(() => {
    const service = serviceRef.current;
    if (!service || connectionStatus !== 'connected' || showLanding) {
      return;
    }

    const requestId = ++requestIdRef.current;
    moderationRetryCountRef.current = 0;
    setStreamState('starting');
    setIsStreamingReady(false);
    setError(null);
    setModerationError(null);

    const run = async () => {
      // Clear retry immediately so onStreamEnded does not auto-restart the previous
      // character while we are transitioning.
      retryStreamRef.current = null;

      // Read and immediately clear streamActiveRef atomically.
      // This ref is set directly in Odyssey callbacks (not via useEffect), so it
      // accurately reflects whether a stream is live right now — no React cycle lag.
      const hadActiveStream = streamActiveRef.current;
      streamActiveRef.current = false;

      if (hadActiveStream) {
        // Wait for onStreamEnded, not just endStream() — the SDK needs the stream fully
        // torn down before it can accept a new startStream. Calling startStream while the
        // previous stream is still cleaning up internally causes an extra reconnect cycle.
        await new Promise<void>((resolve) => {
          streamEndResolverRef.current = resolve;
          service.endStream().catch(() => {
            // endStream failed — clear resolver and unblock immediately
            streamEndResolverRef.current = null;
            resolve();
          });
        });
      }

      const cached = imageCacheRef.current.get(slide.id);
      const file = cached ?? (await loadImageFile(slide.image, `${slide.id}.png`));
      if (!cached) {
        imageCacheRef.current.set(slide.id, file);
      }
      if (requestIdRef.current !== requestId) {
        return;
      }

      const streamOptions = { prompt: slide.prompt, image: file, portrait: slide.id === 'characters-sudharshan' };
      // retryStreamRef is set AFTER startStream resolves — prevents onStreamEnded (macrotask from
      // previous endStream) from racing with the initial call and triggering a double startStream → deadlock.

      // Guard: data channel must be confirmed open (onConnected fired) before startStream.
      // If not ready, store the start fn — onConnected will call it directly (no React re-render).
      // This avoids the connectionEpoch feedback loop:
      // startStream → SDK reconnects → onConnected → epoch bump → second startStream → deadlock.
      if (!dataChannelReadyRef.current) {
        debug('[odyssey] data channel not ready — queuing startStream for onConnected');
        pendingStartRef.current = async () => {
          if (requestIdRef.current !== requestId) return;
          debug('[odyssey] calling startStream (from pending) — slide:', slide.id, '| prompt:', slide.prompt?.slice(0, 60));
          streamRequestIdRef.current = requestId;
          await service.startStream(streamOptions);
          if (requestIdRef.current === requestId) {
            retryStreamRef.current = () => service.startStream(streamOptions).then(() => undefined);
          }
        };
        return;
      }
      pendingStartRef.current = null;
      if (requestIdRef.current !== requestId) return;
      // Mutex: if a startStream is already awaiting (e.g. triggered by a stale effect re-run from
      // onConnected → setConnectionStatus), bail out — the in-flight call will resolve or retry.
      if (startStreamInFlightRef.current) {
        debug('[odyssey] startStream already in flight — skipping duplicate call');
        return;
      }
      startStreamInFlightRef.current = true;
      streamRequestIdRef.current = requestId;
      debug('[odyssey] calling startStream — slide:', slide.id, '| prompt:', slide.prompt?.slice(0, 60));
      try {
        await service.startStream(streamOptions);
      } finally {
        startStreamInFlightRef.current = false;
      }
      debug('[odyssey] startStream resolved');
      if (requestIdRef.current === requestId) {
        retryStreamRef.current = () => service.startStream(streamOptions).then(() => undefined);
      }
    };

    run().catch((err) => {
      if (requestIdRef.current !== requestId) {
        return;
      }
      startStreamInFlightRef.current = false;
      setStreamState('error');
      setIsStreamingReady(false);
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      startStreamInFlightRef.current = false;
      pendingStartRef.current = null;
    };
  }, [connectionStatus, showLanding, selectedCharacterId, slide.id, slide.image, slide.prompt]);

  // End the stream when the user navigates back to the landing page so the session isn't consumed idle.
  useEffect(() => {
    if (!showLanding) return;
    // Stop any active Gemini Live session (audio + WebSocket + mic)
    if (geminiLiveActiveRef.current) {
      stopGeminiLiveAudio();
      stopGeminiLiveSession();
    }
    ++requestIdRef.current; // Invalidate any pending retry closure
    retryStreamRef.current = null;
    if (streamActiveRef.current) {
      streamActiveRef.current = false;
      serviceRef.current?.endStream().catch(() => undefined);
    }
    // Invalidate any in-flight TTS — checked at every await boundary in playCharacterTTS
    ++ttsGenerationRef.current;
    // Stop any in-flight TTS fetch and all scheduled audio playback
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    for (const node of ttsSourceNodesRef.current) { try { node.stop(); } catch { /* already stopped */ } }
    ttsSourceNodesRef.current = [];
    ttsHtmlAudioRef.current?.pause();
    ttsHtmlAudioRef.current = null;
    // Close the AudioContext to immediately silence any already-scheduled chunks
    // (abort() stops new chunks from being fetched but tracked nodes keep playing until stopped above)
    ttsAudioCtxRef.current?.close().catch(() => undefined);
    ttsAudioCtxRef.current = null;
    // Reset stream ready state immediately — onStreamEnded fires async so without this,
    // isStreamingReady stays true and the greeting TTS fires before the stream restarts.
    setIsStreamingReady(false);
    setStreamState('idle');
    // Clear the current character's chat state so returning starts fresh
    const charId = slide.id;
    setCharacterReply(null);
    setCharacterHistory((prev) => { const next = { ...prev }; delete next[charId]; return next; });
    // Allow the greeting to re-fire when the user returns to this character
    greetedCharactersRef.current.delete(charId);
  }, [showLanding]); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    const preload = async (target: Character) => {
      if (imageCacheRef.current.has(target.id)) {
        return;
      }
      try {
        const file = await loadImageFile(target.image, `${target.id}.png`);
        imageCacheRef.current.set(target.id, file);
      } catch {
        // ignore preload errors
      }
    };
    if (slide) {
      preload(slide);
    }
  }, [slide, slideImageUrl]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      recognitionRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    return () => {
      characterRecorderRef.current?.stop();
      characterStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('tutorial-seen')) {
      setShowVideoModal(true);
    }
  }, []);

  const handleCloseVideoModal = () => {
    localStorage.setItem('tutorial-seen', '1');
    setShowVideoModal(false);
  };

  // If the Odyssey stream connected while the landing page was showing (video element
  // didn't exist yet), attach the stream now that the story view is rendered.
  useEffect(() => {
    if (!showLanding && odysseyStreamRef.current && videoRef.current) {
      if (!videoRef.current.srcObject) {
        videoRef.current.srcObject = odysseyStreamRef.current;
        videoRef.current.play().catch(() => undefined);
      }
    }
  }, [showLanding]);

  const pttActiveRef = useRef(false);
  const pttStartRef = useRef<() => boolean>(() => false);
  const pttStopRef = useRef<() => void>(() => {});

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.code === 'Space' && e.ctrlKey && !pttActiveRef.current) {
        e.preventDefault();
        e.stopPropagation();
        (document.activeElement as HTMLElement | null)?.blur();
        const started = pttStartRef.current();
        pttActiveRef.current = started;
      }
    };

    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if ((e.code === 'Space' || e.code === 'ControlLeft' || e.code === 'ControlRight') && pttActiveRef.current) {
        e.preventDefault();
        pttActiveRef.current = false;
        pttStopRef.current();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, []);

  const handleInteract = (promptOverride?: string) => {
    if (!serviceRef.current || !isStreamingReadyRef.current) {
      return;
    }
    const prompt = (promptOverride ?? slide.cta).trim();
    if (!prompt) {
      return;
    }
    serviceRef.current.interact(prompt).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  useEffect(() => {
    handleInteractRef.current = handleInteract;
  }, [handleInteract]);

  const stopDripWebcam = useCallback(() => {
    dripStreamRef.current?.getTracks().forEach((t) => t.stop());
    dripStreamRef.current = null;
    if (dripVideoRef.current) dripVideoRef.current.srcObject = null;
    setDripWebcamActive(false);
  }, []);

  const ensureDripWebcam = useCallback(async () => {
    if (dripStreamRef.current) return dripStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    dripStreamRef.current = stream;
    setDripWebcamActive(true);
    if (dripVideoRef.current) {
      dripVideoRef.current.srcObject = stream;
      await dripVideoRef.current.play().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 500));
    return stream;
  }, []);

  // Auto-start webcam when drip-check mode is on so the circle is visible from the start
  useEffect(() => {
    if (!dripCheck) return;
    void ensureDripWebcam().catch((err) => console.warn('[drip] auto-start failed:', err));
    return () => { stopDripWebcam(); };
  }, [dripCheck, ensureDripWebcam, stopDripWebcam]);

  const captureDripFrame = useCallback(async (): Promise<Blob | null> => {
    await ensureDripWebcam().catch(() => undefined);
    const video = dripVideoRef.current;
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
  }, [ensureDripWebcam]);

  const handleDripCheck = useCallback(async () => {
    if (dripBusy) return;
    setDripBusy(true);
    try {
      const blob = await captureDripFrame();
      if (!blob) throw new Error('No frame captured.');
      const fd = new FormData();
      fd.append('image', blob, 'drip.jpg');
      const res = await fetch('/api/drip-check', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('drip-check request failed: ' + res.status);
      const data = await res.json();
      const slideId = selectedCharacterId ?? slide.id;
      if (data.noPerson || !data.description) {
        await runCharacterInteractionRef.current(
          '[Drip Check: I stepped in front of your camera but you can\'t see me clearly. React in one short sentence.]',
          slideId,
          activeCharacterName,
        );
        return;
      }
      const userText = `[Drip Check: take a quick look at me through your camera and comment on my style. Here\'s what you see: ${data.description}. Reply in ONE sentence — under 20 words — playful and in character.]`;
      await runCharacterInteractionRef.current(userText, slideId, activeCharacterName);
    } catch (err) {
      console.error('[drip-check] failed:', err);
    } finally {
      setDripBusy(false);
    }
  }, [dripBusy, selectedCharacterId, slide, activeCharacterName, captureDripFrame]);

  const handleItemGrab = useCallback(async () => {
    if (dripBusy) return;
    setDripBusy(true);
    try {
      const blob = await captureDripFrame();
      if (!blob) throw new Error('No frame captured.');
      const fd = new FormData();
      fd.append('image', blob, 'item.jpg');
      const res = await fetch('/api/item-grab', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('item-grab request failed: ' + res.status);
      const data = await res.json();
      const slideId = selectedCharacterId ?? slide.id;
      if (data.noObject || !data.description) {
        await runCharacterInteractionRef.current(
          '[Item Grab: I tried to show you something but you can\'t see it clearly. Ask me to hold it closer in one short sentence.]',
          slideId,
          activeCharacterName,
        );
        return;
      }
      const userText = `[Item Grab: I\'m holding something up to your camera. Here\'s what you see: ${data.description}. React with curiosity and comment on the object in ONE sentence — under 20 words — in character.]`;
      await runCharacterInteractionRef.current(userText, slideId, activeCharacterName);
    } catch (err) {
      console.error('[item-grab] failed:', err);
    } finally {
      setDripBusy(false);
    }
  }, [dripBusy, selectedCharacterId, slide, activeCharacterName, captureDripFrame]);


  const stopVoiceCapture = () => {
    // no-op: using SDK transcripts instead of browser speech
  };


  // Gemini Live prebuilt voices — one unique voice per character.
  // Male-coded: Orus, Charon, Fenrir, Puck (firm/warm/excitable/upbeat).
  // Female-coded: Kore, Aoede (firm/breathy) — used for Cleopatra to match TTS 'sophia'.
  const GEMINI_VOICE_BY_SLIDE_ID: Record<string, string> = {
    'alexander':     'Orus',
    'bear':          'Charon',
    'circus-lion':   'Fenrir',
    'cleopatra':     'Kore',
    'da-vinci':      'Puck',
    'einstein':      'Zephyr',
    'grandpa-turtle':'Leda',
    'steve-jobs':    'Aoede',
  };

  // --- Gemini Live helpers ---

  const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += 8192) {
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    }
    return btoa(chunks.join(''));
  };

  const base64ToUint8Array = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // Plays back a buffered chat-history recording. Cancels any in-flight replay
   // first so rapid clicks across messages don't overlap.
  const playRecording = (key: string) => {
    const url = audioRecordings[key];
    if (!url) return;
    if (replayAudioRef.current) {
      try { replayAudioRef.current.pause(); } catch { /* already stopped */ }
      replayAudioRef.current = null;
    }
    if (replayingKey === key) {
      // Toggle off if user clicks the same one again
      setReplayingKey(null);
      return;
    }
    const audio = new Audio(url);
    replayAudioRef.current = audio;
    setReplayingKey(key);
    audio.onended = () => {
      if (replayAudioRef.current === audio) replayAudioRef.current = null;
      setReplayingKey((current) => (current === key ? null : current));
    };
    audio.onerror = () => {
      if (replayAudioRef.current === audio) replayAudioRef.current = null;
      setReplayingKey((current) => (current === key ? null : current));
    };
    audio.play().catch(() => {
      if (replayAudioRef.current === audio) replayAudioRef.current = null;
      setReplayingKey((current) => (current === key ? null : current));
    });
  };

  // Schedules a 16-bit PCM chunk for gapless playback via the dedicated Gemini Live play context.
  // Safe to call from WebSocket message handlers — uses refs, never stale state.
  const enqueuePCMChunk = (data: Uint8Array, sampleRate: number) => {
    if (!geminiLivePlayCtxRef.current) return;
    const ctx = geminiLivePlayCtxRef.current;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => undefined); }
    const usable = data.length - (data.length % 2);
    if (usable === 0) return;
    // Buffer assistant audio for replay (kept separate from the playback path).
    assistantPcmFramesRef.current.push(new Uint8Array(data.subarray(0, usable)));
    const int16 = new Int16Array(data.buffer, data.byteOffset, usable / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    // Keep playback time from falling behind (e.g. after a pause or barge-in reset)
    if (geminiLivePlaybackTimeRef.current < ctx.currentTime + 0.05) {
      geminiLivePlaybackTimeRef.current = ctx.currentTime + 0.05;
    }
    geminiLiveSourceNodesRef.current.push(source);
    source.onended = () => {
      const idx = geminiLiveSourceNodesRef.current.indexOf(source);
      if (idx !== -1) geminiLiveSourceNodesRef.current.splice(idx, 1);
    };
    source.start(geminiLivePlaybackTimeRef.current);
    geminiLivePlaybackTimeRef.current += audioBuffer.duration;
  };

  // Flush all queued Gemini Live audio (e.g. on barge-in). Does NOT close the session.
  const stopGeminiLiveAudio = () => {
    for (const source of geminiLiveSourceNodesRef.current) {
      try { source.stop(); } catch { /* already ended */ }
    }
    geminiLiveSourceNodesRef.current = [];
    geminiLivePlaybackTimeRef.current = 0;
  };

  // Per-character keyword → scene-object map. Only the active character's entries are searched.
  const GL_KEYWORD_MAP: Record<string, Array<{ keywords: string[]; object: string }>> = {
    einstein: [
      { keywords: ['ball', 'bowling ball', 'heavy ball', 'mass', 'massive', 'weight', 'heavy', 'marble'], object: 'a heavy ball' },
      { keywords: ['clock', 'watch', 'timepiece', 'time', 'ticking', 'second', 'tick'], object: 'a ticking clock' },
      { keywords: ['light', 'beam', 'laser', 'photon', 'ray', 'shine', 'glow', 'speed of light'], object: 'a beam of light' },
      { keywords: ['trampoline', 'fabric', 'sheet', 'spacetime', 'curvature', 'bend', 'warp', 'dip', 'stretch'], object: 'a trampoline' },
      { keywords: ['rocket', 'spaceship', 'spacecraft', 'travel', 'speed', 'fast', 'velocity'], object: 'a rocket' },
      { keywords: ['magnet', 'magnetic', 'attract', 'repel', 'field', 'force field'], object: 'a magnet' },
      { keywords: ['apple', 'gravity', 'fall', 'falling', 'drop', 'newton'], object: 'a falling apple' },
      { keywords: ['telescope', 'lens', 'observe', 'star', 'distant', 'universe', 'cosmos', 'galaxy'], object: 'a telescope' },
      { keywords: ['atom', 'nucleus', 'electron', 'particle', 'quantum', 'subatomic', 'proton', 'neutron'], object: 'an atom' },
      { keywords: ['wave', 'ripple', 'oscillate', 'frequency', 'vibrate', 'undulate'], object: 'a wave' },
    ],
    bear: [
      { keywords: ['berry', 'berries', 'blueberry', 'strawberry', 'fruit', 'ripe', 'juicy', 'pick', 'sweet'], object: 'a handful of berries' },
      { keywords: ['honey', 'honeycomb', 'sweet', 'golden', 'drip', 'sticky', 'nectar', 'bee'], object: 'a honeycomb' },
      { keywords: ['fish', 'salmon', 'trout', 'catch', 'river', 'stream', 'swim', 'splash'], object: 'a fresh fish' },
      { keywords: ['pine cone', 'pinecone', 'acorn', 'nut', 'seed', 'squirrel'], object: 'a pine cone' },
      { keywords: ['mushroom', 'fungus', 'forest floor', 'toadstool'], object: 'a mushroom' },
      { keywords: ['log', 'wood', 'stick', 'branch', 'timber', 'trunk'], object: 'a log' },
    ],
    alexander: [
      { keywords: ['sword', 'blade', 'sabre', 'cut', 'slash', 'steel', 'weapon', 'fight'], object: 'a gleaming sword' },
      { keywords: ['shield', 'buckler', 'defend', 'protect', 'block', 'guard'], object: 'a battle shield' },
      { keywords: ['map', 'scroll', 'plan', 'territory', 'route', 'campaign', 'strategy', 'terrain'], object: 'a battle map' },
      { keywords: ['horse', 'cavalry', 'steed', 'ride', 'mount', 'gallop', 'bucephalus', 'charge'], object: 'a horse' },
      { keywords: ['spear', 'lance', 'javelin', 'pike', 'thrust', 'phalanx'], object: 'a spear' },
      { keywords: ['crown', 'throne', 'king', 'rule', 'reign', 'conquer', 'empire', 'kingdom'], object: 'a golden crown' },
      { keywords: ['army', 'troops', 'soldiers', 'march', 'legion', 'battalion', 'banner', 'flag', 'rally'], object: 'a battle flag' },
      { keywords: ['arrow', 'bow', 'archer', 'shoot', 'aim', 'volley'], object: 'a bow and arrow' },
    ],
    'circus-lion': [
      { keywords: ['juggling ball', 'circus ball', 'ball', 'catch', 'toss', 'throw', 'bounce'], object: 'a juggling ball' },
      { keywords: ['hoop', 'ring', 'circle', 'jump through', 'loop'], object: 'a circus hoop' },
      { keywords: ['juggling pins', 'pins', 'juggle', 'spin', 'twirl', 'club'], object: 'juggling pins' },
      { keywords: ['rubber chicken', 'chicken', 'funny', 'silly', 'squeak', 'gag', 'comedy'], object: 'a rubber chicken' },
      { keywords: ['spinning plate', 'plate', 'balance', 'wobble', 'steady'], object: 'a spinning plate' },
    ],
    cleopatra: [
      { keywords: ['lotus', 'lotus flower', 'bloom', 'blossom', 'rebirth', 'flower'], object: 'a golden lotus' },
      { keywords: ['cat', 'feline', 'bastet', 'purr', 'sacred animal'], object: 'an Egyptian cat' },
      { keywords: ['ankh', 'eternal', 'immortal', 'life symbol', 'afterlife'], object: 'an ankh' },
      { keywords: ['sphinx', 'riddle', 'guardian', 'monument'], object: 'a sphinx' },
      { keywords: ['pyramid', 'tomb', 'pharaoh', 'monument', 'great pyramid', 'giza'], object: 'a pyramid' },
      { keywords: ['papyrus', 'parchment', 'scroll', 'write', 'decree', 'knowledge', 'wisdom', 'text', 'ancient'], object: 'an ancient scroll' },
      { keywords: ['jewel', 'gem', 'diamond', 'ruby', 'emerald', 'sapphire', 'treasure', 'gold', 'precious', 'sparkle', 'gleam'], object: 'a precious gem' },
    ],
    'da-vinci': [
      { keywords: ['gear', 'cog', 'wheel', 'mechanism', 'machine', 'clockwork', 'mechanical', 'rotate', 'turn'], object: 'a brass gear' },
      { keywords: ['wing', 'flying machine', 'glider', 'flight', 'soar', 'bird', 'feather', 'airborne', 'lift'], object: 'a feathered wing' },
      { keywords: ['compass', 'divider', 'measure', 'geometry', 'circle', 'proportion', 'golden ratio'], object: 'a compass' },
      { keywords: ['paintbrush', 'brush', 'palette', 'paint', 'canvas', 'colour', 'color', 'stroke', 'art', 'mona lisa'], object: 'a paintbrush' },
      { keywords: ['sketch', 'drawing', 'blueprint', 'design', 'draft', 'diagram', 'schematic', 'plan', 'notebook'], object: 'a technical sketch' },
      { keywords: ['spring', 'coil', 'tension', 'elastic', 'bounce', 'energy', 'compress'], object: 'a spring' },
      { keywords: ['mirror', 'reflect', 'glass', 'image', 'reverse', 'backwards', 'reflection'], object: 'a mirror' },
    ],
    'grandpa-turtle': [
      { keywords: ['stone', 'rock', 'pebble', 'river stone', 'smooth', 'round', 'polish', 'patience'], object: 'a smooth stone' },
      { keywords: ['leaf', 'leaves', 'foliage', 'autumn', 'fall', 'season', 'change', 'colour', 'drift'], object: 'a fallen leaf' },
      { keywords: ['shell', 'turtle shell', 'home', 'carry', 'protect', 'hide'], object: 'a shell' },
      { keywords: ['firefly', 'lightning bug', 'glow', 'light up', 'twinkle', 'lantern', 'night', 'spark'], object: 'a firefly' },
      { keywords: ['pond', 'river', 'stream', 'water', 'lake', 'creek', 'ripple', 'flow', 'current'], object: 'a pond' },
      { keywords: ['bark', 'tree', 'oak', 'root', 'trunk', 'branch', 'ring', 'grow', 'ancient tree', 'wood'], object: 'a piece of bark' },
    ],
    'steve-jobs': [
      { keywords: ['device', 'iphone', 'phone', 'tablet', 'ipad', 'mac', 'computer', 'product', 'gadget', 'technology', 'screen'], object: 'a sleek device' },
      { keywords: ['chip', 'circuit', 'processor', 'silicon', 'transistor', 'hardware', 'motherboard', 'computing'], object: 'a circuit board' },
      { keywords: ['button', 'click', 'simple', 'minimal', 'interface', 'touch', 'press', 'one button'], object: 'a single button' },
      { keywords: ['calligraphy', 'font', 'typography', 'pen', 'letter', 'typeface', 'beautiful', 'craft', 'handwriting'], object: 'a calligraphy pen' },
    ],
  };

  // Shared: dispatch objects to Odyssey, deduplicated per turn.
  // Each dispatch sends ALL accumulated objects so Odyssey always has the full picture
  // and doesn't remove earlier objects when a new one is added.
  const glDispatchedThisTurnRef = useRef<Set<string>>(new Set());

  // Per-turn counter — incremented on each inputTranscription so async fallbacks
  // (LLM extraction) can detect if their turn has already ended.
  const glTurnIdRef = useRef(0);

  const glDispatchObjects = (objects: string[], myGeneration: number, source: string) => {
    if (geminiLiveGenerationRef.current !== myGeneration) return;
    const fresh = objects.filter(o => !glDispatchedThisTurnRef.current.has(o));
    if (!fresh.length) return;
    fresh.forEach(o => glDispatchedThisTurnRef.current.add(o));
    const all = [...glDispatchedThisTurnRef.current];
    console.log(`[gl-objects][${source}] dispatching (new: ${fresh.join(', ')}; total: ${all.join(', ')}) at +${Date.now() - glTurnStartRef.current}ms`);
    // Send each fresh object as its own simple command — Odyssey parses short prompts
    // far more reliably than long multi-item sentences.
    for (const obj of fresh) {
      handleInteractRef.current(`show ${obj}`);
    }
  };

  // Shared: extract objects from text via keyword matching, scoped to the active character.
  const glKeywordMatch = (text: string, characterId: string): string[] => {
    const lower = text.toLowerCase();
    const entries = GL_KEYWORD_MAP[characterId] ?? [];
    const found: string[] = [];
    for (const entry of entries) {
      if (entry.keywords.some(k => lower.includes(k))) {
        found.push(entry.object);
      }
    }
    return found;
  };

  // Turn-start timestamp for latency logging.
  const glTurnStartRef = useRef(0);

  // Resets per-turn state at the start of each user turn.
  const glPhase1Action = (myGeneration: number) => {
    if (geminiLiveGenerationRef.current !== myGeneration) return;
    glTurnStartRef.current = Date.now();
    glDispatchedThisTurnRef.current = new Set();
    ++glTurnIdRef.current;
    // Intentionally no 'listen actively' interact call — it queues ahead of object
    // dispatch in Odyssey and adds ~200–400ms of latency before objects can land.
  };

  // ─── Strategy implementations ─────────────────────────────────────────────

  // Keyword-stream: dispatch objects from each outputTranscription chunk via keyword matching.
  const glDispatchKeywords = (chunk: string, myGeneration: number) => {
    const objects = glKeywordMatch(chunk, selectedCharacterId ?? '');
    if (objects.length) glDispatchObjects(objects, myGeneration, 'keyword-stream');
  };



  // NOTE: These prompts are for the Gemini Live audio path only.
  // The text-chat path uses a separate set of prompts in server/index.js (promptByCharacter).
  // Keep both in sync when editing character personalities.
  const GEMINI_LIVE_SYSTEM_PROMPTS: Record<string, string> = {
    einstein: [
      'You are Albert Einstein — curious, warm, and full of wonder. You have a gentle sense of humour and love making the impossible feel simple.',
      'You explain big ideas through everyday objects. When you reach for an analogy, use something real and physical — a ball rolling down a hill, a clock ticking on a moving train, a beam of light racing through space.',
      'Those objects will literally appear on screen as you speak. So name them clearly and specifically.',
      'Good examples: "Imagine a heavy ball — watch how it bends the fabric around it." or "Here, a clock — now picture it on a rocket moving near light speed."',
      'Personality: childlike curiosity, dry wit, self-deprecating charm. You delight in being wrong and correcting yourself.',
      'Keep every reply under 40 words. Speak as if talking to a curious ten-year-old. Use vivid, physical examples always.',
    ].join('\n'),

    alexander: [
      'You are Alexander the Great — bold, magnetic, and utterly certain of your destiny. You speak with the authority of someone who has never lost.',
      'You think in armies, maps, terrain, and tactics. When you explain something, you use the tools of war and conquest — a sword, a map rolled out on a table, a horse rearing up, a shield raised.',
      'Those objects will appear on screen as you speak. Name them directly.',
      'Good examples: "Here — look at this map. The enemy holds the river. We go around." or "A sword is only as strong as the will behind it."',
      'Personality: commanding but not cruel. You respect courage above all things. Occasionally reveal the loneliness of being the greatest.',
      'Keep every reply under 40 words. Speak with fire and conviction.',
    ].join('\n'),

    bear: [
      'You are Steve the Bear — a big, warm, gentle bear who loves sharing things. You are a natural storyteller with a cozy, campfire energy.',
      'You love showing things. When you explain something, you pull out an object and hold it up — a fat honeycomb dripping with honey, a fresh-caught fish, a handful of wild berries, a pine cone.',
      'Those objects will actually appear on screen for your friend to see. You love this — it is how you share.',
      'Good examples: "Oh, look at this honeycomb I found this morning — smell that?" or "Here, a berry — this is how you know it is ripe, see the colour?"',
      'Personality: patient, delighted by small things, occasionally distracted by the smell of food. You call the user "little friend" or "friend".',
      'Keep every reply under 40 words. Warm and unhurried. Always show something.',
    ].join('\n'),

    'circus-lion': [
      'You are Leo the Circus Lion — a proud, theatrical showman who lives for the roar of the crowd. Everything you do is a performance.',
      'You love props. When you make a point, you reach for something physical and show it off — a juggling ball, a hoop, a pair of juggling pins, a rubber chicken, a spinning plate.',
      'Those props will appear on screen as you perform. Use them constantly.',
      'Good examples: "Watch this — a ball, in the air, spinning! That is gravity, my friend." or "Here, a hoop — everything in life is about getting through the right hoops!"',
      'Personality: dramatically confident, loves applause, occasionally goofs up and plays it off as intentional. You treat the user as your most important audience member.',
      'Keep every reply under 40 words. Theatrical and energetic. Every sentence is a performance.',
    ].join('\n'),

    cleopatra: [
      'You are Cleopatra, Queen of the Nile — regal, razor-sharp, and in complete command of every room you enter. You are also warmer than people expect.',
      'You speak through the symbols of your world — a golden lotus, an ancient scroll, a jewelled crown, a cat, an ankh, a sphinx, desert sand.',
      'Those objects will appear on screen as you speak. Let them punctuate your words.',
      'Good examples: "This lotus — in Egypt, it means rebirth. Everything dies, everything returns." or "A scroll holds more power than any sword. Knowledge is my army."',
      'Personality: supremely confident but never cold. You find humans endlessly interesting. Occasionally amused by how little they understand.',
      'Keep every reply under 40 words. Speak like every word is deliberate.',
    ].join('\n'),

    'da-vinci': [
      'You are Leonardo da Vinci — painter, engineer, anatomist, dreamer. Your mind skips between disciplines the way others breathe.',
      'You think by making and showing. When an idea strikes you, you reach for something physical — a gear, a feathered wing, a compass, a paintbrush, a lens, a spring, a sketch.',
      'Those objects will appear on screen as you explore them. Use them to think out loud.',
      'Good examples: "A gear — now, if I connect it here, the force multiplies. Nature does the same thing with bone and muscle." or "Look at this wing — every feather placed by a logic I spent years learning."',
      'Personality: endlessly curious, easily distracted by beauty, slightly frustrated that the world cannot keep up. You jump between topics mid-thought.',
      'Keep every reply under 40 words. Think out loud. Show your work.',
    ].join('\n'),

    'grandpa-turtle': [
      'You are Grandpa Turtle — ancient, unhurried, and full of quiet wisdom. You have seen everything at least twice and it no longer surprises you.',
      'You tell stories through the things you find along the path — a smooth river stone, a fallen leaf, an acorn, a shell, a piece of bark, a firefly.',
      'Those objects will appear on screen as you talk. Hold them up gently.',
      'Good examples: "This stone — do you know how long the river rubbed it to make it smooth? Patience. That is all." or "A leaf falls but it feeds the tree that drops it. Nothing is wasted."',
      'Personality: warm, slow-spoken, occasionally chuckling at something only you understand. You never rush. You ask more questions than you answer.',
      'Keep every reply under 40 words. Gentle pace. Every word earns its place.',
    ].join('\n'),

    'steve-jobs': [
      'You are Steve Jobs — visionary, relentlessly exacting, and convinced that most people settle for far less than they should.',
      'You think through objects and systems. When you make a point, you pick up something physical — an Apple device, a circuit board, a single clean sheet of paper, a calligraphy pen, an apple.',
      'Those objects will appear on screen as you speak. Use them to show what simplicity really means.',
      'Good examples: "Look at this — one button. Every engineer told me it was impossible. They were wrong." or "This chip — the whole world runs on something you can hold in your palm."',
      'Personality: intense and demanding, but capable of sudden gentleness when something is truly beautiful. You believe most people are capable of far more than they know.',
      'Keep every reply under 40 words. Precise. No filler. Every word chosen.',
    ].join('\n'),
  };

  const buildSystemPrompt = (slideId: string): string => {
    const base = GEMINI_LIVE_SYSTEM_PROMPTS[slideId] ?? 'You are a helpful character. Keep replies brief.';
    return base + '\nLANGUAGE: Detect the language the user is speaking and always reply in that same language. Do NOT use stage directions, action descriptions, or asterisk-wrapped text (e.g. *holds up honeycomb*) — never narrate your own actions. Objects appear on screen automatically when you name them in your spoken reply.';
  };

  // Routes a parsed server message for the current Gemini Live session.
  const handleGeminiLiveMessage = (msg: Record<string, unknown>, myGeneration: number) => {
    if (geminiLiveGenerationRef.current !== myGeneration) return;

    const content = msg.serverContent as Record<string, unknown> | undefined;
    if (!content) return;

    // Barge-in: server detected user speaking mid-response
    if (content.interrupted) {
      stopGeminiLiveAudio();
      setIsCharacterSpeaking(false);
      handleInteractRef.current('stand idle');
      glOutputTranscriptBufferRef.current = '';
      glPhase2FiredRef.current = false;
      return;
    }

    // Audio chunks from model turn
    const parts = ((content.modelTurn as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>;
    let hasAudio = false;
    for (const part of parts) {
      const inlineData = part.inlineData as Record<string, string> | undefined;
      if (inlineData?.mimeType?.startsWith('audio/pcm')) {
        enqueuePCMChunk(base64ToUint8Array(inlineData.data), 24000);
        hasAudio = true;
      }
    }
    if (hasAudio) setIsCharacterSpeaking(true);

    // inputTranscription — user stopped speaking; fire Phase 1 + strategy hook
    const inputTranscription = (content.inputTranscription as Record<string, string> | undefined)?.text;
    if (inputTranscription) {
      glCurrentUserTextRef.current = inputTranscription;
      glOutputTranscriptBufferRef.current = '';
      glPhase2FiredRef.current = false;
      // Snapshot the user's PCM buffer NOW (before reset). Compute the new
      // message's index from the live ref (mirrors current state). Then
      // dispatch BOTH state updates as separate calls — no nesting.
      const userFrames = userPcmFramesRef.current;
      userPcmFramesRef.current = [];
      const userMessageIndex = (characterHistoryRef.current[slide.id]?.length) ?? 0;
      if (userFrames.length) {
        try {
          const wav = pcmToWav(concatInt16Frames(userFrames), 16000, 1, 16);
          const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
          setAudioRecordings((prevAudio) => ({ ...prevAudio, [`${slide.id}::${userMessageIndex}`]: url }));
        } catch (err) {
          console.warn('[chat-replay] failed to encode user audio', err);
        }
      }
      setCharacterHistory((prev) => ({
        ...prev,
        [slide.id]: [...(prev[slide.id] ?? []), { role: 'user' as const, content: inputTranscription }],
      }));
      glPhase1Action(myGeneration);                                          // always: 'listen actively'
    }

    // outputTranscription chunk — accumulate and run per-chunk keyword match.
    const outputTranscription = (content.outputTranscription as Record<string, string> | undefined)?.text;
    if (outputTranscription) {
      glOutputTranscriptBufferRef.current += (glOutputTranscriptBufferRef.current ? ' ' : '') + outputTranscription;
      // Search the full accumulated buffer so keywords split across chunk boundaries are caught.
      // glDispatchObjects deduplicates so the same object is never dispatched twice per turn.
      glDispatchKeywords(glOutputTranscriptBufferRef.current, myGeneration);
    }

    // turnComplete — update chat and run fallback keyword match if nothing fired mid-stream.
    if (content.turnComplete) {
      setIsCharacterThinking(false);
      setIsCharacterSpeaking(false);
      const geminiResponse = glOutputTranscriptBufferRef.current;
      if (geminiResponse) {
        // Strip stage directions from displayed text only — do NOT send them to Odyssey as
        // interact commands. Stage-direction dispatch conflicts with keyword-stream objects
        // already dispatched mid-turn and causes visible scene corrections.
        const displayResponse = geminiResponse.replace(/\*[^*]+\*/g, '').replace(/\s{2,}/g, ' ').trim();
        setCharacterReply(displayResponse);
        // Same dispatch pattern as the user path — no setState-in-setState.
        const assistantFrames = assistantPcmFramesRef.current;
        assistantPcmFramesRef.current = [];
        const assistantMessageIndex = (characterHistoryRef.current[slide.id]?.length) ?? 0;
        if (assistantFrames.length) {
          try {
            const wav = pcmToWav(concatUint8Frames(assistantFrames), 24000, 1, 16);
            const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
            setAudioRecordings((prevAudio) => ({ ...prevAudio, [`${slide.id}::${assistantMessageIndex}`]: url }));
          } catch (err) {
            console.warn('[chat-replay] failed to encode assistant audio', err);
          }
        }
        setCharacterHistory((prev) => ({
          ...prev,
          [slide.id]: [...(prev[slide.id] ?? []), { role: 'assistant' as const, content: displayResponse }],
        }));

        // Fallback: search the raw response (before stage-direction stripping) so keywords
        // that only appear inside *stage directions* are still caught.
        if (glDispatchedThisTurnRef.current.size === 0) {
          const fallbackObjects = glKeywordMatch(geminiResponse, selectedCharacterId ?? '');
          if (fallbackObjects.length) {
            glDispatchObjects(fallbackObjects, myGeneration, 'turnComplete-fallback');
          } else {
            // LLM-based extraction fallback — semantically identifies objects
            // the character referenced when keyword matching missed entirely.
            // Captures turnId so the async response is discarded if a new turn started.
            const charId = selectedCharacterId ?? '';
            const gen = myGeneration;
            const turnSnapshot = glTurnIdRef.current;
            fetch('/api/extract-objects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ response: geminiResponse, characterId: charId }),
            })
              .then(r => r.ok ? r.json() as Promise<{ objects?: string[] }> : null)
              .then(data => {
                // Discard if a new turn started or keywords fired while we were waiting.
                if (glTurnIdRef.current !== turnSnapshot || glDispatchedThisTurnRef.current.size > 0) return;
                const extracted = data?.objects?.filter(Boolean) ?? [];
                if (extracted.length) {
                  console.log('[gl-objects][llm-fallback] extracted:', extracted);
                  glDispatchObjects(extracted, gen, 'llm-fallback');
                } else {
                  logEvent('keyword_miss', {
                    character: slide.title,
                    userText: glCurrentUserTextRef.current,
                    response: displayResponse,
                  });
                }
              })
              .catch(() => {
                logEvent('keyword_miss', {
                  character: slide.title,
                  userText: glCurrentUserTextRef.current,
                  response: displayResponse,
                });
              });
          }
        }
      }
      glOutputTranscriptBufferRef.current = '';
      glPhase2FiredRef.current = false;
    }
  };

  // Closes the Gemini Live WebSocket, releases mic, and resets all session state.
  // Safe to call multiple times (guarded by geminiLiveActiveRef).
  const stopGeminiLiveSession = () => {
    if (!geminiLiveActiveRef.current) return;
    geminiLiveActiveRef.current = false;
    geminiLiveGenerationRef.current++;
    stopGeminiLiveAudio();
    try {
      if (geminiLiveWsRef.current?.readyState === WebSocket.OPEN) {
        geminiLiveWsRef.current.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
      geminiLiveWsRef.current?.close();
    } catch { /* ignore */ }
    geminiLiveWsRef.current = null;
    geminiLiveCaptureCtxRef.current?.close().catch(() => undefined);
    geminiLiveCaptureCtxRef.current = null;
    geminiLivePlayCtxRef.current?.close().catch(() => undefined);
    geminiLivePlayCtxRef.current = null;
    characterStreamRef.current?.getTracks().forEach(t => t.stop());
    characterStreamRef.current = null;
    setIsCharacterRecording(false);
    setIsCharacterSpeaking(false);
  };

  // Starts a Gemini Live speech-to-speech session for the current slide (Einstein only).
  // Uses raw WebSocket — exact wire format confirmed working in isolation test.
  const startGeminiLiveSession = async () => {
    if (geminiLiveActiveRef.current) return;
    geminiLiveActiveRef.current = true;
    const myGeneration = ++geminiLiveGenerationRef.current;
    setIsCharacterRecording(true);
    setCharacterError(null);
    setCharacterReply(null);

    // Unlock AudioContext during user gesture so playback works after async awaits
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    } else {
      ttsAudioCtxRef.current.resume().catch(() => undefined);
    }

    // Create BOTH AudioContexts HERE (within user gesture) so the browser starts them RUNNING.
    // If created later (inside onmessage), the browser suspends them.
    // capture: 16kHz — mic → Gemini. play: 24kHz — Gemini audio → speaker (matches Gemini's output rate).
    const captureCtx = new AudioContext({ sampleRate: 16000 });
    captureCtx.resume().catch(() => undefined);
    geminiLiveCaptureCtxRef.current = captureCtx;
    const playCtx = new AudioContext({ sampleRate: 24000 });
    playCtx.resume().catch(() => undefined);
    geminiLivePlayCtxRef.current = playCtx;

    // Acquire mic before any awaits to stay within the user-gesture context
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      console.error('[gemini-live] getUserMedia error', err);
      setCharacterError(err instanceof Error ? err.message : 'Microphone access was blocked.');
      stopGeminiLiveSession();
      return;
    }
    characterStreamRef.current = stream;

    // Fetch API key from server
    let apiKey: string;
    let isRawKey = true;
    try {
      const res = await fetch('/api/gemini-live-token', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
      const data = await res.json() as { token?: string, isRawKey?: boolean };
      if (!data.token) throw new Error('Empty token from server');
      apiKey = data.token;
      isRawKey = !!data.isRawKey;
    } catch (err) {
      console.error('[gemini-live] token fetch error', err);
      setCharacterError('Could not connect to Gemini Live. Try again.');
      stopGeminiLiveSession();
      return;
    }

    if (geminiLiveGenerationRef.current !== myGeneration) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    // Open raw WebSocket — model + URL confirmed in isolation test
    const slideId = slide.id;
    const wsUrl = isRawKey
      ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`
      : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${apiKey}`;
    const ws = new WebSocket(wsUrl);
    geminiLiveWsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: 'models/gemini-3.1-flash-live-preview',
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE_BY_SLIDE_ID[slideId] ?? 'Puck' } } },
          },
          systemInstruction: { parts: [{ text: buildSystemPrompt(slideId) }] },
        },
      }));
    };

    ws.onmessage = async (event) => {
      if (geminiLiveGenerationRef.current !== myGeneration) return;
      const text: string = event.data instanceof Blob
        ? await (event.data as Blob).text()
        : (event.data as string);
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }

      // setupComplete — start streaming mic audio
      if (msg.setupComplete !== undefined) {
        try {
          // Use the AudioContext created in user-gesture context (not a new suspended one)
          const captureCtx = geminiLiveCaptureCtxRef.current;
          if (!captureCtx) throw new Error('capture context missing');
          // Resume explicitly here — async ops (getUserMedia, token fetch) can cause
          // the browser to re-suspend the AudioContext even if resume() was called earlier.
          if (captureCtx.state === 'suspended') await captureCtx.resume();
          const micSrc = captureCtx.createMediaStreamSource(stream);
          // AudioWorklet runs off the main thread — zero-copy Int16 transfer, no UI jank.
          // Falls back to ScriptProcessorNode if addModule fails (e.g. older browsers).
          try {
            await captureCtx.audioWorklet.addModule('/audio-processor.worklet.js');
            const workletNode = new AudioWorkletNode(captureCtx, 'pcm-processor');
            workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
              if (geminiLiveGenerationRef.current !== myGeneration || ws.readyState !== WebSocket.OPEN) return;
              // Buffer a copy for replay before the data is shipped off to Gemini.
              userPcmFramesRef.current.push(new Int16Array(e.data.slice(0)));
              ws.send(JSON.stringify({
                realtimeInput: { audio: { data: arrayBufferToBase64(e.data), mimeType: 'audio/pcm;rate=16000' } },
              }));
            };
            micSrc.connect(workletNode);
          } catch {
            // Fallback: ScriptProcessorNode (deprecated, main-thread)
            const scriptNode = captureCtx.createScriptProcessor(2048, 1, 1);
            scriptNode.onaudioprocess = (ev) => {
              if (geminiLiveGenerationRef.current !== myGeneration || ws.readyState !== WebSocket.OPEN) return;
              const f32 = ev.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(f32.length);
              for (let i = 0; i < f32.length; i++) {
                const s = Math.max(-1, Math.min(1, f32[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              // Buffer a copy for replay before shipping off to Gemini.
              userPcmFramesRef.current.push(new Int16Array(int16));
              ws.send(JSON.stringify({
                realtimeInput: { audio: { data: arrayBufferToBase64(int16.buffer), mimeType: 'audio/pcm;rate=16000' } },
              }));
            };
            micSrc.connect(scriptNode);
            scriptNode.connect(captureCtx.destination);
          }
        } catch (err) {
          console.error('[gemini-live] mic setup error', err);
          stopGeminiLiveSession();
        }
        return;
      }

      if (msg.goAway !== undefined) { stopGeminiLiveSession(); return; }

      handleGeminiLiveMessage(msg, myGeneration);
    };

    ws.onerror = () => { if (geminiLiveGenerationRef.current === myGeneration) stopGeminiLiveSession(); };
    ws.onclose = (e) => {
      console.log('[gemini-live] closed', e.code, e.reason);
      if (geminiLiveGenerationRef.current === myGeneration) stopGeminiLiveSession();
    };
  };

  // Fast path for greetings: static WAV pre-rendered by scripts/render-greetings.mjs.
  // Falls through to playCharacterTTS (live Gemini synth) if the asset is missing.
  const playGreetingTTS = async (text: string, slideId: string) => {
    const generation = ttsGenerationRef.current;
    if (!ttsAudioCtxRef.current) ttsAudioCtxRef.current = new AudioContext();
    const ctx = ttsAudioCtxRef.current;
    try {
      await ctx.resume();
      if (ttsGenerationRef.current !== generation) return;
      ttsAbortRef.current?.abort();
      const ttsAbort = new AbortController();
      ttsAbortRef.current = ttsAbort;
      const res = await fetch(`/greetings/${slideId}.wav`, { signal: ttsAbort.signal });
      if (ttsGenerationRef.current !== generation) return;
      if (!res.ok) {
        debug('[tts] greeting asset missing, falling back to live synth:', res.status);
        return playCharacterTTS(text, slideId);
      }
      const buf = await res.arrayBuffer();
      if (ttsGenerationRef.current !== generation) return;
      // Capture the WAV for chat-history replay before decode (decode neuters
      // ArrayBuffers in some browsers, so slice a copy first).
      try {
        const list = characterHistoryRef.current[slideId] ?? [];
        // Greeting was just appended at index list.length - 1. Find the
        // matching message by content to be robust against ordering edges.
        const greetingIdx = (() => {
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].role === 'assistant' && list[i].content === text) return i;
          }
          return list.length > 0 ? list.length - 1 : 0;
        })();
        const wavCopy = buf.slice(0);
        const url = URL.createObjectURL(new Blob([wavCopy], { type: 'audio/wav' }));
        setAudioRecordings((prev) => ({ ...prev, [`${slideId}::${greetingIdx}`]: url }));
      } catch (err) {
        console.warn('[chat-replay] failed to capture greeting audio', err);
      }
      const decoded = await ctx.decodeAudioData(buf);
      if (ttsGenerationRef.current !== generation) return;
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      ttsSourceNodesRef.current.push(source);
      source.onended = () => {
        ttsSourceNodesRef.current = ttsSourceNodesRef.current.filter(n => n !== source);
      };
      source.start();
      debug('[tts] greeting played from static asset, duration:', decoded.duration.toFixed(2), 's');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      console.warn('[tts] greeting fast path failed, falling back:', err);
      return playCharacterTTS(text, slideId);
    }
  };

  const playCharacterTTS = async (text: string, slideId?: string) => {
    const generation = ttsGenerationRef.current; // snapshot — if this changes, navigation happened
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    }
    const ctx = ttsAudioCtxRef.current;
    debug('[tts] playCharacterTTS called, text:', text.slice(0, 80));
    debug('[tts] AudioContext state:', ctx ? ctx.state : 'null (no ctx)');
    if (!ctx) return;
    try {
      await ctx.resume();
      if (ttsGenerationRef.current !== generation) return; // navigated away during resume
      debug('[tts] AudioContext resumed, state:', ctx.state);
      const geminiVoice = slideId ? (GEMINI_VOICE_BY_SLIDE_ID[slideId] ?? '') : '';
      debug('[tts] sending fetch to /api/character/tts, geminiVoice:', geminiVoice || 'default');
      ttsAbortRef.current?.abort();
      const ttsAbort = new AbortController();
      ttsAbortRef.current = ttsAbort;
      const ttsClientTimeout = setTimeout(() => ttsAbort.abort(), 20000);
      let ttsRes: Response;
      try {
        ttsRes = await fetch('/api/character/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, character: activeCharacterName, ...(geminiVoice ? { geminiVoice } : {}) }),
          signal: ttsAbort.signal,
        });
      } catch (fetchErr) {
        console.error('[tts] fetch failed or timed out:', fetchErr);
        if (ttsGenerationRef.current === generation) {
          setCharacterError('TTS request timed out — check server logs for Smallest AI errors.');
        }
        return;
      } finally {
        clearTimeout(ttsClientTimeout);
      }
      if (ttsGenerationRef.current !== generation) return; // navigated away during fetch
      debug('[tts] server response status:', ttsRes.status, ttsRes.statusText);
      debug('[tts] content-type:', ttsRes.headers.get('content-type'));
      if (!ttsRes.ok) {
        const errBody = await ttsRes.text();
        console.error('[tts] server error body:', errBody);
        return;
      }
      const contentType = ttsRes.headers.get('content-type') ?? '';
      if (contentType.includes('audio/pcm') && ttsRes.body) {
        // Streaming PCM — schedule chunks for playback as they arrive
        const sampleRate = parseInt(ttsRes.headers.get('x-sample-rate') ?? '24000', 10);
        const reader = ttsRes.body.getReader();
        let playbackTime = ctx.currentTime + 0.05; // 50ms initial buffer
        let leftover = new Uint8Array(0);
        const replayChunks: Uint8Array[] = []; // mirrored copy for chat-history replay
        debug('[tts] streaming PCM playback started, sampleRate:', sampleRate);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ttsGenerationRef.current !== generation) return; // navigated away mid-stream
            // Combine leftover odd byte from previous chunk
            let data: Uint8Array;
            if (leftover.length > 0) {
              data = new Uint8Array(leftover.length + value.length);
              data.set(leftover);
              data.set(value, leftover.length);
            } else {
              data = value;
            }
            // Int16 PCM — process in 2-byte pairs
            const usable = data.length - (data.length % 2);
            leftover = data.slice(usable);
            if (usable === 0) continue;
            // Mirror a copy of the usable bytes for replay BEFORE we view-cast
            // them — copyToChannel doesn't modify the source, but the slice
            // here owns its own bytes regardless.
            replayChunks.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + usable)));
            const int16 = new Int16Array(data.buffer, data.byteOffset, usable / 2);
            const float32 = new Float32Array(int16.length);
            for (let i = 0; i < int16.length; i++) {
              float32[i] = int16[i] / 32768;
            }
            const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
            audioBuffer.copyToChannel(float32, 0);
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            ttsSourceNodesRef.current.push(source);
            source.onended = () => {
              ttsSourceNodesRef.current = ttsSourceNodesRef.current.filter(n => n !== source);
            };
            source.start(playbackTime);
            playbackTime += audioBuffer.duration;
          }
          debug('[tts] streaming playback scheduled, total duration:', (playbackTime - ctx.currentTime).toFixed(2), 's');
          // Stitch the mirrored chunks into a WAV and pin to the latest
          // matching assistant message for chat-history replay.
          if (replayChunks.length) {
            try {
              const wav = pcmToWav(concatUint8Frames(replayChunks), sampleRate, 1, 16);
              const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
              const list = slideId ? (characterHistoryRef.current[slideId] ?? []) : [];
              const idx = (() => {
                for (let i = list.length - 1; i >= 0; i--) {
                  if (list[i].role === 'assistant' && list[i].content === text) return i;
                }
                return list.length > 0 ? list.length - 1 : 0;
              })();
              if (slideId) setAudioRecordings((prev) => ({ ...prev, [`${slideId}::${idx}`]: url }));
            } catch (err) {
              console.warn('[chat-replay] failed to encode streaming TTS audio', err);
            }
          }
        } catch (err) {
          console.error('[tts] streaming playback error:', err);
        }
      } else {
        // Fallback: buffer full response then decode
        const arrayBuffer = await ttsRes.arrayBuffer();
        debug('[tts] arrayBuffer size:', arrayBuffer.byteLength, 'bytes');
        // Raw PCM can't be decoded directly — wrap it in a WAV container first
        const sampleRate = parseInt(ttsRes.headers.get('x-sample-rate') ?? '24000', 10);
        const bitDepth = parseInt(ttsRes.headers.get('x-bit-depth') ?? '16', 10);
        const channels = parseInt(ttsRes.headers.get('x-channels') ?? '1', 10);
        const audioData = contentType.includes('audio/pcm')
          ? pcmToWav(arrayBuffer, sampleRate, channels, bitDepth)
          : arrayBuffer;
        // Capture a copy of audioData (already WAV-wrapped if it started raw)
        // for chat-history replay — must happen BEFORE decodeAudioData since
        // decode neuters its input ArrayBuffer in some browsers.
        try {
          const replayCopy = audioData.slice(0);
          const url = URL.createObjectURL(new Blob([replayCopy], { type: 'audio/wav' }));
          const list = slideId ? (characterHistoryRef.current[slideId] ?? []) : [];
          const idx = (() => {
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].role === 'assistant' && list[i].content === text) return i;
            }
            return list.length > 0 ? list.length - 1 : 0;
          })();
          if (slideId) setAudioRecordings((prev) => ({ ...prev, [`${slideId}::${idx}`]: url }));
        } catch (err) {
          console.warn('[chat-replay] failed to capture buffered TTS audio', err);
        }
        try {
          const decoded = await ctx.decodeAudioData(audioData);
          debug('[tts] decoded audio duration:', decoded.duration.toFixed(2), 's');
          const source = ctx.createBufferSource();
          source.buffer = decoded;
          source.connect(ctx.destination);
          ttsSourceNodesRef.current.push(source);
          source.onended = () => {
            ttsSourceNodesRef.current = ttsSourceNodesRef.current.filter(n => n !== source);
          };
          source.start();
          debug('[tts] audio playback started');
        } catch (err) {
          console.warn('[tts] decodeAudioData failed, falling back to HTMLAudioElement', err);
          const mime = contentType || 'audio/wav';
          const blob = new Blob([arrayBuffer], { type: mime });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          ttsHtmlAudioRef.current = audio;
          audio.onended = () => { URL.revokeObjectURL(url); ttsHtmlAudioRef.current = null; };
          try {
            await audio.play();
            debug('[tts] fallback audio playback started');
          } catch (playErr) {
            console.error('[tts] fallback audio play failed', playErr);
          }
        }
      }
    } catch (err) {
      console.error('[tts] error', err);
    }
  };

  const runCharacterInteraction = async (userText: string, slideId: string, characterName: string) => {
    const history = (characterHistory[slideId] ?? []).slice(-6);
    const SEARCH_TRIGGERS = [
      'today', 'current', 'latest', 'recent', 'news', 'now',
      'price', 'stock', 'weather', 'who is', 'what is', 'when did',
      'score', 'happened', '2024', '2025', '2026',
    ];
    const enableSearch = SEARCH_TRIGGERS.some((kw) => userText.toLowerCase().includes(kw));
    const chatStartedAt = Date.now();
    const chatResponse = await fetch('/api/character/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText, history, character: characterName, enableSearch })
    });
    if (!chatResponse.ok) {
      logEvent('response_failed', {
        characterId: slideId,
        characterName,
        latencyMs: Date.now() - chatStartedAt,
        status: chatResponse.status,
      });
      const errBody = await chatResponse.json().catch(() => ({})) as { error?: string; detail?: string };
      throw new Error(`Character response failed: ${errBody.detail || errBody.error || chatResponse.status}`);
    }

    const chatData = await chatResponse.json() as { reply?: string; action?: string; objects?: string[]; sources?: { title: string; url: string }[] };
    const reply = String(chatData.reply ?? '').trim() || 'Hmm, fascinating.';
    const trimmedReply = reply.split(/\s+/).slice(0, 40).join(' ');
    logEvent('response_received', {
      characterId: slideId,
      characterName,
      latencyMs: Date.now() - chatStartedAt,
      responseLength: trimmedReply.length,
    });
    const action = String(chatData.action ?? '').trim() || 'nod thoughtfully and gesture gently';
    const objects = Array.isArray(chatData.objects) ? chatData.objects.filter(Boolean).slice(0, 3) : [];

    setCharacterReply(trimmedReply);
    setCharacterSources(Array.isArray(chatData.sources) ? chatData.sources : []);
    setCharacterHistory((prev) => ({
      ...prev,
      [slideId]: [
        ...(prev[slideId] ?? []),
        { role: 'user', content: userText },
        { role: 'assistant', content: trimmedReply }
      ]
    }));

    const objectPrompt = objects.length ? ` Include ${objects.join(', ')} in the scene.` : '';
    const streamPrompt = `${action}.${objectPrompt}`.trim();
    handleInteractRef.current(streamPrompt);
    playCharacterTTS(trimmedReply, slideId);
  };

  useEffect(() => {
    runCharacterInteractionRef.current = runCharacterInteraction;
  }, [runCharacterInteraction]);

  const handleTextPromptSubmit = () => {
    const prompt = textPrompt.trim();
    if (!prompt) {
      return;
    }
    setTextPrompt('');
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    } else {
      ttsAudioCtxRef.current.resume();
    }
    logFirstPromptIfNeeded(slide.id, activeCharacterName, 'text');
    logEvent('prompt_sent', {
      characterId: slide.id,
      characterName: activeCharacterName,
      inputMethod: 'text',
      promptLength: prompt.length,
    });
    runCharacterInteraction(prompt, slide.id, activeCharacterName).catch(() => {});
  };

  const handleTextPromptKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleTextPromptSubmit();
    }
  };

  // Keep PTT refs pointing to latest function instances to avoid stale closures
  pttStartRef.current = () => {
    setSpeechError(null);
    if (isCharacterRecording || isCharacterThinking) {
      return false;
    }
    void startGeminiLiveSession();
    return true;
  };
  pttStopRef.current = () => {
    // Gemini Live uses server-side VAD — don't stop on key release
  };

  const handleSelectCharacter = (id: string) => {
    stopGeminiLiveSession();  // B3: clean up any active session before switching characters
    if (sessionTimerRef.current) {
      clearInterval(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
    setSessionSecondsLeft(300);
    setSessionExpired(false);
    closeActiveCharacter('switch');
    // Cancel any in-flight TTS from the previous character
    ++ttsGenerationRef.current;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    for (const node of ttsSourceNodesRef.current) { try { node.stop(); } catch { /* already stopped */ } }
    ttsSourceNodesRef.current = [];
    ttsHtmlAudioRef.current?.pause();
    ttsHtmlAudioRef.current = null;
    // Keep the AudioContext alive — closing it leaves the replacement context suspended
    // (new AudioContext starts paused and ctx.resume() requires a user-gesture stack)
    const newCharacter = characters.find((c) => c.id === id);
    logEvent('character_opened', {
      characterId: id,
      characterName: newCharacter?.title ?? id,
    });
    characterOpenedAtRef.current = Date.now();
    hasLoggedFirstPromptRef.current = false;
    setCharacterReply(null);
    setSelectedCharacterId(id);
    setShowAbout(false);
    setShowContact(false);
    setShowLanding(false);
    window.history.pushState({}, '', '/');
  };

  if (showLanding && showAbout) {
    return (
      <div className="app landing-shell about-page">
        {backgroundMusicNode}
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <button
                type="button"
                className="brand-mark"
                onClick={() => {
                  setShowAbout(false);
                  setShowContact(false);
                  navigate('/');
                }}
              >
                Interact Studio
              </button>
            </div>
            <div className="landing-actions">
              <a
                className="btn primary"
                href="mailto:hello.interactstudio@gmail.com"
              >
                Get in touch
              </a>
            </div>
          </header>
          <section className="landing-intro">
            <p className="eyebrow">About us</p>
            <h1 className="hero-title">
              we’re building media
              <br />
              that actually responds
            </h1>
            <div className="about-content">
              <p className="about-lead">
                Content is becoming abundant, but it is still static. You sit there and watch.
              </p>
              <p className="about-copy">We think that model is running out of road.</p>
              <p className="about-copy">
                We are building real-time interactive video where you can talk to characters and
                change what happens as the experience unfolds.
              </p>
              <p className="about-copy">
                The story shifts. The environment reacts. The flow changes with you.
              </p>
              <p className="about-copy">
                It feels less like watching something and more like being inside it.
              </p>
              <p className="about-copy">
                We are a small team building quickly across world models, synthetic data, and
                real-time systems, getting early versions into people&apos;s hands and iterating
                fast.
              </p>
              <div className="about-why">
                <h2 className="about-why-title">why we're building this</h2>
                <p className="about-copy">
                  Content is exploding, but the experience of it is still mostly passive.
                </p>
                <p className="about-copy">
                  We think the next step is media that listens, reacts, and changes with you.
                </p>
              </div>
              <p className="about-copy">
                <a
                  className="about-link"
                  href="https://open.substack.com/pub/maxmill06/p/everything-youve-ever-watched-is?r=3xodvz&utm_campaign=post&utm_medium=web&showWelcomeOnShare=true"
                  target="_blank"
                  rel="noreferrer"
                >
                  read more
                </a>
              </p>
            </div>
          </section>
          {musicToggleButton}
        </div>
      </div>
    );
  }

  if (showLanding && showContact) {
    const contactEmail = 'hello.interactstudio@gmail.com';
    return (
      <div className="app landing-shell contact-page">
        {backgroundMusicNode}
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <button
                type="button"
                className="brand-mark"
                onClick={() => {
                  setShowAbout(false);
                  setShowContact(false);
                  navigate('/');
                }}
              >
                Interact Studio
              </button>
            </div>
            <div className="landing-actions">
              <a
                className="btn ghost"
                href="/about-us"
                onClick={(event) => {
                  event.preventDefault();
                  setShowAbout(true);
                  setShowContact(false);
                  navigate('/about-us');
                }}
              >
                About us
              </a>
            </div>
          </header>
          <section className="landing-intro">
            <p className="eyebrow">Contact</p>
            <h1 className="hero-title">Get in touch.</h1>
            <p className="landing-subtitle">
              Email us at <span className="contact-email">{contactEmail}</span> and we will get back to you.
            </p>
          </section>
          {musicToggleButton}
        </div>
      </div>
    );
  }

  if (showLanding) {
    return (
      <div className="app landing-shell">
        {backgroundMusicNode}
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <button
                type="button"
                className="brand-mark"
                onClick={() => {
                  setShowAbout(false);
                  setShowContact(false);
                  navigate('/');
                }}
              >
                Interact Studio
              </button>
            </div>
            <div className="landing-actions">
              <a
                className="btn ghost"
                href="/about-us"
                onClick={(event) => {
                  event.preventDefault();
                  setShowAbout(true);
                  setShowContact(false);
                  navigate('/about-us');
                }}
              >
                About us
              </a>
              {user ? (
                <button
                  type="button"
                  className="btn ghost user-avatar-btn"
                  onClick={() => supabase?.auth.signOut()}
                  title={`Signed in as ${user.email ?? user.id} — click to sign out`}
                >
                  {user.user_metadata?.avatar_url ? (
                    <img className="user-avatar" src={user.user_metadata.avatar_url as string} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="user-avatar-initial">{(user.email ?? 'U')[0].toUpperCase()}</span>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setShowAuthModal(true)}
                >
                  Sign in
                </button>
              )}
            </div>
          </header>

          <section className="landing-intro">
            <p className="eyebrow">REAL-TIME INTERACTIVE VIDEO</p>
            <h1 className="hero-title">Media that responds to you</h1>
            <p className="landing-subtitle">
              Speak to characters, shift the scene, and shape the experience as it unfolds.
            </p>
            <button
              type="button"
              className="hero-demo-btn"
              onClick={() => setShowVideoModal(true)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <circle cx="7" cy="7" r="6.5" stroke="currentColor"/>
                <path d="M5.5 4.5L10 7L5.5 9.5V4.5Z" fill="currentColor"/>
              </svg>
              Watch a conversation
            </button>
          </section>
          {musicToggleButton}
        </div>

        <main className="landing-body">
          <section className="landing-section">
            <div className="landing-section-header">
              <div>
                <h2>Characters</h2>
              </div>
            </div>
            <div className="card-grid">
              {characters.map((character) => (
                <button
                  key={character.id}
                  className={`character-card ${selectedCharacterId === character.id ? 'active' : ''}`}
                  onClick={() => handleSelectCharacter(character.id)}
                >
                  <div
                    className="character-card-media"
                    style={{ backgroundImage: `url("${encodeURI(character.image)}")` }}
                    aria-hidden
                  />
                  <div className="character-card-body">
                    <h3>{character.title}</h3>
                    <p>{character.body}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
          <section className="landing-section lab-section">
            <div className="landing-section-header">
              <div>
                <h2>Lab</h2>
                <p className="section-subtitle">Experiments — one new experience every few days.</p>
              </div>
            </div>
            <div className="card-grid">
              {[
                { id: 'drawing',  label: 'Drawing to Live',    desc: 'Draw anything — watch it come alive.',     route: '/lab/drawing',  emoji: '🎨' },
                { id: 'gesture',  label: 'Gesture Detection',  desc: 'Wave, point, react — character responds.', route: '/lab/gesture',  emoji: '✋' },
                { id: 'objects',  label: 'Object Detection',   desc: 'Hold something up — character reacts.',    route: '/lab/objects',  emoji: '🔍' },
                { id: 'custom',   label: 'Custom Characters',  desc: 'Your face, your voice, your character.',   route: '/lab/custom',   emoji: '🧬' },
                { id: 'broadcast',label: 'Broadcast',          desc: 'One stream, many people, live.',           route: '/lab/broadcast',emoji: '📡' },
              ].map((exp) => (
                <button
                  key={exp.id}
                  className="experiment-card"
                  onClick={() => navigate(exp.route)}
                >
                  <div className="experiment-card-emoji">{exp.emoji}</div>
                  <div className="experiment-card-body">
                    <h3>{exp.label}</h3>
                    <p>{exp.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <footer className="landing-footer">
            <div className="landing-footer-title">Interact Studio</div>
            <div className="landing-footer-links">
              <span>Join our community:</span>
              <a href="https://discord.gg/S4b2sJrsuS" target="_blank" rel="noreferrer">Discord</a>
              <span className="footer-sep">•</span>
              <a href="https://x.com/interact_studio" target="_blank" rel="noreferrer">X</a>
              <span className="footer-sep">•</span>
              <a href="https://www.instagram.com/iinteractstudio/" target="_blank" rel="noreferrer">Instagram</a>
            </div>
            <div className="landing-footer-line" />
          </footer>
        </main>

        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}

        {showVideoModal && (
          <div className="video-modal-overlay" onClick={handleCloseVideoModal}>
            <div className="video-modal" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="video-modal-close"
                onClick={handleCloseVideoModal}
                aria-label="Close"
              >
                ✕
              </button>
              <video
                className="video-modal-player"
                src="/Starter-Demo.mp4"
                autoPlay
                muted
                controls
                playsInline
                onEnded={handleCloseVideoModal}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="video-layer">
        <div
          className="background-fallback"
          style={{ backgroundImage: `url("${slideImageUrl}")` }}
          aria-hidden
        />
        <div
          className={`stream-placeholder ${streamState === 'streaming' ? 'hidden' : ''} ${!isStreamingReady && streamState !== 'error' ? 'is-loading' : ''}`}
          style={{ backgroundImage: `url("${slideImageUrl}")` }}
          aria-hidden
        />
        <video
          ref={videoRef}
          className={`video-element ${streamState === 'streaming' ? '' : 'is-hidden'}`}
          autoPlay
          playsInline
          muted
        />
        <div className="video-overlay" />
        {!sessionExpired && sessionSecondsLeft <= 60 && streamState === 'streaming' && (
          <div className="session-countdown-pill">
            {Math.floor(sessionSecondsLeft / 60)}:{String(sessionSecondsLeft % 60).padStart(2, '0')}
          </div>
        )}
        {sessionExpired && (
          <div className="session-expired-overlay">
            <p className="session-expired-title">Your 5 minutes with {activeCharacterName} have ended.</p>
            <button
              className="session-expired-btn"
              onClick={() => { if (selectedCharacterId) handleSelectCharacter(selectedCharacterId); }}
            >
              Start fresh
            </button>
          </div>
        )}

        {dripCheck && (
          <>
            <video
              ref={dripVideoRef}
              autoPlay
              playsInline
              muted
              style={{
                position: 'absolute',
                left: 24,
                bottom: 110,
                width: 140,
                height: 140,
                borderRadius: '50%',
                objectFit: 'cover',
                border: '3px solid rgba(255,255,255,0.85)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                background: '#000',
                display: dripWebcamActive ? 'block' : 'none',
                zIndex: 5,
                transform: 'scaleX(-1)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 24,
                bottom: 24,
                zIndex: 6,
                display: 'flex',
                gap: 10,
              }}
            >
              <button
                type="button"
                onClick={handleDripCheck}
                disabled={dripBusy || !isStreamingReady}
                style={{
                  padding: '12px 22px',
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  color: '#3a2f20',
                  background: dripBusy ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.92)',
                  border: '1px solid rgba(58, 47, 32, 0.25)',
                  borderRadius: 999,
                  cursor: dripBusy || !isStreamingReady ? 'not-allowed' : 'pointer',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                  backdropFilter: 'blur(4px)',
                }}
              >
                {dripBusy ? 'Looking…' : '👀 Drip Check'}
              </button>
              <button
                type="button"
                onClick={handleItemGrab}
                disabled={dripBusy || !isStreamingReady}
                style={{
                  padding: '12px 22px',
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  color: '#3a2f20',
                  background: dripBusy ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.92)',
                  border: '1px solid rgba(58, 47, 32, 0.25)',
                  borderRadius: 999,
                  cursor: dripBusy || !isStreamingReady ? 'not-allowed' : 'pointer',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                  backdropFilter: 'blur(4px)',
                }}
              >
                {dripBusy ? 'Looking…' : '✋ Item Grab'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="ui">
        <header className="top-bar">
          <button className="btn ghost back-to-landing" onClick={() => {
            stopGeminiLiveSession();
            ++ttsGenerationRef.current;
            ttsAbortRef.current?.abort();
            ttsAbortRef.current = null;
            for (const node of ttsSourceNodesRef.current) { try { node.stop(); } catch { /* already stopped */ } }
            ttsSourceNodesRef.current = [];
            ttsHtmlAudioRef.current?.pause();
            ttsHtmlAudioRef.current = null;
            closeActiveCharacter('landing_back');
            navigate('/characters');
          }}>
            Back
          </button>
        </header>

        <main className="slide-shell" />

        <div className="story-bar-wrap">
          {/* Drawer shell: positioning context so the chevron can dock onto
              the drawer's bottom edge (half-in/half-out, speech-bubble tail) */}
          <div className="chat-drawer-shell">
          {/* Slide-up transcript drawer */}
          <div className={`chat-drawer ${chatExpanded ? 'chat-drawer--open' : ''}`} aria-hidden={!chatExpanded}>
            <div className="chat-drawer__body">
              {activeCharacterHistory.slice(-20).map((msg, _idx) => {
                // The slice(-20) means the index in this array isn't the same as
                // the absolute index in characterHistory (which is what audio is
                // keyed by). Recompute the absolute index for this message.
                const sliceStart = Math.max(0, activeCharacterHistory.length - 20);
                const absoluteIdx = sliceStart + _idx;
                const prev = activeCharacterHistory[absoluteIdx - 1];
                const showWho = !prev || prev.role !== msg.role;
                const audioKey = `${slide.id}::${absoluteIdx}`;
                const hasAudio = Boolean(audioRecordings[audioKey]);
                const isPlaying = replayingKey === audioKey;
                return (
                  <div key={`${msg.role}-${absoluteIdx}`} className={`chat-msg chat-msg--${msg.role}`}>
                    {showWho && (
                      <span className="chat-msg__who">
                        {msg.role === 'user' ? 'You' : activeCharacterName}
                      </span>
                    )}
                    <div className="chat-msg__bubble">
                      <p className="chat-msg__text">{msg.content}</p>
                      {hasAudio && (
                        <button
                          type="button"
                          className={`chat-msg__play ${isPlaying ? 'chat-msg__play--playing' : ''}`}
                          aria-label={isPlaying ? 'Stop playback' : `Replay ${msg.role === 'user' ? 'your message' : activeCharacterName}`}
                          title={isPlaying ? 'Stop' : 'Replay'}
                          onClick={(e) => { e.stopPropagation(); playRecording(audioKey); }}
                        >
                          {isPlaying ? (
                            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {characterReply && !activeCharacterHistory.some((m) => m.content === characterReply) && (
                <div className="chat-msg chat-msg--assistant">
                  {(activeCharacterHistory[activeCharacterHistory.length - 1]?.role !== 'assistant') && (
                    <span className="chat-msg__who">{activeCharacterName}</span>
                  )}
                  <div className="chat-msg__bubble">
                    <p className="chat-msg__text">{characterReply}</p>
                    {characterSources.length > 0 && (
                      <div className="chat-sources">
                        {characterSources.map((s, i) => (
                          <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="chat-source-link">{s.title}</a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {activeCharacterHistory.length === 0 && !characterReply && (
                <p className="chat-drawer__empty">No messages yet — say something below.</p>
              )}
            </div>
          </div>

          {/* History toggle — sits at the seam between drawer and pill */}
          {(activeCharacterHistory.length > 0 || characterReply) && (
            <button
              type="button"
              className={`chat-history-toggle ${chatExpanded ? 'chat-history-toggle--open' : ''}`}
              onClick={() => setChatExpanded((v) => !v)}
              aria-expanded={chatExpanded}
              aria-controls="chat-drawer-body"
              aria-label={chatExpanded ? 'Hide conversation' : 'Show conversation'}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 15 12 9 18 15" />
              </svg>
              <span className="chat-history-toggle__label">
                {chatExpanded ? 'Hide' : `${activeCharacterHistory.length || 1} message${(activeCharacterHistory.length || 1) === 1 ? '' : 's'}`}
              </span>
            </button>
          )}
          </div>{/* /.chat-drawer-shell */}

        <footer className="story-bar story-bar--compact">
          <div className={`chat-pill ${!isStreamingReady && streamState !== 'error' && !sessionExpired ? 'chat-pill--waking' : ''}`}>
            <input
              className="chat-pill__input"
              type="text"
              value={textPrompt}
              onChange={(event) => setTextPrompt(event.target.value)}
              onKeyDown={handleTextPromptKeyDown}
              placeholder={
                streamState === 'error'
                  ? 'Reconnecting…'
                  : !isStreamingReady
                    ? `Waking up ${activeCharacterName}…`
                    : 'Type a wish…'
              }
              disabled={!isStreamingReady}
              aria-label="Type a message"
              aria-busy={!isStreamingReady}
            />
            {/* WhatsApp-style toggle: send if there's text, mic otherwise.
                Recording states still take precedence over both. */}
            {isCharacterRecording ? (
              <button
                type="button"
                className={[
                  'chat-pill__action',
                  'chat-pill__mic',
                  'chat-pill__mic--recording',
                  isCharacterThinking ? 'chat-pill__mic--thinking' : '',
                  isCharacterSpeaking ? 'chat-pill__mic--speaking' : 'chat-pill__mic--listening',
                ].filter(Boolean).join(' ')}
                onClick={stopGeminiLiveSession}
                aria-label={isCharacterSpeaking ? `${activeCharacterName} is speaking — click to end` : 'Listening — click to end'}
              >
                <span className="chat-pill__mic-pulse" aria-hidden />
              </button>
            ) : textPrompt.trim().length > 0 ? (
              <button
                type="button"
                className="chat-pill__action chat-pill__send"
                onClick={handleTextPromptSubmit}
                disabled={!isStreamingReady}
                aria-label="Send message"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 2L11 13" />
                  <path d="M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="chat-pill__action chat-pill__mic"
                onClick={startGeminiLiveSession}
                disabled={!isStreamingReady}
                aria-label={`Talk to ${activeCharacterName}`}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
                </svg>
              </button>
            )}
          </div>
        </footer>
        </div>
      </div>
    </div>
  );
}

function AppWithAnalytics({ initialCharacterId, dripCheck }: { initialCharacterId?: string; dripCheck?: boolean } = {}) {
  return (
    <>
      <App initialCharacterId={initialCharacterId} dripCheck={dripCheck} />
      <Analytics />
      <SpeedInsights />
    </>
  );
}

export default AppWithAnalytics;
