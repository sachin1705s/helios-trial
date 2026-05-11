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

type AnomalyCallback = (anomaly: Anomaly) => void;

const MAX_HISTORY = 1800;

export class WebRTCStatsCollector {
  private pc: RTCPeerConnection;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: WebRTCStatsSnapshot[] = [];
  private prevBytesReceived = 0;
  private prevTimestamp = 0;
  private prevPacketsLost = 0;
  private prevPacketsReceived = 0;
  private prevFramesDropped = 0;
  private prevFramesDecoded = 0;
  private bitrateWindow: number[] = [];
  private anomalyCallbacks: AnomalyCallback[] = [];
  private _anomalyCount = 0;

  constructor(pc: RTCPeerConnection, intervalMs = 2000) {
    this.pc = pc;
    this.intervalMs = intervalMs;
  }

  get anomalyCount() {
    return this._anomalyCount;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
      snapshotCount: this.history.length,
      anomalyCount: this._anomalyCount,
      snapshots: this.history,
    }, null, 2);
  }

  onAnomaly(callback: AnomalyCallback) {
    this.anomalyCallbacks.push(callback);
  }

  private emitAnomaly(metric: string, value: number, threshold: number, severity: AnomalySeverity) {
    this._anomalyCount++;
    const anomaly: Anomaly = { timestamp: Date.now(), metric, value, threshold, severity };
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
      }
    });

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
