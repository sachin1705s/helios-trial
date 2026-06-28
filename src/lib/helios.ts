import { Reactor, type ReactorStatus } from '@reactor-team/js-sdk';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAIN_VIDEO_TRACK = 'main_video';

export type ReactorModel = 'helios' | 'lingbot';
const MODEL_NAMES: Record<ReactorModel, string> = {
  helios: 'helios',
  lingbot: 'lingbot',
};

export type ClientCredentials = {
  jwt: string;
  sessionId?: string;
};

export type ConnectionStatus = ReactorStatus | 'connected';
export type StreamState = 'idle' | 'starting' | 'streaming' | 'ended' | 'error';

export type BroadcastInfo = {
  webrtcUrl?: string;
  spectatorToken?: string;
  hlsUrl?: string;
};

export interface OdysseyEventHandlers {
  /** Fired as soon as the video track arrives (during "waiting") — bind it to <video> early. */
  onStream?: (stream: MediaStream) => void;
  /** Fired once the session is "ready" (safe to send commands). */
  onConnected?: (stream: MediaStream) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  onStreamStarted?: (streamId?: string) => void;
  onStreamEnded?: () => void;
  onStreamError?: (reason: string, message?: string) => void;
  onInteractAcknowledged?: (prompt: string) => void;
  onBroadcastReady?: (info: BroadcastInfo) => void;
  onError?: (error: Error) => void;
}

// Default first-chunk prompt when a caller doesn't supply one.
const DEFAULT_PROMPT = 'animate it';
// How long to wait for the GPU session to report "ready" before giving up.
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;

const log = (...args: unknown[]) => console.log('[helios]', ...args);

/**
 * Helios session lifecycle, modelled on the documented Reactor flow:
 *   connect → status reaches "ready" → set_conditioning/set_prompt → start.
 *
 * Two facts drive the design:
 *   1. The WebRTC `main_video` track negotiates while the session is still
 *      "waiting", so it is delivered to the UI immediately (onStream) — but it
 *      is NOT treated as "ready".
 *   2. Commands (set_prompt/set_conditioning/start) are only accepted once the
 *      session is "ready". The SDK's `statusChanged` event can skip the
 *      waiting→ready transition, so readiness is also polled via getStatus().
 *
 * `startStream()` awaits readiness internally, so callers can invoke it any time
 * after connect() without racing the handshake.
 */
export class HeliosService {
  private client: Reactor;
  private credentials: ClientCredentials;
  private model: ReactorModel;
  private stream = new MediaStream();
  private handlers?: OdysseyEventHandlers;
  private connectedNotified = false;
  private generationStarted = false;
  private activePrompt: string | null = null;
  private isReady = false;
  private readyWaiters: Array<(ok: boolean) => void> = [];
  private readyPollTimer: ReturnType<typeof setInterval> | null = null;
  private conditionWaiters: Array<{ requireImage: boolean; done: () => void }> = [];
  private imageAcceptedWaiters: Array<() => void> = [];
  private hasReferenceImage = false;
  private anchorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(credentials: ClientCredentials, model: ReactorModel = 'helios') {
    this.credentials = credentials;
    this.model = model;
    this.client = new Reactor({ modelName: MODEL_NAMES[model] });
  }

  async connect(handlers?: OdysseyEventHandlers) {
    this.handlers = handlers;

    this.client.on('trackReceived', (name: string, track: MediaStreamTrack, stream?: MediaStream) => {
      if (name !== MAIN_VIDEO_TRACK) return;
      // Bind the SDK-managed MediaStream (the canonical, documented object) — a
      // hand-built `new MediaStream()` with the track added can fail to paint
      // frames in some browsers. Fall back to assembling one only if absent.
      if (stream) {
        this.stream = stream;
      } else if (!this.stream.getTracks().some((existing) => existing.id === track.id)) {
        this.stream.addTrack(track);
      }
      log('trackReceived:', name, '| tracks:', this.stream.getVideoTracks().length, '| usingSdkStream:', !!stream);
      // Show the live feed as soon as the track arrives (it appears during
      // "waiting"); readiness for commands is tracked separately.
      this.handlers?.onStream?.(this.stream);
      this.checkReady();
    });

    this.client.on('statusChanged', (status: ReactorStatus) => {
      log('status:', status);
      if (status === 'ready') {
        this.markReady();
      } else {
        this.isReady = false;
        this.connectedNotified = false;
        handlers?.onStatusChange?.(status);
      }
    });

    this.client.on('message', (msg: { type?: string; data?: Record<string, unknown> }) => {
      switch (msg.type) {
        case 'conditions_ready': {
          log('conditions_ready:', msg.data);
          const hasPrompt = msg.data?.has_prompt === true;
          const hasImage = msg.data?.has_image === true;
          // Release any startStream waiting to send `start`, once its required
          // conditioning is committed by the model.
          this.conditionWaiters = this.conditionWaiters.filter((w) => {
            if (hasPrompt && (!w.requireImage || hasImage)) {
              w.done();
              return false;
            }
            return true;
          });
          return;
        }
        case 'image_accepted': {
          log('image_accepted');
          const acceptedWaiters = this.imageAcceptedWaiters;
          this.imageAcceptedWaiters = [];
          acceptedWaiters.forEach((w) => w());
          return;
        }
        case 'generation_started':
          log('generation_started:', msg.data);
          this.markGenerationStarted();
          return;
        case 'chunk_complete':
          // First completed chunk = video is genuinely flowing.
          this.markGenerationStarted();
          return;
        case 'prompt_accepted':
          if (typeof msg.data?.prompt === 'string') {
            this.activePrompt = msg.data.prompt;
            this.handlers?.onInteractAcknowledged?.(msg.data.prompt);
          }
          return;
        case 'command_error':
          console.warn('[helios] command_error:', msg.data);
          this.handlers?.onStreamError?.(
            String(msg.data?.command ?? 'command_error'),
            String(msg.data?.reason ?? 'Helios command failed.'),
          );
          return;
        default:
          return;
      }
    });

    this.client.on('runtimeMessage', (msg: { type?: string; data?: { message?: string } }) => {
      if (msg.type === 'moderation') {
        this.handlers?.onStreamError?.('moderation_failed', msg.data?.message ?? 'Prompt blocked by moderation.');
      }
    });

    this.client.on('error', (err: unknown) => {
      const e = err as { name?: string; code?: string; recoverable?: boolean; message?: string };
      // Recoverable/transient errors (NOT_READY races, aborted teardown) are
      // noise — log them but don't surface a fatal error to the UI.
      if (e?.name === 'AbortError' || e?.recoverable) {
        log('recoverable error (ignored):', e?.code ?? e?.name, '-', e?.message);
        return;
      }
      console.error('[helios] error:', err);
      this.handlers?.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    try {
      await this.client.connect(this.credentials.jwt);
    } catch (err) {
      // Aborted while a teardown raced the handshake — expected, not fatal.
      if ((err as { name?: string })?.name === 'AbortError') return;
      throw err;
    }
    log('connect() resolved, status =', this.client.getStatus());
    this.checkReady();
    this.startReadyPoll();
  }

  // ─── Readiness ────────────────────────────────────────────────────────────

  /** Resolves true once the session is "ready", false if it times out/disconnects. */
  private whenReady(): Promise<boolean> {
    if (this.isReady) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, READY_TIMEOUT_MS);
      const waiter = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.readyWaiters.push(waiter);
    });
  }

  /** Promote to ready if the SDK reports "ready" (event may have been skipped). */
  private checkReady() {
    if (this.isReady) return;
    if (this.client.getStatus() === 'ready') this.markReady();
  }

  private markReady() {
    if (this.isReady) return;
    this.isReady = true;
    this.stopReadyPoll();
    log('session ready');
    this.notifyConnected();
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    waiters.forEach((w) => w(true));
  }

  private startReadyPoll() {
    this.stopReadyPoll();
    this.readyPollTimer = setInterval(() => {
      const status = this.client.getStatus();
      if (this.isReady || status === 'disconnected') {
        this.stopReadyPoll();
        return;
      }
      this.checkReady();
    }, READY_POLL_INTERVAL_MS);
  }

  private stopReadyPoll() {
    if (this.readyPollTimer) {
      clearInterval(this.readyPollTimer);
      this.readyPollTimer = null;
    }
  }

  // ─── Generation ─────────────────────────────────────────────────────────────

  private markGenerationStarted() {
    if (this.generationStarted) return;
    this.generationStarted = true;
    this.handlers?.onStreamStarted?.(this.credentials.sessionId);
  }

  // Re-send set_image_strength every 30 s to counteract diffusion drift.
  // Each set_prompt call nudges the model away from the reference image; this
  // keeps pulling it back without triggering a visible stream restart.
  private startAnchorTimer() {
    this.stopAnchorTimer();
    if (!this.hasReferenceImage || this.model !== 'helios') return;
    this.anchorTimer = setInterval(() => {
      if (!this.isReady) return;
      this.client.sendCommand('set_image_strength', { image_strength: 0.92 }).catch(() => undefined);
    }, 10_000);
  }

  private stopAnchorTimer() {
    if (this.anchorTimer) {
      clearInterval(this.anchorTimer);
      this.anchorTimer = null;
    }
  }

  /**
   * Resolve once the model confirms (via `conditions_ready`) that the prompt
   * — and the image, if one was sent — is committed for chunk 0. `start` is
   * rejected with "No prompt set" if it reaches the model before this, because
   * awaiting sendCommand only confirms send, not model-side processing. Falls
   * back after a short wait so a missed message can't hang the start.
   */
  private waitForConditions(requireImage: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter = { requireImage, done: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        this.conditionWaiters = this.conditionWaiters.filter((w) => w !== waiter);
        log('conditions_ready not seen in time — sending start anyway');
        resolve();
      }, 4000);
      this.conditionWaiters.push(waiter);
    });
  }

  /** Waits for LingBot's image_accepted confirmation before calling start. */
  private waitForImageAccepted(): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.imageAcceptedWaiters = this.imageAcceptedWaiters.filter((w) => w !== waiter);
        log('image_accepted not seen in time — sending start anyway');
        resolve();
      }, 8000);
      this.imageAcceptedWaiters.push(waiter);
    });
  }

  /**
   * Start generation. Waits for the session to be "ready", then sets the first
   * chunk's conditioning and starts.
   *
   * Helios: atomic set_conditioning (image+prompt) → conditions_ready → start.
   * LingBot: set_image → set_prompt → image_accepted → start.
   */
  async startStream(options?: { prompt?: string; portrait?: boolean; image?: File | Blob; broadcast?: boolean }) {
    const prompt = options?.prompt?.trim() || DEFAULT_PROMPT;
    this.activePrompt = prompt;

    log('startStream — waiting for ready (model:', this.model, '| status:', this.client.getStatus(), '| prompt:', JSON.stringify(prompt), '| hasImage:', !!options?.image, ')');
    const ready = await this.whenReady();
    if (!ready) {
      throw new Error('Session never became ready (timed out). The avatar pool may be busy — please retry.');
    }

    if (this.model === 'lingbot') {
      // LingBot protocol: separate set_image + set_prompt, then wait for image_accepted
      if (options?.image) {
        const imageRef = await this.client.uploadFile(options.image);
        await this.client.sendCommand('set_image', { image: imageRef });
        log('set_image sent');
      }
      await this.client.sendCommand('set_prompt', { prompt });
      log('set_prompt sent — awaiting image_accepted');
      if (options?.image) {
        await this.waitForImageAccepted();
      }
      await this.client.sendCommand('start', {});
      log('start sent — generation requested');
      this.markGenerationStarted();
      return;
    }

    // Helios protocol: atomic set_conditioning (image+prompt), then conditions_ready
    const hasImage = !!options?.image;
    this.hasReferenceImage = hasImage;
    if (options?.image) {
      // Atomic image+prompt for chunk 0 — the docs warn that sending set_image
      // and set_prompt separately before start races and the image lands late.
      const image = await this.client.uploadFile(options.image);
      await this.client.sendCommand('set_conditioning', { prompt, image });
      log('set_conditioning sent — awaiting conditions_ready');
      // Start high; the periodic anchor timer keeps this at 0.92 as the stream matures.
      await this.client.sendCommand('set_image_strength', { image_strength: 0.92 }).catch(() => undefined);
    } else {
      await this.client.sendCommand('set_prompt', { prompt });
      log('set_prompt sent — awaiting conditions_ready');
    }

    // 2× super-resolution — applies to every chunk from the first frame onwards.
    await this.client.sendCommand('set_sr_scale', { sr_scale: '2x' }).catch(() => undefined);
    log('set_sr_scale 2x sent');

    // Gate `start` on the model confirming the prompt (and image) are committed,
    // otherwise start is rejected with "No prompt set. Call set_prompt first."
    await this.waitForConditions(hasImage);

    await this.client.sendCommand('start', {});
    log('start sent — generation requested');

    // generation_started / chunk_complete will fire onStreamStarted; flip
    // optimistically too so the UI doesn't wait on a message that may lag.
    this.markGenerationStarted();
    // Begin periodic re-anchoring to resist drift over long sessions.
    this.startAnchorTimer();
  }

  get lastAppliedPrompt(): string | null {
    return this.activePrompt;
  }

  async interact(prompt: string) {
    const nextPrompt = prompt.trim();
    if (!nextPrompt) return;
    // Commands are only accepted when "ready"; wait if a reconnect is in flight.
    if (!this.isReady) {
      const ok = await this.whenReady();
      if (!ok) return;
    }
    this.activePrompt = nextPrompt;
    // Re-assert image anchoring before every prompt so each new chunk starts
    // from the reference image, not from the accumulated drift of prior chunks.
    if (this.hasReferenceImage && this.model === 'helios') {
      await this.client.sendCommand('set_image_strength', { image_strength: 0.92 }).catch(() => undefined);
    }
    await this.client.sendCommand('set_prompt', { prompt: nextPrompt });
    this.handlers?.onInteractAcknowledged?.(nextPrompt);
  }

  async endStream() {
    this.stopAnchorTimer();
    this.generationStarted = false;
    // Only reset when the session can accept commands. Sending `reset` while
    // status is "waiting"/"connecting" triggers a NOT_READY error.
    if (this.isReady && this.client.getStatus() === 'ready') {
      await this.client.sendCommand('reset', {}).catch(() => undefined);
    }
    this.handlers?.onStreamEnded?.();
  }

  async disconnect() {
    this.stopAnchorTimer();
    this.connectedNotified = false;
    this.isReady = false;
    this.stopReadyPoll();
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    waiters.forEach((w) => w(false));
    this.conditionWaiters.forEach((w) => w.done());
    this.conditionWaiters = [];
    this.imageAcceptedWaiters.forEach((w) => w());
    this.imageAcceptedWaiters = [];
    try {
      await this.client.disconnect();
    } catch {
      // AbortError when tearing down an in-flight connection — expected.
    }
  }

  private notifyConnected() {
    if (this.connectedNotified) return;
    this.connectedNotified = true;
    this.handlers?.onStatusChange?.('connected');
    this.handlers?.onConnected?.(this.stream);
  }
}

export function credentialsFromDict(value: unknown): ClientCredentials {
  const dict = value as { jwt?: unknown; sessionId?: unknown };
  if (typeof dict?.jwt !== 'string' || !dict.jwt) {
    throw new Error('Missing Reactor JWT in token response.');
  }
  return {
    jwt: dict.jwt,
    sessionId: typeof dict.sessionId === 'string' ? dict.sessionId : undefined,
  };
}

export async function loadImageFile(url: string, name = 'slide-image') {
  const response = await fetch(encodeURI(url));
  if (!response.ok) {
    throw new Error(`Failed to load image: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    const sizeMb = (blob.size / (1024 * 1024)).toFixed(2);
    throw new Error(`Image is too large (${sizeMb} MB). Max is 25 MB.`);
  }
  const type = blob.type || 'image/png';
  return new File([blob], name, { type });
}
