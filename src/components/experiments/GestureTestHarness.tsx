import { useCallback, useEffect, useRef, useState } from 'react';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/odyssey';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';

const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. React expressively to the user\'s gestures and body language. Keep every reply under 20 words.';

const ALL_GESTURES = [
  'hello',
  'thumbs_up',
  'victory',
  'namaste',
  'pointing',
  'thinking',
  'shrug',
  'crossed_arms',
  'leaning_forward',
  'leaning_back',
  'facepalm',
  'clapping',
];

type Result = 'pass' | 'fail' | 'pending';

export default function GestureTestHarness() {
  const { status, error, videoRef, startStream, interact, disconnect } = useOdysseyStream();

  const [results, setResults] = useState<Record<string, Result>>(() =>
    Object.fromEntries(ALL_GESTURES.map(g => [g, 'pending' as Result]))
  );
  const [current, setCurrent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] Status: ${status}${error ? ` — ${error}` : ''}`]);
  }, [status, error]);

  useEffect(() => {
    if (status !== 'ready') return;
    const run = async () => {
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: true });
    };
    void run();
  }, [status, startStream]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const addLog = useCallback((msg: string) => {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const sendGesture = useCallback(async (gesture: string) => {
    if (sending) return;
    setSending(true);
    setCurrent(gesture);
    const label = gesture.replace(/_/g, ' ');
    const prompt = `The user is ${label}. React to this body language expressively in one sentence.`;
    addLog(`Sending: "${prompt}"`);
    try {
      await interact(prompt);
      addLog(`Sent "${gesture}" — watch Einstein's reaction`);
    } catch (err) {
      addLog(`Error sending "${gesture}": ${err}`);
    } finally {
      setSending(false);
    }
  }, [sending, interact, addLog]);

  const markResult = useCallback((gesture: string, result: Result) => {
    setResults(prev => ({ ...prev, [gesture]: result }));
    addLog(`Marked "${gesture}" as ${result.toUpperCase()}`);
  }, [addLog]);

  const exportResults = useCallback(() => {
    const passed = ALL_GESTURES.filter(g => results[g] === 'pass');
    const failed = ALL_GESTURES.filter(g => results[g] === 'fail');
    const pending = ALL_GESTURES.filter(g => results[g] === 'pending');
    const summary = [
      '=== Gesture Test Results ===',
      '',
      `PASS (${passed.length}): ${passed.join(', ') || 'none'}`,
      `FAIL (${failed.length}): ${failed.join(', ') || 'none'}`,
      `UNTESTED (${pending.length}): ${pending.join(', ') || 'none'}`,
      '',
      'Array for live version:',
      `const GESTURES = ${JSON.stringify(passed, null, 2)};`,
    ].join('\n');
    addLog(summary);
    navigator.clipboard?.writeText(summary).then(() => addLog('Copied to clipboard'));
  }, [results, addLog]);

  return (
    <div className="atrium" style={{ minHeight: '100vh', background: 'var(--paper)', display: 'flex' }}>
      {/* Video panel */}
      <div style={{ flex: 1, background: 'var(--night)', position: 'relative', minHeight: '100vh' }}>
        <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        {status !== 'streaming' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--paper)', fontFamily: 'var(--body)', fontSize: '0.9rem', opacity: 0.6,
          }}>
            {status === 'connecting' ? 'Connecting to Odyssey…' :
             status === 'ready' ? 'Starting stream…' :
             status === 'error' ? `Error: ${error}` : 'Initializing…'}
          </div>
        )}
      </div>

      {/* Test panel */}
      <aside style={{
        width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid var(--paper-edge)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--paper-edge)',
          fontFamily: 'var(--display)', fontSize: '1.2rem', fontWeight: 600, color: 'var(--ink)',
        }}>
          Gesture Test Harness
        </div>

        {/* Gesture list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ALL_GESTURES.map(gesture => {
              const r = results[gesture];
              const isCurrent = current === gesture;
              return (
                <div key={gesture} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                  border: `1.5px solid ${isCurrent ? 'var(--moss)' : r === 'pass' ? 'rgba(47,94,72,0.3)' : r === 'fail' ? 'rgba(217,73,43,0.3)' : 'rgba(20,40,38,0.08)'}`,
                  background: r === 'pass' ? 'rgba(47,94,72,0.06)' : r === 'fail' ? 'rgba(217,73,43,0.06)' : 'transparent',
                  transition: 'all 0.2s',
                }}>
                  {/* Gesture name */}
                  <span style={{
                    flex: 1, fontFamily: 'var(--body)', fontSize: '0.85rem', fontWeight: 500,
                    color: 'var(--ink)', textTransform: 'capitalize',
                  }}>
                    {gesture.replace(/_/g, ' ')}
                  </span>

                  {/* Status badge */}
                  <span style={{
                    fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.05em', fontFamily: 'var(--body)',
                    color: r === 'pass' ? 'var(--moss)' : r === 'fail' ? 'var(--clay)' : 'var(--ink-mute)',
                  }}>
                    {r}
                  </span>

                  {/* Send button */}
                  <button
                    onClick={() => sendGesture(gesture)}
                    disabled={sending || status !== 'streaming'}
                    style={{
                      padding: '4px 10px', borderRadius: 'var(--radius-pill)',
                      border: '1px solid rgba(20,40,38,0.15)', background: 'var(--paper)',
                      fontFamily: 'var(--body)', fontSize: '0.72rem', fontWeight: 600,
                      color: 'var(--ink)', cursor: 'pointer', opacity: sending ? 0.4 : 1,
                    }}
                  >
                    Send
                  </button>

                  {/* Pass/Fail buttons */}
                  <button
                    onClick={() => markResult(gesture, 'pass')}
                    style={{
                      padding: '4px 8px', borderRadius: 'var(--radius-pill)',
                      border: '1px solid rgba(47,94,72,0.3)', background: r === 'pass' ? 'var(--moss)' : 'transparent',
                      color: r === 'pass' ? 'var(--paper)' : 'var(--moss)',
                      fontFamily: 'var(--body)', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Pass
                  </button>
                  <button
                    onClick={() => markResult(gesture, 'fail')}
                    style={{
                      padding: '4px 8px', borderRadius: 'var(--radius-pill)',
                      border: '1px solid rgba(217,73,43,0.3)', background: r === 'fail' ? 'var(--clay)' : 'transparent',
                      color: r === 'fail' ? 'var(--paper)' : 'var(--clay)',
                      fontFamily: 'var(--body)', fontSize: '0.7rem', fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Fail
                  </button>
                </div>
              );
            })}
          </div>

          {/* Export */}
          <button
            onClick={exportResults}
            style={{
              marginTop: 16, width: '100%', padding: '12px',
              borderRadius: 'var(--radius-pill)', border: 'none',
              background: 'var(--ink)', color: 'var(--paper)',
              fontFamily: 'var(--body)', fontSize: '0.85rem', fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Export Results
          </button>
        </div>

        {/* Log */}
        <div
          ref={logRef}
          style={{
            height: 160, flexShrink: 0, overflow: 'auto',
            borderTop: '1px solid var(--paper-edge)', padding: '8px 12px',
            background: 'var(--night)', color: 'rgba(245,241,232,0.7)',
            fontFamily: 'monospace', fontSize: '0.7rem', lineHeight: 1.6,
          }}
        >
          {log.length === 0 ? (
            <span style={{ opacity: 0.4 }}>Waiting for connection…</span>
          ) : log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </aside>
    </div>
  );
}
