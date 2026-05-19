export interface WebRTCStatsSnapshot {
  timestamp: number;
  bitrate: number;
  jitter: number;
  packetLossRate: number;
  roundTripTime: number;
  framesPerSecond: number;
  framesDropped: number;
  frameDropRate: number;
  resolution: { width: number; height: number };
  iceState: RTCIceConnectionState;
  connectionState: RTCPeerConnectionState;
}

export type AnomalySeverity = 'warning' | 'critical';

export interface Anomaly {
  timestamp: number;
  metric: string;
  value: number;
  threshold: number;
  severity: AnomalySeverity;
}

export interface SelectedCandidatePair {
  localType: string;
  remoteType: string;
  protocol: string;
  relayProtocol?: string;
  localAddress?: string;
  remoteAddress?: string;
}

export interface CollectorContext {
  sessionId?: string;
  streamId?: string;
  route?: string;
}

type AnomalyCallback = (anomaly: Anomaly) => void;

const MAX_HISTORY = 1800;

let activeCollector: WebRTCStatsCollector | null = null;

export function getActiveStatsCollector(): WebRTCStatsCollector | null {
  return activeCollector;
}

export class WebRTCStatsCollector {
  private pc: RTCPeerConnection;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: WebRTCStatsSnapshot[] = [];
  private anomalies: Anomaly[] = [];
  private prevBytesReceived = 0;
  private prevTimestamp = 0;
  private prevPacketsLost = 0;
  private prevPacketsReceived = 0;
  private prevFramesDropped = 0;
  private prevFramesDecoded = 0;
  private bitrateWindow: number[] = [];
  private anomalyCallbacks: AnomalyCallback[] = [];
  private _anomalyCount = 0;
  private context: CollectorContext = {};
  private startedAt = Date.now();
  private firstAnomalyAt: number | null = null;
  private selectedPair: SelectedCandidatePair | null = null;

  constructor(pc: RTCPeerConnection, intervalMs = 2000, context: CollectorContext = {}) {
    this.pc = pc;
    this.intervalMs = intervalMs;
    this.context = { ...context };
  }

  setContext(context: Partial<CollectorContext>) {
    this.context = { ...this.context, ...context };
  }

  getContext(): Readonly<CollectorContext> {
    return this.context;
  }

  getSelectedPair(): SelectedCandidatePair | null {
    return this.selectedPair;
  }

  get anomalyCount() {
    return this._anomalyCount;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    activeCollector = this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (activeCollector === this) activeCollector = null;
  }

  getLatestStats(): WebRTCStatsSnapshot | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  getHistory(): readonly WebRTCStatsSnapshot[] {
    return this.history;
  }

  exportJSON(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      context: this.context,
      selectedPair: this.selectedPair,
      snapshotCount: this.history.length,
      anomalyCount: this._anomalyCount,
      anomalies: this.anomalies,
      snapshots: this.history,
    }, null, 2);
  }

  buildSummary(): string {
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const recent = this.anomalies.filter((a) => a.timestamp >= fiveMinAgo);

    const byMetric = new Map<string, { warnings: number; critical: number; worst: number }>();
    for (const a of recent) {
      const entry = byMetric.get(a.metric) ?? { warnings: 0, critical: 0, worst: 0 };
      if (a.severity === 'critical') entry.critical++;
      else entry.warnings++;
      // "worst" depends on metric direction; FPS is worst-when-low
      const isLowBad = a.metric === 'framesPerSecond' || a.metric === 'bitrateDrop';
      if (isLowBad) {
        entry.worst = entry.worst === 0 ? a.value : Math.min(entry.worst, a.value);
      } else {
        entry.worst = Math.max(entry.worst, a.value);
      }
      byMetric.set(a.metric, entry);
    }

    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const conn = (nav as any)?.connection;
    const date = new Date();
    const tzOffsetMin = -date.getTimezoneOffset();
    const tzSign = tzOffsetMin >= 0 ? '+' : '-';
    const tzAbs = Math.abs(tzOffsetMin);
    const tzLabel = `UTC${tzSign}${String(Math.floor(tzAbs / 60)).padStart(2, '0')}:${String(tzAbs % 60).padStart(2, '0')}`;

    const lines: string[] = [];
    lines.push('Interact Studio — WebRTC issue report');
    lines.push(`Time (local): ${date.toLocaleString()} (${tzLabel})`);
    lines.push(`Time (UTC):   ${date.toISOString()}`);
    lines.push(`Session start: ${new Date(this.startedAt).toISOString()} (${Math.round((now - this.startedAt) / 1000)}s ago)`);
    lines.push(`Route:        ${this.context.route ?? (typeof location !== 'undefined' ? location.pathname : 'unknown')}`);
    lines.push(`URL:          ${typeof location !== 'undefined' ? location.href : 'unknown'}`);
    lines.push(`User agent:   ${nav?.userAgent ?? 'unknown'}`);
    lines.push(`Platform:     ${(nav as any)?.userAgentData?.platform ?? nav?.platform ?? 'unknown'}`);
    if (conn) {
      lines.push(`Network:      ${conn.effectiveType ?? '?'}, downlink=${conn.downlink ?? '?'} Mbps, rtt=${conn.rtt ?? '?'} ms${conn.saveData ? ', save-data' : ''}`);
    } else {
      lines.push('Network:      (navigator.connection unavailable)');
    }
    lines.push('');
    lines.push(`Odyssey session id: ${this.context.sessionId ?? '(not set)'}`);
    lines.push(`Odyssey stream id:  ${this.context.streamId ?? '(not started)'}`);
    if (this.selectedPair) {
      const p = this.selectedPair;
      const relay = p.relayProtocol ? ` via ${p.relayProtocol.toUpperCase()}` : '';
      lines.push(`Selected ICE pair:  ${p.localType} → ${p.remoteType} (${p.protocol}${relay})`);
      if (p.localAddress || p.remoteAddress) {
        lines.push(`  local=${p.localAddress ?? '?'}  remote=${p.remoteAddress ?? '?'}`);
      }
    } else {
      lines.push('Selected ICE pair:  (not yet nominated)');
    }
    lines.push(`ICE connection state: ${this.pc.iceConnectionState}`);
    lines.push(`PC connection state:  ${this.pc.connectionState}`);
    lines.push('');
    lines.push('Anomalies (last 5 min):');
    if (recent.length === 0) {
      lines.push('  (none)');
    } else {
      const formatWorst = (metric: string, worst: number) => {
        if (metric === 'packetLossRate') return `worst ${worst.toFixed(2)}%`;
        if (metric === 'jitter' || metric === 'roundTripTime') return `worst ${worst.toFixed(0)} ms`;
        if (metric === 'framesPerSecond') return `worst ${worst.toFixed(0)} fps`;
        if (metric === 'bitrateDrop') return `worst ${worst.toFixed(0)} kbps`;
        return `worst ${worst.toFixed(2)}`;
      };
      for (const [metric, e] of byMetric) {
        const critPart = e.critical > 0 ? `, ${e.critical} critical` : '';
        lines.push(`  ${metric}: ${e.warnings} warnings${critPart} (${formatWorst(metric, e.worst)})`);
      }
    }
    if (this.firstAnomalyAt !== null) {
      const offsetSec = Math.round((this.firstAnomalyAt - this.startedAt) / 1000);
      lines.push(`First anomaly at: t+${offsetSec}s (${new Date(this.firstAnomalyAt).toISOString()})`);
    }
    lines.push(`Total anomalies (session): ${this._anomalyCount}`);
    lines.push(`Snapshots collected: ${this.history.length}`);
    const last = this.getLatestStats();
    if (last) {
      lines.push('');
      lines.push('Latest sample:');
      lines.push(`  bitrate=${last.bitrate.toFixed(0)} kbps  pktLoss=${last.packetLossRate.toFixed(2)}%  jitter=${last.jitter.toFixed(0)}ms  rtt=${last.roundTripTime.toFixed(0)}ms  fps=${last.framesPerSecond.toFixed(0)}  res=${last.resolution.width}x${last.resolution.height}`);
    }
    return lines.join('\n');
  }

  onAnomaly(callback: AnomalyCallback) {
    this.anomalyCallbacks.push(callback);
  }

  private emitAnomaly(metric: string, value: number, threshold: number, severity: AnomalySeverity) {
    this._anomalyCount++;
    const anomaly: Anomaly = { timestamp: Date.now(), metric, value, threshold, severity };
    this.anomalies.push(anomaly);
    if (this.firstAnomalyAt === null) this.firstAnomalyAt = anomaly.timestamp;
    const label = severity === 'critical' ? '🔴 CRITICAL' : '🟡 WARNING';
    console.warn(`[WebRTC-Diag] ${label} ${metric}: ${value.toFixed(2)} (threshold: ${threshold})`);
    for (const cb of this.anomalyCallbacks) cb(anomaly);
  }

  private async poll() {
    if (this.pc.connectionState === 'closed') {
      this.stop();
      return;
    }

    try {
      const stats = await this.pc.getStats();
      const now = Date.now();
      const snap = this.buildSnapshot(stats, now);
      if (!snap) return;

      this.history.push(snap);
      if (this.history.length > MAX_HISTORY) {
        this.history.splice(0, this.history.length - MAX_HISTORY);
      }

      this.checkAnomalies(snap);
    } catch {
      // pc may have been closed between check and getStats
    }
  }

  private buildSnapshot(stats: RTCStatsReport, now: number): WebRTCStatsSnapshot | null {
    let bytesReceived = 0;
    let jitter = 0;
    let packetsLost = 0;
    let packetsReceived = 0;
    let framesDecoded = 0;
    let framesDropped = 0;
    let framesPerSecond = 0;
    let frameWidth = 0;
    let frameHeight = 0;
    let roundTripTime = 0;
    let foundVideo = false;
    let selectedPairId: string | null = null;
    const candidates = new Map<string, RTCIceCandidatePairStats | any>();
    const localCands = new Map<string, any>();
    const remoteCands = new Map<string, any>();

    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        foundVideo = true;
        bytesReceived = report.bytesReceived ?? 0;
        jitter = report.jitter ?? 0;
        packetsLost = report.packetsLost ?? 0;
        packetsReceived = report.packetsReceived ?? 0;
        framesDecoded = report.framesDecoded ?? 0;
        framesDropped = report.framesDropped ?? 0;
        framesPerSecond = report.framesPerSecond ?? 0;
        frameWidth = report.frameWidth ?? 0;
        frameHeight = report.frameHeight ?? 0;
      }

      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        roundTripTime = report.currentRoundTripTime ?? 0;
        if ((report as any).nominated || (report as any).selected) {
          selectedPairId = report.id;
        }
        candidates.set(report.id, report);
      }

      if (report.type === 'local-candidate') localCands.set(report.id, report);
      if (report.type === 'remote-candidate') remoteCands.set(report.id, report);
    });

    if (selectedPairId) {
      const pair = candidates.get(selectedPairId) as any;
      if (pair) {
        const local = localCands.get(pair.localCandidateId);
        const remote = remoteCands.get(pair.remoteCandidateId);
        this.selectedPair = {
          localType: local?.candidateType ?? 'unknown',
          remoteType: remote?.candidateType ?? 'unknown',
          protocol: local?.protocol ?? 'unknown',
          relayProtocol: local?.relayProtocol,
          localAddress: local?.address,
          remoteAddress: remote?.address,
        };
      }
    }

    if (!foundVideo) return null;

    const deltaTime = this.prevTimestamp ? (now - this.prevTimestamp) / 1000 : 0;
    const deltaBytes = bytesReceived - this.prevBytesReceived;
    const bitrate = deltaTime > 0 && this.prevTimestamp ? (deltaBytes * 8) / deltaTime / 1000 : 0;

    const deltaLost = packetsLost - this.prevPacketsLost;
    const deltaReceived = packetsReceived - this.prevPacketsReceived;
    const deltaTotal = deltaLost + deltaReceived;
    const packetLossRate = deltaTotal > 0 && this.prevTimestamp ? (deltaLost / deltaTotal) * 100 : 0;

    const deltaDropped = framesDropped - this.prevFramesDropped;
    const deltaDecoded = framesDecoded - this.prevFramesDecoded;
    const deltaFrameTotal = deltaDropped + deltaDecoded;
    const frameDropRate = deltaFrameTotal > 0 && this.prevTimestamp ? (deltaDropped / deltaFrameTotal) * 100 : 0;

    this.prevBytesReceived = bytesReceived;
    this.prevTimestamp = now;
    this.prevPacketsLost = packetsLost;
    this.prevPacketsReceived = packetsReceived;
    this.prevFramesDropped = framesDropped;
    this.prevFramesDecoded = framesDecoded;

    return {
      timestamp: now,
      bitrate,
      jitter: jitter * 1000, // convert to ms
      packetLossRate,
      roundTripTime: roundTripTime * 1000, // convert to ms
      framesPerSecond,
      framesDropped: deltaDropped,
      frameDropRate,
      resolution: { width: frameWidth, height: frameHeight },
      iceState: this.pc.iceConnectionState,
      connectionState: this.pc.connectionState,
    };
  }

  private checkAnomalies(snap: WebRTCStatsSnapshot) {
    if (snap.packetLossRate > 15) {
      this.emitAnomaly('packetLossRate', snap.packetLossRate, 15, 'critical');
    } else if (snap.packetLossRate > 5) {
      this.emitAnomaly('packetLossRate', snap.packetLossRate, 5, 'warning');
    }

    if (snap.jitter > 50) {
      this.emitAnomaly('jitter', snap.jitter, 50, 'warning');
    }

    if (snap.roundTripTime > 300) {
      this.emitAnomaly('roundTripTime', snap.roundTripTime, 300, 'warning');
    }

    if (snap.framesPerSecond > 0 && snap.framesPerSecond < 15) {
      this.emitAnomaly('framesPerSecond', snap.framesPerSecond, 15, 'warning');
    }

    // Bitrate drop detection
    this.bitrateWindow.push(snap.bitrate);
    if (this.bitrateWindow.length > 15) this.bitrateWindow.shift();
    if (this.bitrateWindow.length >= 5 && snap.bitrate > 0) {
      const avg = this.bitrateWindow.slice(0, -1).reduce((a, b) => a + b, 0) / (this.bitrateWindow.length - 1);
      if (avg > 0 && snap.bitrate < avg * 0.5) {
        this.emitAnomaly('bitrateDrop', snap.bitrate, avg * 0.5, 'warning');
      }
    }
  }
}
