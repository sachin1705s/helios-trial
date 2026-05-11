import { useEffect, useState, useRef } from 'react';
import { getFirstPeerConnection } from '../lib/webrtc-diagnostics';
import { WebRTCStatsCollector } from '../lib/webrtc-stats-collector';
import type { WebRTCStatsSnapshot } from '../lib/webrtc-stats-collector';

function isEnabled() {
  return (
    localStorage.getItem('webrtc_debug') === 'true' ||
    new URLSearchParams(window.location.search).has('webrtc_debug')
  );
}

function severity(value: number, warn: number, crit?: number): string {
  if (crit !== undefined && value >= crit) return '#ef4444';
  if (value >= warn) return '#eab308';
  return '#22c55e';
}

function severityLow(value: number, warn: number): string {
  if (value > 0 && value < warn) return '#eab308';
  return '#22c55e';
}

export default function WebRTCDebugOverlay() {
  const [snap, setSnap] = useState<WebRTCStatsSnapshot | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(isEnabled);
  const collectorRef = useRef<WebRTCStatsCollector | null>(null);

  useEffect(() => {
    if (!visible) return;

    // Poll for an active PeerConnection (it may not exist yet)
    const discover = setInterval(() => {
      if (collectorRef.current) return;
      const pc = getFirstPeerConnection();
      if (pc) {
        const collector = new WebRTCStatsCollector(pc);
        collector.start();
        collectorRef.current = collector;
      }
    }, 2000);

    const refresh = setInterval(() => {
      if (collectorRef.current) {
        setSnap(collectorRef.current.getLatestStats());
      }
    }, 2000);

    return () => {
      clearInterval(discover);
      clearInterval(refresh);
      collectorRef.current?.stop();
      collectorRef.current = null;
    };
  }, [visible]);

  useEffect(() => {
    const handler = () => setVisible(isEnabled());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  if (!visible) return null;

  const collector = collectorRef.current;

  const exportStats = () => {
    if (!collector) return;
    const json = collector.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webrtc-stats-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: collapsed ? 180 : 280,
        background: 'rgba(0, 0, 0, 0.85)',
        color: '#e5e5e5',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        borderRadius: 8,
        overflow: 'hidden',
        zIndex: 99999,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.05)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span style={{ fontWeight: 600, letterSpacing: 0.5 }}>WebRTC Diag</span>
        <span>{collapsed ? '▲' : '▼'}</span>
      </div>

      {!collapsed && (
        <div style={{ padding: '8px 10px' }}>
          {!snap ? (
            <div style={{ color: '#a3a3a3' }}>Waiting for stats...</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 12px' }}>
              <Row label="Bitrate" value={`${snap.bitrate.toFixed(0)} kbps`} color="#22c55e" />
              <Row
                label="Pkt Loss"
                value={`${snap.packetLossRate.toFixed(1)}%`}
                color={severity(snap.packetLossRate, 5, 15)}
              />
              <Row
                label="Jitter"
                value={`${snap.jitter.toFixed(1)} ms`}
                color={severity(snap.jitter, 50)}
              />
              <Row
                label="RTT"
                value={`${snap.roundTripTime.toFixed(0)} ms`}
                color={severity(snap.roundTripTime, 300)}
              />
              <Row
                label="FPS"
                value={`${snap.framesPerSecond.toFixed(0)}`}
                color={severityLow(snap.framesPerSecond, 15)}
              />
              <Row
                label="Drops"
                value={`${snap.framesDropped}`}
                color={snap.framesDropped > 5 ? '#eab308' : '#22c55e'}
              />
              <Row
                label="Res"
                value={`${snap.resolution.width}×${snap.resolution.height}`}
                color="#a3a3a3"
              />
              <Row label="ICE" value={snap.iceState} color="#a3a3a3" />
            </div>
          )}

          <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
            <button
              onClick={exportStats}
              style={{
                flex: 1,
                padding: '4px 8px',
                background: 'rgba(255,255,255,0.1)',
                color: '#e5e5e5',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'inherit',
              }}
            >
              Export JSON
            </button>
            <button
              onClick={() => {
                if (collector) void navigator.clipboard.writeText(collector.exportJSON());
              }}
              style={{
                flex: 1,
                padding: '4px 8px',
                background: 'rgba(255,255,255,0.1)',
                color: '#e5e5e5',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'inherit',
              }}
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <>
      <span style={{ color: '#a3a3a3' }}>{label}</span>
      <span style={{ color, textAlign: 'right' }}>{value}</span>
    </>
  );
}
