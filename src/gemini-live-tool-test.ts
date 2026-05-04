/**
 * Gemini Live — Function Calling Test
 *
 * Tests whether Gemini Live can call spawn_object / trigger_action tools
 * mid-turn (while generating audio), and measures timing relative to audio.
 *
 * Sends text turns (no microphone) so the test is fully automated and repeatable.
 * Tests both Gemini 3.1 Flash Live and Gemini 2.5 Flash Live side-by-side.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModelConfig {
  id: string;
  label: string;
  model: string;
}

export const MODELS: ModelConfig[] = [
  {
    id: 'gemini-31',
    label: 'Gemini 3.1 Flash Live',
    model: 'models/gemini-3.1-flash-live-preview',
  },
  {
    id: 'gemini-25',
    label: 'Gemini 2.5 Flash Live',
    model: 'models/gemini-2.5-flash-preview-native-audio-dialog',
  },
];

export interface TestPrompt {
  id: string;
  character: string;
  userText: string;
  expectedTools: string[];   // function names or object names we expect to be called
}

export const TEST_PROMPTS: TestPrompt[] = [
  {
    id: 'einstein-gravity',
    character: 'Albert Einstein',
    userText: 'Can you show me how gravity works using something physical?',
    expectedTools: ['spawn_object'],
  },
  {
    id: 'bear-food',
    character: 'Steve the Bear',
    userText: 'What is your favourite food? Can you show me?',
    expectedTools: ['spawn_object'],
  },
  {
    id: 'alexander-battle',
    character: 'Alexander',
    userText: 'Show me how you would plan a battle.',
    expectedTools: ['spawn_object', 'trigger_action'],
  },
  {
    id: 'circus-lion-juggle',
    character: 'Circus Lion',
    userText: 'Show me a juggling trick!',
    expectedTools: ['spawn_object', 'trigger_action'],
  },
  {
    id: 'davinci-invention',
    character: 'Da Vinci',
    userText: 'Tell me about one of your inventions and show me how it works.',
    expectedTools: ['spawn_object'],
  },
];

export interface ToolCall {
  name: string;
  args: Record<string, string>;
  receivedAtMs: number;       // ms since session start
  relativeToFirstAudioMs: number | null;  // negative = before first audio
}

export interface TurnMeasurement {
  promptId: string;
  userText: string;
  firstAudioMs: number | null;
  firstToolCallMs: number | null;
  turnCompleteMs: number | null;
  toolCalls: ToolCall[];
  audioChunks: number;
  toolCallsBeforeAudio: number;
  toolCallsDuringAudio: number;
  toolCallsAfterAudio: number;
  error?: string;
}

export interface ModelResult {
  model: ModelConfig;
  turns: TurnMeasurement[];
  avgFirstToolMs: number | null;
  avgFirstAudioMs: number | null;
  toolBeforeAudioRate: number;   // 0–1
  totalToolCalls: number;
  errorCount: number;
}

// ─── Tool declarations ────────────────────────────────────────────────────────

const TOOL_DECLARATIONS = {
  functionDeclarations: [
    {
      name: 'spawn_object',
      description: 'Spawn a visual prop or object in the scene for the user to see. Call this when you reference or hold up any physical object.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING',
            description: 'The object to spawn, e.g. "trampoline", "heavy ball", "sword", "honeycomb"',
          },
          description: {
            type: 'STRING',
            description: 'Brief description of how the object appears, e.g. "a worn battle map spread on a table"',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'trigger_action',
      description: 'Trigger a character animation or physical action. Call this when you perform a gesture, movement, or expression.',
      parameters: {
        type: 'OBJECT',
        properties: {
          action: {
            type: 'STRING',
            description: 'The action to perform, e.g. "holds up fish proudly", "unrolls map", "roars with satisfaction"',
          },
        },
        required: ['action'],
      },
    },
  ],
};

// ─── Session runner ───────────────────────────────────────────────────────────

async function fetchApiKey(): Promise<{token: string, isRawKey: boolean}> {
  const res = await fetch('/api/gemini-live-token', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
  const data = await res.json() as { token?: string, isRawKey?: boolean };
  if (!data.token) throw new Error('Empty token');
  return { token: data.token, isRawKey: !!data.isRawKey };
}


async function runTurn(
  ws: WebSocket,
  prompt: TestPrompt,
  onLog: (msg: string) => void,
): Promise<TurnMeasurement> {
  const t0 = performance.now();
  const measurement: TurnMeasurement = {
    promptId: prompt.id,
    userText: prompt.userText,
    firstAudioMs: null,
    firstToolCallMs: null,
    turnCompleteMs: null,
    toolCalls: [],
    audioChunks: 0,
    toolCallsBeforeAudio: 0,
    toolCallsDuringAudio: 0,
    toolCallsAfterAudio: 0,
  };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      onLog(`  ⚠ Timeout on ${prompt.id}`);
      resolve(measurement);
    }, 20000);

    const onMessage = async (event: MessageEvent) => {
      const text: string = event.data instanceof Blob
        ? await (event.data as Blob).text()
        : event.data as string;

      let msg: Record<string, unknown>;
      try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }

      const now = Math.round(performance.now() - t0);

      // ── Tool calls ──
      const toolCall = msg.toolCall as Record<string, unknown> | undefined;
      if (toolCall) {
        const calls = (toolCall.functionCalls ?? []) as Array<Record<string, unknown>>;
        for (const call of calls) {
          const callName = call.name as string;
          const callArgs = (call.args ?? {}) as Record<string, string>;
          const callId = call.id as string;
          onLog(`  🔧 toolCall: ${callName}(${JSON.stringify(callArgs)}) at +${now}ms`);
          const relativeToFirstAudio = measurement.firstAudioMs !== null
            ? now - measurement.firstAudioMs
            : null;
          measurement.toolCalls.push({
            name: callName,
            args: callArgs,
            receivedAtMs: now,
            relativeToFirstAudioMs: relativeToFirstAudio,
          });
          if (measurement.firstToolCallMs === null) measurement.firstToolCallMs = now;

          // Respond to tool call so model continues
          ws.send(JSON.stringify({
            toolResponse: {
              functionResponses: [{
                id: callId,
                response: { result: 'ok' },
              }],
            },
          }));
        }
      }

      // ── Audio chunks ──
      const content = msg.serverContent as Record<string, unknown> | undefined;
      if (content) {
        const parts = ((content.modelTurn as Record<string, unknown> | undefined)?.parts ?? []) as Array<Record<string, unknown>>;
        for (const part of parts) {
          const inlineData = part.inlineData as Record<string, string> | undefined;
          if (inlineData?.mimeType?.startsWith('audio/pcm')) {
            measurement.audioChunks++;
            if (measurement.firstAudioMs === null) {
              measurement.firstAudioMs = now;
              onLog(`  🔊 first audio at +${now}ms`);
            }
          }
        }

        // ── Turn complete ──
        if (content.turnComplete) {
          measurement.turnCompleteMs = now;
          onLog(`  ✓ turnComplete at +${now}ms`);

          // Classify tool calls relative to audio
          for (const tc of measurement.toolCalls) {
            if (measurement.firstAudioMs === null || tc.receivedAtMs < measurement.firstAudioMs) {
              measurement.toolCallsBeforeAudio++;
            } else if (tc.receivedAtMs <= measurement.turnCompleteMs) {
              measurement.toolCallsDuringAudio++;
            } else {
              measurement.toolCallsAfterAudio++;
            }
          }

          ws.removeEventListener('message', onMessage);
          clearTimeout(timeout);
          resolve(measurement);
        }
      }
    };

    ws.addEventListener('message', onMessage);

    // Send text turn to Gemini Live
    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: prompt.userText }] }],
        turnComplete: true,
      },
    }));

    onLog(`  → sent: "${prompt.userText}"`);
  });
}

async function runModel(
  modelConfig: ModelConfig,
  onLog: (msg: string) => void,
  onProgress: (pct: number) => void,
): Promise<ModelResult> {
  onLog(`\n${'═'.repeat(60)}`);
  onLog(`Model: ${modelConfig.label}`);
  onLog(`${'═'.repeat(60)}`);

  const result: ModelResult = {
    model: modelConfig,
    turns: [],
    avgFirstToolMs: null,
    avgFirstAudioMs: null,
    toolBeforeAudioRate: 0,
    totalToolCalls: 0,
    errorCount: 0,
  };

  let apiKey: string;
  let isRawKey = true;
  try {
    const keyData = await fetchApiKey();
    apiKey = keyData.token;
    isRawKey = keyData.isRawKey;
    onLog('✓ API key fetched');
  } catch (err) {
    onLog(`✗ Failed to fetch API key: ${(err as Error).message}`);
    result.errorCount = TEST_PROMPTS.length;
    return result;
  }

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const wsUrl = isRawKey
      ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`
      : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${apiKey}`;
    const socket = new WebSocket(wsUrl);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('WebSocket failed to open'));
    setTimeout(() => reject(new Error('WebSocket open timeout')), 10000);
  }).catch((err) => {
    onLog(`✗ WebSocket error: ${(err as Error).message}`);
    return null;
  });

  if (!ws) {
    result.errorCount = TEST_PROMPTS.length;
    return result;
  }

  // Wait for setupComplete
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('setup timeout')), 10000);
    const onMsg = async (ev: MessageEvent) => {
      const text = ev.data instanceof Blob ? await (ev.data as Blob).text() : ev.data as string;
      try {
        const msg = JSON.parse(text) as Record<string, unknown>;
        if (msg.setupComplete !== undefined) {
          clearTimeout(t);
          ws.removeEventListener('message', onMsg);
          onLog('✓ Setup complete');
          resolve();
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({
      setup: {
        model: modelConfig.model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
        systemInstruction: {
          parts: [{ text: 'You are a helpful interactive character. When you reference a physical object, call spawn_object. When you perform a gesture or action, call trigger_action. Keep replies concise.' }],
        },
        tools: [TOOL_DECLARATIONS],
      },
    }));
  }).catch((err) => {
    onLog(`✗ Setup failed: ${(err as Error).message}`);
  });

  // Run each test prompt sequentially (Gemini Live is stateful)
  for (let i = 0; i < TEST_PROMPTS.length; i++) {
    const prompt = TEST_PROMPTS[i];
    onLog(`\n[${i + 1}/${TEST_PROMPTS.length}] ${prompt.id}`);
    try {
      const turn = await runTurn(ws, prompt, onLog);
      result.turns.push(turn);
      result.totalToolCalls += turn.toolCalls.length;
      if (turn.error) result.errorCount++;
    } catch (err) {
      onLog(`  ✗ Error: ${(err as Error).message}`);
      result.errorCount++;
    }
    onProgress(((i + 1) / TEST_PROMPTS.length) * 100);
    // Brief pause between turns
    await new Promise(r => setTimeout(r, 1000));
  }

  ws.close();

  // Aggregate stats
  const toolTimes = result.turns.map(t => t.firstToolCallMs).filter((x): x is number => x !== null);
  const audioTimes = result.turns.map(t => t.firstAudioMs).filter((x): x is number => x !== null);
  const totalTurns = result.turns.length;

  result.avgFirstToolMs = toolTimes.length
    ? Math.round(toolTimes.reduce((a, b) => a + b, 0) / toolTimes.length)
    : null;
  result.avgFirstAudioMs = audioTimes.length
    ? Math.round(audioTimes.reduce((a, b) => a + b, 0) / audioTimes.length)
    : null;
  result.toolBeforeAudioRate = totalTurns > 0
    ? result.turns.reduce((sum, t) => sum + t.toolCallsBeforeAudio, 0) /
      Math.max(1, result.turns.reduce((sum, t) => sum + t.toolCalls.length, 0))
    : 0;

  return result;
}

// ─── Main exports ─────────────────────────────────────────────────────────────

// Run a single model config — used by the HTML runner to support user-editable model names.
export async function runModelConfig(
  modelConfig: ModelConfig,
  onLog: (msg: string) => void,
  onProgress: (pct: number) => void,
): Promise<ModelResult> {
  return runModel(modelConfig, onLog, onProgress);
}

// Run all models in sequence.
export async function runToolTest(
  onLog: (msg: string) => void,
  onProgress: (modelId: string, pct: number) => void,
): Promise<ModelResult[]> {
  const results: ModelResult[] = [];
  for (const modelConfig of MODELS) {
    const result = await runModel(
      modelConfig,
      onLog,
      (pct) => onProgress(modelConfig.id, pct),
    );
    results.push(result);
  }
  return results;
}

// ─── Summary renderer ─────────────────────────────────────────────────────────

export function renderToolTestSummary(results: ModelResult[]): string {
  const lines: string[] = [
    '╔══════════════════════════════════════════════════════════════════════════╗',
    '║           GEMINI LIVE FUNCTION CALLING TEST — RESULTS                    ║',
    '╚══════════════════════════════════════════════════════════════════════════╝',
    '',
    `${'Model'.padEnd(30)} ${'Avg 1st tool'.padEnd(14)} ${'Avg 1st audio'.padEnd(15)} ${'Tool before audio'.padEnd(19)} ${'Total calls'.padEnd(12)} Errors`,
    '─'.repeat(96),
  ];

  for (const r of results) {
    const toolMs = r.avgFirstToolMs !== null ? `${r.avgFirstToolMs}ms` : 'never';
    const audioMs = r.avgFirstAudioMs !== null ? `${r.avgFirstAudioMs}ms` : 'never';
    const beforeRate = `${Math.round(r.toolBeforeAudioRate * 100)}%`;
    lines.push(
      `${r.model.label.padEnd(30)} ${toolMs.padEnd(14)} ${audioMs.padEnd(15)} ${beforeRate.padEnd(19)} ${String(r.totalToolCalls).padEnd(12)} ${r.errorCount}`
    );
  }

  lines.push('');
  lines.push('PER-TURN BREAKDOWN');
  lines.push('─'.repeat(96));

  for (const r of results) {
    lines.push(`\n▶ ${r.model.label}`);
    for (const turn of r.turns) {
      const toolMs = turn.firstToolCallMs !== null ? `${turn.firstToolCallMs}ms` : 'never';
      const audioMs = turn.firstAudioMs !== null ? `${turn.firstAudioMs}ms` : 'never';
      lines.push(`  ${turn.promptId.padEnd(22)} 1st tool: ${toolMs.padEnd(8)} 1st audio: ${audioMs.padEnd(8)} calls: ${turn.toolCalls.length}`);
      for (const tc of turn.toolCalls) {
        const rel = tc.relativeToFirstAudioMs !== null
          ? (tc.relativeToFirstAudioMs < 0 ? `${tc.relativeToFirstAudioMs}ms before audio` : `+${tc.relativeToFirstAudioMs}ms after audio start`)
          : 'before any audio';
        const argStr = Object.entries(tc.args).map(([k, v]) => `${k}="${v}"`).join(', ');
        lines.push(`    → ${tc.name}(${argStr})  [${rel}]`);
      }
    }
  }

  lines.push('');
  lines.push('INTERPRETATION');
  lines.push('─'.repeat(96));
  lines.push('Tool before audio rate > 50% → model reliably calls tools BEFORE speaking → ideal for object spawning');
  lines.push('Tool before audio rate ~0%   → model calls tools AFTER speaking → still usable but less synchronized');
  lines.push('No tool calls at all         → model ignores function declarations in Live mode → strategy not viable');

  return lines.join('\n');
}
