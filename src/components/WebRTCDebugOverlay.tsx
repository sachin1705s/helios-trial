import { useEffect, useState, useRef } from 'react';
import { getFirstPeerConnection } from '../lib/webrtc-diagnostics';
import { WebRTCStatsCollector, getActiveStatsCollector } from '../lib/webrtc-stats-collector';
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
  const [, force] = useState(0);
  const collectorRef = useRef<WebRTCStatsCollector | null>(null);
  const ownsCollectorRef = useRef(false);

  useEffect(() => {
    if (!visible) return;

    // Prefer the collector created by useOdysseyStream (it has sessionId).
    // Fall back to creating our own only if no active collector exists yet.
    const discover = setInterval(() => {
      if (collectorRef.current) return;
      const active = getActiveStatsCollector();
      if (active) {
        collectorRef.current = active;
        ownsCollectorRef.current = false;
        force((n) => n + 1);
        return;
      }
      const pc = getFirstPeerConnection();
      if (pc) {
        const collector = new WebRTCStatsCollector(pc, 2000, {
          route: typeof location !== 'undefined' ? location.pathname : undefined,
        });
        collector.start();
        collectorRef.current = collector;
        ownsCollectorRef.current = true;
        force((n) => n + 1);
      }
    }, 1000);

    const refresh = setInterval(() => {
      if (collectorRef.current) {
        setSnap(collectorRef.current.getLatestStats());
      }
    }, 2000);

    return () => {
      clearInterval(discover);
      clearInterval(refresh);
      if (ownsCollectorRef.current) collectorRef.current?.stop();
      collectorRef.current = null;
      ownsCollectorRef.current = false;
    };
  }, [visible]);

  useEffect(() => {
    const handler = () => setVisible(isEnabled());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  if (!visible) return null;

  const collector = collectorRef.current;
  const ctx = collector?.getContext();
  const pair = collector?.getSelectedPair();

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

  const copySummary = () => {
    if (!collector) return;
    void navigator.clipboard.writeText(collector.buildSummary());
  };

  const copyText = (text: string | undefined) => {
    if (text) void navigator.clipboard.writeText(text);
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
          {(ctx?.sessionId || pair) && (
            <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'grid', gap: 2 }}>
              {ctx?.sessionId && (
                <ClickToCopyRow label="Session" value={ctx.sessionId} onCopy={() => copyText(ctx.sessionId)} />
              )}
              {ctx?.streamId && (
                <ClickToCopyRow label="Stream" value={ctx.streamId} onCopy={() => copyText(ctx.streamId)} />
              )}
              {pair && (
                <div style={{ display: 'flex', gap: 6, color: '#a3a3a3', fontSize: 10 }}>
                  <span>ICE:</span>
                  <span style={{ color: pair.localType === 'relay' || pair.remoteType === 'relay' ? '#eab308' : '#22c55e' }}>
                    {pair.localType}→{pair.remoteType} ({pair.protocol}{pair.relayProtocol ? `/${pair.relayProtocol}` : ''})
                  </span>
                </div>
              )}
            </div>
          )}
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

          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button onClick={copySummary} title="Compact text summary for sharing with Odyssey team" style={primaryBtnStyle}>
              Copy summary
            </button>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={exportStats} style={btnStyle}>
                Export JSON
              </button>
              <button
                onClick={() => {
                  if (collector) void navigator.clipboard.writeText(collector.exportJSON());
                }}
                style={btnStyle}
              >
                Copy JSON
              </button>
            </div>
            <div style={{ color: '#737373', fontSize: 10, marginTop: 4, lineHeight: 1.4 }}>
              Capture: open <code style={{ color: '#a3a3a3' }}>chrome://webrtc-internals</code>
              {' '}in a new tab, reproduce the issue, then click <b>Create Dump</b> there. Send that
              file together with the summary above.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  flex: 1,
  padding: '4px 8px',
  background: 'rgba(255,255,255,0.1)',
  color: '#e5e5e5',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
};

const primaryBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: 'rgba(34,197,94,0.18)',
  border: '1px solid rgba(34,197,94,0.4)',
  fontWeight: 600,
};

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <>
      <span style={{ color: '#a3a3a3' }}>{label}</span>
      <span style={{ color, textAlign: 'right' }}>{value}</span>
    </>
  );
}

function ClickToCopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  const short = value.length > 22 ? value.slice(0, 8) + '…' + value.slice(-8) : value;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10, color: '#a3a3a3' }}>
      <span>{label}</span>
      <button
        onClick={onCopy}
        title={`Click to copy: ${value}`}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#d4d4d4',
          fontFamily: 'inherit',
          fontSize: 10,
          cursor: 'pointer',
          padding: 0,
          textAlign: 'right',
        }}
      >
        {short} 📋
      </button>
    </div>
  );
}
