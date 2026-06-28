import { useCallback, useEffect, useRef, useState } from 'react';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';
import { loadImageFile } from '../../lib/helios';
import '../../demo/shared/tokens.css';
import '../../demo/atrium/Atrium.css';

const CHARACTER_IMAGE  = '/images/characters/einstein.png';
const CHARACTER_PROMPT = 'You are Einstein. Respond to stage directions and display objects when asked.';

// ─── Prompt framing variants ─────────────────────────────────────────────────
// {a} = action string, {o} = object string, {sa} = short action
// Variants A–F: prompt framing tests
// Variants G–I: strategy formats from gemini-live-object-dispatch-strategies.md
const PROMPT_VARIANTS = [
  // --- Prompt framing ---
  { id: 'A', label: 'Prod combined', template: '{a}. Include {o} in the scene.' },
  { id: 'B', label: 'Prod show',     template: 'show {o}' },
  { id: 'C', label: 'Action only',   template: '{a}' },
  { id: 'D', label: 'Split (2x)',    template: '{a} |SPLIT| show {o}' },
  { id: 'E', label: 'Short action',  template: '{sa}. Show {o}.' },
  { id: 'F', label: 'Object first',  template: 'show {o}. Then {a}.' },
  // --- Dispatch strategy formats (from research doc) ---
  { id: 'G', label: 'V1 batch',      template: 'add {o} to the scene' },
  { id: 'H', label: 'V3 stage-dir',  template: '*holds up {o}*' },
  { id: 'I', label: 'V7 correct',    template: 'show {o} |CORRECT| update the scene to show {o}' },
] as const;

type VariantId = typeof PROMPT_VARIANTS[number]['id'];
type Result = 'pass' | 'fail' | 'pending';
type ResultKey = `${string}::${VariantId}`;

// ─── Test scenarios ──────────────────────────────────────────────────────────
// Modeled on real production prompts from App.tsx text-chat and Gemini Live paths.
interface Scenario {
  id: string;
  label: string;
  action: string;
  shortAction: string;
  object: string;
  note: string;
  isStress?: boolean;
}

const SCENARIOS: Scenario[] = [
  // ── Single-object action prompts (text-chat path) ──
  { id: 'nod_clock',         label: 'Nod + clock',           action: 'nod thoughtfully and gesture gently', shortAction: 'nod',              object: 'a ticking clock',     note: 'Simple action + single object' },
  { id: 'smile_apple',       label: 'Smile + apple',         action: 'smile warmly and lean forward',       shortAction: 'smile',            object: 'a falling apple',     note: 'Warm action + object' },
  { id: 'excited_rocket',    label: 'Excited + rocket',      action: 'express great excitement and point',  shortAction: 'point excitedly',  object: 'a rocket',            note: 'High-energy action' },
  { id: 'explain_atom',      label: 'Explain + atom',        action: 'gesture with both hands while explaining', shortAction: 'gesture',     object: 'an atom',             note: 'Long compound action' },
  { id: 'show_telescope',    label: 'Show telescope',        action: 'gaze upward with wonder',             shortAction: 'look up',          object: 'a telescope',         note: 'Gaze direction + object' },
  // ── Object-only (Gemini Live V2 keyword-stream path) ──
  { id: 'obj_beam',          label: 'Just beam',             action: 'stand idle',                          shortAction: 'idle',             object: 'a beam of light',     note: 'V2 object-only dispatch' },
  { id: 'obj_trampoline',    label: 'Just trampoline',       action: 'stand idle',                          shortAction: 'idle',             object: 'a trampoline',        note: 'V2 object-only dispatch' },
  { id: 'obj_magnet',        label: 'Just magnet',           action: 'stand idle',                          shortAction: 'idle',             object: 'a magnet',            note: 'V2 object-only dispatch' },
  // ── Action-only (no objects) ──
  { id: 'action_wave',       label: 'Wave hello',            action: 'smile and wave hello warmly',         shortAction: 'wave',             object: '',                    note: 'No object, greeting action' },
  { id: 'action_think',      label: 'Think deeply',          action: 'stroke chin and look contemplative',  shortAction: 'think',            object: '',                    note: 'No object, thinking action' },
  // ── Core fixtures from dispatch-strategies doc (5 scenarios) ──
  { id: 'fix_gravity',       label: 'Gravity demo',          action: 'demonstrate gravity with enthusiasm', shortAction: 'demonstrate',      object: 'a heavy ball',        note: 'Doc fixture: einstein-gravity (obj 1/2)' },
  { id: 'fix_gravity2',      label: 'Gravity trampoline',    action: 'show spacetime curvature',            shortAction: 'show curvature',   object: 'a trampoline',        note: 'Doc fixture: einstein-gravity (obj 2/2)' },
  { id: 'fix_berries',       label: 'Bear berries',          action: 'sniff the air and reach out',         shortAction: 'reach out',        object: 'a handful of berries', note: 'Doc fixture: bear-berries' },
  { id: 'fix_honeycomb',     label: 'Bear honeycomb',        action: 'lick lips with delight',              shortAction: 'lick lips',        object: 'a honeycomb',         note: 'Doc fixture: bear-berries' },
  { id: 'fix_sword',         label: 'Battle sword',          action: 'draw weapon and take a battle stance', shortAction: 'draw sword',      object: 'a gleaming sword',    note: 'Doc fixture: alexander-battle' },
  { id: 'fix_battlemap',     label: 'Battle map',            action: 'study the terrain carefully',         shortAction: 'study map',        object: 'a battle map',        note: 'Doc fixture: alexander-battle' },
  { id: 'fix_juggle',        label: 'Juggling pins',         action: 'start juggling with flair',           shortAction: 'juggle',           object: 'juggling pins',       note: 'Doc fixture: circus-lion-juggling' },
  { id: 'fix_wing',          label: 'Da Vinci wing',         action: 'unfold the design proudly',           shortAction: 'unfold design',    object: 'a feathered wing',    note: 'Doc fixture: davinci-wing' },
  { id: 'fix_gear',          label: 'Da Vinci gear',         action: 'examine the mechanism closely',       shortAction: 'examine',          object: 'a brass gear',        note: 'Doc fixture: davinci-wing' },
  // ── Stress: multi-object rapid dispatch (V2 pattern — keyword fires per chunk) ──
  { id: 'rapid_2obj',        label: 'Rapid 2 obj',           action: 'gesture with both hands',             shortAction: 'gesture',          object: 'a heavy ball',        note: 'V2 multi-dispatch: 2 objects 500ms apart', isStress: true },
  { id: 'rapid_3obj',        label: 'Rapid 3 obj',           action: 'gesture expansively',                 shortAction: 'gesture',          object: 'a heavy ball',        note: 'V2 multi-dispatch: 3 objects 500ms apart', isStress: true },
  // ── Stress: V7 speculative-correct pattern (show wrong obj, then correct) ──
  { id: 'speculative_miss',  label: 'V7 wrong→correct',      action: 'look surprised and adjust',           shortAction: 'adjust',           object: 'a rocket',            note: 'V7: show wrong obj, correct to right obj', isStress: true },
  // ── Stress: long compound prompt ──
  { id: 'long_compound',     label: 'Long compound',         action: 'express great excitement while standing up, clapping both hands, and pointing at something amazing in the distance', shortAction: 'excited clap and point', object: 'a rocket', note: 'Very long action string', isStress: true },
  // ── Stress: V1 batch — all objects in one interact() call ──
  { id: 'batch_2obj',        label: 'V1 batch 2 obj',        action: 'demonstrate with both objects',       shortAction: 'demonstrate',      object: 'a heavy ball',        note: 'V1: add 2 objects in single call', isStress: true },
];

const SECOND_OBJECT = 'a ticking clock';
const THIRD_OBJECT  = 'a trampoline';
const WRONG_OBJECT  = 'a telescope';  // for V7 speculative-correct: show this first, then correct

const REGULAR_SCENARIOS = SCENARIOS.filter(s => !s.isStress);
const STRESS_SCENARIOS  = SCENARIOS.filter(s => s.isStress);

// ─── Component ───────────────────────────────────────────────────────────────

export default function ActionStreamHarness() {
  const { status, error, videoRef, startStream, interact, disconnect, connect } = useOdysseyStream({ autoConnect: true });

  const [results, setResults]   = useState<Record<ResultKey, Result>>({} as Record<ResultKey, Result>);
  const [activeVariant, setActiveVariant] = useState<VariantId>('A');
  const [running, setRunning]   = useState<string | null>(null);
  type ImageMode = 'original' | 'custom' | 'none';
  const [imageMode, setImageMode] = useState<ImageMode>('original');
  const [customImage, setCustomImage] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
      if (imageMode === 'original') {
        addLog('Loading Einstein image (original w/ baked-in background)…');
        const image = await loadImageFile(CHARACTER_IMAGE, 'einstein.png');
        await startStream({ image, prompt: CHARACTER_PROMPT, portrait: false });
      } else if (imageMode === 'custom' && customImage) {
        addLog(`Loading custom image: ${customImage.name}…`);
        await startStream({ image: customImage, prompt: CHARACTER_PROMPT, portrait: false });
      } else {
        addLog('Starting stream with NO image…');
        await startStream({ prompt: CHARACTER_PROMPT, portrait: false });
      }
      addLog(`Stream started (image=${imageMode}) — Send buttons are active`);
    };
    void run();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const switchImageMode = useCallback(async (mode: ImageMode) => {
    setImageMode(mode);
    addLog(`Switching image mode → ${mode}, reconnecting…`);
    await disconnect();
    await connect();
  }, [disconnect, connect, addLog]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCustomImage(file);
      addLog(`Custom image selected: ${file.name}`);
      void switchImageMode('custom');
    }
  }, [switchImageMode, addLog]);

  const buildPrompt = useCallback((variantId: VariantId, scenario: Scenario): string | string[] => {
    const variant = PROMPT_VARIANTS.find(v => v.id === variantId)!;
    const t = variant.template;

    // Action-only scenarios: only action-containing variants make sense
    if (!scenario.object) {
      return scenario.action;
    }
    // Object-only scenarios with action-only variant: fallback to action
    if (variantId === 'C') {
      return scenario.action;
    }

    const prompt = t
      .replace('{a}', scenario.action)
      .replace('{sa}', scenario.shortAction)
      .replace(/{o}/g, scenario.object);

    // Variant D splits into two separate interact() calls (action then object)
    if (prompt.includes('|SPLIT|')) {
      return prompt.split('|SPLIT|').map(s => s.trim());
    }
    // Variant I (V7 correct): two calls — speculative show, then correction
    if (prompt.includes('|CORRECT|')) {
      return prompt.split('|CORRECT|').map(s => s.trim());
    }
    return prompt;
  }, []);

  const sendScenario = useCallback(async (scenario: Scenario) => {
    if (running || status !== 'streaming') return;
    setRunning(scenario.id);
    try {
      // ── Stress: V2 rapid multi-object dispatch (keyword fires per chunk) ──
      if (scenario.id === 'rapid_2obj') {
        const objs = [scenario.object, SECOND_OBJECT];
        for (let i = 0; i < objs.length; i++) {
          const p = `show ${objs[i]}`;
          addLog(`[${activeVariant}] Rapid obj ${i + 1}/${objs.length}: "${p}"`);
          await interact(p);
          if (i < objs.length - 1) await new Promise(r => setTimeout(r, 500));
        }
      } else if (scenario.id === 'rapid_3obj') {
        const objs = [scenario.object, SECOND_OBJECT, THIRD_OBJECT];
        for (let i = 0; i < objs.length; i++) {
          const p = `show ${objs[i]}`;
          addLog(`[${activeVariant}] Rapid obj ${i + 1}/${objs.length}: "${p}"`);
          await interact(p);
          if (i < objs.length - 1) await new Promise(r => setTimeout(r, 500));
        }
      }
      // ── Stress: V7 speculative-correct (show wrong, then correct) ──
      else if (scenario.id === 'speculative_miss') {
        const wrongP = `show ${WRONG_OBJECT}`;
        const correctP = `update the scene to show ${scenario.object}`;
        addLog(`[${activeVariant}] V7 speculative: "${wrongP}"`);
        await interact(wrongP);
        await new Promise(r => setTimeout(r, 1500));
        addLog(`[${activeVariant}] V7 correction: "${correctP}"`);
        await interact(correctP);
      }
      // ── Stress: V1 batch — multiple objects in a single interact() call ──
      else if (scenario.id === 'batch_2obj') {
        const p = `add ${scenario.object} and ${SECOND_OBJECT} to the scene`;
        addLog(`[${activeVariant}] V1 batch: "${p}"`);
        await interact(p);
      }
      // ── Normal: build from variant template ──
      else {
        const prompt = buildPrompt(activeVariant, scenario);
        if (Array.isArray(prompt)) {
          for (let i = 0; i < prompt.length; i++) {
            addLog(`[${activeVariant}] Call ${i + 1}/${prompt.length}: "${prompt[i]}"`);
            await interact(prompt[i]);
            if (i < prompt.length - 1) await new Promise(r => setTimeout(r, 500));
          }
        } else {
          addLog(`[${activeVariant}] "${prompt}"`);
          await interact(prompt);
        }
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
    const lines = ['=== Action → Stream A/B Test Results ===', ''];

    PROMPT_VARIANTS.forEach(v => {
      const passed       = REGULAR_SCENARIOS.filter(s => getResult(s.id, v.id) === 'pass');
      const failed       = REGULAR_SCENARIOS.filter(s => getResult(s.id, v.id) === 'fail');
      const stressPassed = STRESS_SCENARIOS.filter(s => getResult(s.id, v.id) === 'pass');
      const stressFailed = STRESS_SCENARIOS.filter(s => getResult(s.id, v.id) === 'fail');
      lines.push(`Variant ${v.id} — "${v.label}" (${v.template})`);
      lines.push(`  Regular PASS (${passed.length}/${REGULAR_SCENARIOS.length}): ${passed.map(s => s.id).join(', ') || 'none'}`);
      lines.push(`  Regular FAIL (${failed.length}): ${failed.map(s => s.id).join(', ') || 'none'}`);
      lines.push(`  Stress  PASS: ${stressPassed.map(s => s.id).join(', ') || 'none'}`);
      lines.push(`  Stress  FAIL: ${stressFailed.map(s => s.id).join(', ') || 'none'}`);
      lines.push('');
    });

    // Break down by scenario type
    const actionOnly = REGULAR_SCENARIOS.filter(s => !s.object);
    const objectOnly = REGULAR_SCENARIOS.filter(s => s.object && s.action === 'stand idle');
    const combined   = REGULAR_SCENARIOS.filter(s => s.object && s.action !== 'stand idle');

    lines.push('--- By scenario type ---');
    for (const [label, group] of [['Action only', actionOnly], ['Object only', objectOnly], ['Action + Object', combined]] as const) {
      const bestV = PROMPT_VARIANTS
        .map(v => ({ v, passes: group.filter(s => getResult(s.id, v.id) === 'pass').length }))
        .sort((a, b) => b.passes - a.passes)[0];
      lines.push(`${label}: best = ${bestV.v.id} (${bestV.passes}/${group.length})`);
    }

    // Overall best
    const best = PROMPT_VARIANTS
      .map(v => ({ v, passes: REGULAR_SCENARIOS.filter(s => getResult(s.id, v.id) === 'pass').length }))
      .sort((a, b) => b.passes - a.passes)[0];
    lines.push('');
    lines.push(`Overall best variant: ${best.v.id} — "${best.v.label}" (${best.passes}/${REGULAR_SCENARIOS.length})`);
    lines.push(`Template: ${best.v.template}`);

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
          Action → Stream Harness
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

        <div style={{ display: 'flex', gap: 3 }}>
          {(['original', 'custom', 'none'] as const).map(mode => (
            <button key={mode} onClick={() => mode === 'custom' ? fileInputRef.current?.click() : void switchImageMode(mode)} style={{
              padding: '3px 8px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
              fontFamily: 'var(--body)', fontSize: '0.68rem', fontWeight: 600,
              border: `1px solid ${imageMode === mode ? 'rgba(47,94,72,0.3)' : 'rgba(20,40,38,0.12)'}`,
              background: imageMode === mode ? 'rgba(47,94,72,0.1)' : 'transparent',
              color: imageMode === mode ? 'var(--moss)' : 'var(--ink-mute)',
            }}>
              {mode === 'original' ? 'IMG: Original' : mode === 'custom' ? 'IMG: Custom' : 'IMG: None'}
            </button>
          ))}
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload}
          style={{ display: 'none' }} />

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
        {PROMPT_VARIANTS.find(v => v.id === activeVariant)?.template
          .replace('{a}', '<action>')
          .replace('{sa}', '<short-action>')
          .replace('{o}', '<object>')}
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
          width: 400, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderLeft: '1px solid var(--paper-edge)', overflow: 'hidden',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* Section: Action + Object */}
            <SectionLabel text="Action + Object" />
            {REGULAR_SCENARIOS.filter(s => s.object && s.action !== 'stand idle' && !s.id.startsWith('fix_')).map(scenario => (
              <ScenarioRow
                key={scenario.id}
                scenario={scenario}
                result={getResult(scenario.id, activeVariant)}
                isRunning={running === scenario.id}
                disabled={!!running || !isStreaming}
                onSend={() => void sendScenario(scenario)}
                onPass={() => markResult(scenario.id, 'pass')}
                onFail={() => markResult(scenario.id, 'fail')}
              />
            ))}

            {/* Section: Object Only */}
            <SectionLabel text="Object Only (V2 keyword-stream path)" />
            {REGULAR_SCENARIOS.filter(s => s.action === 'stand idle').map(scenario => (
              <ScenarioRow
                key={scenario.id}
                scenario={scenario}
                result={getResult(scenario.id, activeVariant)}
                isRunning={running === scenario.id}
                disabled={!!running || !isStreaming}
                onSend={() => void sendScenario(scenario)}
                onPass={() => markResult(scenario.id, 'pass')}
                onFail={() => markResult(scenario.id, 'fail')}
              />
            ))}

            {/* Section: Action Only */}
            <SectionLabel text="Action Only (no object)" />
            {REGULAR_SCENARIOS.filter(s => !s.object).map(scenario => (
              <ScenarioRow
                key={scenario.id}
                scenario={scenario}
                result={getResult(scenario.id, activeVariant)}
                isRunning={running === scenario.id}
                disabled={!!running || !isStreaming}
                onSend={() => void sendScenario(scenario)}
                onPass={() => markResult(scenario.id, 'pass')}
                onFail={() => markResult(scenario.id, 'fail')}
              />
            ))}

            {/* Section: Doc Fixtures (5 core scenarios from dispatch-strategies.md) */}
            <SectionLabel text="Doc Fixtures (cross-character objects)" />
            {REGULAR_SCENARIOS.filter(s => s.id.startsWith('fix_')).map(scenario => (
              <ScenarioRow
                key={scenario.id}
                scenario={scenario}
                result={getResult(scenario.id, activeVariant)}
                isRunning={running === scenario.id}
                disabled={!!running || !isStreaming}
                onSend={() => void sendScenario(scenario)}
                onPass={() => markResult(scenario.id, 'pass')}
                onFail={() => markResult(scenario.id, 'fail')}
              />
            ))}

            {/* Section: Stress */}
            <SectionLabel text="Stress Tests (V1/V2/V7 patterns)" />
            {STRESS_SCENARIOS.map(scenario => (
              <ScenarioRow
                key={scenario.id}
                scenario={scenario}
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

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{
      margin: '4px 0 2px', padding: '4px 0',
      borderTop: '1px solid var(--paper-edge)',
      fontSize: '0.65rem', fontWeight: 700, fontFamily: 'var(--body)',
      color: 'var(--ink-mute)', letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>
      {text}
    </div>
  );
}

interface ScenarioRowProps {
  scenario: Scenario;
  result: Result;
  isRunning: boolean;
  disabled: boolean;
  isStress?: boolean;
  onSend: () => void;
  onPass: () => void;
  onFail: () => void;
}

function ScenarioRow({ scenario, result, isRunning, disabled, isStress, onSend, onPass, onFail }: ScenarioRowProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '7px 10px', borderRadius: 'var(--radius-sm)',
      border: `1.5px solid ${result === 'pass' ? 'rgba(47,94,72,0.3)' : result === 'fail' ? 'rgba(217,73,43,0.25)' : 'rgba(20,40,38,0.08)'}`,
      background: result === 'pass' ? 'rgba(47,94,72,0.05)' : result === 'fail' ? 'rgba(217,73,43,0.05)' : 'transparent',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--body)', fontSize: '0.82rem', fontWeight: 600, color: 'var(--ink)' }}>
          {scenario.label}
        </div>
        <div style={{
          fontFamily: 'var(--body)', fontSize: '0.68rem', color: 'var(--ink-mute)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {scenario.note}
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
