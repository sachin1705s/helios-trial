import { useCallback, useEffect, useRef, useState } from 'react';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/helios';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';

const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. Speak the given lines naturally and expressively.';

const PROMPT_VARIANTS = [
  { id: 'A', label: 'Direct',    template: 'Say this: "{c}"' },
  { id: 'B', label: 'Instruct',  template: 'Tell them: "{c}"' },
  { id: 'C', label: 'In-scene',  template: 'You just thought of something. Say: "{c}"' },
  { id: 'D', label: 'Raw',       template: '{c}' },
  { id: 'E', label: 'Character', template: 'As Einstein, say: "{c}"' },
  { id: 'F', label: 'Reactive',  template: 'React by saying: "{c}"' },
] as const;

type VariantId = typeof PROMPT_VARIANTS[number]['id'];
type Result = 'pass' | 'fail' | 'pending';
type ResultKey = `${string}::${VariantId}`;

interface Scenario {
  id: string;
  label: string;
  content: string;
  isStress?: boolean;
  interruptContent?: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'greeting',        label: 'Greeting',    content: "Hello! It's wonderful to see you here today." },
  { id: 'short_fact',      label: 'Short fact',  content: 'Light travels at 299,792 km per second.' },
  { id: 'excited',         label: 'Excited',     content: 'Extraordinary! This changes everything!' },
  { id: 'explanation',     label: 'Explanation', content: 'A thought experiment is a device of the imagination.' },
  { id: 'correction',      label: 'Correction',  content: "Actually, that's a common misconception." },
  { id: 'question_answer', label: 'Q&A',         content: 'My greatest work was understanding that energy and mass are equivalent.' },
  { id: '3_sentences',     label: '3 sentences', content: 'The universe does not care about our intuitions. It follows its own rules. Our job is to find them.' },
  { id: 'follow_up',       label: 'Follow-up',   content: 'And furthermore, what this means for you is this.' },
  { id: 'pivot',           label: 'Pivot',       content: 'Now, let us speak of something entirely different.' },
  { id: 'humor',           label: 'Humor',       content: "Imagination is more important than knowledge. Don't tell the professors I said that." },
  { id: 'rapid_stress',    label: 'Rapid ×3',    content: 'Light travels at 299,792 km per second.', isStress: true },
  { id: 'interrupt_test',  label: 'Interrupt',   content: 'A thought experiment is a device of the imagination.', isStress: true, interruptContent: "Hello! It's wonderful to see you here today." },
];

const REGULAR_SCENARIOS = SCENARIOS.filter(s => !s.isStress);
const STRESS_SCENARIOS  = SCENARIOS.filter(s => s.isStress);

export default function StreamInteractHarness() {
  const { status, error, videoRef, startStream, interact } = useOdysseyStream();

  const [results, setResults]   = useState<Record<ResultKey, Result>>({} as Record<ResultKey, Result>);
  const [activeVariant, setActiveVariant] = useState<VariantId>('A');
  const [running, setRunning]   = useState<string | null>(null);
  const [log, setLog]           = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((msg: string) => {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  useEffect(() => {
    addLog(`Status → ${status}${error ? `: ${error}` : ''}`);
  }, [status, error]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status !== 'ready') return;
    const run = async () => {
      addLog('Loading Einstein image…');
      const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
      await startStream({ image, prompt: CHARACTER_PROMPT, portrait: false });
      addLog('Stream started — Send buttons are active');
    };
    void run();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const buildPrompt = useCallback((variantId: VariantId, content: string): string => {
    return PROMPT_VARIANTS.find(v => v.id === variantId)!.template.replace('{c}', content);
  }, []);

  const sendScenario = useCallback(async (scenario: Scenario) => {
    if (running || status !== 'streaming') return;
    setRunning(scenario.id);
    try {
      if (scenario.id === 'rapid_stress') {
        for (let i = 1; i <= 3; i++) {
          const prompt = buildPrompt(activeVariant, scenario.content);
          addLog(`[${activeVariant}] Rapid #${i}: "${prompt}"`);
          await interact(prompt);
          if (i < 3) await new Promise(r => setTimeout(r, 1500));
        }
      } else if (scenario.id === 'interrupt_test') {
        const prompt1 = buildPrompt(activeVariant, scenario.content);
        const prompt2 = buildPrompt(activeVariant, scenario.interruptContent!);
        addLog(`[${activeVariant}] Interrupt main: "${prompt1}"`);
        void interact(prompt1);
        await new Promise(r => setTimeout(r, 800));
        addLog(`[${activeVariant}] Interrupt with: "${prompt2}"`);
        await interact(prompt2);
      } else {
        const prompt = buildPrompt(activeVariant, scenario.content);
        addLog(`[${activeVariant}] "${prompt}"`);
        await interact(prompt);
      }
    } catch (err) {
      addLog(`Error: ${err}`);
    } finally {
      setRunning(null);
    }
  }, [running, status, activeVariant, buildPrompt, interact, addLog]);

  const markResult = useCallback((scenarioId: string, result: Result) => {
    const key = `${scenarioId}::${activeVariant}` as ResultKey;
    setResults(prev => ({ ...prev, [key]: result }));
    addLog(`[${activeVariant}] ${scenarioId} → ${result.toUpperCase()}`);
  }, [activeVariant, addLog]);

  const getResult = (scenarioId: string, variantId: VariantId): Result =>
    results[`${scenarioId}::${variantId}` as ResultKey] ?? 'pending';

  const exportResults = useCallback(() => {
    const lines = ['=== Stream Interact A/B Test Results ===', ''];
    PROMPT_VARIANTS.forEach(v => {
      const passed       = REGULAR_SCENARIOS.filter(s => getResult(s.id, v.id) === 'pass');
      const failed       = REGULAR_SCENARIOS.filter(s => getResult(s.id, v.id) === 'fail');
      const stressPassed = STRESS_SCENARIOS.filter(s => getResult(s.id, v.id) === 'pass');
      const stressFailed = STRESS_SCENARIOS.filter(s => getResult(s.id, v.id) === 'fail');
      lines.push(`Variant ${v.id} — "${v.label}" (${v.template})`);
      lines.push(`  Regular  PASS (${passed.length}/${REGULAR_SCENARIOS.length}): ${passed.map(s => s.id).join(', ') || 'none'}`);
      lines.push(`  Regular  FAIL (${failed.length}): ${failed.map(s => s.id).join(', ') || 'none'}`);
      lines.push(`  Stress   PASS: ${stressPassed.map(s => s.id).join(', ') || 'none'}`);
      lines.push(`  Stress   FAIL: ${stressFailed.map(s => s.id).join(', ') || 'none'}`);
      lines.push('');
    });

    const best = PROMPT_VARIANTS
      .map(v => ({ v, passes: REGULAR_SCENARIOS.filter(s => getResult(s.id, v.id) === 'pass').length }))
      .sort((a, b) => b.passes - a.passes)[0];
    lines.push(`Best variant: ${best.v.id} — "${best.v.label}" (${best.passes}/${REGULAR_SCENARIOS.length} passes)`);
    lines.push(`Template: ${best.v.template}`);

    const unsafe = REGULAR_SCENARIOS.filter(s => PROMPT_VARIANTS.every(v => getResult(s.id, v.id) === 'fail'));
    if (unsafe.length) {
      lines.push('');
      lines.push(`Unsafe scenarios (failed all variants): ${unsafe.map(s => s.id).join(', ')}`);
    }

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
          Stream Interact Harness
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

      {/* Template preview */}
      <div style={{
        padding: '6px 16px', flexShrink: 0, fontSize: '0.75rem', fontFamily: 'var(--body)',
        color: 'var(--ink-mute)', borderBottom: '1px solid var(--paper-edge)',
        background: 'rgba(20,40,38,0.02)',
      }}>
        <strong style={{ color: 'var(--ink)' }}>Template [{activeVariant}]:</strong>{' '}
        {PROMPT_VARIANTS.find(v => v.id === activeVariant)?.template.replace('{c}', '<content>')}
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
          width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderLeft: '1px solid var(--paper-edge)', overflow: 'hidden',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {REGULAR_SCENARIOS.map(scenario => (
              <ScenarioRow
                key={scenario.id}
                label={scenario.label}
                content={scenario.content}
                result={getResult(scenario.id, activeVariant)}
                isRunning={running === scenario.id}
                disabled={!!running || !isStreaming}
                onSend={() => void sendScenario(scenario)}
                onPass={() => markResult(scenario.id, 'pass')}
                onFail={() => markResult(scenario.id, 'fail')}
              />
            ))}

            <div style={{
              margin: '4px 0 2px', padding: '4px 0',
              borderTop: '1px solid var(--paper-edge)',
              fontSize: '0.65rem', fontWeight: 700, fontFamily: 'var(--body)',
              color: 'var(--ink-mute)', letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>
              Stress Tests
            </div>

            {STRESS_SCENARIOS.map(scenario => (
              <ScenarioRow
                key={scenario.id}
                label={scenario.label}
                content={scenario.content}
                result={getResult(scenario.id, activeVariant)}
                isRunning={running === scenario.id}
                disabled={!!running || !isStreaming}
                isStress
                onSend={() => void sendScenario(scenario)}
                onPass={() => markResult(scenario.id, 'pass')}
                onFail={() => markResult(scenario.id, 'fail')}
              />
            ))}

            <button onClick={exportResults} style={{
              marginTop: 4, padding: '10px', borderRadius: 'var(--radius-pill)',
              border: 'none', background: 'var(--ink)', color: 'var(--paper)',
              fontFamily: 'var(--body)', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
            }}>Export Results</button>
          </div>

          {/* Log */}
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

interface ScenarioRowProps {
  label: string;
  content: string;
  result: Result;
  isRunning: boolean;
  disabled: boolean;
  isStress?: boolean;
  onSend: () => void;
  onPass: () => void;
  onFail: () => void;
}

function ScenarioRow({ label, content, result, isRunning, disabled, isStress, onSend, onPass, onFail }: ScenarioRowProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '7px 10px', borderRadius: 'var(--radius-sm)',
      border: `1.5px solid ${result === 'pass' ? 'rgba(47,94,72,0.3)' : result === 'fail' ? 'rgba(217,73,43,0.25)' : 'rgba(20,40,38,0.08)'}`,
      background: result === 'pass' ? 'rgba(47,94,72,0.05)' : result === 'fail' ? 'rgba(217,73,43,0.05)' : 'transparent',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--body)', fontSize: '0.82rem', fontWeight: 600, color: 'var(--ink)' }}>
          {label}
        </div>
        <div style={{
          fontFamily: 'var(--body)', fontSize: '0.68rem', color: 'var(--ink-mute)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {content}
        </div>
      </div>
      <span style={{
        fontSize: '0.65rem', fontWeight: 700, fontFamily: 'var(--body)',
        color: result === 'pass' ? 'var(--moss)' : result === 'fail' ? 'var(--clay)' : 'var(--ink-mute)',
        minWidth: 44, textAlign: 'center', flexShrink: 0,
      }}>
        {isRunning ? '…' : result.toUpperCase()}
      </span>
      <button onClick={onSend} disabled={disabled} style={{
        padding: '3px 8px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
        border: `1px solid ${isStress ? 'rgba(217,73,43,0.3)' : 'rgba(20,40,38,0.15)'}`,
        background: isStress ? 'rgba(217,73,43,0.06)' : 'var(--paper)',
        fontFamily: 'var(--body)', fontSize: '0.7rem', fontWeight: 600,
        color: isStress ? 'var(--clay)' : 'var(--ink)',
        opacity: disabled ? 0.4 : 1, flexShrink: 0,
      }}>
        {isStress ? 'Run' : 'Send'}
      </button>
      <button onClick={onPass} style={{
        padding: '3px 8px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
        border: '1px solid rgba(47,94,72,0.3)', fontFamily: 'var(--body)',
        fontSize: '0.7rem', fontWeight: 600, flexShrink: 0,
        background: result === 'pass' ? 'var(--moss)' : 'transparent',
        color: result === 'pass' ? 'var(--paper)' : 'var(--moss)',
      }}>✓</button>
      <button onClick={onFail} style={{
        padding: '3px 8px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
        border: '1px solid rgba(217,73,43,0.25)', fontFamily: 'var(--body)',
        fontSize: '0.7rem', fontWeight: 600, flexShrink: 0,
        background: result === 'fail' ? 'var(--clay)' : 'transparent',
        color: result === 'fail' ? 'var(--paper)' : 'var(--clay)',
      }}>✗</button>
    </div>
  );
}
