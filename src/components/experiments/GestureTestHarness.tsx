import { useCallback, useEffect, useRef, useState } from 'react';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/helios';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';

const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. React expressively to the user\'s gestures and body language. Keep every reply under 20 words.';

const ALL_GESTURES = [
  'hello', 'thumbs_up', 'victory', 'namaste', 'pointing',
  'thinking', 'shrug', 'crossed_arms', 'leaning_forward',
  'leaning_back', 'facepalm', 'clapping',
];

// A/B prompt variations — {id, label, template} where {g} = gesture label (spaces)
// Note: gesture labels are noun/participle phrases ("thumbs up", "crossed arms",
// "leaning forward") so "The user is {g}" breaks for noun forms. Use "just did" or
// "is showing" framing so all labels read naturally.
const PROMPT_VARIANTS = [
  { id: 'A', label: 'Just did',   template: 'The user just did {g}. React to that gesture expressively in one sentence.' },
  { id: 'B', label: 'Showing',    template: 'The user is showing {g}. React to this body language expressively in one sentence.' },
  { id: 'C', label: 'Physical',   template: 'The user just did {g}. Match their energy with a physical reaction and one sentence.' },
  { id: 'D', label: 'Short',      template: 'The user just did {g}. React!' },
  { id: 'E', label: 'In-scene',   template: 'The person in front of you just did {g}. React as Einstein would in one sentence.' },
  { id: 'F', label: 'Imperative', template: '{G}! Respond physically and say something brief.' },
] as const;

type VariantId = typeof PROMPT_VARIANTS[number]['id'];
type Result = 'pass' | 'fail' | 'pending';
type ResultKey = `${string}::${VariantId}`;

export default function GestureTestHarness() {
  const { status, error, videoRef, startStream, interact, disconnect, connect } = useOdysseyStream();

  const [results, setResults]         = useState<Record<ResultKey, Result>>({} as Record<ResultKey, Result>);
  const [activeVariant, setActiveVariant] = useState<VariantId>('A');
  const [sending, setSending]         = useState(false);
  const [log, setLog]                 = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((msg: string) => {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // Log status changes
  useEffect(() => {
    addLog(`Status → ${status}${error ? `: ${error}` : ''}`);
  }, [status, error]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start stream once ready
  useEffect(() => {
    if (status !== 'ready') return;
    const run = async () => {
      addLog('Loading Einstein image…');
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: true });
      addLog('Stream started — Send buttons are active');
    };
    void run();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const [reconnecting, setReconnecting] = useState(false);

  const reconnect = useCallback(async () => {
    setReconnecting(true);
    addLog('Reconnecting…');
    try {
      await disconnect();
      await connect();
    } catch (err) {
      addLog(`Reconnect error: ${err}`);
    } finally {
      setReconnecting(false);
    }
  }, [disconnect, connect, addLog]);

  const sendGesture = useCallback(async (gesture: string) => {
    if (sending || status !== 'streaming') return;
    setSending(true);
    const variant = PROMPT_VARIANTS.find(v => v.id === activeVariant)!;
    const label = gesture.replace(/_/g, ' ');
    const prompt = variant.template
      .replace('{g}', label)
      .replace('{G}', label.charAt(0).toUpperCase() + label.slice(1));
    addLog(`[${variant.id}] "${prompt}"`);
    try {
      await interact(prompt);
    } catch (err) {
      addLog(`Error: ${err}`);
    } finally {
      setSending(false);
    }
  }, [sending, status, activeVariant, interact, addLog]);

  const markResult = useCallback((gesture: string, result: Result) => {
    const key = `${gesture}::${activeVariant}` as ResultKey;
    setResults(prev => ({ ...prev, [key]: result }));
    addLog(`[${activeVariant}] ${gesture} → ${result.toUpperCase()}`);
  }, [activeVariant, addLog]);

  const getResult = (gesture: string, variantId: VariantId): Result =>
    results[`${gesture}::${variantId}` as ResultKey] ?? 'pending';

  const exportResults = useCallback(() => {
    const lines = ['=== Gesture A/B Test Results ===', ''];
    PROMPT_VARIANTS.forEach(v => {
      const passed  = ALL_GESTURES.filter(g => getResult(g, v.id) === 'pass');
      const failed  = ALL_GESTURES.filter(g => getResult(g, v.id) === 'fail');
      lines.push(`Variant ${v.id} — "${v.label}" (${v.template})`);
      lines.push(`  PASS (${passed.length}): ${passed.join(', ') || 'none'}`);
      lines.push(`  FAIL (${failed.length}): ${failed.join(', ') || 'none'}`);
      lines.push('');
    });
    // Best variant = most passes
    const best = PROMPT_VARIANTS.map(v => ({
      v, passes: ALL_GESTURES.filter(g => getResult(g, v.id) === 'pass').length,
    })).sort((a, b) => b.passes - a.passes)[0];
    const bestGestures = ALL_GESTURES.filter(g => getResult(g, best.v.id) === 'pass');
    lines.push(`Best variant: ${best.v.id} (${best.passes} passes)`);
    lines.push(`const GESTURES = ${JSON.stringify(bestGestures)};`);
    const summary = lines.join('\n');
    addLog(summary);
    navigator.clipboard?.writeText(summary).then(() => addLog('Copied to clipboard'));
  }, [results, addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  const isStreaming = status === 'streaming';

  return (
    <div className="atrium" style={{
      height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
      background: 'var(--paper)',
    }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px',
        borderBottom: '1px solid var(--paper-edge)', flexShrink: 0,
        background: 'var(--paper)',
      }}>
        <span style={{ fontFamily: 'var(--display)', fontSize: '1rem', fontWeight: 600, color: 'var(--ink)' }}>
          Gesture Test Harness
        </span>
        <span style={{
          padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: '0.72rem',
          fontFamily: 'var(--body)', fontWeight: 600,
          background: isStreaming ? 'rgba(47,94,72,0.1)' : 'rgba(20,40,38,0.06)',
          color: isStreaming ? 'var(--moss)' : 'var(--ink-mute)',
          border: `1px solid ${isStreaming ? 'rgba(47,94,72,0.25)' : 'rgba(20,40,38,0.1)'}`,
        }}>
          {isStreaming ? '● LIVE' : status.toUpperCase()}
        </span>

        {/* Reconnect button */}
        <button onClick={() => void reconnect()} disabled={reconnecting} style={{
          padding: '4px 12px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
          fontFamily: 'var(--body)', fontSize: '0.72rem', fontWeight: 600,
          border: '1px solid rgba(20,40,38,0.2)',
          background: reconnecting ? 'rgba(20,40,38,0.06)' : 'var(--paper)',
          color: reconnecting ? 'var(--ink-mute)' : 'var(--ink)',
          opacity: reconnecting ? 0.6 : 1,
        }}>
          {reconnecting ? 'Reconnecting…' : '↺ Reconnect'}
        </button>

        {/* Variant selector */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {PROMPT_VARIANTS.map(v => (
            <button key={v.id} onClick={() => setActiveVariant(v.id)} style={{
              padding: '4px 10px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
              fontFamily: 'var(--body)', fontSize: '0.72rem', fontWeight: 600,
              border: '1px solid',
              borderColor: activeVariant === v.id ? 'var(--moss)' : 'rgba(20,40,38,0.15)',
              background: activeVariant === v.id ? 'var(--moss)' : 'transparent',
              color: activeVariant === v.id ? 'var(--paper)' : 'var(--ink)',
            }}>
              {v.id} — {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Active prompt preview */}
      <div style={{
        padding: '6px 16px', flexShrink: 0, fontSize: '0.75rem', fontFamily: 'var(--body)',
        color: 'var(--ink-mute)', borderBottom: '1px solid var(--paper-edge)',
        background: 'rgba(20,40,38,0.02)',
      }}>
        <strong style={{ color: 'var(--ink)' }}>Prompt [{activeVariant}]:</strong>{' '}
        {PROMPT_VARIANTS.find(v => v.id === activeVariant)?.template.replace('{g}', '<gesture>').replace('{G}', '<Gesture>')}
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Video */}
        <div style={{ flex: 1, background: 'var(--night)', position: 'relative' }}>
          <video ref={videoRef} autoPlay playsInline muted
            style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          {!isStreaming && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'rgba(245,241,232,0.5)',
              fontFamily: 'var(--body)', fontSize: '0.85rem',
            }}>
              {status === 'error' ? `Error: ${error}` : 'Connecting…'}
            </div>
          )}
        </div>

        {/* Right panel */}
        <div style={{
          width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderLeft: '1px solid var(--paper-edge)', overflow: 'hidden',
        }}>
          {/* Gesture list — scrollable */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ALL_GESTURES.map(gesture => {
              const r = getResult(gesture, activeVariant);
              return (
                <div key={gesture} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 10px', borderRadius: 'var(--radius-sm)',
                  border: `1.5px solid ${r === 'pass' ? 'rgba(47,94,72,0.3)' : r === 'fail' ? 'rgba(217,73,43,0.25)' : 'rgba(20,40,38,0.08)'}`,
                  background: r === 'pass' ? 'rgba(47,94,72,0.05)' : r === 'fail' ? 'rgba(217,73,43,0.05)' : 'transparent',
                }}>
                  <span style={{ flex: 1, fontFamily: 'var(--body)', fontSize: '0.82rem', fontWeight: 500, color: 'var(--ink)', textTransform: 'capitalize' }}>
                    {gesture.replace(/_/g, ' ')}
                  </span>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 700, fontFamily: 'var(--body)',
                    color: r === 'pass' ? 'var(--moss)' : r === 'fail' ? 'var(--clay)' : 'var(--ink-mute)',
                    minWidth: 44, textAlign: 'center',
                  }}>
                    {r.toUpperCase()}
                  </span>
                  <button onClick={() => sendGesture(gesture)} disabled={sending || !isStreaming}
                    style={{
                      padding: '3px 8px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
                      border: '1px solid rgba(20,40,38,0.15)', background: 'var(--paper)',
                      fontFamily: 'var(--body)', fontSize: '0.7rem', fontWeight: 600, color: 'var(--ink)',
                      opacity: (sending || !isStreaming) ? 0.4 : 1,
                    }}>Send</button>
                  <button onClick={() => markResult(gesture, 'pass')}
                    style={{
                      padding: '3px 8px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
                      border: '1px solid rgba(47,94,72,0.3)', fontFamily: 'var(--body)',
                      fontSize: '0.7rem', fontWeight: 600,
                      background: r === 'pass' ? 'var(--moss)' : 'transparent',
                      color: r === 'pass' ? 'var(--paper)' : 'var(--moss)',
                    }}>✓</button>
                  <button onClick={() => markResult(gesture, 'fail')}
                    style={{
                      padding: '3px 8px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
                      border: '1px solid rgba(217,73,43,0.25)', fontFamily: 'var(--body)',
                      fontSize: '0.7rem', fontWeight: 600,
                      background: r === 'fail' ? 'var(--clay)' : 'transparent',
                      color: r === 'fail' ? 'var(--paper)' : 'var(--clay)',
                    }}>✗</button>
                </div>
              );
            })}
            <button onClick={exportResults} style={{
              marginTop: 4, padding: '10px', borderRadius: 'var(--radius-pill)',
              border: 'none', background: 'var(--ink)', color: 'var(--paper)',
              fontFamily: 'var(--body)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
            }}>Export Results</button>
          </div>

          {/* Log — fixed height, always visible */}
          <div ref={logRef} style={{
            height: 140, flexShrink: 0, overflowY: 'auto',
            borderTop: '1px solid var(--paper-edge)',
            background: 'var(--night)', padding: '6px 10px',
            fontFamily: 'monospace', fontSize: '0.68rem', lineHeight: 1.6,
            color: 'rgba(245,241,232,0.65)',
          }}>
            {log.length === 0
              ? <span style={{ opacity: 0.4 }}>No activity yet…</span>
              : log.map((line, i) => <div key={i}>{line}</div>)
            }
          </div>
        </div>
      </div>
    </div>
  );
}
