import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import type { ConnectionStatus } from '@odysseyml/odyssey';
import charactersData from './data/characters.json';
import { trackEvent } from './lib/analytics';
import { OdysseyService, credentialsFromDict, loadImageFile, type ClientCredentials, type StreamState } from './lib/odyssey';
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

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const win = window as typeof window & {
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    SpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
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

function App() {
  const [credentials, setCredentials] = useState<ClientCredentials | undefined>(undefined);
  const [showLanding, setShowLanding] = useState(true);
  const [showAbout, setShowAbout] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(characters[0]?.id ?? null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [_error, setError] = useState<string | null>(null);
  const [isStreamingReady, setIsStreamingReady] = useState(false);
  const [_speechText, setSpeechText] = useState('');
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [isCharacterRecording, setIsCharacterRecording] = useState(false);
  const [isCharacterThinking, setIsCharacterThinking] = useState(false);
  const [isCharacterSpeaking, setIsCharacterSpeaking] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [characterReply, setCharacterReply] = useState<string | null>(null);
  const [characterSources, setCharacterSources] = useState<{ title: string; url: string }[]>([]);
  const [characterError, setCharacterError] = useState<string | null>(null);
  const [moderationError, setModerationError] = useState<string | null>(null);
  const [characterHistory, setCharacterHistory] = useState<Record<string, Array<{ role: 'user' | 'assistant'; content: string }>>>({});
  const [uploadImage, setUploadImage] = useState<File | null>(null);
  const [_uploadError, setUploadError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [, setVoiceError] = useState<string | null>(null);
  const [, setLastVoiceText] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const odysseyStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const characterRecorderRef = useRef<MediaRecorder | null>(null);
  const characterStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  const isVoiceAgentSlideRef = useRef(false);
  const lastVoiceActionAtRef = useRef(0);
  const handleInteractRef = useRef<(promptOverride?: string) => void>(() => undefined);
  const ttsAudioCtxRef = useRef<AudioContext | null>(null);
  const characterOpenedAtRef = useRef<number | null>(null);
  const hasLoggedFirstPromptRef = useRef(false);
  const currentPageRef = useRef<string | null>(null);
  // Gemini Live session state
  const geminiLiveWsRef = useRef<WebSocket | null>(null);
  const geminiLiveCaptureCtxRef = useRef<AudioContext | null>(null);
  const geminiLivePlayCtxRef = useRef<AudioContext | null>(null);
  const geminiLiveGenerationRef = useRef(0);
  const geminiLiveActiveRef = useRef(false);
  const geminiLivePlaybackTimeRef = useRef(0);
  const geminiLiveSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
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

  const isUploadSlide = false;
  const isCharacterSlide = true;
  const VOICE_AGENT_ID_BY_SLIDE: Record<string, { id: string; label: string }> = {
    'circus-lion': { id: '', label: 'Circus Lion' },
    'einstein': { id: '', label: 'Albert Einstein' }
  };
  const activeVoiceAgent = slide ? VOICE_AGENT_ID_BY_SLIDE[slide.id] : null;
  const isVoiceAgentSlide = Boolean(activeVoiceAgent);
  const activeCharacterName = slide?.title ?? 'Character';
  const activeCharacterHistory = slide ? characterHistory[slide.id] ?? [] : [];
  const slideCtaRef = useRef('');


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
      closeActiveCharacter('page_exit');
      releaseOdysseyLease();
    };
  }, [selectedCharacterId]);


  useEffect(() => {
    isStreamingReadyRef.current = isStreamingReady;
  }, [isStreamingReady]);

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
    if (!isStreamingReady || !isCharacterSlide) return;
    const greeting = slide.greeting;
    if (!greeting) return;
    if ((characterHistory[slide.id] ?? []).length > 0) return;
    setCharacterHistory((prev) => ({
      ...prev,
      [slide.id]: [{ role: 'assistant', content: greeting }],
    }));
    playCharacterTTS(greeting, slide.id);
  }, [isStreamingReady, slide.id]);

  useEffect(() => {
    if (isCharacterSlide) {
      return;
    }
    if (isCharacterRecording) {
      stopCharacterRecording();
    }
  }, [isCharacterSlide, isCharacterRecording]);

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
          // Set 'connected' here (not in onStatusChange) so the startStream
          // useEffect only fires after the data channel is open and ready.
          dataChannelReadyRef.current = true;
          setConnectionStatus('connected');
          // If the effect fired before the data channel was ready (stale connectionStatus),
          // it stored its start function here. Call it now — no React re-render needed.
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
          setStreamState('error');
          setIsStreamingReady(false);
          const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
          const m = typeof message === 'string' ? message : JSON.stringify(message);
          if (r === 'moderation_failed') {
            logEvent('moderation_blocked', {
              reason: r,
              message: m,
              characterId: slide.id,
              characterName: activeCharacterName,
            });
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

      if (isUploadSlide) {
        if (hadActiveStream) await service.endStream().catch(() => undefined);
        setStreamState('idle');
        return;
      }

      if (hadActiveStream) {
        await service.endStream().catch(() => undefined);
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
      // retryStreamRef is set AFTER startStream resolves, not before.
      // Setting it before would let onStreamEnded fire a concurrent startStream while the
      // initial call is still in-flight (endStream → onStreamEnded → retry races run()).

      // Guard: data channel must be confirmed open (onConnected fired) before startStream.
      // If not ready, store as pending — onConnected will call it directly (no React re-render).
      // Using pendingStartRef avoids a feedback loop:
      // startStream → SDK reconnects → onConnected → effect re-runs → second startStream → deadlock.
      if (!dataChannelReadyRef.current) {
        debug('[odyssey] data channel not ready — queuing startStream for onConnected');
        pendingStartRef.current = async () => {
          if (requestIdRef.current !== requestId) return;
          debug('[odyssey] calling startStream (from pending) — slide:', slide.id, '| prompt:', slide.prompt?.slice(0, 60));
          await service.startStream(streamOptions);
          if (requestIdRef.current === requestId) {
            retryStreamRef.current = () => service.startStream(streamOptions).then(() => undefined);
          }
        };
        return;
      }
      pendingStartRef.current = null;
      if (requestIdRef.current !== requestId) return;
      debug('[odyssey] calling startStream — slide:', slide.id, '| prompt:', slide.prompt?.slice(0, 60));
      await service.startStream(streamOptions);
      debug('[odyssey] startStream resolved');
      if (requestIdRef.current === requestId) {
        retryStreamRef.current = () => service.startStream(streamOptions).then(() => undefined);
      }
    };

    run().catch((err) => {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setStreamState('error');
      setIsStreamingReady(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [connectionStatus, showLanding, selectedCharacterId, slide.id, slide.image, slide.prompt, isUploadSlide]);

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
    if (!serviceRef.current || !isStreamingReady) {
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

  const OBJECT_KEYWORDS: Array<{ keywords: string[]; object: string }> = [
    { keywords: ['sword', 'blade'], object: 'a shining sword' },
    { keywords: ['shield'], object: 'a glowing shield' },
    { keywords: ['crown', 'tiara'], object: 'a golden crown' },
    { keywords: ['flower', 'rose', 'bouquet'], object: 'a bright flower' },
    { keywords: ['star', 'stars'], object: 'twinkling stars' },
    { keywords: ['balloon', 'balloons'], object: 'colorful balloons' },
    { keywords: ['book'], object: 'an ancient book' },
    { keywords: ['map'], object: 'a glowing map' },
    { keywords: ['lantern', 'lamp'], object: 'a warm lantern' }
  ];

  const findObjectFromUtterance = (normalized: string) => {
    for (const entry of OBJECT_KEYWORDS) {
      for (const key of entry.keywords) {
        const pattern = new RegExp(`(^|\\b)${key}(\\b|$)`, 'i');
        if (pattern.test(normalized)) {
          return entry.object;
        }
      }
    }
    return null;
  };

  const mapUtteranceToPrompt = (text: string) => {
    const normalized = text.toLowerCase();
    const object = findObjectFromUtterance(normalized);
    if (/(^|\\b)(hello|hi|hey|yo|greetings)(\\b|$)/.test(normalized)) {
      return { prompt: 'do hello', label: 'hello', object };
    }
    if (/(thumbs?\\s*up|like\\sthis)/.test(normalized)) {
      return { prompt: 'do thumbs up', label: 'thumbs up', object };
    }
    if (/(victory|peace\\s*sign|v\\s*sign)/.test(normalized)) {
      return { prompt: 'do victory sign', label: 'victory', object };
    }
    if (/(namaste|namaskar)/.test(normalized)) {
      return { prompt: 'do namaste', label: 'namaste', object };
    }
    if (/(wave|waving)/.test(normalized)) {
      return { prompt: 'do hello', label: 'wave', object };
    }
    if (/(dance|celebrate|celebration)/.test(normalized)) {
      return { prompt: slideCtaRef.current || 'Animate it', label: 'celebrate', object };
    }
    if (object) {
      return { prompt: slideCtaRef.current || 'Animate it', label: `object: ${object}`, object };
    }
    return null;
  };


  const handleVoiceUtterance = (text: string, _source: string) => {
    const mapped = mapUtteranceToPrompt(text);
    if (!mapped) return;
    const now = Date.now();
    if (now - lastVoiceActionAtRef.current < 1800) return;
    lastVoiceActionAtRef.current = now;
    if (!isStreamingReadyRef.current) return;
    const objectPrompt = mapped.object ? ` Include ${mapped.object} in the scene.` : '';
    const fullPrompt = `${mapped.prompt}.${objectPrompt}`.trim();
    handleInteractRef.current(fullPrompt);
  };

  const stopVoiceCapture = () => {
    // no-op: using SDK transcripts instead of browser speech
  };


  const stopCharacterRecording = () => {
    if (!isCharacterRecording) {
      return;
    }
    characterRecorderRef.current?.stop();
  };

  const VOICE_BY_SLIDE_ID: Record<string, string> = {
    'grandpa-turtle': 'magnus',
    'cleopatra': 'sophia',
    'bear': 'liam',
    'alexander': 'alex',
    'circus-lion': 'alex',
    'einstein': 'magnus',
    'steve-jobs': 'alex',
    'da-vinci': 'magnus'
  };

  // --- Gemini Live helpers ---

  const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  const base64ToUint8Array = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // Schedules a 16-bit PCM chunk for gapless playback via the dedicated Gemini Live play context.
  // Safe to call from WebSocket message handlers — uses refs, never stale state.
  const enqueuePCMChunk = (data: Uint8Array, sampleRate: number) => {
    if (!geminiLivePlayCtxRef.current) return;
    const ctx = geminiLivePlayCtxRef.current;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => undefined); }
    const usable = data.length - (data.length % 2);
    if (usable === 0) return;
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

  // ─── Object-dispatch strategy ─────────────────────────────────────────────
  // Switch here to change which strategy runs in production.
  // Options: 'turn-complete' | 'keyword-stream' | 'stage-dir-stream' |
  //          'predict-at-input' | 'word-threshold' | 'hybrid' | 'speculative-correct' |
  //          'odyssey-last-prompt' | 'odyssey-ack-inject' | 'odyssey-video-frame'
  const GL_OBJECT_STRATEGY: string = 'speculative-correct';

  // Extended keyword → scene-object map covering all 8 characters.
  const GL_KEYWORD_MAP: Array<{ keywords: string[]; object: string }> = [
    // Physics / Einstein
    { keywords: ['ball', 'bowling ball', 'heavy ball'], object: 'a heavy ball' },
    { keywords: ['clock', 'watch', 'timepiece'], object: 'a ticking clock' },
    { keywords: ['light', 'beam', 'laser', 'photon'], object: 'a beam of light' },
    { keywords: ['trampoline', 'fabric', 'sheet'], object: 'a trampoline' },
    { keywords: ['rocket', 'spaceship', 'spacecraft'], object: 'a rocket' },
    { keywords: ['magnet', 'magnetic'], object: 'a magnet' },
    { keywords: ['apple', 'gravity'], object: 'a falling apple' },
    { keywords: ['telescope', 'lens'], object: 'a telescope' },
    { keywords: ['atom', 'nucleus', 'electron'], object: 'an atom' },
    { keywords: ['wave', 'ripple'], object: 'a wave' },
    // Bear
    { keywords: ['berry', 'berries', 'blueberry', 'strawberry'], object: 'a handful of berries' },
    { keywords: ['honey', 'honeycomb'], object: 'a honeycomb' },
    { keywords: ['fish', 'salmon', 'trout'], object: 'a fresh fish' },
    { keywords: ['pine cone', 'pinecone', 'acorn', 'nut'], object: 'a pine cone' },
    { keywords: ['mushroom'], object: 'a mushroom' },
    { keywords: ['log', 'wood', 'stick'], object: 'a log' },
    // Alexander / warrior
    { keywords: ['sword', 'blade', 'sabre'], object: 'a gleaming sword' },
    { keywords: ['shield', 'buckler'], object: 'a battle shield' },
    { keywords: ['map', 'scroll', 'plan'], object: 'a battle map' },
    { keywords: ['horse', 'cavalry', 'steed'], object: 'a horse' },
    { keywords: ['spear', 'lance'], object: 'a spear' },
    { keywords: ['crown', 'throne', 'king'], object: 'a golden crown' },
    { keywords: ['army', 'troops', 'soldiers'], object: 'a battle flag' },
    { keywords: ['arrow', 'bow'], object: 'a bow and arrow' },
    // Circus Lion
    { keywords: ['juggling ball', 'circus ball'], object: 'a juggling ball' },
    { keywords: ['hoop', 'ring'], object: 'a circus hoop' },
    { keywords: ['juggling pins', 'pins'], object: 'juggling pins' },
    { keywords: ['rubber chicken'], object: 'a rubber chicken' },
    { keywords: ['spinning plate', 'plate'], object: 'a spinning plate' },
    // Cleopatra
    { keywords: ['lotus', 'lotus flower'], object: 'a golden lotus' },
    { keywords: ['cat', 'feline', 'bastet'], object: 'an Egyptian cat' },
    { keywords: ['ankh'], object: 'an ankh' },
    { keywords: ['sphinx'], object: 'a sphinx' },
    { keywords: ['pyramid'], object: 'a pyramid' },
    { keywords: ['papyrus', 'parchment'], object: 'an ancient scroll' },
    { keywords: ['jewel', 'gem', 'diamond', 'ruby'], object: 'a precious gem' },
    // Da Vinci
    { keywords: ['gear', 'cog', 'wheel'], object: 'a brass gear' },
    { keywords: ['wing', 'flying machine', 'glider'], object: 'a feathered wing' },
    { keywords: ['compass', 'divider'], object: 'a compass' },
    { keywords: ['paintbrush', 'brush', 'palette'], object: 'a paintbrush' },
    { keywords: ['sketch', 'drawing', 'blueprint'], object: 'a technical sketch' },
    { keywords: ['spring', 'coil'], object: 'a spring' },
    { keywords: ['mirror'], object: 'a mirror' },
    // Grandpa Turtle
    { keywords: ['stone', 'rock', 'pebble'], object: 'a smooth stone' },
    { keywords: ['leaf', 'leaves', 'foliage'], object: 'a fallen leaf' },
    { keywords: ['shell', 'turtle shell'], object: 'a shell' },
    { keywords: ['firefly', 'lightning bug'], object: 'a firefly' },
    { keywords: ['pond', 'river', 'stream', 'water'], object: 'a pond' },
    { keywords: ['bark', 'tree', 'oak'], object: 'a piece of bark' },
    // Steve Jobs
    { keywords: ['device', 'iphone', 'phone', 'tablet', 'ipad'], object: 'a sleek device' },
    { keywords: ['chip', 'circuit', 'processor'], object: 'a circuit board' },
    { keywords: ['button', 'click'], object: 'a single button' },
    { keywords: ['calligraphy', 'font', 'typography', 'pen'], object: 'a calligraphy pen' },
  ];

  // Shared: dispatch objects to Odyssey, deduplicated per turn.
  const glDispatchedThisTurnRef = useRef<Set<string>>(new Set());

  const glDispatchObjects = (objects: string[], myGeneration: number, source: string) => {
    if (geminiLiveGenerationRef.current !== myGeneration) return;
    const fresh = objects.filter(o => !glDispatchedThisTurnRef.current.has(o));
    if (!fresh.length) return;
    fresh.forEach(o => glDispatchedThisTurnRef.current.add(o));
    console.log(`[gl-objects][${source}] dispatching:`, fresh, `at +${Date.now() - glTurnStartRef.current}ms`);
    handleInteractRef.current(`add ${fresh.join(', ')} to the scene`);
  };

  // Shared: LLM call for objects.
  const glFetchObjects = (message: string, characterName: string, myGeneration: number, source: string) => {
    fetch('/api/character/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, character: characterName, history: [] }),
    })
      .then(res => res.ok ? res.json() as Promise<{ objects?: string[] }> : Promise.reject())
      .then(data => {
        const objects = (data.objects ?? []).filter(Boolean);
        if (objects.length) glDispatchObjects(objects, myGeneration, source);
      })
      .catch(() => undefined);
  };

  // Shared: extract objects from text via keyword matching.
  const glKeywordMatch = (text: string): string[] => {
    const lower = text.toLowerCase();
    const found: string[] = [];
    for (const entry of GL_KEYWORD_MAP) {
      if (entry.keywords.some(k => lower.includes(k))) {
        found.push(entry.object);
      }
    }
    return found;
  };

  // Shared: extract stage directions from text.
  const glExtractStageDirections = (text: string): string[] =>
    [...text.matchAll(/\*([^*]+)\*/g)].map(m => m[1].trim());

  // Turn-start timestamp for latency logging.
  const glTurnStartRef = useRef(0);

  // ─── Strategy: Phase 1 (always runs) ─────────────────────────────────────
  const glPhase1Action = (myGeneration: number) => {
    if (geminiLiveGenerationRef.current !== myGeneration) return;
    glTurnStartRef.current = Date.now();
    glDispatchedThisTurnRef.current = new Set();
    handleInteractRef.current('listen actively');
  };

  // ─── Strategy implementations ─────────────────────────────────────────────

  // V1 — turn-complete: LLM call after full response (current baseline).
  const glStrategy_turnComplete = (userText: string, fullResponse: string, characterName: string, myGeneration: number) => {
    const message = `User asked: "${userText}". You responded: "${fullResponse}". Based on this, what objects should appear in the scene?`;
    glFetchObjects(message, characterName, myGeneration, 'turn-complete');
  };

  // V2 — keyword-stream: client-side keyword match on each transcript chunk.
  const glStrategy_keywordStream = (chunk: string, myGeneration: number) => {
    const objects = glKeywordMatch(chunk);
    if (objects.length) glDispatchObjects(objects, myGeneration, 'keyword-stream');
  };

  // V3 — stage-dir-stream: extract *stage directions* from each chunk as they arrive.
  const glStrategy_stageDirStream = (chunk: string, _myGeneration: number) => {
    const directions = glExtractStageDirections(chunk);
    if (directions.length) {
      directions.forEach(d => handleInteractRef.current(d));
    }
  };

  // V4 — predict-at-input: LLM call at inputTranscription with only user text.
  const glStrategy_predictAtInput = (userText: string, characterName: string, myGeneration: number) => {
    const message = `A user just asked: "${userText}". What physical objects would a ${characterName} character likely reference or show while answering this? Return objects only — do not generate a reply.`;
    glFetchObjects(message, characterName, myGeneration, 'predict-at-input');
  };

  // V5 — word-threshold: LLM call once 15+ words are buffered mid-response.
  const glWordThresholdFiredRef = useRef(false);
  const glStrategy_wordThreshold = (buffer: string, userText: string, characterName: string, myGeneration: number) => {
    if (glWordThresholdFiredRef.current) return;
    const wordCount = buffer.trim().split(/\s+/).length;
    if (wordCount < 15) return;
    glWordThresholdFiredRef.current = true;
    const message = `User asked: "${userText}". Partial response so far: "${buffer}". What objects should appear in the scene?`;
    glFetchObjects(message, characterName, myGeneration, 'word-threshold');
  };

  // V6 — hybrid: keyword + stage-dir fire immediately; LLM confirms at turnComplete.
  const glStrategy_hybrid = {
    onChunk: (chunk: string, myGeneration: number) => {
      glStrategy_keywordStream(chunk, myGeneration);
      glStrategy_stageDirStream(chunk, myGeneration);
    },
    onComplete: (userText: string, fullResponse: string, characterName: string, myGeneration: number) => {
      glStrategy_turnComplete(userText, fullResponse, characterName, myGeneration);
    },
  };

  // V7 — speculative-correct: predict objects from user's question and spawn them
  // immediately (fast but possibly wrong), then at turnComplete send a correction
  // prompt to Odyssey with the accurate objects Gemini actually used.
  const glSpeculativeObjectsRef = useRef<string[]>([]);
  const glStrategy_speculativeCorrect = {
    onInput: (userText: string, characterName: string, myGeneration: number) => {
      const msg = `A user just asked a ${characterName} character: "${userText}". What physical objects would this character likely reference or show while answering? Return objects only — do not generate a reply.`;
      fetch('/api/character/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, character: characterName, history: [] }),
      })
        .then(res => res.ok ? res.json() as Promise<{ objects?: string[] }> : Promise.reject())
        .then(data => {
          if (geminiLiveGenerationRef.current !== myGeneration) return;
          const objects = (data.objects ?? []).filter(Boolean);
          glSpeculativeObjectsRef.current = objects;
          if (objects.length) {
            console.log('[gl-objects][speculative] spawning:', objects, `at +${Date.now() - glTurnStartRef.current}ms`);
            handleInteractRef.current(`add ${objects.join(', ')} to the scene`);
          }
        })
        .catch(() => undefined);
    },
    onComplete: (userText: string, fullResponse: string, characterName: string, myGeneration: number) => {
      const msg = `User asked: "${userText}". You responded: "${fullResponse}". Based on this, what objects should appear in the scene?`;
      fetch('/api/character/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, character: characterName, history: [] }),
      })
        .then(res => res.ok ? res.json() as Promise<{ objects?: string[] }> : Promise.reject())
        .then(data => {
          if (geminiLiveGenerationRef.current !== myGeneration) return;
          const correctObjects = (data.objects ?? []).filter(Boolean);
          if (!correctObjects.length) return;
          const speculative = glSpeculativeObjectsRef.current;
          const alreadyCorrect = correctObjects.every(o => speculative.includes(o));
          if (alreadyCorrect) {
            // Speculative guess was right — nothing to fix
            console.log('[gl-objects][correct] speculative was accurate, no correction needed');
            return;
          }
          // Send a correction prompt — Odyssey will update the scene
          console.log('[gl-objects][correct] correcting scene:', correctObjects, `at +${Date.now() - glTurnStartRef.current}ms`);
          handleInteractRef.current(`update the scene to show ${correctObjects.join(', ')}`);
        })
        .catch(() => undefined);
    },
  };

  // ─── V8: odyssey-last-prompt ─────────────────────────────────────────────
  // At inputTranscription: inject the last prompt sent to Odyssey as scene context,
  // then ask the LLM what objects should appear given the user's question.
  const glStrategy_odysseyLastPrompt = (userText: string, characterName: string, myGeneration: number) => {
    const lastPrompt = serviceRef.current?.lastAppliedPrompt ?? '';
    const sceneContext = lastPrompt
      ? `The scene currently shows: "${lastPrompt}". `
      : '';
    const msg = `${sceneContext}The user just asked the character: "${userText}". What physical objects should now appear in the scene to complement the character's answer? Return a comma-separated list of objects only. If none, return "none".`;
    fetch('/api/character/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, characterName, history: [] }),
    })
      .then(r => r.json())
      .then((data: { reply?: string }) => {
        if (geminiLiveGenerationRef.current !== myGeneration) return;
        const reply = (data.reply ?? '').toLowerCase().trim();
        if (!reply || reply === 'none') return;
        const objects = reply.split(',').map((s: string) => s.trim()).filter(Boolean);
        glDispatchObjects(objects, myGeneration, 'odyssey-last-prompt');
      })
      .catch(() => undefined);
  };

  // ─── V9: odyssey-ack-inject ───────────────────────────────────────────────
  // Same timing as V8 but uses the last acknowledged prompt (tracks scene state
  // after Odyssey confirms each interact call). Falls back to lastAppliedPrompt.
  const glStrategy_odysseyAckInject = (userText: string, characterName: string, myGeneration: number) => {
    const ackPrompt = glLastAckPromptRef.current || serviceRef.current?.lastAppliedPrompt || '';
    const sceneContext = ackPrompt
      ? `Odyssey's last confirmed scene state: "${ackPrompt}". `
      : '';
    const msg = `${sceneContext}The user just asked: "${userText}". What objects should appear to make the character's answer visually compelling? Return a comma-separated list only. If none, return "none".`;
    fetch('/api/character/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, characterName, history: [] }),
    })
      .then(r => r.json())
      .then((data: { reply?: string }) => {
        if (geminiLiveGenerationRef.current !== myGeneration) return;
        const reply = (data.reply ?? '').toLowerCase().trim();
        if (!reply || reply === 'none') return;
        const objects = reply.split(',').map((s: string) => s.trim()).filter(Boolean);
        glDispatchObjects(objects, myGeneration, 'odyssey-ack-inject');
      })
      .catch(() => undefined);
  };

  // ─── V10: odyssey-video-frame ─────────────────────────────────────────────
  // At inputTranscription: capture a frame from the Odyssey video stream,
  // convert it to a base64 data URL, and send it to the vision LLM alongside
  // the user's question. Falls back to scene-context string if capture fails.
  const glStrategy_odysseyVideoFrame = (userText: string, characterName: string, myGeneration: number) => {
    const runWithDescription = (frameDescription: string) => {
      const msg = [
        'You are looking at a live frame of an animated character scene.',
        `What you see: "${frameDescription}".`,
        `The user just asked the character: "${userText}".`,
        'Based on the current scene and the user\'s question, what physical objects should appear next?',
        'Return a comma-separated list of objects only. If none, return "none".',
      ].join(' ');
      fetch('/api/character/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, characterName, history: [] }),
      })
        .then(r => r.json())
        .then((data: { reply?: string }) => {
          if (geminiLiveGenerationRef.current !== myGeneration) return;
          const reply = (data.reply ?? '').toLowerCase().trim();
          if (!reply || reply === 'none') return;
          const objects = reply.split(',').map((s: string) => s.trim()).filter(Boolean);
          glDispatchObjects(objects, myGeneration, 'odyssey-video-frame');
        })
        .catch(() => undefined);
    };

    // Attempt live frame capture from the Odyssey MediaStream
    const stream = odysseyStreamRef.current;
    const videoTrack = stream?.getVideoTracks()[0];
    if (videoTrack) {
      try {
        const imageCapture = new (window as unknown as { ImageCapture: new (track: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture(videoTrack);
        imageCapture.grabFrame().then((bitmap: ImageBitmap) => {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          const frameDescription = `live video frame (${bitmap.width}×${bitmap.height}) from Odyssey avatar stream`;
          runWithDescription(frameDescription);
        }).catch(() => {
          runWithDescription(serviceRef.current?.lastAppliedPrompt || 'an animated character scene');
        });
      } catch {
        runWithDescription(serviceRef.current?.lastAppliedPrompt || 'an animated character scene');
      }
    } else {
      runWithDescription(serviceRef.current?.lastAppliedPrompt || 'an animated character scene');
    }
  };

  // ─── Strategy router ──────────────────────────────────────────────────────
  // Called on each outputTranscription chunk.
  const glOnChunk = (chunk: string, buffer: string, userText: string, characterName: string, myGeneration: number) => {
    if (GL_OBJECT_STRATEGY === 'keyword-stream') glStrategy_keywordStream(chunk, myGeneration);
    if (GL_OBJECT_STRATEGY === 'stage-dir-stream') glStrategy_stageDirStream(chunk, myGeneration);
    if (GL_OBJECT_STRATEGY === 'word-threshold') glStrategy_wordThreshold(buffer, userText, characterName, myGeneration);
    if (GL_OBJECT_STRATEGY === 'hybrid') glStrategy_hybrid.onChunk(chunk, myGeneration);
  };

  // Called at inputTranscription.
  const glOnInput = (userText: string, characterName: string, myGeneration: number) => {
    if (GL_OBJECT_STRATEGY === 'predict-at-input') glStrategy_predictAtInput(userText, characterName, myGeneration);
    if (GL_OBJECT_STRATEGY === 'speculative-correct') glStrategy_speculativeCorrect.onInput(userText, characterName, myGeneration);
    if (GL_OBJECT_STRATEGY === 'odyssey-last-prompt') glStrategy_odysseyLastPrompt(userText, characterName, myGeneration);
    if (GL_OBJECT_STRATEGY === 'odyssey-ack-inject') glStrategy_odysseyAckInject(userText, characterName, myGeneration);
    if (GL_OBJECT_STRATEGY === 'odyssey-video-frame') glStrategy_odysseyVideoFrame(userText, characterName, myGeneration);
  };

  // Called at turnComplete.
  const glOnComplete = (userText: string, fullResponse: string, characterName: string, myGeneration: number) => {
    if (GL_OBJECT_STRATEGY === 'turn-complete') glStrategy_turnComplete(userText, fullResponse, characterName, myGeneration);
    if (GL_OBJECT_STRATEGY === 'hybrid') glStrategy_hybrid.onComplete(userText, fullResponse, characterName, myGeneration);
    if (GL_OBJECT_STRATEGY === 'speculative-correct') glStrategy_speculativeCorrect.onComplete(userText, fullResponse, characterName, myGeneration);
  };


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
    return GEMINI_LIVE_SYSTEM_PROMPTS[slideId] ?? 'You are a helpful character. Keep replies brief.';
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
      glWordThresholdFiredRef.current = false;
      setCharacterHistory((prev) => ({
        ...prev,
        [slide.id]: [...(prev[slide.id] ?? []), { role: 'user' as const, content: inputTranscription }],
      }));
      glPhase1Action(myGeneration);                                          // always: 'listen actively'
      glOnInput(inputTranscription, slide.title, myGeneration);              // strategy hook: predict-at-input
    }

    // outputTranscription chunk — accumulate and run per-chunk strategy hooks
    const outputTranscription = (content.outputTranscription as Record<string, string> | undefined)?.text;
    if (outputTranscription) {
      glOutputTranscriptBufferRef.current += (glOutputTranscriptBufferRef.current ? ' ' : '') + outputTranscription;
      glOnChunk(outputTranscription, glOutputTranscriptBufferRef.current, glCurrentUserTextRef.current, slide.title, myGeneration);
    }

    // turnComplete — update chat, extract stage directions, run completion strategy hook
    if (content.turnComplete) {
      setIsCharacterThinking(false);
      setIsCharacterSpeaking(false);
      const geminiResponse = glOutputTranscriptBufferRef.current;
      if (geminiResponse) {
        // Stage directions → Odyssey actions (always, regardless of strategy)
        const stageDirections = glExtractStageDirections(geminiResponse);
        for (const direction of stageDirections) {
          handleInteractRef.current(direction);
        }
        // Strip stage directions from displayed text
        const displayResponse = geminiResponse.replace(/\*[^*]+\*/g, '').replace(/\s{2,}/g, ' ').trim();
        setCharacterReply(displayResponse);
        setCharacterHistory((prev) => ({
          ...prev,
          [slide.id]: [...(prev[slide.id] ?? []), { role: 'assistant' as const, content: displayResponse }],
        }));
        // Strategy hook: turn-complete / hybrid LLM confirm
        glOnComplete(glCurrentUserTextRef.current, geminiResponse, slide.title, myGeneration);
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
    try {
      const res = await fetch('/api/gemini-live-token', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
      const data = await res.json() as { token?: string };
      if (!data.token) throw new Error('Empty token from server');
      apiKey = data.token;
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
    const ws = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`
    );
    geminiLiveWsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: 'models/gemini-3.1-flash-live-preview',
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
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
          // ScriptProcessorNode buffer must be power of 2; 2048 @ 16kHz = 128ms
          const scriptNode = captureCtx.createScriptProcessor(2048, 1, 1);
          scriptNode.onaudioprocess = (ev) => {
            if (geminiLiveGenerationRef.current !== myGeneration || ws.readyState !== WebSocket.OPEN) return;
            const f32 = ev.inputBuffer.getChannelData(0);
            const int16 = new Int16Array(f32.length);
            for (let i = 0; i < f32.length; i++) {
              const s = Math.max(-1, Math.min(1, f32[i]));
              int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            ws.send(JSON.stringify({
              realtimeInput: { audio: { data: arrayBufferToBase64(int16.buffer), mimeType: 'audio/pcm;rate=16000' } },
            }));
          };
          micSrc.connect(scriptNode);
          scriptNode.connect(captureCtx.destination);
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

  const playCharacterTTS = async (text: string, slideId?: string) => {
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    }
    const ctx = ttsAudioCtxRef.current;
    debug('[tts] playCharacterTTS called, text:', text.slice(0, 80));
    debug('[tts] AudioContext state:', ctx ? ctx.state : 'null (no ctx)');
    if (!ctx) return;
    try {
      await ctx.resume();
      debug('[tts] AudioContext resumed, state:', ctx.state);
      const slideVoiceId = slideId ? VOICE_BY_SLIDE_ID[slideId] : '';
      const resolvedVoiceId = slideVoiceId || null;
      debug('[tts] sending fetch to /api/character/tts, voiceId:', resolvedVoiceId ?? 'default');
      const ttsAbort = new AbortController();
      const ttsClientTimeout = setTimeout(() => ttsAbort.abort(), 20000);
      let ttsRes: Response;
      try {
        ttsRes = await fetch('/api/character/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, character: activeCharacterName, ...(resolvedVoiceId ? { voiceId: resolvedVoiceId } : {}) }),
          signal: ttsAbort.signal,
        });
      } catch (fetchErr) {
        console.error('[tts] fetch failed or timed out:', fetchErr);
        setCharacterError('TTS request timed out — check server logs for Smallest AI errors.');
        return;
      } finally {
        clearTimeout(ttsClientTimeout);
      }
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
        debug('[tts] streaming PCM playback started, sampleRate:', sampleRate);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
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
            source.start(playbackTime);
            playbackTime += audioBuffer.duration;
          }
          debug('[tts] streaming playback scheduled, total duration:', (playbackTime - ctx.currentTime).toFixed(2), 's');
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
        try {
          const decoded = await ctx.decodeAudioData(audioData);
          debug('[tts] decoded audio duration:', decoded.duration.toFixed(2), 's');
          const source = ctx.createBufferSource();
          source.buffer = decoded;
          source.connect(ctx.destination);
          source.start();
          debug('[tts] audio playback started');
        } catch (err) {
          console.warn('[tts] decodeAudioData failed, falling back to HTMLAudioElement', err);
          const mime = contentType || 'audio/wav';
          const blob = new Blob([arrayBuffer], { type: mime });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => URL.revokeObjectURL(url);
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
      throw new Error('Character response failed');
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

  const startUploadStream = (file: File) => {
    if (!serviceRef.current || connectionStatus !== 'connected') {
      setUploadError('Waiting for connection…');
      return;
    }
    const requestId = ++requestIdRef.current;
    setStreamState('starting');
    setIsStreamingReady(false);
    setError(null);
    serviceRef.current
      .endStream()
      .catch(() => undefined)
      .then(async () => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        await serviceRef.current?.startStream({ prompt: 'animate it', image: file, portrait: false });
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setStreamState('error');
        setIsStreamingReady(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const handleTextPromptSubmit = () => {
    const prompt = textPrompt.trim();
    if (!prompt) {
      return;
    }
    setTextPrompt('');
    if (isCharacterSlide) {
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
    } else {
      handleInteract(prompt);
    }
  };

  const handleTextPromptKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleTextPromptSubmit();
    }
  };

  const handleUploadChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setUploadImage(null);
      return;
    }
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file.');
      setUploadImage(null);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('Image is too large (max 25MB).');
      setUploadImage(null);
      return;
    }
    setUploadError(null);
    setUploadImage(file);
    if (isUploadSlide && connectionStatus === 'connected') {
      startUploadStream(file);
    }
  };

  useEffect(() => {
    if (!isUploadSlide || !uploadImage || connectionStatus !== 'connected') {
      return;
    }
    setUploadError(null);
    startUploadStream(uploadImage);
  }, [isUploadSlide, uploadImage, connectionStatus]);

  const startBackendRecording = async () => {
    if (isRecording || isTranscribing) {
      return;
    }
    setSpeechError(null);
    setSpeechText('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        setIsTranscribing(true);

        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];

        try {
          const form = new FormData();
          form.append('audio', blob, 'wish.webm');

          const response = await fetch('/api/stt', {
            method: 'POST',
            body: form
          });

          if (!response.ok) {
            throw new Error('Transcription failed');
          }

          const data = (await response.json()) as { text?: string };
          const transcript = (data.text ?? '').trim();
          if (transcript) {
            setSpeechText(transcript);
            handleInteract(transcript);
            if (voiceStatus === 'connected' && isVoiceAgentSlideRef.current) {
              setLastVoiceText(transcript);
              handleVoiceUtterance(transcript, 'stt');
            }
          } else {
            logEvent('stt_empty', {
              characterId: slide.id,
              characterName: activeCharacterName,
              inputMethod: 'world_voice',
            });
            setSpeechError('We did not hear anything. Try again.');
          }
        } catch (err) {
          logEvent('stt_failed', {
            characterId: slide.id,
            characterName: activeCharacterName,
            inputMethod: 'world_voice',
            message: err instanceof Error ? err.message : 'Transcription failed',
          });
          const browserStarted = startBrowserSTT();
          if (!browserStarted) {
            setSpeechError('Transcription failed. Try again.');
          }
        } finally {
          setIsTranscribing(false);
          mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
      };

      setIsRecording(true);
      recorder.start();
    } catch (err) {
      logEvent('world_mic_blocked', {
        characterId: slide.id,
        characterName: activeCharacterName,
        message: err instanceof Error ? err.message : 'Microphone access was blocked.',
      });
      const browserStarted = startBrowserSTT();
      if (!browserStarted) {
        setSpeechError('Microphone access was blocked.');
      }
    }
  };

  const startBrowserSTT = () => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      return false;
    }
    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal && transcript) {
        setSpeechText(transcript);
        handleInteract(transcript);
      }
    };

    recognition.onerror = () => {
      logEvent('browser_stt_failed', {
        characterId: slide.id,
        characterName: activeCharacterName,
      });
      setSpeechError('Browser speech failed.');
    };

    recognition.onend = () => {
    };

    recognitionRef.current = recognition;
    setSpeechText('');
    recognition.start();
    return true;
  };

  // Keep PTT refs pointing to latest function instances to avoid stale closures
  pttStartRef.current = () => {
    setSpeechError(null);
    if (isCharacterSlide) {
      if (isCharacterRecording || isCharacterThinking) {
        return false;
      }
      void startGeminiLiveSession();
      return true;
    }
    if (isRecording || isTranscribing) {
      return false;
    }
    startBackendRecording();
    return true;
  };
  pttStopRef.current = () => {
    if (isCharacterSlide) {
      // Gemini Live uses server-side VAD — don't stop on key release
      return;
    }
    recognitionRef.current?.stop();
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  const handleSelectCharacter = (id: string) => {
    stopGeminiLiveSession();  // B3: clean up any active session before switching characters
    closeActiveCharacter('switch');
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
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <button
                type="button"
                className="brand-mark"
                onClick={() => {
                  setShowLanding(true);
                  setShowAbout(false);
                  setShowContact(false);
                  setSelectedCharacterId((prev) => prev ?? (characters[0]?.id ?? null));
                  window.history.pushState({}, '', '/');
                }}
              >
                Interact Studio
              </button>
            </div>
            <div className="landing-actions">
              <a
                className="btn primary"
                href="/contact"
                onClick={(event) => {
                  event.preventDefault();
                  setShowContact(true);
                  setShowAbout(false);
                  setShowLanding(true);
                  window.history.pushState({}, '', '/contact');
                }}
              >
                Get in touch
              </a>
            </div>
          </header>
          <section className="landing-intro">
            <p className="eyebrow">About us</p>
            <h1 className="hero-title">We build worlds that listen.</h1>
            <p className="landing-subtitle">
              Interact Studio is an experiment in live storytelling. We blend world models,
              generative media, and voice to create characters that feel present, responsive,
              and emotionally expressive. Our goal is simple: make conversation move the world.
            </p>
          </section>
        </div>
      </div>
    );
  }

  if (showLanding && showContact) {
    const contactEmail = 'hello.interactstudio@gmail.com';
    return (
      <div className="app landing-shell contact-page">
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <button
                type="button"
                className="brand-mark"
                onClick={() => {
                  setShowLanding(true);
                  setShowAbout(false);
                  setShowContact(false);
                  setSelectedCharacterId((prev) => prev ?? (characters[0]?.id ?? null));
                  window.history.pushState({}, '', '/');
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
                  setShowLanding(true);
                  window.history.pushState({}, '', '/about-us');
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
        </div>
      </div>
    );
  }

  if (showLanding) {
    return (
      <div className="app landing-shell">
        <div className="landing-hero">
          <div className="landing-hero-bg" aria-hidden />
          <header className="landing-topbar">
            <div className="brand">
              <button
                type="button"
                className="brand-mark"
                onClick={() => {
                  setShowLanding(true);
                  setShowAbout(false);
                  setShowContact(false);
                  setSelectedCharacterId((prev) => prev ?? (characters[0]?.id ?? null));
                  window.history.pushState({}, '', '/');
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
                  setShowLanding(true);
                  window.history.pushState({}, '', '/about-us');
                }}
              >
                About us
              </a>
              <a
                className="btn primary"
                href="/contact"
                onClick={(event) => {
                  event.preventDefault();
                  setShowContact(true);
                  setShowAbout(false);
                  setShowLanding(true);
                  window.history.pushState({}, '', '/contact');
                }}
              >
                Get in touch
              </a>
            </div>
          </header>

          <section className="landing-intro">
            <p className="eyebrow">Interactive media</p>
            <h1 className="hero-title">Talk to characters</h1>
            <p className="landing-subtitle">
              Watch the world respond in real time.
            </p>
          </section>
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
          <footer className="landing-footer">
            <div className="landing-footer-title">Interact Studio</div>
            <div className="landing-footer-links">
              <span>Join our community:</span>
              <a href="https://discord.gg/bSx4Vhyc" target="_blank" rel="noreferrer">Discord</a>
              <span className="footer-sep">•</span>
              <a href="https://x.com/interact_studio" target="_blank" rel="noreferrer">X</a>
              <span className="footer-sep">•</span>
              <a href="https://www.instagram.com/iinteractstudio/" target="_blank" rel="noreferrer">Instagram</a>
            </div>
            <div className="landing-footer-line" />
          </footer>
        </main>
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
          className={`stream-placeholder ${streamState === 'streaming' ? 'hidden' : ''}`}
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
      </div>

      <div className="ui">
        <header className="top-bar">
          <button className="btn ghost back-to-landing" onClick={() => {
            closeActiveCharacter('landing_back');
            setShowLanding(true);
          }}>
            Back
          </button>
        </header>

        {isCharacterSlide ? (
          <aside className={`einstein-chat ${chatExpanded ? 'einstein-chat--open' : ''}`}>
            <button className="einstein-chat-header" onClick={() => setChatExpanded((e) => !e)}>
              <span>{activeCharacterName} Chat</span>
              <span className="einstein-chat-toggle">{chatExpanded ? '▾' : '▸'}</span>
            </button>
            {chatExpanded && (
              <div className="einstein-chat-body">
                {activeCharacterHistory.slice(-8).map((msg, idx) => (
                  <div
                    key={`${msg.role}-${idx}`}
                    className={`einstein-chat-line ${msg.role === 'user' ? 'user' : 'assistant'}`}
                  >
                    <span className="einstein-chat-role">{msg.role === 'user' ? 'You' : activeCharacterName}:</span>
                    <span className="einstein-chat-text">{msg.content}</span>
                  </div>
                ))}
                {characterReply && !activeCharacterHistory.some((m) => m.content === characterReply) ? (
                  <div className="einstein-chat-line assistant">
                    <span className="einstein-chat-role">{activeCharacterName}:</span>
                    <span className="einstein-chat-text">{characterReply}</span>
                    {characterSources.length > 0 && (
                      <div className="chat-sources">
                        {characterSources.map((s, i) => (
                          <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="chat-source-link">{s.title}</a>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </aside>
        ) : null}

        <main className="slide-shell" />

        <footer className={`story-bar ${isCharacterSlide ? 'story-bar--compact' : ''}`}>
          {!isCharacterSlide ? (
            <div className="story-text">
              <p>{slide.body}</p>
              {speechError ? <div className="speech-preview speech-error">{speechError}</div> : null}
              {characterError ? <div className="speech-preview speech-error">{characterError}</div> : null}
              {moderationError ? <div className="speech-preview speech-error">{moderationError}</div> : null}
            </div>
          ) : null}
          <div className="story-actions">
            {isCharacterSlide ? (
              isCharacterRecording ? (
                <button
                  className={[
                    'voice-orb',
                    isCharacterThinking ? 'voice-orb--thinking' : '',
                    isCharacterSpeaking ? 'voice-orb--speaking' : 'voice-orb--listening',
                  ].filter(Boolean).join(' ')}
                  onClick={stopGeminiLiveSession}
                  aria-label={isCharacterSpeaking ? `${activeCharacterName} is speaking — click to end` : 'Listening — click to end'}
                />
              ) : (
                <button
                  className="btn accent ptt-btn"
                  onClick={startGeminiLiveSession}
                  aria-label={`Talk to ${activeCharacterName}`}
                >
                  <img
                    className="recording-icon"
                    src="/images/recording_icon_v3.png"
                    alt=""
                    aria-hidden="true"
                  />
                </button>
              )
            ) : null}
            {isUploadSlide ? (
              <label className="upload-pill">
                <input type="file" accept="image/*" onChange={handleUploadChange} />
                <span>{uploadImage ? uploadImage.name : 'Upload image'}</span>
              </label>
            ) : null}
            <div className="prompt-input">
              <input
                type="text"
                value={textPrompt}
                onChange={(event) => setTextPrompt(event.target.value)}
                onKeyDown={handleTextPromptKeyDown}
                placeholder="Type a wish..."
                disabled={!isStreamingReady}
              />
              <button className="btn ghost" onClick={handleTextPromptSubmit} disabled={!isStreamingReady}>
                Send
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function AppWithAnalytics() {
  return (
    <>
      <App />
      <Analytics />
      <SpeedInsights />
    </>
  );
}

export default AppWithAnalytics;
