import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import type { ConnectionStatus } from '@odysseyml/odyssey';
import charactersData from './data/characters.json';
import { OdysseyService, credentialsFromDict, loadImageFile, type ClientCredentials, type StreamState } from './lib/odyssey';
import './App.css';

interface Character {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  image: string;
  prompt: string;
  cta: string;
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

function App() {
  const [credentials, setCredentials] = useState<ClientCredentials | undefined>(undefined);
  const [showLanding, setShowLanding] = useState(true);
  const [showAbout, setShowAbout] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(characters[0]?.id ?? null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionEpoch, setConnectionEpoch] = useState(0); // bumps each time onConnected fires (data channel ready)
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
  const characterChunksRef = useRef<Blob[]>([]);
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
  const isVoiceAgentSlideRef = useRef(false);
  const lastVoiceActionAtRef = useRef(0);
  const handleInteractRef = useRef<(promptOverride?: string) => void>(() => undefined);
  const ttsAudioCtxRef = useRef<AudioContext | null>(null);
  const characterOpenedAtRef = useRef<number | null>(null);
  const hasLoggedFirstPromptRef = useRef(false);

  const logEvent = (event: string, data: Record<string, unknown>) => {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
    }).catch(() => undefined);
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
      releaseOdysseyLease();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      releaseOdysseyLease();
    };
  }, []);


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
          console.log('[odyssey] onConnected — stream:', stream);
          // Set 'connected' here (not in onStatusChange) so the startStream
          // useEffect only fires after the data channel is open and ready.
          // Also bump connectionEpoch so the effect re-runs even if connectionStatus
          // was already 'connected' (e.g. slide changed while reconnecting).
          dataChannelReadyRef.current = true;
          setConnectionStatus('connected');
          setConnectionEpoch((e) => e + 1);
          odysseyStreamRef.current = stream;
          const attach = () => {
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              videoRef.current.play().catch((e) => {
                console.warn('[odyssey] video.play failed:', e);
              });
            } else {
              setTimeout(attach, 100);
            }
          };
          attach();
        },
        onStatusChange: (status) => {
          console.log('[odyssey] status:', status);
          // 'connected' is set in onConnected instead, which fires only after
          // both the video track and data channel are ready.
          if (status !== 'connected') {
            setConnectionStatus(status);
            dataChannelReadyRef.current = false; // data channel not ready during reconnect
          }
        },
        onStreamStarted: () => {
          console.log('[odyssey] onStreamStarted');
          streamActiveRef.current = true;
          setStreamState('streaming');
          setIsStreamingReady(true);
          setModerationError(null);
        },
        onStreamEnded: () => {
          console.log('[odyssey] onStreamEnded');
          streamActiveRef.current = false;
          setStreamState('ended');
          setIsStreamingReady(false);
          // Auto-restart the stream so interact() keeps working
          if (retryStreamRef.current) {
            console.log('[odyssey] auto-restarting stream after end');
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
            if (moderationRetryCountRef.current < 3 && retryStreamRef.current) {
              moderationRetryCountRef.current++;
              console.log(`[odyssey] moderation_failed — retrying (attempt ${moderationRetryCountRef.current})`);
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
          setError(`${r}: ${m}`);
        },
        onError: (err) => {
          console.error('[odyssey] onError:', err);
          streamActiveRef.current = false;
          setStreamState('error');
          setIsStreamingReady(false);
          if (err.message?.includes('moderation_failed')) {
            setModerationError('Prompt blocked by moderation. Please try a different request.');
            setError(null);
            return;
          }
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
      // retryStreamRef is set AFTER startStream resolves — prevents onStreamEnded (macrotask from
      // previous endStream) from racing with the initial call and triggering a double startStream → deadlock.

      // Guard: data channel must be confirmed open (onConnected fired) before startStream.
      // If not ready, bail out — connectionEpoch will bump when onConnected fires and re-run this effect.
      if (!dataChannelReadyRef.current) {
        console.log('[odyssey] data channel not ready — skipping startStream, awaiting onConnected');
        return;
      }
      if (requestIdRef.current !== requestId) return;
      console.log('[odyssey] calling startStream — slide:', slide.id, '| prompt:', slide.prompt?.slice(0, 60));
      await service.startStream(streamOptions);
      console.log('[odyssey] startStream resolved');
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
  }, [connectionStatus, connectionEpoch, showLanding, selectedCharacterId, slide.id, slide.image, slide.prompt, isUploadSlide]);

  // End the stream when the user navigates back to the landing page so the session isn't consumed idle.
  useEffect(() => {
    if (!showLanding) return;
    ++requestIdRef.current; // Invalidate any pending retry closure
    retryStreamRef.current = null;
    if (streamActiveRef.current) {
      streamActiveRef.current = false;
      serviceRef.current?.endStream().catch(() => undefined);
    }
  }, [showLanding]);


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

  const playCharacterTTS = async (text: string, slideId?: string) => {
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    }
    const ctx = ttsAudioCtxRef.current;
    console.log('[tts] playCharacterTTS called, text:', text.slice(0, 80));
    console.log('[tts] AudioContext state:', ctx ? ctx.state : 'null (no ctx)');
    if (!ctx) return;
    try {
      await ctx.resume();
      console.log('[tts] AudioContext resumed, state:', ctx.state);
      const slideVoiceId = slideId ? VOICE_BY_SLIDE_ID[slideId] : '';
      const resolvedVoiceId = slideVoiceId || null;
      console.log('[tts] sending fetch to /api/character/tts, voiceId:', resolvedVoiceId ?? 'default');
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
      console.log('[tts] server response status:', ttsRes.status, ttsRes.statusText);
      console.log('[tts] content-type:', ttsRes.headers.get('content-type'));
      if (!ttsRes.ok) {
        const errBody = await ttsRes.text();
        console.error('[tts] server error body:', errBody);
        return;
      }
      const arrayBuffer = await ttsRes.arrayBuffer();
      console.log('[tts] arrayBuffer size:', arrayBuffer.byteLength, 'bytes');
      if (arrayBuffer.byteLength < 200) {
        const text = new TextDecoder().decode(arrayBuffer);
        console.warn('[tts] suspiciously small buffer — raw content:', text);
      }
      try {
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        console.log('[tts] decoded audio duration:', decoded.duration.toFixed(2), 's');
        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(ctx.destination);
        source.start();
        console.log('[tts] audio playback started');
      } catch (err) {
        console.warn('[tts] decodeAudioData failed, falling back to HTMLAudioElement', err);
        const mime = ttsRes.headers.get('content-type') || 'audio/wav';
        const blob = new Blob([arrayBuffer], { type: mime });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        try {
          await audio.play();
          console.log('[tts] fallback audio playback started');
        } catch (playErr) {
          console.error('[tts] fallback audio play failed', playErr);
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
    if (!chatResponse.ok) throw new Error('Character response failed');

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

  const startCharacterRecording = async () => {
    if (isCharacterRecording || isCharacterThinking) {
      return;
    }
    setCharacterError(null);
    setCharacterReply(null);
    // Unlock AudioContext during user gesture so TTS can play after async awaits
    if (!ttsAudioCtxRef.current) {
      ttsAudioCtxRef.current = new AudioContext();
    } else {
      ttsAudioCtxRef.current.resume();
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const slideId = slide.id;
      const characterName = activeCharacterName;

      characterStreamRef.current = stream;
      characterRecorderRef.current = recorder;
      characterChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          characterChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        setIsCharacterRecording(false);
        setIsCharacterThinking(true);

        const blob = new Blob(characterChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        characterChunksRef.current = [];

        try {
          const form = new FormData();
          form.append('audio', blob, 'character.webm');

          const sttResponse = await fetch('/api/character/stt', {
            method: 'POST',
            body: form
          });

          if (!sttResponse.ok) {
            let detail = '';
            try {
              const raw = await sttResponse.text();
              if (raw) {
                try {
                  const data = JSON.parse(raw);
                  detail = String(data?.details ?? data?.error ?? raw);
                } catch {
                  detail = raw;
                }
              }
            } catch {
              // ignore read errors
            }
            const statusLine = `STT failed (${sttResponse.status})`;
            const message = detail ? `${statusLine}: ${detail}` : statusLine;
            throw new Error(message);
          }

          const sttData = (await sttResponse.json()) as { text?: string };
          const transcript = (sttData.text ?? '').trim();
          if (!transcript) {
            setCharacterError('We did not hear anything. Try again.');
            return;
          }

          logFirstPromptIfNeeded(slideId, characterName, 'stt');
          logEvent('prompt_sent', {
            characterId: slideId,
            characterName,
            inputMethod: 'stt',
            promptLength: transcript.length,
          });
          await runCharacterInteraction(transcript, slideId, characterName);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Character flow failed.';
          const isInputError =
            /stt/i.test(message) ||
            /microphone/i.test(message) ||
            /hear anything/i.test(message);
          if (isInputError) {
            setCharacterError(message);
          } else {
            console.warn('[character] non-input error', message);
          }
        } finally {
          setIsCharacterThinking(false);
          characterStreamRef.current?.getTracks().forEach((track) => track.stop());
          characterStreamRef.current = null;
        }
      };

      setIsCharacterRecording(true);
      recorder.start();
    } catch (err) {
      setCharacterError(err instanceof Error ? err.message : 'Microphone access was blocked.');
    }
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
            setSpeechError('We did not hear anything. Try again.');
          }
        } catch (err) {
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
      startCharacterRecording();
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
      if (isCharacterRecording) {
        stopCharacterRecording();
      }
      return;
    }
    recognitionRef.current?.stop();
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  const handleSelectCharacter = (id: string) => {
    // Log time spent on previous character before switching
    if (selectedCharacterId && characterOpenedAtRef.current !== null) {
      const timeSpentMs = Date.now() - characterOpenedAtRef.current;
      const prevCharacter = characters.find((c) => c.id === selectedCharacterId);
      logEvent('character_closed', {
        characterId: selectedCharacterId,
        characterName: prevCharacter?.title ?? selectedCharacterId,
        timeSpentMs,
      });
    }
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
          <button className="btn ghost back-to-landing" onClick={() => setShowLanding(true)}>
            Back
          </button>
        </header>

        {isCharacterSlide ? (
          <aside className="einstein-chat">
            <div className="einstein-chat-header">{activeCharacterName} Chat</div>
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
          </aside>
        ) : null}

        <main className="slide-shell" />

        <footer className="story-bar">
          <div className="story-text">
            <p>{slide.body}</p>
            {speechError ? <div className="speech-preview speech-error">{speechError}</div> : null}
            {characterError ? <div className="speech-preview speech-error">{characterError}</div> : null}
            {moderationError ? <div className="speech-preview speech-error">{moderationError}</div> : null}
          </div>
          <div className="story-actions">
            {isCharacterSlide ? (
              <button
                className="btn accent"
                onClick={isCharacterRecording ? stopCharacterRecording : startCharacterRecording}
                disabled={isCharacterThinking}
              >
                {isCharacterRecording
                  ? 'Stop'
                  : isCharacterThinking
                    ? 'Thinking...'
                      : `Talk to ${activeCharacterName}`}
              </button>
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
