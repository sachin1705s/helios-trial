/**
 * Gemini Live Object-Dispatch Latency Test
 *
 * Simulates realistic Gemini Live conversation sequences and measures when
 * each strategy would dispatch objects to Odyssey, relative to inputTranscription.
 *
 * Strategies tested:
 *   V1  turn-complete          — LLM call after full response (baseline)
 *   V2  keyword-stream         — client-side keyword match per chunk
 *   V3  stage-dir-stream       — extract *stage directions* per chunk
 *   V4  predict-at-input       — LLM call at inputTranscription with user text only
 *   V5  word-threshold         — LLM call after 15+ words buffered
 *   V6  hybrid                 — keyword+stage-dir immediate, LLM confirms at end
 *   V7  speculative-correct    — predict immediately, correct after full transcript
 *   V8  odyssey-last-prompt    — inject Odyssey's lastAppliedPrompt as scene context
 *   V9  odyssey-ack-inject     — inject last onInteractAcknowledged prompt as context
 *   V10 odyssey-video-frame    — simulated vision: describe Odyssey frame, ask Gemini Flash
 *
 * Run: open gemini-live-latency-test.html in a browser (needs /api/character/chat).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface GeminiEvent {
  type: 'inputTranscription' | 'outputChunk' | 'turnComplete';
  text?: string;       // inputTranscription text or outputChunk text
  delayMs: number;     // ms after previous event
}

interface OdysseyContext {
  /** The rewritten prompt Odyssey is currently rendering (client.lastAppliedPrompt). */
  lastAppliedPrompt: string;
  /** The last interact prompt that was acknowledged (onInteractAcknowledged). Null if no interact has fired yet. */
  lastAckPrompt: string | null;
  /** A brief textual description of what a vision model would see in an Odyssey frame capture.
   *  Used by V10 to simulate video-frame → Gemini Flash vision without real frame capture in tests. */
  frameDescription: string;
}

interface Fixture {
  id: string;
  character: string;
  userText: string;
  events: GeminiEvent[];
  expectedObjects: string[];   // ground-truth — what should ideally appear
  odysseyContext: OdysseyContext;
}

interface StrategyResult {
  strategy: string;
  dispatchedAt: number[];        // ms from inputTranscription per object batch
  objects: string[][];           // objects in each batch
  firstDispatchMs: number | null;
  accuracy: 'hit' | 'partial' | 'miss' | 'pending';
}

interface TurnResult {
  fixtureId: string;
  userText: string;
  expectedObjects: string[];
  strategies: StrategyResult[];
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Events mirror real Gemini Live timing: chunks arrive every 200-400ms.

const FIXTURES: Fixture[] = [
  {
    id: 'einstein-gravity',
    character: 'Albert Einstein',
    userText: 'Can you show me how gravity works?',
    events: [
      { type: 'inputTranscription', text: 'Can you show me how gravity works?', delayMs: 0 },
      { type: 'outputChunk', text: 'Imagine', delayMs: 350 },
      { type: 'outputChunk', text: 'a heavy ball', delayMs: 250 },
      { type: 'outputChunk', text: '*places ball on trampoline*', delayMs: 200 },
      { type: 'outputChunk', text: 'placed on a trampoline.', delayMs: 250 },
      { type: 'outputChunk', text: 'It bends the fabric —', delayMs: 300 },
      { type: 'outputChunk', text: 'that is spacetime curving.', delayMs: 250 },
      { type: 'outputChunk', text: 'A smaller ball then rolls', delayMs: 300 },
      { type: 'outputChunk', text: 'into the dip. That is gravity!', delayMs: 250 },
      { type: 'turnComplete', delayMs: 200 },
    ],
    expectedObjects: ['a heavy ball', 'a trampoline'],
    odysseyContext: {
      lastAppliedPrompt: 'Albert Einstein stands in a bright physics classroom, chalk in hand, looking curious and ready to explain',
      lastAckPrompt: null,
      frameDescription: 'An animated Einstein character stands centre-frame in a classroom setting, empty whiteboard behind him, hands at his sides, no props visible yet',
    },
  },
  {
    id: 'bear-berries',
    character: 'Steve the Bear',
    userText: 'What is your favourite food?',
    events: [
      { type: 'inputTranscription', text: 'What is your favourite food?', delayMs: 0 },
      { type: 'outputChunk', text: 'Oh friend!', delayMs: 380 },
      { type: 'outputChunk', text: '*holds up a honeycomb*', delayMs: 200 },
      { type: 'outputChunk', text: 'Look at this honeycomb —', delayMs: 250 },
      { type: 'outputChunk', text: 'smell that sweetness!', delayMs: 250 },
      { type: 'outputChunk', text: 'And these berries I found', delayMs: 300 },
      { type: 'outputChunk', text: 'by the river this morning.', delayMs: 250 },
      { type: 'turnComplete', delayMs: 200 },
    ],
    expectedObjects: ['a honeycomb', 'a handful of berries'],
    odysseyContext: {
      lastAppliedPrompt: 'A friendly bear sitting by a forest stream, looking warm and happy, surrounded by nature',
      lastAckPrompt: null,
      frameDescription: 'A large friendly brown bear sits near a forest stream, paws resting in lap, pine trees in background, no food items currently visible',
    },
  },
  {
    id: 'alexander-battle',
    character: 'Alexander',
    userText: 'How do you win a battle against a larger army?',
    events: [
      { type: 'inputTranscription', text: 'How do you win a battle against a larger army?', delayMs: 0 },
      { type: 'outputChunk', text: 'Here —', delayMs: 360 },
      { type: 'outputChunk', text: 'look at this map.', delayMs: 220 },
      { type: 'outputChunk', text: '*unrolls a battle map*', delayMs: 200 },
      { type: 'outputChunk', text: 'The enemy holds the river.', delayMs: 280 },
      { type: 'outputChunk', text: 'We strike the flank with cavalry.', delayMs: 300 },
      { type: 'outputChunk', text: 'Speed is your sword', delayMs: 250 },
      { type: 'outputChunk', text: 'when numbers are not.', delayMs: 200 },
      { type: 'turnComplete', delayMs: 200 },
    ],
    expectedObjects: ['a battle map', 'a gleaming sword'],
    odysseyContext: {
      lastAppliedPrompt: 'Alexander the Great stands tall in battle armour, commanding presence, ancient Macedonian battlefield backdrop',
      lastAckPrompt: 'Alexander stands ready, sword raised',
      frameDescription: 'An armoured Alexander character stands in a battle-ready pose, sword visible at his side, dusty battlefield visible behind him',
    },
  },
  {
    id: 'circus-lion-juggling',
    character: 'Circus Lion',
    userText: 'Can you juggle?',
    events: [
      { type: 'inputTranscription', text: 'Can you juggle?', delayMs: 0 },
      { type: 'outputChunk', text: 'Can I juggle?!', delayMs: 320 },
      { type: 'outputChunk', text: '*grabs juggling pins*', delayMs: 180 },
      { type: 'outputChunk', text: 'Watch — three pins,', delayMs: 220 },
      { type: 'outputChunk', text: 'in the air!', delayMs: 200 },
      { type: 'outputChunk', text: 'And here — a ball too!', delayMs: 280 },
      { type: 'outputChunk', text: 'Are you not entertained?!', delayMs: 220 },
      { type: 'turnComplete', delayMs: 200 },
    ],
    expectedObjects: ['juggling pins', 'a juggling ball'],
    odysseyContext: {
      lastAppliedPrompt: 'Leo the Circus Lion stands under a big top spotlight, dramatic pose, circus ring visible, looking proud and theatrical',
      lastAckPrompt: 'Circus lion bows dramatically to the crowd',
      frameDescription: 'A colourful circus lion character stands under a spotlight in the centre of a circus ring, no props in hand yet, audience bleachers visible in background',
    },
  },
  {
    id: 'davinci-wing',
    character: 'Da Vinci',
    userText: 'Tell me about your flying machine.',
    events: [
      { type: 'inputTranscription', text: 'Tell me about your flying machine.', delayMs: 0 },
      { type: 'outputChunk', text: 'Ah — look at this wing.', delayMs: 370 },
      { type: 'outputChunk', text: '*holds up a feathered wing*', delayMs: 200 },
      { type: 'outputChunk', text: 'Every feather placed by logic', delayMs: 260 },
      { type: 'outputChunk', text: 'I spent years learning.', delayMs: 240 },
      { type: 'outputChunk', text: 'Now — this gear here —', delayMs: 280 },
      { type: 'outputChunk', text: 'connect it so and the', delayMs: 220 },
      { type: 'outputChunk', text: 'force multiplies threefold.', delayMs: 220 },
      { type: 'turnComplete', delayMs: 200 },
    ],
    expectedObjects: ['a feathered wing', 'a brass gear'],
    odysseyContext: {
      lastAppliedPrompt: 'Leonardo da Vinci in his Renaissance workshop, surrounded by sketches and mechanical drawings, looking thoughtful',
      lastAckPrompt: 'Da Vinci studies a sketch of a flying machine',
      frameDescription: 'Da Vinci character stands in a cluttered workshop, scrolls and blueprints visible on a table beside him, no props currently held',
    },
  },
];

// ─── Keyword map (mirrors App.tsx GL_KEYWORD_MAP) ─────────────────────────────

const KEYWORD_MAP: Array<{ keywords: string[]; object: string }> = [
  { keywords: ['ball', 'bowling ball', 'heavy ball'], object: 'a heavy ball' },
  { keywords: ['clock', 'watch'], object: 'a ticking clock' },
  { keywords: ['light', 'beam', 'laser'], object: 'a beam of light' },
  { keywords: ['trampoline', 'fabric', 'sheet'], object: 'a trampoline' },
  { keywords: ['rocket', 'spaceship'], object: 'a rocket' },
  { keywords: ['apple'], object: 'a falling apple' },
  { keywords: ['berry', 'berries', 'blueberry', 'strawberry'], object: 'a handful of berries' },
  { keywords: ['honey', 'honeycomb'], object: 'a honeycomb' },
  { keywords: ['fish', 'salmon'], object: 'a fresh fish' },
  { keywords: ['pine cone', 'pinecone', 'acorn'], object: 'a pine cone' },
  { keywords: ['sword', 'blade'], object: 'a gleaming sword' },
  { keywords: ['shield'], object: 'a battle shield' },
  { keywords: ['map'], object: 'a battle map' },
  { keywords: ['horse', 'cavalry'], object: 'a horse' },
  { keywords: ['juggling ball', 'circus ball'], object: 'a juggling ball' },
  { keywords: ['hoop', 'ring'], object: 'a circus hoop' },
  { keywords: ['juggling pins', 'pins'], object: 'juggling pins' },
  { keywords: ['lotus'], object: 'a golden lotus' },
  { keywords: ['cat', 'feline'], object: 'an Egyptian cat' },
  { keywords: ['gear', 'cog'], object: 'a brass gear' },
  { keywords: ['wing', 'flying machine', 'glider'], object: 'a feathered wing' },
  { keywords: ['paintbrush', 'brush'], object: 'a paintbrush' },
  { keywords: ['stone', 'rock', 'pebble'], object: 'a smooth stone' },
  { keywords: ['leaf', 'leaves'], object: 'a fallen leaf' },
  { keywords: ['shell'], object: 'a shell' },
  { keywords: ['chip', 'circuit'], object: 'a circuit board' },
  { keywords: ['device', 'iphone', 'phone'], object: 'a sleek device' },
];

function keywordMatch(text: string): string[] {
  const lower = text.toLowerCase();
  return KEYWORD_MAP
    .filter(e => e.keywords.some(k => lower.includes(k)))
    .map(e => e.object);
}

function extractStageDirections(text: string): string[] {
  return [...text.matchAll(/\*([^*]+)\*/g)].map(m => m[1].trim());
}

// ─── Simulated LLM call ───────────────────────────────────────────────────────
// In the real test this calls /api/character/chat. Returns objects + elapsed ms.

async function llmFetchObjects(
  message: string,
  character: string
): Promise<{ objects: string[]; elapsedMs: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch('/api/character/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, character, history: [] }),
    });
    const elapsedMs = Math.round(performance.now() - t0);
    if (!res.ok) return { objects: [], elapsedMs };
    const data = await res.json() as { objects?: string[] };
    return { objects: (data.objects ?? []).filter(Boolean), elapsedMs };
  } catch {
    return { objects: [], elapsedMs: Math.round(performance.now() - t0) };
  }
}

// ─── Strategy runners ─────────────────────────────────────────────────────────
// Each returns StrategyResult by replaying a fixture's events with real delays.

async function runStrategy_turnComplete(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'turn-complete', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  let buffer = '';
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'outputChunk') buffer += (buffer ? ' ' : '') + ev.text;
    if (ev.type === 'turnComplete') {
      const msg = `User asked: "${fixture.userText}". You responded: "${buffer}". Based on this, what objects should appear in the scene?`;
      const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      const totalMs = elapsed + elapsedMs;
      if (objects.length) {
        result.dispatchedAt.push(totalMs);
        result.objects.push(objects);
        if (result.firstDispatchMs === null) result.firstDispatchMs = totalMs;
      }
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

async function runStrategy_keywordStream(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'keyword-stream', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  const dispatched = new Set<string>();
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'outputChunk' && ev.text) {
      const found = keywordMatch(ev.text).filter(o => !dispatched.has(o));
      if (found.length) {
        found.forEach(o => dispatched.add(o));
        result.dispatchedAt.push(elapsed);
        result.objects.push(found);
        if (result.firstDispatchMs === null) result.firstDispatchMs = elapsed;
      }
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

async function runStrategy_stageDirStream(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'stage-dir-stream', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  const dispatched = new Set<string>();
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'outputChunk' && ev.text) {
      const dirs = extractStageDirections(ev.text).filter(d => !dispatched.has(d));
      if (dirs.length) {
        dirs.forEach(d => dispatched.add(d));
        result.dispatchedAt.push(elapsed);
        result.objects.push(dirs);
        if (result.firstDispatchMs === null) result.firstDispatchMs = elapsed;
      }
    }
  }
  // Score: stage dirs are actions, not objects — check if they imply expected objects
  result.accuracy = result.dispatchedAt.length > 0 ? 'partial' : 'miss';
  return result;
}

async function runStrategy_predictAtInput(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'predict-at-input', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'inputTranscription') {
      const msg = `A user just asked a ${fixture.character} character: "${fixture.userText}". What physical objects would this character likely reference or show? Return objects only — do not generate a reply.`;
      const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      const totalMs = elapsed + elapsedMs;
      if (objects.length) {
        result.dispatchedAt.push(totalMs);
        result.objects.push(objects);
        if (result.firstDispatchMs === null) result.firstDispatchMs = totalMs;
      }
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

async function runStrategy_wordThreshold(fixture: Fixture): Promise<StrategyResult> {
  const THRESHOLD = 15;
  const result: StrategyResult = { strategy: 'word-threshold', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  let buffer = '';
  let fired = false;
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'outputChunk' && ev.text && !fired) {
      buffer += (buffer ? ' ' : '') + ev.text;
      const wordCount = buffer.trim().split(/\s+/).length;
      if (wordCount >= THRESHOLD) {
        fired = true;
        const msg = `User asked: "${fixture.userText}". Partial response so far: "${buffer}". What objects should appear in the scene?`;
        const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
        const totalMs = elapsed + elapsedMs;
        if (objects.length) {
          result.dispatchedAt.push(totalMs);
          result.objects.push(objects);
          if (result.firstDispatchMs === null) result.firstDispatchMs = totalMs;
        }
      }
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

async function runStrategy_hybrid(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'hybrid', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  let buffer = '';
  const dispatched = new Set<string>();
  const dispatch = (objs: string[], ms: number) => {
    const fresh = objs.filter(o => !dispatched.has(o));
    if (!fresh.length) return;
    fresh.forEach(o => dispatched.add(o));
    result.dispatchedAt.push(ms);
    result.objects.push(fresh);
    if (result.firstDispatchMs === null) result.firstDispatchMs = ms;
  };
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'outputChunk' && ev.text) {
      buffer += (buffer ? ' ' : '') + ev.text;
      // keyword-stream
      dispatch(keywordMatch(ev.text), elapsed);
      // stage-dir-stream (treated as action labels, included in result for measurement)
      const dirs = extractStageDirections(ev.text);
      if (dirs.length) dispatch(dirs, elapsed);
    }
    if (ev.type === 'turnComplete') {
      // LLM confirm — adds any objects keyword-stream missed
      const msg = `User asked: "${fixture.userText}". You responded: "${buffer}". Based on this, what objects should appear in the scene?`;
      const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      dispatch(objects, elapsed + elapsedMs);
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

async function runStrategy_speculativeCorrect(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'speculative-correct', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  let buffer = '';
  let speculativeObjects: string[] = [];

  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;

    if (ev.type === 'inputTranscription') {
      // Speculative: predict from user question alone
      const msg = `A user just asked a ${fixture.character} character: "${fixture.userText}". What physical objects would this character likely reference or show while answering? Return objects only — do not generate a reply.`;
      const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      const totalMs = elapsed + elapsedMs;
      speculativeObjects = objects;
      if (objects.length) {
        result.dispatchedAt.push(totalMs);
        result.objects.push([...objects.map(o => `[speculative] ${o}`)]);
        if (result.firstDispatchMs === null) result.firstDispatchMs = totalMs;
      }
    }

    if (ev.type === 'outputChunk' && ev.text) {
      buffer += (buffer ? ' ' : '') + ev.text;
    }

    if (ev.type === 'turnComplete') {
      // Correct: use full response to verify/update
      const msg = `User asked: "${fixture.userText}". You responded: "${buffer}". Based on this, what objects should appear in the scene?`;
      const { objects: correctObjects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      const totalMs = elapsed + elapsedMs;
      if (correctObjects.length) {
        const alreadyCorrect = correctObjects.every(o => speculativeObjects.includes(o));
        if (!alreadyCorrect) {
          result.dispatchedAt.push(totalMs);
          result.objects.push([...correctObjects.map(o => `[correction] ${o}`)]);
        }
        // Merge for accuracy scoring
        const allDispatched = [...speculativeObjects, ...correctObjects];
        result.accuracy = scoreAccuracy(allDispatched, fixture.expectedObjects);
      } else {
        result.accuracy = scoreAccuracy(speculativeObjects, fixture.expectedObjects);
      }
    }
  }

  if (result.accuracy === 'pending') {
    result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  }
  return result;
}

// V8 — odyssey-last-prompt: inject lastAppliedPrompt as scene context into
// the prediction call at inputTranscription. Tells the LLM what Odyssey is
// currently rendering so it can predict complementary objects.
async function runStrategy_odysseyLastPrompt(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'odyssey-last-prompt', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'inputTranscription') {
      const { lastAppliedPrompt } = fixture.odysseyContext;
      const msg = [
        `The scene currently shows: "${lastAppliedPrompt}".`,
        `The user just asked the character: "${fixture.userText}".`,
        `What physical objects should now appear in the scene to complement the character's answer?`,
        `Return objects only.`,
      ].join(' ');
      const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      const totalMs = elapsed + elapsedMs;
      if (objects.length) {
        result.dispatchedAt.push(totalMs);
        result.objects.push(objects);
        if (result.firstDispatchMs === null) result.firstDispatchMs = totalMs;
      }
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

// V9 — odyssey-ack-inject: inject the last onInteractAcknowledged prompt as
// context. Tells the LLM what Odyssey most recently confirmed it is showing,
// making predictions coherent with the acknowledged scene state.
async function runStrategy_odysseyAckInject(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'odyssey-ack-inject', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'inputTranscription') {
      const { lastAckPrompt, lastAppliedPrompt } = fixture.odysseyContext;
      const sceneState = lastAckPrompt
        ? `Odyssey last confirmed: "${lastAckPrompt}".`
        : `Odyssey is currently rendering: "${lastAppliedPrompt}".`;
      const msg = [
        sceneState,
        `The user just asked: "${fixture.userText}".`,
        `What new objects should appear in the scene to complement the character's response?`,
        `Return objects only, avoid repeating what is already shown.`,
      ].join(' ');
      const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      const totalMs = elapsed + elapsedMs;
      if (objects.length) {
        result.dispatchedAt.push(totalMs);
        result.objects.push(objects);
        if (result.firstDispatchMs === null) result.firstDispatchMs = totalMs;
      }
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

// V10 — odyssey-video-frame: simulate capturing a frame from Odyssey's
// MediaStream and passing a visual description to the LLM. In production this
// would be a real JPEG frame sent to Gemini Flash vision; in the test we use
// the fixture's frameDescription as a stand-in for what the vision model sees.
async function runStrategy_odysseyVideoFrame(fixture: Fixture): Promise<StrategyResult> {
  const result: StrategyResult = { strategy: 'odyssey-video-frame', dispatchedAt: [], objects: [], firstDispatchMs: null, accuracy: 'pending' };
  let elapsed = 0;
  for (const ev of fixture.events) {
    await sleep(ev.delayMs);
    elapsed += ev.delayMs;
    if (ev.type === 'inputTranscription') {
      const { frameDescription } = fixture.odysseyContext;
      // In production: grab frame → canvas → base64 JPEG → Gemini Flash vision call.
      // In simulation: use the textual frame description as a vision substitute.
      const msg = [
        `You are looking at a live frame of an animated character scene.`,
        `What you see: "${frameDescription}".`,
        `The user just asked the character: "${fixture.userText}".`,
        `Based on the current scene and the user's question, what physical objects should`,
        `appear next to make the character's answer visually compelling?`,
        `Return objects only.`,
      ].join(' ');
      const { objects, elapsedMs } = await llmFetchObjects(msg, fixture.character);
      const totalMs = elapsed + elapsedMs;
      if (objects.length) {
        result.dispatchedAt.push(totalMs);
        result.objects.push(objects);
        if (result.firstDispatchMs === null) result.firstDispatchMs = totalMs;
      }
    }
  }
  result.accuracy = scoreAccuracy(result.objects.flat(), fixture.expectedObjects);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scoreAccuracy(dispatched: string[], expected: string[]): 'hit' | 'partial' | 'miss' {
  if (!dispatched.length) return 'miss';
  const hits = expected.filter(e =>
    dispatched.some(d => d.toLowerCase().includes(e.toLowerCase().split(' ')[1] ?? e))
  );
  if (hits.length === expected.length) return 'hit';
  if (hits.length > 0) return 'partial';
  return 'miss';
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runAllStrategies(
  onProgress: (msg: string) => void
): Promise<TurnResult[]> {
  const results: TurnResult[] = [];

  for (const fixture of FIXTURES) {
    onProgress(`Running fixture: ${fixture.id}…`);

    const strategies = await Promise.all([
      runStrategy_turnComplete(fixture),
      runStrategy_keywordStream(fixture),
      runStrategy_stageDirStream(fixture),
      runStrategy_predictAtInput(fixture),
      runStrategy_wordThreshold(fixture),
      runStrategy_hybrid(fixture),
      runStrategy_speculativeCorrect(fixture),
      runStrategy_odysseyLastPrompt(fixture),
      runStrategy_odysseyAckInject(fixture),
      runStrategy_odysseyVideoFrame(fixture),
    ]);

    results.push({
      fixtureId: fixture.id,
      userText: fixture.userText,
      expectedObjects: fixture.expectedObjects,
      strategies,
    });

    onProgress(`  Done: ${fixture.id}`);
  }

  return results;
}

// ─── Summary renderer ─────────────────────────────────────────────────────────

export function renderSummary(results: TurnResult[]): string {
  const strategies = [
    'turn-complete', 'keyword-stream', 'stage-dir-stream',
    'predict-at-input', 'word-threshold', 'hybrid', 'speculative-correct',
    'odyssey-last-prompt', 'odyssey-ack-inject', 'odyssey-video-frame',
  ];

  // Aggregate: avg first-dispatch latency + accuracy per strategy
  type Agg = { latencies: number[]; hits: number; partials: number; misses: number };
  const agg: Record<string, Agg> = {};
  for (const s of strategies) {
    agg[s] = { latencies: [], hits: 0, partials: 0, misses: 0 };
  }

  for (const turn of results) {
    for (const sr of turn.strategies) {
      const a = agg[sr.strategy];
      if (sr.firstDispatchMs !== null) a.latencies.push(sr.firstDispatchMs);
      if (sr.accuracy === 'hit') a.hits++;
      else if (sr.accuracy === 'partial') a.partials++;
      else a.misses++;
    }
  }

  const lines: string[] = [
    '╔══════════════════════════════════════════════════════════════════════════╗',
    '║            GEMINI LIVE OBJECT-DISPATCH LATENCY TEST RESULTS              ║',
    '╠══════════════════════════════════════════════════════════════════════════╣',
    `${'Strategy'.padEnd(20)} ${'Avg 1st dispatch'.padEnd(18)} ${'Hits'.padEnd(6)} ${'Partial'.padEnd(9)} ${'Misses'.padEnd(8)} Score`,
    '─'.repeat(74),
  ];

  const scored: Array<{ strategy: string; score: number; avgMs: number }> = [];

  for (const s of strategies) {
    const a = agg[s];
    const avgMs = a.latencies.length
      ? Math.round(a.latencies.reduce((x, y) => x + y, 0) / a.latencies.length)
      : 99999;
    // Score: hits=3pts, partial=1pt, minus latency penalty (1pt per 500ms)
    const latPenalty = Math.min(6, Math.floor(avgMs / 500));
    const score = (a.hits * 3 + a.partials) - latPenalty;
    scored.push({ strategy: s, score, avgMs });

    const latStr = a.latencies.length ? `${avgMs}ms` : 'none';
    lines.push(
      `${s.padEnd(20)} ${latStr.padEnd(18)} ${String(a.hits).padEnd(6)} ${String(a.partials).padEnd(9)} ${String(a.misses).padEnd(8)} ${score}`
    );
  }

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];

  lines.push('─'.repeat(74));
  lines.push(`WINNER: ${winner.strategy} (score: ${winner.score}, avg latency: ${winner.avgMs}ms)`);
  lines.push('╚══════════════════════════════════════════════════════════════════════╝');

  // Per-fixture breakdown
  lines.push('');
  lines.push('PER-FIXTURE BREAKDOWN');
  lines.push('─'.repeat(74));
  for (const turn of results) {
    lines.push(`\n${turn.fixtureId}  |  user: "${turn.userText}"`);
    lines.push(`Expected: ${turn.expectedObjects.join(', ')}`);
    for (const sr of turn.strategies) {
      const lat = sr.firstDispatchMs !== null ? `${sr.firstDispatchMs}ms` : 'never';
      const objs = sr.objects.flat().join(', ') || '—';
      lines.push(`  ${sr.strategy.padEnd(18)} first: ${lat.padEnd(8)} accuracy: ${sr.accuracy.padEnd(8)} objects: ${objs}`);
    }
  }

  return lines.join('\n');
}
